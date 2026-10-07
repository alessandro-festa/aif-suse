// Pure pre-flight logic: cluster facts + form -> list of checks. No store access here so it is
// easy to unit test and to reuse from a CLI or admission policy later.

import { GpuType, gpuShort, sameGpu } from './gputypes';
import { SharedGpu, sharedGpuChecks, kaiShareChecks } from './gpushare';
import { ClusterCapacity, QueueIndex, availability, explain } from './quota';
import {
  backendForSchedulerName, backendOf, holdsPods, placesGpuMemoryShares, podQueueLabel, SchedulerType, usesQueueTree,
  workloadQueueLabel
} from './schedulers';

// How each scheduler binds a run (schedulerName, queue label) is in schedulers.ts, the chart's
// schedulers.yaml. kai and runai share the queue-tree maths below: Run:AI is the commercial build
// of KAI, with the same Queue CRD, queue hierarchy and gang admission.
export type { SchedulerType } from './schedulers';

export type Severity = 'pass' | 'fail' | 'warn' | 'info';

// Checks that do not depend on a cluster: the ones that still mean something for a run AI Factory
// places automatically, before it is known which cluster it lands on.
const CLUSTERLESS_CHECKS = ['chart', 'name', 'image', 'image-torch', 'image-packages', 'command'];

/**
 * The checks for a run placed automatically in an AI project: the cluster-independent ones, and
 * what will happen. Queue, capacity and GPU checks are the placement controller's to make, on
 * every cluster the project spans, when it places the run.
 */
export function automaticPlacementChecks(checks: Check[], project: string): Check[] {
  return [
    ...checks.filter((c) => CLUSTERLESS_CHECKS.includes(c.id)),
    {
      id: 'project', severity: 'pass', title: `AI project ${ project }`, detail: `The run is recorded in ${ project ? `aif-${ project }` : '' } on the management cluster.`
    },
    {
      id: 'pool', severity: 'info', title: 'Placed automatically', detail: 'AI Factory runs it on the compute pool of the project that fits it best, or queues it until one does.'
    },
  ];
}

export interface Check {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
}

export interface QueueInfo {
  name: string; namespace?: string; clusterQueue?: string;
  gpuQuota?: number | null; // KAI: single number from spec.resources.gpu.quota
  gpuQuotaByMode?: { 'device-plugin'?: number | null; dra?: number | null }; // Kueue: separate pools per request shape
  covered?: string[];
}
// A PVC offered as a dataset/checkpoint mount. accessModes decides whether a multi-node run can
// use it at all: only RWX (or RO-many, for a read-only dataset) can be mounted by every pod.
export interface PvcInfo {
  name: string; accessModes: string[]; phase: string;
  // what it is (see pvcRole), the run it belongs to, its size
  role?: 'checkpoint' | 'scratch' | 'app' | 'data'; run?: string; size?: string;
}
export interface StorageClassInfo { name: string; provisioner: string; isDefault: boolean; bindingMode?: string }
export interface GpuNode {
  name: string; gpus: number; cpuFree: number; memFree: number; // cpu in cores, mem in bytes
  diskPressure: boolean; ephemeralFree: number; images: string[]; // ephemeral in bytes; cached image refs
  ephemeralTotal?: number; // allocatable ephemeral storage, bytes: the most one pod could ever get
}

export interface Facts {
  loaded: boolean;
  namespaces: string[];
  kueueInstalled: boolean;
  kaiInstalled: boolean;
  // Run:AI is KAI plus a control plane, and ships the same queue CRD, so kaiInstalled is true on a
  // Run:AI cluster too. This narrows it: true means the scheduler is named runai-scheduler and
  // binds queues by the `project` pod label rather than kai.scheduler/queue.
  runaiInstalled: boolean;
  // Namespaces a run.ai Project claims (status.namespace). Only these carry the RoleBindings the
  // Run:AI scheduler needs to bind a pod; labelling a namespace by hand does not create them.
  // Empty means the Projects could not be read, in which case the check is skipped rather than
  // failing everyone who lacks the RBAC to list them.
  runaiProjectNamespaces: string[];
  localQueues: QueueInfo[];
  clusterQueues: QueueInfo[];
  kaiQueues: QueueInfo[];
  devicePluginGpus: number; // sum of allocatable nvidia.com/gpu across nodes
  draDevices: number; // devices advertised by ResourceSlices for the GPU driver
  gpuDeviceMemory: number; // bytes: the largest GPU device's memory from ResourceSlice capacity (0 = unknown)
  gpuTypes: GpuType[]; // GPU models in the cluster, from DRA slices and GPU Feature Discovery labels
  gfdLabels: boolean; // some node carries nvidia.com/gpu.product (GPU Feature Discovery)
  // MiB: the largest nvidia.com/gpu.memory node label (GPU Feature Discovery). KAI sizes a GPU-memory
  // share as a fraction of it. 0 / absent = unknown.
  gpuNodeMemoryMiB?: number;
  sharedGpus: SharedGpu[]; // MPS ResourceClaims workloads can attach to, with who uses them
  // GPU devices currently allocated to ResourceClaims, and the namespaces holding them. Counts only
  // claims this user can list, so for a project-scoped user it is a lower bound.
  draAllocated: number;
  draAllocatedBy: string[];
  claimsClusterWide: boolean; // ResourceClaims were listed across the cluster (cluster-wide read granted)
  draClassExists: boolean;
  // Can this user list nodes, DeviceClasses and ResourceSlices? Without all three, "no GPUs" means
  // "cannot see them", and neither this page nor the chart's gpu.mode=auto can tell how they are exposed.
  gpuReadable: boolean;
  computeDomainAvailable: boolean; // ComputeDomain CRD present and channel DeviceClass exists
  gpuNodes: GpuNode[]; // nodes that expose GPUs, with remaining schedulable CPU/memory
  podsReadable: boolean; // can this user list pods cluster-wide? (needed for headroom)
  existingJobs: { name: string; namespace: string }[];
  configMaps: string[]; // ConfigMaps in the selected namespace (for the mount picker)
  configMapCode?: Record<string, string>; // their train.py, by ConfigMap name, for the image checks
  // Secrets in the selected namespace (for the credentials mount). Empty also means "could not
  // read them", which is common — plenty of submitters can create a job and not list secrets — so
  // the check that uses this treats empty as "cannot tell" rather than as "it does not exist".
  secrets: string[];
  pvcs: PvcInfo[]; // PVCs in the selected namespace (for the dataset/checkpoint pickers)
  // Every StorageClass in the cluster. A scratch volume is a PVC, so without a default one there is
  // nothing to provision it from and the pod waits forever — see the scratch check.
  storageClasses: StorageClassInfo[];
  pytorchOperatorInstalled: boolean; // Kubeflow Training Operator: required for job.kind=pytorchjob
  // The AIJob API: the operator installs the run, from the training chart built into it.
  jobApi: boolean;
  // A custom chart instead of the built-in one (Advanced). null = the built-in chart.
  chart: { repoName: string; chartName: string; version: string } | null;
  // The compute pool the run goes to ('' = none chosen), how many there are to choose from, and the
  // AI project namespace on local its AIJob is recorded in (null: the namespace is in no AI project).
  // Undefined on pages that do not place runs.
  pool?: string;
  poolsAvailable?: number;
  aiProjectNamespace?: string | null;
  fetchErrors: string[]; // things we could not read (RBAC etc.)
  // Queue hierarchy and live capacity, for the quota checks. Separate from kaiQueues above, which
  // stays a flat list for the picker; quota answers need the whole tree.
  queueIndex: QueueIndex;
  capacity: ClusterCapacity;
  // queue the selected namespace is labelled for, when it has one
  namespaceQueue: string | null;
}

export interface Form {
  namespace: string;
  releaseName: string;
  image: string;
  tag: string;
  kind: 'job' | 'pytorchjob'; // Indexed Job, or a Kubeflow PyTorchJob (Master + Workers)
  mode: 'smoke' | 'torchrun' | 'custom';
  nodes: number;
  gpusPerNode: number;
  gpuMode: 'auto' | 'device-plugin' | 'dra';
  // GPU model the run must get ('' = any), as the cluster names it. gpu.productName in the chart:
  // a DRA device selector, or GPU Feature Discovery's product label under the device plugin.
  gpuProduct: string;
  // Secret the kubelet pulls the image with ('' = the namespace default ServiceAccount's). imagePullSecrets.
  pullSecret: string;
  // GPU allocation: 0 = a GPU of the run's own (exclusive); > 0 = attach to the project's shared GPU
  // (an MPS ResourceClaim) with this much GPU memory per pod, enforced by MPS. gpuSharedClaim is that
  // claim's name, picked per namespace by the page; profiles do not store it.
  gpuShareMiB: number;
  gpuSharedClaim: string;
  scheduler: SchedulerType;
  queue: string;
  priorityClassName: string;
  rendezvous: 'c10d' | 'etcd-v2';
  rendezvousEndpoint: string;
  multusNetwork: string;
  ncclSocketIfname: string;
  // Fabric. hostNetwork puts the pod on the node's NICs, which is the only way NCCL can reach an
  // RDMA rail; rdma mounts the verbs devices and runs the trainer privileged.
  hostNetwork: boolean;
  rdma: boolean;
  ncclIbHca: string; // e.g. mlx5_0:1,mlx5_1:1 — both rails of a dual-rail fabric
  ncclIbGidIndex: string; // RoCEv2 GID, usually 3
  rdmaHostLibPath: string; // node path with libibverbs, for images that lack it ('' = none)
  script: string;
  cpuRequest: string; // per pod, e.g. "500m"
  memRequest: string; // per pod, e.g. "1Gi"
  command: string; // custom mode: e.g. "python /mnt/config/train.py"
  args: string; // extra args, space separated
  configMap: string; // existing ConfigMap to mount read-only at /mnt/config
  env: Record<string, string>; // extra environment variables
  computeDomain: boolean; // multi-node NVLink domain: ComputeDomain + channel claim per pod
  ephemeralRequest: string; // per pod ephemeral-storage request (writable layer + logs)
  scratchSize: string; // '' = none; else scratch at /scratch of that size
  scratchMedium: 'volume' | 'node'; // a PVC from scratchStorageClass, or an emptyDir on the node disk
  scratchStorageClass: string; // '' = the cluster default
  datasetPVC: string; // existing PVC mounted read-only at /mnt/dataset
  checkpointPVC: string; // existing PVC mounted read-write at /mnt/checkpoints
  // checkpoints/outputs: none, a new volume for this run (dynamically provisioned), or checkpointPVC
  checkpointMode: 'none' | 'create' | 'existing';
  checkpointSize: string;
  checkpointStorageClass: string; // '' = the cluster default
  checkpointKeep: boolean; // keep the created volume after the run
  secretName: string; // existing Secret mounted read-only (S3 credentials, a token file)
  secretMountPath: string;
  // Wall-clock limit for the whole run, in hours; 0 = none. Becomes job.activeDeadlineSeconds, which
  // Kubernetes enforces by failing the Job (or PyTorchJob) and killing its pods when it runs out.
  runtimeLimitHours: number;
  // scratch sizing inputs (not sent to the chart; they drive the estimate)
  modelParamsB: number; // parameters in billions
  weightsSource: 'mounted' | 'download';
  datasetSource: 'streamed' | 'local';
  datasetCacheGB: number; // local copy size if datasetSource=local
  checkpointTarget: 'pvc' | 'scratch';
  checkpointCopies: number;
}

const CD_KUEUE_RESOURCE = 'compute-domain-channel';

export const DEFAULT_FORM: Form = {
  namespace:              '',
  releaseName:            '',
  // torchrun by default, because a real submission is a training run and the smoke test was only
  // ever the thing you reach for when the cluster itself is suspect. That forces the image: the
  // chart execs torchrun with no install step, so the default image has to carry PyTorch: the SUSE
  // Application Collection's, as the sample profiles use. It is multi-arch, which the amd64-only
  // pytorch/pytorch is not -- and arm64 GPU nodes are exactly where "the image silently will not
  // pull" costs the most time to diagnose. It pulls with the namespace's pull secret (see image-pull).
  image:                  'dp.apps.rancher.io/containers/pytorch',
  tag:                    '2.14.0-nvidia-2.1',
  kind:                   'job',
  mode:                   'torchrun',
  nodes:                  1,
  gpusPerNode:            1,
  gpuMode:                'auto',
  gpuProduct:             '',
  pullSecret:             '',
  gpuShareMiB:            0,
  gpuSharedClaim:         '',
  scheduler:              'none',
  queue:                  '',
  priorityClassName:      '',
  rendezvous:             'c10d',
  rendezvousEndpoint:     '',
  multusNetwork:          '',
  ncclSocketIfname:       '',
  hostNetwork:            false,
  rdma:                   false,
  ncclIbHca:              '',
  ncclIbGidIndex:         '3',
  rdmaHostLibPath:        '',
  script:                 '',
  cpuRequest:             '500m',
  memRequest:             '1Gi',
  command:                '',
  args:                   '',
  configMap:              '',
  env:                    {},
  ephemeralRequest:       '2Gi',
  scratchSize:            '',
  scratchMedium:          'volume',
  scratchStorageClass:    '',
  computeDomain:          false,
  datasetPVC:             '',
  checkpointPVC:          '',
  checkpointMode:         'none',
  checkpointSize:         '20Gi',
  checkpointStorageClass: '',
  checkpointKeep:         true,
  secretName:             '',
  secretMountPath:        '/secrets',
  runtimeLimitHours:      0,
  modelParamsB:           7,
  weightsSource:          'download',
  datasetSource:          'streamed',
  datasetCacheGB:         0,
  checkpointTarget:       'pvc',
  checkpointCopies:       2,
};

// ---- scratch sizing: bytes-per-parameter arithmetic, per pod ----
export interface ScratchEstimate { totalGiB: number; lines: { label: string; gib: number }[] }

export function estimateScratch(form: Form): ScratchEstimate {
  const params = Math.max(0, Number(form.modelParamsB) || 0); // billions
  const world = Math.max(1, (Number(form.nodes) || 1) * (Number(form.gpusPerNode) || 1));
  const lines: { label: string; gib: number }[] = [];
  const gib = (gb: number) => gb * 1e9 / 2 ** 30;

  if (form.weightsSource === 'download' && params > 0) {
    lines.push({ label: 'Weights downloaded into the pod (2 B/param × 1.2 conversion headroom)', gib: gib(params * 2 * 1.2) });
  }
  if (form.datasetSource === 'local' && form.datasetCacheGB > 0) {
    lines.push({ label: 'Dataset cached locally (as entered; Hugging Face Arrow conversion can double it)', gib: gib(form.datasetCacheGB) });
  }
  if (form.checkpointTarget === 'scratch' && params > 0) {
    const copies = Math.max(1, Number(form.checkpointCopies) || 1);

    lines.push({ label: `Checkpoints staged locally (16 B/param ÷ ${ world } rank(s) × ${ copies } copies)`, gib: gib(params * 16 / world * copies) });
  }
  lines.push({ label: 'Framework caches (compiler, pip, hub metadata)', gib: 5 });
  lines.push({ label: 'Slack', gib: 10 });
  const raw = lines.reduce((a, l) => a + l.gib, 0);

  return { totalGiB: Math.ceil(raw / 5) * 5, lines };
}

// Kubernetes quantity parsing (enough for cpu/memory): "500m" -> 0.5, "2Gi" -> bytes
export function parseCpu(q: string | number | undefined): number {
  if (q === undefined || q === null || q === '') {
    return 0;
  }
  const str = String(q).trim();

  return str.endsWith('m') ? parseFloat(str) / 1000 : parseFloat(str);
}
const MEM_UNITS: Record<string, number> = {
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, K: 1e3, M: 1e6, G: 1e9, T: 1e12, k: 1e3
};

export function parseMem(q: string | number | undefined): number {
  if (q === undefined || q === null || q === '') {
    return 0;
  }
  const m = String(q).trim().match(/^([0-9.]+)\s*([KMGT]i?|k)?$/);

  if (!m) {
    return NaN;
  }

  return parseFloat(m[1]) * (m[2] ? MEM_UNITS[m[2]] : 1);
}
export function fmtMem(b: number): string {
  return b >= 2 ** 30 ? `${ (b / 2 ** 30).toFixed(1) }Gi` : `${ Math.round(b / 2 ** 20) }Mi`;
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,50}[a-z0-9])?$/;

/**
 * Base images known to carry no PyTorch.
 *
 * A deny-list, not an allow-list: "which images have torch" is unanswerable from the name, and a
 * false "no torch" on someone's own training image would be a check that cries wolf. These few are
 * certain, and between them they cover the mistake that actually happens — leaving the chart's
 * default image (SUSE's BCI base, for the smoke mode) in place after switching the mode to torchrun.
 */
const TORCHLESS_IMAGES = [
  'registry.suse.com/bci/bci-base', 'registry.suse.com/bci/bci-minimal', 'registry.suse.com/bci/bci-micro', 'registry.suse.com/bci/bci-busybox',
  'nvidia/cuda', 'nvcr.io/nvidia/cuda', 'ubuntu', 'debian', 'rockylinux', 'alpine', 'busybox'
];

export function isTorchlessImage(repository: string): boolean {
  const repo = (repository || '').trim().toLowerCase().replace(/^docker\.io\//, '');

  return TORCHLESS_IMAGES.includes(repo);
}

/**
 * Images that carry PyTorch and nothing else: no torchvision, no pip to add it. Code that imports
 * one of the usual companions fails on its first line there.
 */
const TORCH_ONLY_IMAGES = ['dp.apps.rancher.io/containers/pytorch'];
const COMPANIONS = ['torchvision', 'torchaudio', 'transformers', 'datasets', 'peft', 'accelerate', 'timm'];

/** The packages `code` imports that a torch-only image does not have; [] for any other image. */
export function missingPackages(image: string, code: string): string[] {
  const repo = (image || '').trim().toLowerCase().replace(/^docker\.io\//, '');

  if (!TORCH_ONLY_IMAGES.includes(repo) || !code) {
    return [];
  }

  return COMPANIONS.filter((m) => new RegExp(`^\\s*(import|from)\\s+${ m }\\b`, 'm').test(code));
}

export function resolveGpuMode(form: Form, facts: Facts): 'device-plugin' | 'dra' {
  if (form.gpuMode !== 'auto') {
    return form.gpuMode;
  }
  if (facts.devicePluginGpus > 0) {
    return 'device-plugin';
  }
  if (facts.draClassExists) {
    return 'dra';
  }

  return 'device-plugin';
}

export function runPreflight(form: Form, facts: Facts): Check[] {
  const out: Check[] = [];
  const add = (id: string, severity: Severity, title: string, detail = '') => out.push({
    id, severity, title, detail
  });

  if (!facts.loaded) {
    add('loading', 'info', 'Reading cluster state…');

    return out;
  }

  // 1. chart
  if (!facts.jobApi) {
    add('chart', 'fail', 'AI Factory job API not available',
      'This cluster has no AIJob API. Training jobs are submitted through AI Factory, on the ' +
      'cluster where its operator runs (the Rancher local cluster).');
  } else if (facts.chart) {
    add('chart', 'pass', 'Custom job template', `${ facts.chart.repoName } / ${ facts.chart.chartName } ${ facts.chart.version }`);
  } else {
    add('chart', 'pass', 'Job template built into AI Factory', 'gpu-train-job, installed by the AI Factory operator; no chart repository needed');
  }

  // 1b. where it runs: an AI project, and a compute pool of one of its clusters
  if (facts.poolsAvailable && !facts.aiProjectNamespace) {
    add('project', 'fail', 'Choose an AI project',
      'A run belongs to an AI project, which decides who can see it and the clusters it may run on. Pick one at the top of the page.');
  } else if (facts.poolsAvailable && !facts.pool) {
    add('pool', 'fail', 'Choose a compute pool', 'Pick a pool of the project, or Automatic.');
  } else if (facts.pool) {
    add('project', 'pass', 'AI project', `The run is recorded in ${ facts.aiProjectNamespace } on the management cluster and runs in ${ form.namespace } here.`);
  }

  // 2. namespace
  if (!form.namespace) {
    add('namespace', 'fail', 'Choose a namespace');
  } else if (!facts.namespaces.includes(form.namespace)) {
    add('namespace', 'fail', 'Namespace not visible', `You cannot see namespace "${ form.namespace }" (does it exist / do you have access?).`);
  } else {
    add('namespace', 'pass', `Namespace ${ form.namespace }`);
  }

  // 3. release name
  if (!form.releaseName) {
    add('name', 'fail', 'Enter a job name');
  } else if (!DNS_LABEL.test(form.releaseName)) {
    add('name', 'fail', 'Invalid job name', 'Lowercase letters, digits and dashes, max 52 characters, must start and end alphanumeric.');
  } else if (facts.existingJobs.some((j) => j.name === form.releaseName && j.namespace === form.namespace)) {
    add('name', 'fail', 'Job name already in use', `A job named "${ form.releaseName }" already exists in ${ form.namespace }. Pick another name or delete the old run.`);
  } else {
    add('name', 'pass', `Job name ${ form.releaseName }`);
  }

  // 4. image
  if (!form.image || !form.tag) {
    add('image', 'fail', 'Image and tag are required');
  } else {
    add('image', 'pass', `Image ${ form.image }:${ form.tag }`);
    // torchrun has to exist in the image; the chart does not pip-install anything. A base CUDA
    // image has no torch, so the pod starts, exits 127 with "torchrun: not found" and is reported
    // as a failed training run -- which reads like a cluster problem and is not one.
    const code = form.script || (form.configMap ? facts.configMapCode?.[form.configMap] || '' : '');
    const missing = form.mode === 'torchrun' ? missingPackages(form.image, code) : [];

    if (missing.length) {
      add('image-packages', 'warn', `${ form.image } has PyTorch only: the code imports ${ missing.join(', ') }`,
        `This image has no ${ missing.join(', ') } and no pip, so the run fails on its first import. Use an image built from dp.apps.rancher.io/containers/pytorch with them added (the SUSE Application Collection image has PyTorch only), or one that ships them, such as nvcr.io/nvidia/pytorch or pytorch/pytorch (torchvision included).`);
    }
    if (form.mode === 'torchrun' && isTorchlessImage(form.image)) {
      add('image-torch', 'fail', `${ form.image } does not ship PyTorch`,
        'torchrun mode execs torchrun directly, with no install step, so this pod exits 127 immediately. Use a runtime that has it — dp.apps.rancher.io/containers/pytorch (SUSE Application Collection, multi-arch), nvcr.io/nvidia/pytorch:24.10-py3 (multi-arch) or pytorch/pytorch (amd64) — or switch the mode to Smoke test, which only needs nvidia-smi.');
    }
  }
  // Registries that need credentials. Without a pull secret on the form, the pod pulls with the
  // namespace default ServiceAccount's secrets: AI Factory adds suse-ai-pull-combined there in the
  // namespaces it deploys into, and nothing does elsewhere.
  if (form.image) {
    const host = form.image.includes('/') && /[.:]/.test(form.image.split('/')[0]) ? form.image.split('/')[0] : 'docker.io';
    // registry.suse.com serves BCI and suse/ images publicly; its ai/ path is SUSE AI's, behind a login
    const needsAuth = host === 'dp.apps.rancher.io' || (host === 'registry.suse.com' && form.image.startsWith('registry.suse.com/ai/'));

    if (form.pullSecret) {
      if (facts.secrets.length && !facts.secrets.includes(form.pullSecret)) {
        add('image-pull', 'fail', `Image pull secret ${ form.pullSecret } is not in ${ form.namespace }`, 'The pod would stay in ImagePullBackOff. Create it, or clear the field to use the namespace default ServiceAccount.');
      } else {
        add('image-pull', 'pass', `Pulls with Secret ${ form.pullSecret }`);
      }
    } else if (needsAuth) {
      add('image-pull', 'info', `${ host } needs credentials`, `No pull secret is set, so the pod uses the namespace default ServiceAccount's. Namespaces where SUSE AI Factory has deployed carry suse-ai-pull-combined there; elsewhere set Image pull secret, or the pod stays in ImagePullBackOff.`);
    }
  }


  // 5. scheduler installed
  if (form.scheduler === 'kueue') {
    if (facts.kueueInstalled) {
      add('scheduler', 'pass', 'Kueue is installed');
    } else {
      add('scheduler', 'fail', 'Kueue is not installed on this cluster', 'Pick "Default scheduler" or install Kueue first.');
    }
  } else if (usesQueueTree(form.scheduler)) {
    const bind = backendOf(form.scheduler);

    if (!facts.kaiInstalled) {
      add('scheduler', 'fail', `${ bind.display } is not installed on this cluster`, `Pods with schedulerName ${ bind.schedulerName } would stay Pending forever. Pick another scheduler.`);
    } else if (form.scheduler === 'kai' && facts.runaiInstalled) {
      // The queue CRD is present either way, so this one cannot be caught by looking for queues.
      add('scheduler', 'fail', 'This cluster runs Run:AI, not stand-alone KAI',
        'They share the Queue CRD and differ in schedulerName, so a pod asking for kai-scheduler waits for a scheduler that is not running — with no event on the pod to say so. Choose "Run:AI scheduler".');
    } else if (form.scheduler === 'runai' && !facts.runaiInstalled) {
      add('scheduler', 'fail', 'Run:AI is not installed on this cluster',
        'The Queue CRD here belongs to stand-alone KAI. Choose "KAI scheduler".');
    } else {
      add('scheduler', 'pass', `${ bind.display } is installed`);
    }
  } else {
    add('scheduler', 'pass', 'Default kube-scheduler', 'No queueing: the job runs as soon as the GPUs are free.');
  }

  // GPU request shape decides which Kueue quota pool applies (nvidia.com/gpu vs the DRA-mapped "gpu")
  const mode = resolveGpuMode(form, facts);

  // 6. queue exists (+ quota). A GPU-memory share under KAI is charged as a fraction of a GPU: its
  // share of the node's GPU memory, rounded up to KAI's two decimals.
  const kaiShare = form.gpuShareMiB > 0 && placesGpuMemoryShares(form.scheduler);
  const shareFraction = kaiShare && facts.gpuNodeMemoryMiB ? Math.ceil((form.gpuShareMiB / facts.gpuNodeMemoryMiB) * 100) / 100 : 1;
  const requested = kaiShare ? form.nodes * shareFraction : form.nodes * form.gpusPerNode;

  if (form.scheduler === 'kueue' && facts.kueueInstalled) {
    const lq = facts.localQueues.find((q) => q.name === form.queue && q.namespace === form.namespace);

    if (!form.queue) {
      add('queue', 'fail', 'Choose a Kueue LocalQueue');
    } else if (!lq) {
      const inNs = facts.localQueues.filter((q) => q.namespace === form.namespace).map((q) => q.name);

      add('queue', 'fail', `LocalQueue "${ form.queue }" not found in ${ form.namespace }`,
        inNs.length ? `Queues in this namespace: ${ inNs.join(', ') }` : 'This namespace has no LocalQueue. Submit from a namespace that owns one, or ask an admin to create one.');
    } else {
      const cq = facts.clusterQueues.find((c) => c.name === lq.clusterQueue);
      // Kueue keeps nvidia.com/gpu and the DRA-mapped "gpu" as independent pools; on a dual-mode
      // ClusterQueue both cover the same physical GPUs, so only the pool for this request shape counts.
      const quota = cq?.gpuQuotaByMode?.[mode];
      const pool = mode === 'dra' ? 'DRA claims' : 'nvidia.com/gpu';

      const covered = cq?.covered || [];
      const needed = ['cpu', 'memory', ...(form.ephemeralRequest ? ['ephemeral-storage'] : []), ...(form.computeDomain ? [CD_KUEUE_RESOURCE] : [])];
      const missing = covered.length ? needed.filter((r) => !covered.includes(r)) : [];

      if (typeof quota === 'number' && requested > quota) {
        add('queue', 'fail', `Request exceeds queue quota`, `${ requested } GPUs requested but ClusterQueue ${ lq.clusterQueue } allows ${ quota } for ${ pool }. This job could never be admitted.`);
      } else if (missing.length) {
        add('queue', 'fail', `ClusterQueue ${ lq.clusterQueue } does not cover ${ missing.join(', ') }`, `Kueue refuses admission for any requested resource the queue does not cover.${ missing.includes('ephemeral-storage') ? ' Clear the ephemeral storage request, or ask an admin to add ephemeral-storage to the ClusterQueue.' : '' }${ missing.includes(CD_KUEUE_RESOURCE) ? ` ComputeDomain: Kueue must map the channel DeviceClass to "${ CD_KUEUE_RESOURCE }" in deviceClassMappings and the ClusterQueue must cover it.` : '' }`);
      } else {
        add('queue', 'pass', `LocalQueue ${ lq.name } → ${ lq.clusterQueue }`, typeof quota === 'number' ? `GPU quota ${ quota } (${ pool } pool)` : '');
      }
    }
  } else if (usesQueueTree(form.scheduler) && facts.kaiInstalled) {
    const node = facts.queueIndex[form.queue];

    if (!form.queue) {
      add('queue', 'fail', 'Choose a queue');
    } else if (!node) {
      add('queue', 'fail', `Queue "${ form.queue }" not found`, facts.kaiQueues.length ? `Available: ${ facts.kaiQueues.map((q) => q.name).join(', ') }` : 'No Queue objects visible.');
    } else if (!node.isLeaf) {
      // A parent queue is an accounting node; the scheduler will never place a pod on it, and the
      // pod gives no indication why. Catch it here instead.
      add('queue', 'fail', `"${ form.queue }" is a parent queue`, `Only leaf queues run workloads. Submit to one of its children: ${ node.children.join(', ') }.`);
    } else {
      const a = availability(form.queue, facts.queueIndex, facts.capacity, 'gpu');
      const detail = explain(a, requested);

      if (requested <= a.freeInQuota) {
        add('queue', 'pass', `Queue ${ form.queue }: ${ requested } GPU within guaranteed quota`, detail);
      } else if (requested <= a.schedulableNow) {
        add('queue', 'warn', `Queue ${ form.queue }: ${ requested } GPU needs over-quota borrowing`, detail);
      } else if (Number.isFinite(a.cap) && requested > a.cap) {
        // Not a transient wait — this job can never be admitted to this queue as configured.
        add('queue', 'fail', `Request exceeds the queue's hard cap`, `${ requested } GPU requested but ${ a.capBoundBy === form.queue ? `queue ${ form.queue }` : `parent queue ${ a.capBoundBy }` } caps this at ${ a.cap }. This job could never be admitted.`);
      } else {
        add('queue', 'warn', `Queue ${ form.queue }: ${ requested } GPU will wait`, detail);
      }

      if (a.stale) {
        add('quota-freshness', 'info', 'Queue usage derived from pods', 'The scheduler has not published status on this queue, so in-use GPUs are summed from pod requests. Fractional GPU sharing would not be counted.');
      }
    }

    // Run:AI's pod webhooks are scoped to namespaces carrying runai/queue. Without it the pods are
    // admitted and then ignored by the scheduler: Pending, no event, nothing on the pod to read.
    if (form.scheduler === 'runai' && !facts.namespaceQueue) {
      add('queue-ns-label', 'fail', `Namespace ${ form.namespace } is not bound to a Run:AI queue`,
        `Run:AI only manages namespaces labelled runai/queue. Run: kubectl label ns ${ form.namespace } runai/queue=${ form.queue || '<queue>' } runai/namespace-version=v2 — or create the namespace from the Projects page, which labels it.`);
    }

    // The label is necessary and not sufficient, which is the trap this check exists for.
    //
    // Run:AI's scheduler creates a BindRequest in the workload's own namespace to place a pod, and
    // its permission to do that comes from a RoleBinding that Run:AI's project-controller writes
    // when a Project is created -- one per Run:AI component, ~26 of them. A namespace that was
    // hand-labelled has the webhooks but none of the RoleBindings, so the scheduler picks a node
    // and then fails to bind:
    //
    //   FailedBinding  bindrequests.scheduling.run.ai is forbidden:
    //   User "system:serviceaccount:runai:runai-scheduler" cannot create resource "bindrequests"
    //
    // The pods then sit Pending and the podgroup is evicted as stale. Unlike the missing-label
    // case the reason IS on the pod, but it reads as a Run:AI internal error rather than "this
    // namespace was never provisioned", so it is worth naming here before anything is submitted.
    if (form.scheduler === 'runai' && facts.namespaceQueue && facts.runaiProjectNamespaces.length &&
        !facts.runaiProjectNamespaces.includes(form.namespace)) {
      add('runai-project', 'fail', `Namespace ${ form.namespace } is labelled for Run:AI but not provisioned by it`,
        `No run.ai Project claims this namespace, so it has none of the RoleBindings the Run:AI scheduler needs to bind pods in it — the pods will be scheduled and then fail to bind. Submit into a namespace a Run:AI Project owns (${ facts.runaiProjectNamespaces.join(', ') }), or create a Project whose spec.namespace is ${ form.namespace }.`);
    }

    // A namespace labelled for a different queue is a real trap: the scheduler follows the
    // namespace label for Run:AI-style binding, so the job can land on quota the user did not pick.
    if (form.queue && facts.namespaceQueue && facts.namespaceQueue !== form.queue) {
      add('queue-ns-mismatch', 'warn', `Namespace ${ form.namespace } is labelled for queue "${ facts.namespaceQueue }"`, `You selected "${ form.queue }". Under Run:AI the namespace label wins, so the job would be charged to "${ facts.namespaceQueue }". Pick that queue, or submit from a namespace bound to "${ form.queue }".`);
    }
  }

  // 7. GPU exposure

  if (form.gpusPerNode === 0 && !(form.gpuShareMiB > 0)) {
    // a CPU-only run (the chart's gpu mode none): nothing to expose
    add('gpu', 'pass', 'CPU only: no GPU requested');
  } else if (mode === 'device-plugin') {
    if (facts.devicePluginGpus > 0) {
      add('gpu', 'pass', `GPU request via device plugin (nvidia.com/gpu)`, `${ facts.devicePluginGpus } allocatable across the cluster${ form.gpuMode === 'auto' ? ' — auto-detected' : '' }`);
    } else if (facts.draClassExists) {
      add('gpu', 'fail', 'No node advertises nvidia.com/gpu', 'This cluster exposes GPUs through DRA. Set GPU request mode to auto or dra.');
    } else if (!facts.gpuReadable) {
      add('gpu', 'fail', 'Cannot see this cluster\'s GPUs', 'Your account cannot list nodes, DeviceClasses or ResourceSlices, so the GPU request mode cannot be worked out (and auto would guess wrong on a DRA cluster). Ask an admin to bind the AI Scheduler Cluster Read role in this cluster.');
    } else {
      add('gpu', 'fail', 'No GPUs visible', 'No nvidia.com/gpu capacity and no DRA DeviceClass. Is the GPU Operator running?');
    }
  } else if (facts.draClassExists) {
    add('gpu', 'pass', 'GPU request via DRA ResourceClaim', `${ facts.draDevices } device(s) advertised${ form.gpuMode === 'auto' ? ' — auto-detected' : '' }`);
  } else {
    add('gpu', 'fail', 'DRA DeviceClass not found', 'Set GPU request mode to device-plugin, or install the NVIDIA DRA driver.');
  }

  // 7b. multi-node NVLink
  if (form.computeDomain) {
    if (mode !== 'dra') {
      add('cd', 'fail', 'ComputeDomain needs DRA', 'The NVLink channel is a DRA claim; set GPU request mode to dra (or auto on a DRA cluster).');
    } else if (!facts.computeDomainAvailable) {
      add('cd', 'fail', 'ComputeDomain support not present on this cluster', 'Needs the NVIDIA DRA driver with compute domains enabled (CRD resource.nvidia.com/ComputeDomain and the channel DeviceClass).');
    } else {
      add('cd', 'pass', `ComputeDomain for ${ form.nodes } node(s)`, form.nodes === 1 ? 'One node: valid, but IMEX only matters across nodes.' : 'Every pod gets a GPU claim plus an IMEX channel claim.');
    }
  } else if (form.nodes > 1 && mode === 'dra' && facts.computeDomainAvailable) {
    add('cd', 'info', 'Multi-node run without a ComputeDomain', 'If the NVLink fabric spans nodes on this system, enable it so NCCL can use NVLink between nodes; otherwise inter-node traffic goes over the network fabric.');
  }

  // 7b. GPU type: the model the run asked for, in whichever way this cluster can enforce it
  if (form.gpuProduct) {
    const label = gpuShort(form.gpuProduct);
    const matches = (facts.gpuTypes || []).filter((t) => sameGpu(t.product, form.gpuProduct));
    const others = (facts.gpuTypes || []).map((t) => gpuShort(t.product)).join(', ') || 'none found';

    if (mode === 'dra') {
      const t = matches.find((m) => m.source === 'dra');

      if (!t) {
        add('gpu-type', 'fail', `No ${ label } GPU in this cluster`, `The claim only matches devices with that productName. GPUs here: ${ others }.`);
      } else if (!form.gpuShareMiB && (t.free ?? 0) < requested) {
        add('gpu-type', 'warn', `${ t.free } of ${ t.total } ${ label } free, ${ requested } requested`, 'The run waits until enough of that model are released.');
      } else {
        add('gpu-type', 'pass', `GPU type ${ label }: ${ t.free } of ${ t.total } free`, `Matched by the claim's device selector on ${ t.nodes.join(', ') }.`);
      }
    } else if (!facts.gfdLabels) {
      add('gpu-type', 'fail', 'GPU type cannot be enforced here', 'The device plugin cannot ask for a GPU model. The chart selects nodes by nvidia.com/gpu.product, which GPU Feature Discovery sets, and no node has it: the pod would stay Pending. Enable GPU Feature Discovery in the GPU Operator, or clear GPU type.');
    } else if (!matches.length) {
      add('gpu-type', 'fail', `No node has ${ label } GPUs`, `By GPU Feature Discovery's nvidia.com/gpu.product label. GPUs here: ${ others }.`);
    } else {
      const nodes = matches.flatMap((m) => m.nodes);

      add('gpu-type', 'pass', `GPU type ${ label } on ${ nodes.length } node(s)`, `Pods are placed on ${ nodes.join(', ') } by nvidia.com/gpu.product.`);
    }
  }

  // 7c. a shared GPU: the claim, one GPU per pod, and the memory left on it
  if (kaiShare) {
    kaiShareChecks(form.gpuShareMiB, form.gpusPerNode, facts, backendOf(form.scheduler).display).forEach((c) => add(c.id, c.severity, c.title, c.detail));
  } else if (form.gpuShareMiB > 0) {
    sharedGpuChecks(form.namespace, form.gpuSharedClaim, form.gpuShareMiB, form.nodes, form.gpusPerNode, facts, mode, form.scheduler).forEach((c) => add(c.id, c.severity, c.title, c.detail));
  }

  // 8. capacity
  const total = mode === 'device-plugin' ? facts.devicePluginGpus : facts.draDevices;

  // 8a. GPUs already allocated through DRA to other workloads. Kueue only accounts for GPUs taken
  // through its own queues, so admission can succeed and the pod still never schedules.
  // A shared GPU is allocated to its shared claim by design; that is not a conflict for a run joining it.
  if (mode === 'dra' && facts.draAllocated > 0 && !(form.gpuShareMiB > 0)) {
    const free = Math.max(0, facts.draDevices - facts.draAllocated);
    const by = facts.draAllocatedBy.length ? ` (namespace${ facts.draAllocatedBy.length > 1 ? 's' : '' } ${ facts.draAllocatedBy.join(', ') })` : '';
    const atLeast = facts.claimsClusterWide ? '' : 'At least ';

    if (requested > free) {
      add('gpu-in-use', form.scheduler === 'none' ? 'fail' : 'warn',
        `${ atLeast }${ facts.draAllocated } of ${ facts.draDevices } GPU(s) already allocated to other workloads${ by }`,
        `${ free } free, ${ requested } requested. ${ form.scheduler === 'kueue' ? 'Kueue does not see GPUs taken outside its queues, so it may admit this job and the pod will still sit Pending on "cannot allocate all claims".' : 'The pod will sit Pending on "cannot allocate all claims" until a claim is released.' }`);
    } else {
      add('gpu-in-use', 'info', `${ atLeast }${ facts.draAllocated } of ${ facts.draDevices } GPU(s) allocated to other workloads${ by }`, `${ free } free for this job.`);
    }
  }

  if (kaiShare) {
    // KAI places the share; its own check above covers fit.
  } else if (total > 0 && requested > total) {
    add('capacity', 'warn', `Requesting ${ requested } GPUs, cluster has ${ total }`, 'The job will wait in Pending/queued until enough GPUs exist. Reduce nodes or GPUs per node to run now.');
  } else if (total > 0) {
    add('capacity', 'pass', `${ requested } GPU(s) requested of ${ total } in the cluster`);
  }

  // 8b. CPU / memory headroom on GPU nodes (the usual reason a GPU pod sits Pending on a busy node)
  const cpuReq = parseCpu(form.cpuRequest);
  const memReq = parseMem(form.memRequest);

  if (!form.cpuRequest || Number.isNaN(cpuReq) || !form.memRequest || Number.isNaN(memReq)) {
    add('headroom', 'fail', 'CPU and memory requests must be valid quantities', 'Examples: 500m, 2, 1Gi, 512Mi');
  } else if (!facts.podsReadable) {
    add('headroom', 'info', 'Node headroom not checked', 'Your role cannot list pods cluster-wide, so free CPU/memory on the GPU nodes is unknown. If the pod stays Pending with "Insufficient cpu", lower the requests.');
  } else if (facts.gpuNodes.length) {
    const fits = facts.gpuNodes.filter((n) => n.cpuFree >= cpuReq && n.memFree >= memReq);
    const best = [...facts.gpuNodes].sort((a, b) => b.cpuFree - a.cpuFree)[0];
    const detail = `Most headroom: ${ best.name } has ${ best.cpuFree.toFixed(2) } CPU / ${ fmtMem(best.memFree) } free; this pod asks ${ cpuReq } CPU / ${ fmtMem(memReq) }.`;

    if (fits.length === 0) {
      add('headroom', 'fail', 'No GPU node has enough free CPU/memory for this pod', `${ detail } Lower the requests or free capacity on the GPU node.`);
    } else if (fits.length < form.nodes) {
      add('headroom', 'warn', `Only ${ fits.length } GPU node(s) can fit a pod right now (need ${ form.nodes })`, detail);
    } else {
      add('headroom', 'pass', `${ fits.length } GPU node(s) have room for the pod's CPU/memory`, detail);
    }
  }

  if (form.mode === 'custom' && !form.command.trim()) {
    add('command', 'fail', 'Custom mode needs a command', 'Example: python /mnt/config/train.py');
  }
  if (form.configMap && !facts.configMaps.includes(form.configMap)) {
    add('configmap', 'fail', `ConfigMap "${ form.configMap }" not found in ${ form.namespace }`);
  } else if (form.configMap && form.mode === 'torchrun') {
    add('configmap', 'info', `torchrun runs /mnt/config/train.py from ConfigMap ${ form.configMap }`, 'The ConfigMap must have a train.py key; the inline script box is ignored.');
  }

  // 7b. dataset / checkpoint PVCs. A volume only one pod can mount leaves the rest of a
  // distributed run Pending on "Multi-Attach error", which is not obvious from the pod events.
  for (const [field, claim, label, mount] of [
    ['dataset', form.datasetPVC, 'Dataset', '/mnt/dataset'],
    ['checkpoint', form.checkpointMode !== 'create' ? form.checkpointPVC : '', 'Checkpoint', '/mnt/checkpoints'],
  ] as [string, string, string, string][]) {
    if (!claim) {
      continue;
    }
    const pvc = facts.pvcs.find((p) => p.name === claim);

    if (!pvc) {
      add(`pvc-${ field }`, 'fail', `${ label } PVC "${ claim }" not found in ${ form.namespace }`,
        facts.pvcs.length ? `Available: ${ facts.pvcs.map((p) => p.name).join(', ') }` : 'No PVCs visible in this namespace.');
      continue;
    }

    const shared = pvc.accessModes.includes('ReadWriteMany') ||
      (field === 'dataset' && pvc.accessModes.includes('ReadOnlyMany'));

    if (form.nodes > 1 && !shared) {
      add(`pvc-${ field }`, 'fail', `${ label } PVC "${ claim }" cannot be shared across ${ form.nodes } pods`,
        `It is ${ pvc.accessModes.join('/') }, so only one pod can mount it. The other pods would stay Pending on a Multi-Attach error. Use an RWX volume (CephFS/NFS), or set nodes to 1.`);
    } else if (pvc.phase && pvc.phase !== 'Bound') {
      add(`pvc-${ field }`, 'fail', `${ label } PVC "${ claim }" is ${ pvc.phase }, not Bound`,
        'The pod will not start until the volume binds.');
    } else {
      add(`pvc-${ field }`, 'pass', `${ label } PVC ${ claim } → ${ mount }`,
        `${ pvc.accessModes.join('/') }${ field === 'dataset' ? ', mounted read-only' : '' }`);
    }
  }

  // 8c. disk: pressure, ephemeral headroom, image cached
  if (facts.gpuNodes.length) {
    const healthy = facts.gpuNodes.filter((n) => !n.diskPressure);

    if (healthy.length === 0) {
      add('disk', 'fail', 'Every GPU node reports DiskPressure', `${ facts.gpuNodes.map((n) => n.name).join(', ') }: pods there lose their logs and get evicted. Ask an admin to free disk on the node before submitting.`);
    } else if (healthy.length < facts.gpuNodes.length) {
      add('disk', 'warn', `${ facts.gpuNodes.length - healthy.length } GPU node(s) under DiskPressure`, `Only ${ healthy.map((n) => n.name).join(', ') } are usable right now.`);
    } else {
      add('disk', 'pass', 'GPU nodes have no disk pressure');
    }

    const eph = parseMem(form.ephemeralRequest);

    if (!form.ephemeralRequest || Number.isNaN(eph)) {
      add('ephemeral', 'fail', 'Ephemeral storage request must be a valid quantity', 'e.g. 2Gi');
    } else if (facts.podsReadable) {
      const fits = healthy.filter((n) => n.ephemeralFree >= eph);
      // A request above every node's total can never be met; one above what is free now can wait.
      const largest = Math.max(0, ...healthy.map((n) => n.ephemeralTotal ?? n.ephemeralFree));

      if (healthy.length && largest < eph) {
        add('ephemeral', 'fail', 'More local disk per worker than any GPU node has', `Each worker requests ${ fmtMem(eph) } of node-local disk (ephemeral storage); the largest GPU node offers ${ fmtMem(largest) } in total.`);
      } else if (fits.length === 0) {
        const best = [...healthy].sort((a, b) => b.ephemeralFree - a.ephemeralFree)[0];

        add('ephemeral-free', 'fail', 'No GPU node has that much free local disk right now', best ? `${ best.name } has ${ fmtMem(best.ephemeralFree) } unrequested; each worker asks ${ fmtMem(eph) }.` : '');
      } else {
        add('ephemeral', 'pass', `Ephemeral storage ${ fmtMem(eph) } fits on ${ fits.length } GPU node(s)`);
      }
    }

    const ref = `${ form.image }:${ form.tag }`;
    const cachedOn = healthy.filter((n) => n.images.some((i) => i === ref || i.endsWith(`/${ ref }`) || i.endsWith(`library/${ ref }`)));

    if (cachedOn.length) {
      add('image-cache', 'pass', `Image already cached on ${ cachedOn.map((n) => n.name).join(', ') }`, 'No pull needed; the pod starts immediately.');
    } else {
      add('image-cache', 'warn', 'Image not cached on any GPU node', 'First start pulls it (ML runtime images are 3–10 GB). Needs that much free space on the node\'s image disk, and takes minutes.');
    }
  }
  // scratch sizing estimate (weights / dataset cache / checkpoints staged locally + caches + slack)
  const est = form.mode !== 'smoke' ? estimateScratch(form) : null;

  if (est && form.checkpointTarget === 'pvc' && form.checkpointMode !== 'create' && !form.checkpointPVC) {
    add('ckpt', 'warn', 'Checkpoints target a volume but none is set', 'Create a checkpoint volume or pick an existing PVC, or set the target to scratch (then they do not survive the pod).');
  }
  if (form.checkpointMode === 'existing' && !form.checkpointPVC) {
    add('ckpt', 'fail', 'Pick the existing checkpoint PVC', 'Or create a new volume for the run instead.');
  }
  // a checkpoint volume created for the run: dynamically provisioned from a StorageClass
  if (form.checkpointMode === 'create') {
    storageClassChecks('ckpt', 'Checkpoint volume', form.checkpointSize, form.checkpointStorageClass, form.nodes, facts,
      `${ form.releaseName || '<run>' }-checkpoints, ReadWrite${ form.nodes > 1 ? 'Many' : 'Once' }, mounted at /mnt/checkpoints ($CHECKPOINT_DIR); ${ form.checkpointKeep ? 'kept after the run (delete it by hand when done)' : 'deleted with the run' }.`).forEach((c) => add(c.id, c.severity, c.title, c.detail));
  }
  if (!form.scratchSize && form.mode !== 'smoke') {
    const needs = form.weightsSource === 'download' || form.datasetSource === 'local' || form.checkpointTarget === 'scratch';

    add('scratch', needs ? 'warn' : 'info', needs ? `No scratch volume; estimate is ${ est?.totalGiB } Gi` : 'No scratch volume',
      needs ? 'Weights, dataset cache or checkpoints would land on the node\'s image disk. Use the suggested size.' : 'Downloads written inside the container land on the node\'s image disk. Set a scratch size to get a /scratch PVC instead (SCRATCH_DIR env is set for the script).');
  } else if (form.scratchSize && Number.isNaN(parseMem(form.scratchSize))) {
    add('scratch', 'fail', 'Scratch size must be a valid quantity', 'e.g. 20Gi');
  } else if (form.scratchSize && form.scratchMedium === 'node') {
    add('scratch', 'pass', `Node-local scratch, up to ${ form.scratchSize } per pod`,
      'An emptyDir on the node\'s disk at /scratch ($SCRATCH_DIR): fast, and gone with the pod. It counts against the node\'s ephemeral storage; past the pod\'s ephemeral-storage limit the kubelet evicts the pod.');
  } else if (form.scratchSize) {
    // "Ephemeral" describes the volume's lifetime, not its implementation: scratch is a real PVC
    // that is created with the pod and deleted with it, so it needs a provisioner like any other.
    // Without a default StorageClass the PVC is never bound and the pod sits Pending indefinitely
    // with no failure — only "waiting for ephemeral volume controller to create the pvc", which is
    // not something anyone reads as "this cluster has no storage".
    const chosen = form.scratchStorageClass ? facts.storageClasses.find((c) => c.name === form.scratchStorageClass) : facts.storageClasses.find((c) => c.isDefault);

    if (!facts.storageClasses.length) {
      add('scratch', 'warn', 'No StorageClass is visible on this cluster',
        'A scratch volume is an ephemeral PVC and needs one to be provisioned from. Either this cluster has no storage configured — in which case the pod will sit Pending — or you cannot list StorageClasses. Clear the scratch size to write to the node disk instead.');
    } else if (form.scratchStorageClass && !chosen) {
      add('scratch', 'fail', `StorageClass "${ form.scratchStorageClass }" does not exist`,
        `Available: ${ facts.storageClasses.map((c) => c.name).join(', ') }.`);
    } else if (!chosen) {
      add('scratch', 'fail', 'No default StorageClass, so the scratch PVC cannot be provisioned',
        `The pod would stay Pending, not fail. Pick a storage class above, mark one of ${ facts.storageClasses.map((c) => c.name).join(', ') } default (storageclass.kubernetes.io/is-default-class), or clear the scratch size and write to the node disk.`);
    } else {
      // A provisioner can be installed and still be broken — the Harvester CSI driver crashlooping
      // against a moved API endpoint looks exactly like a healthy cluster from the StorageClass
      // list alone. Another PVC already stuck Pending is the cheap tell, and it is the one the
      // scratch volume is about to hit too.
      const stuck = facts.pvcs.filter((p) => p.phase === 'Pending').map((p) => p.name);

      if (stuck.length) {
        add('scratch', 'warn', `Storage class "${ chosen.name }" may not be provisioning`,
          `${ stuck.length } PVC(s) in this namespace are still Pending (${ stuck.join(', ') }). The scratch volume would queue behind the same provisioner (${ chosen.provisioner }). Check that its controller pods are running.`);
      } else if (est && parseMem(form.scratchSize) < est.totalGiB * 2 ** 30) {
        add('scratch', 'warn', `Scratch ${ form.scratchSize } from "${ chosen.name }" is below the ${ est.totalGiB } Gi estimate`,
          est.lines.map((l) => `${ l.label }: ${ l.gib.toFixed(1) } Gi`).join(' · '));
      } else {
        add('scratch', 'pass', `Scratch volume ${ form.scratchSize } from "${ chosen.name }"${ est ? ` covers the ${ est.totalGiB } Gi estimate` : '' }`,
          'An ephemeral PVC mounted at /scratch, created with the pod and deleted with it. $SCRATCH_DIR points at it.');
      }
    }
  }

  // 8d. workload kind. PyTorchJob needs an operator that the Indexed Job path does not.
  if (form.kind === 'pytorchjob') {
    if (!facts.pytorchOperatorInstalled) {
      add('kind', 'fail', 'Kubeflow Training Operator is not installed on this cluster',
        'PyTorchJob objects would be created but nothing would act on them. Install the Training Operator, or choose "Indexed Job" — torchrun works there with no operator.');
    } else {
      add('kind', 'pass', `PyTorchJob: 1 master + ${ Math.max(form.nodes - 1, 0) } worker(s)`,
        holdsPods(form.scheduler) ? `${ backendOf(form.scheduler).display } gang-schedules the replicas together: all of them are admitted, or none are.` : 'The training-operator injects RANK/WORLD_SIZE/MASTER_ADDR into every replica.');
    }
    if (form.scheduler === 'none' && form.nodes > 1) {
      add('kind-gang', 'warn', 'Multi-node PyTorchJob on the default scheduler',
        'Without a queueing scheduler the replicas are placed one at a time, so a partly-placed job can hold GPUs while waiting for the rest. KAI gang-schedules them instead.');
    }
  }

  // 9. mode-specific hints
  if (form.mode === 'torchrun') {
    // Rendezvous is a Job-path concern: the training-operator supplies MASTER_ADDR/MASTER_PORT.
    if (form.kind === 'job' && form.nodes > 1 && form.rendezvous === 'c10d') {
      add('rdzv', 'info', 'Rendezvous on rank 0 (c10d)', 'Fine for testing. For elastic recovery from a node loss use an external etcd rendezvous.');
    }
    if (form.kind === 'job' && form.rendezvous === 'etcd-v2' && !form.rendezvousEndpoint) {
      add('rdzv', 'fail', 'etcd rendezvous needs an endpoint (host:port)');
    }
  }
  if (form.mode !== 'smoke' && form.multusNetwork && !form.ncclSocketIfname) {
    add('nccl', 'warn', 'Secondary network attached but NCCL_SOCKET_IFNAME empty', 'NCCL may pick the pod network instead of the fabric interface. Set it to net1.');
  }
  if (form.mode === 'custom' && form.nodes > 1) {
    add('rdzv', 'info', 'Multi-node custom command', 'Your launcher must perform rendezvous itself; RDZV_ENDPOINT points at pod 0 on port 29400 and JOB_COMPLETION_INDEX is the node rank.');
  }

  // 10. fabric. An RDMA rail has no presence on the pod network, so the two switches only mean
  // anything together: devices without the host's NICs is a privileged pod that still all-reduces
  // over TCP, and it fails as "slower than expected" rather than as an error.
  if (form.rdma && !form.hostNetwork) {
    add('rdma', 'fail', 'RDMA without host network',
      'The verbs devices are mounted but the pod is on the cluster network, where the RoCE rail does not exist. Turn on Host network as well.');
  }
  if (form.rdma && !form.ncclIbHca) {
    add('rdma', 'warn', 'NCCL_IB_HCA not set',
      'NCCL will pick one device. On a dual-rail fabric that is half the bandwidth — set it to both ports, e.g. mlx5_0:1,mlx5_1:1.');
  }
  if (form.hostNetwork && form.nodes > 1) {
    add('hostnet', 'info', 'Host network: one run per node',
      'The pods answer on the nodes\' own addresses, so a second run on the same node collides on the rendezvous port.');
  }
  if (form.secretName && facts.secrets.length && !facts.secrets.includes(form.secretName)) {
    add('secret', 'fail', `Secret ${ form.secretName } not found in ${ form.namespace }`,
      'The pod stays in ContainerCreating until it exists; a Secret is mounted by name, not created by the chart.');
  }
  if (form.secretName && !form.secretMountPath) {
    add('secret', 'fail', 'Secret mount path is empty');
  }

  if (facts.fetchErrors.length) {
    add('rbac', 'warn', 'Some checks could not run', facts.fetchErrors.join('; '));
  }

  return out;
}

export function summarize(checks: Check[]) {
  const fails = checks.filter((c) => c.severity === 'fail').length;
  const warns = checks.filter((c) => c.severity === 'warn').length;

  return {
    fails, warns, ok: fails === 0
  };
}

/**
 * A Form rebuilt from a Helm values document — the reverse of the page's chartValues.
 *
 * The YAML tab was one-way on purpose: the form cannot express everything the chart takes, so
 * reading YAML back into it risked silently discarding whatever did not fit. That objection is
 * about *silence*, not about the direction, so this reports what it could not place instead of
 * dropping it. The caller shows `unmapped` and the user decides whether the loss matters.
 *
 * Anything absent from the document keeps its value in `base`, so a partial values file edits the
 * form rather than resetting it.
 */
/**
 * Split a command line into its words as a POSIX shell would: whitespace (newlines included)
 * separates words outside quotes; single quotes keep everything literally, newlines included;
 * double quotes keep everything but \" \\ \$ \`; a backslash outside quotes escapes the next
 * character; adjacent quoted and unquoted pieces make one word ('a'\''b' is a'b). The inverse of
 * joinArgs, so a command such as sh -c '<a multi-line script>' survives the form.
 */
export function splitArgs(str: string): string[] {
  const out: string[] = [];
  const s = str || '';
  let word = '';
  let inWord = false;
  let i = 0;

  while (i < s.length) {
    const c = s[i];

    if (/\s/.test(c)) {
      if (inWord) {
        out.push(word);
        word = '';
        inWord = false;
      }
      i++;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      const stop = end < 0 ? s.length : end;

      word += s.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) {
          word += s[i + 1];
          i += 2;
        } else {
          word += s[i];
          i++;
        }
      }
      inWord = true;
      i++;
    } else if (c === '\\' && i + 1 < s.length) {
      word += s[i + 1];
      inWord = true;
      i += 2;
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  if (inWord) {
    out.push(word);
  }

  return out;
}

/** Join words into one command line a shell (and splitArgs) reads back as the same words. */
export function joinArgs(parts: string[]): string {
  return (parts || []).map((p) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : `'${ p.replace(/'/g, "'\\''") }'`)).join(' ');
}

/** A shared-GPU run in a Kueue project: installed without Kueue (see chartValuesFor). */
export function kueueSkipped(f: Form): boolean {
  return f.gpuShareMiB > 0 && f.scheduler === 'kueue';
}

/**
 * The gpu-train-job values a form installs. formFromValues is its inverse, and the round-trip test
 * holds the two together. `podsReadable` switches on the chart's own headroom lookup, which needs
 * cluster-wide pod reads.
 */
export function chartValuesFor(f: Form, podsReadable: boolean): any {
  return {
    image:            { repository: f.image, tag: f.tag },
    imagePullSecrets: f.pullSecret ? [{ name: f.pullSecret }] : [],
    job:              {
      kind:                  f.kind,
      mode:                  f.mode,
      nodes:                 f.nodes,
      gpusPerNode:           f.gpusPerNode,
      script:                f.script,
      command:               f.mode === 'custom' ? splitArgs(f.command) : [],
      args:                  splitArgs(f.args),
      activeDeadlineSeconds: Math.round((Number(f.runtimeLimitHours) || 0) * 3600),
    },
    env: Object.entries(f.env || {}).filter(([k]) => k).map(([name, value]) => ({ name, value: String(value) })),
    gpu: {
      mode:            f.gpuMode,
      productName:     f.gpuProduct,
      sharedClaim:     f.gpuShareMiB > 0 && !placesGpuMemoryShares(f.scheduler) ? f.gpuSharedClaim : '', // KAI shares need no claim
      sharedMemoryMiB: f.gpuShareMiB > 0 ? f.gpuShareMiB : 0,
    },
    computeDomain: { enabled: f.computeDomain },
    // Kueue marks a workload that attaches to an existing ResourceClaim Inadmissible ("DRA resource
    // claims not supported"), so a run on a shared GPU would sit Queued forever. It goes straight to
    // the scheduler instead; the shared claim's GPU is already allocated and MPS caps its memory.
    scheduler:     {
      type: kueueSkipped(f) ? 'none' : f.scheduler, queue: kueueSkipped(f) ? '' : f.queue, priorityClassName: f.priorityClassName
    },
    rendezvous: { backend: f.rendezvous, endpoint: f.rendezvousEndpoint },
    network:    {
      multusNetwork:    f.multusNetwork,
      ncclSocketIfname: f.ncclSocketIfname,
      hostNetwork:      f.hostNetwork,
      rdma:             { enabled: f.rdma, hostLibPath: f.rdma ? f.rdmaHostLibPath : '' },
      // Only meaningful with the IB transport on, and a stale HCA list on a TCP run reads like
      // the fabric is in use when it is not.
      ncclIbHca:        f.rdma ? f.ncclIbHca : '',
      ncclIbGidIndex:   f.rdma ? f.ncclIbGidIndex : '',
    },
    resources: {
      requests: {
        cpu: f.cpuRequest, memory: f.memRequest, 'ephemeral-storage': f.ephemeralRequest
      }
    },
    storage: {
      configMap:           f.configMap,
      scratchSize:         f.scratchSize,
      scratchMedium:       f.scratchMedium,
      scratchStorageClass: f.scratchStorageClass,
      datasetPVC:          f.datasetPVC,
      // a picked PVC is an existing one unless the form says create (the Deploy page's picker sets only the PVC)
      checkpointPVC:       f.checkpointMode !== 'create' ? f.checkpointPVC : '',
      checkpointCreate:    f.checkpointMode === 'create' ? {
        enabled: true, size: f.checkpointSize, storageClass: f.checkpointStorageClass, keep: f.checkpointKeep
      } : { enabled: false },
      secretMounts: f.secretName ? [{ name: f.secretName, mountPath: f.secretMountPath }] : [],
    },
    preflight: { checkHeadroom: podsReadable },
  };
}

export function formFromValues(values: any, base: Form): { form: Form; unmapped: string[] } {
  const form: Form = { ...base };
  const unmapped: string[] = [];
  const doc = values && typeof values === 'object' ? values : {};

  // Assign only when the key is actually present: `undefined` and "the user cleared it" are
  // different, and only the second should overwrite the form.
  const set = <K extends keyof Form>(key: K, v: any, coerce: (x: any) => Form[K]) => {
    if (v !== undefined && v !== null) {
      form[key] = coerce(v);
    }
  };
  const str = (x: any) => String(x);
  const num = (x: any) => Number(x) || 0;
  // Enum fields fall back to what the form already had rather than accepting a value the rest of
  // the page would then have to defend against.
  const oneOf = <T extends string>(allowed: readonly T[], fallback: T) => (x: any): T => (allowed as readonly string[]).includes(String(x)) ? String(x) as T : fallback;

  set('image', doc.image?.repository, str);
  set('tag', doc.image?.tag, str);
  set('kind', doc.job?.kind, oneOf(['job', 'pytorchjob'] as const, base.kind));
  set('mode', doc.job?.mode, oneOf(['smoke', 'torchrun', 'custom'] as const, base.mode));
  set('nodes', doc.job?.nodes, num);
  set('gpusPerNode', doc.job?.gpusPerNode, num);
  set('script', doc.job?.script, str);
  set('runtimeLimitHours', doc.job?.activeDeadlineSeconds, (x) => (Number(x) || 0) / 3600);
  // command/args round-trip through a shell-quoted string, which is what the form holds.
  set('command', doc.job?.command, (x) => (Array.isArray(x) ? joinArgs(x.map(String)) : String(x)));
  set('args', doc.job?.args, (x) => (Array.isArray(x) ? joinArgs(x.map(String)) : String(x)));
  set('gpuMode', doc.gpu?.mode, oneOf(['auto', 'device-plugin', 'dra'] as const, base.gpuMode));
  set('gpuProduct', doc.gpu?.productName, str);
  set('gpuSharedClaim', doc.gpu?.sharedClaim, str);
  set('gpuShareMiB', doc.gpu?.sharedMemoryMiB, num);
  set('computeDomain', doc.computeDomain?.enabled, (x) => !!x);
  set('scheduler', doc.scheduler?.type, oneOf(['none', 'kueue', 'kai', 'runai'] as const, base.scheduler));
  set('queue', doc.scheduler?.queue, str);
  set('priorityClassName', doc.scheduler?.priorityClassName, str);
  set('rendezvous', doc.rendezvous?.backend, oneOf(['c10d', 'etcd-v2'] as const, base.rendezvous));
  set('rendezvousEndpoint', doc.rendezvous?.endpoint, str);
  set('multusNetwork', doc.network?.multusNetwork, str);
  set('ncclSocketIfname', doc.network?.ncclSocketIfname, str);
  set('hostNetwork', doc.network?.hostNetwork, (x) => !!x);
  set('rdma', doc.network?.rdma?.enabled, (x) => !!x);
  set('rdmaHostLibPath', doc.network?.rdma?.hostLibPath, str);
  set('ncclIbHca', doc.network?.ncclIbHca, str);
  // chartValuesFor blanks the GID index when RDMA is off; reading that back keeps the form's default
  // rather than turning it into an empty field that would have to be re-entered to enable RDMA.
  set('ncclIbGidIndex', doc.network?.ncclIbGidIndex === '' ? undefined : doc.network?.ncclIbGidIndex, str);
  set('cpuRequest', doc.resources?.requests?.cpu, str);
  set('memRequest', doc.resources?.requests?.memory, str);
  set('ephemeralRequest', doc.resources?.requests?.['ephemeral-storage'], str);
  set('configMap', doc.storage?.configMap, str);
  set('scratchSize', doc.storage?.scratchSize, str);
  set('scratchStorageClass', doc.storage?.scratchStorageClass, str);
  set('datasetPVC', doc.storage?.datasetPVC, str);
  set('checkpointPVC', doc.storage?.checkpointPVC, str);
  set('scratchMedium', doc.storage?.scratchMedium, oneOf(['volume', 'node'] as const, base.scratchMedium));
  const cc = doc.storage?.checkpointCreate;

  if (form.checkpointPVC) {
    form.checkpointMode = 'existing';
  } else if (cc?.enabled) {
    form.checkpointMode = 'create';
    form.checkpointSize = String(cc.size || base.checkpointSize);
    form.checkpointStorageClass = String(cc.storageClass || '');
    form.checkpointKeep = cc.keep !== false;
    if (cc.accessMode) {
      unmapped.push('storage.checkpointCreate.accessMode');
    }
  } else if (doc.storage && 'checkpointPVC' in doc.storage) {
    form.checkpointMode = 'none';
  }
  // The chart takes a list of secret mounts; the form holds one, so anything past the first is
  // reported rather than dropped.
  // The form holds one pull secret; more are reported, as for secret mounts.
  if (Array.isArray(doc.imagePullSecrets)) {
    const [first, ...rest] = doc.imagePullSecrets;

    form.pullSecret = String(first?.name ?? '');
    rest.forEach((s: any, i: number) => unmapped.push(`imagePullSecrets[${ i + 1 }] (${ s?.name || '?' })`));
  }

  if (Array.isArray(doc.storage?.secretMounts)) {
    const [first, ...rest] = doc.storage.secretMounts;

    form.secretName = String(first?.name ?? '');
    form.secretMountPath = String(first?.mountPath ?? base.secretMountPath);
    rest.forEach((m: any, i: number) => unmapped.push(`storage.secretMounts[${ i + 1 }] (${ m?.name || '?' })`));
  }

  if (Array.isArray(doc.env)) {
    form.env = {};
    doc.env.forEach((e: any) => {
      if (e?.name) {
        form.env[String(e.name)] = String(e.value ?? '');
      }
    });
  }

  // Everything the form has no field for. resources.limits is the common one: the chart derives
  // limits from requests, and a values file that sets them explicitly would lose them here.
  const KNOWN: Record<string, string[] | null> = {
    image:            ['repository', 'tag'],
    job:              ['kind', 'mode', 'nodes', 'gpusPerNode', 'script', 'command', 'args', 'activeDeadlineSeconds'],
    env:              null,
    gpu:              ['mode', 'productName', 'sharedClaim', 'sharedMemoryMiB'],
    computeDomain:    ['enabled'],
    scheduler:        ['type', 'queue', 'priorityClassName'],
    rendezvous:       ['backend', 'endpoint'],
    network:          ['multusNetwork', 'ncclSocketIfname', 'hostNetwork', 'rdma', 'ncclIbHca', 'ncclIbGidIndex'],
    resources:        ['requests'],
    storage:          ['configMap', 'scratchSize', 'scratchMedium', 'scratchStorageClass', 'datasetPVC', 'checkpointPVC', 'checkpointCreate', 'secretMounts'],
    preflight:        null,
    imagePullSecrets: null,
    profile:          null, // set by Deploy and the CLI, not a form field
  };

  Object.keys(doc).forEach((top) => {
    if (!(top in KNOWN)) {
      unmapped.push(top);

      return;
    }
    const keys = KNOWN[top];
    const branch = doc[top];

    if (!keys || !branch || typeof branch !== 'object' || Array.isArray(branch)) {
      return;
    }
    Object.keys(branch).forEach((k) => {
      if (!keys.includes(k)) {
        unmapped.push(`${ top }.${ k }`);
      }
    });
  });
  // network.rdma is a branch of its own, so its unknown keys need the same treatment.
  if (doc.network?.rdma && typeof doc.network.rdma === 'object') {
    Object.keys(doc.network.rdma).forEach((k) => {
      if (!['enabled', 'hostLibPath'].includes(k)) {
        unmapped.push(`network.rdma.${ k }`);
      }
    });
  }
  // requests is the only sub-branch the form reads, so its siblings have to be checked a level down.
  if (doc.resources?.requests && typeof doc.resources.requests === 'object') {
    Object.keys(doc.resources.requests).forEach((k) => {
      if (!['cpu', 'memory', 'ephemeral-storage'].includes(k)) {
        unmapped.push(`resources.requests.${ k }`);
      }
    });
  }

  return { form, unmapped };
}

// The chart's own names for the volumes it creates. Recognising them is what lets a rendered
// manifest come back as "scratch: 20Gi" rather than as an unmapped volume the form cannot show.
const SCRATCH_VOLUME = 'scratch';
const GPU_LIMIT = 'nvidia.com/gpu';

/** The container a training manifest is about, out of however many the pod has. */
function trainerContainer(pod: any): { c: any; extra: string[] } {
  const containers: any[] = Array.isArray(pod?.containers) ? pod.containers : [];
  const named = containers.find((c) => ['trainer', 'train', 'pytorch'].includes(c?.name));
  const c = named || containers[0] || {};
  const extra = containers.filter((x) => x !== c).map((x) => `containers.${ x?.name || '?' }`);

  return { c, extra };
}

/**
 * A Form rebuilt from pasted Kubernetes manifests — the reverse of the page's manifestSkeleton,
 * and of what the chart renders.
 *
 * Same contract as formFromValues: the form holds a fraction of what a PodSpec can say, so
 * everything it cannot hold comes back in `unmapped` instead of disappearing. The gap is much wider
 * here than for Helm values — affinity, initContainers, sidecars, securityContext and the rest have
 * no field at all — which is exactly why naming them matters more, not less.
 *
 * `mode` is never inferred. A rendered command is a generated shell blob; guessing "this is
 * torchrun" from it would be wrong often enough to be worse than leaving the choice where the user
 * put it, so a command that is not the smoke default just becomes mode=custom, verbatim.
 */
export function formFromManifest(docs: any[], base: Form): { form: Form; unmapped: string[] } {
  const form: Form = { ...base };
  const unmapped: string[] = [];
  const list = Array.isArray(docs) ? docs.filter((d) => d && typeof d === 'object') : [];
  const workload = list.find((d) => ['Job', 'PyTorchJob'].includes(d.kind));

  if (!workload) {
    return { form, unmapped: list.map((d) => `${ d.kind || '?' }/${ d.metadata?.name || '?' }`) };
  }
  // Anything alongside the workload — a ConfigMap of training code is the usual one — stays in the
  // YAML. It is not lost, but the form will not recreate it, so say so.
  list.filter((d) => d !== workload).forEach((d) => unmapped.push(`${ d.kind || '?' }/${ d.metadata?.name || '?' }`));

  form.kind = workload.kind === 'PyTorchJob' ? 'pytorchjob' : 'job';
  if (workload.metadata?.name) {
    form.releaseName = String(workload.metadata.name);
  }
  if (workload.metadata?.namespace) {
    form.namespace = String(workload.metadata.namespace);
  }

  let pod: any = {};
  // The pod template's metadata, not the pod spec's: the queue label a gang scheduler reads lives
  // there, and for a PyTorchJob it is nested under the replica spec rather than under spec.template.
  let podMeta: any = {};

  if (form.kind === 'pytorchjob') {
    const specs = workload.spec?.pytorchReplicaSpecs || {};
    const master = specs.Master || specs.master;
    const worker = specs.Worker || specs.worker;
    const template = (master || worker)?.template || {};

    pod = template.spec || {};
    podMeta = template.metadata || {};
    // nodes is the whole gang: the operator counts Master as rank 0.
    form.nodes = (master ? (Number(master.replicas) || 1) : 0) + (worker ? Number(worker.replicas) || 0 : 0) || form.nodes;
  } else {
    pod = workload.spec?.template?.spec || {};
    podMeta = workload.spec?.template?.metadata || {};
    form.nodes = Number(workload.spec?.completions ?? workload.spec?.parallelism) || form.nodes;
  }

  const { c, extra } = trainerContainer(pod);

  unmapped.push(...extra);

  if (typeof c.image === 'string' && c.image) {
    // Split on the last colon, but only past the last slash: a registry port is also a colon.
    const slash = c.image.lastIndexOf('/');
    const colon = c.image.lastIndexOf(':');

    if (colon > slash) {
      form.image = c.image.slice(0, colon);
      form.tag = c.image.slice(colon + 1);
    } else {
      form.image = c.image;
      form.tag = '';
    }
  }

  const limits = c.resources?.limits || {};
  const requests = c.resources?.requests || {};

  if (limits[GPU_LIMIT] !== undefined) {
    form.gpusPerNode = Number(limits[GPU_LIMIT]) || 0;
  }
  if (requests.cpu !== undefined) {
    form.cpuRequest = String(requests.cpu);
  }
  if (requests.memory !== undefined) {
    form.memRequest = String(requests.memory);
  }
  if (requests['ephemeral-storage'] !== undefined) {
    form.ephemeralRequest = String(requests['ephemeral-storage']);
  }

  if (Array.isArray(c.env)) {
    form.env = {};
    c.env.forEach((e: any) => {
      if (!e?.name) {
        return;
      }
      // valueFrom (secretKeyRef, fieldRef) has no representation in a key/value editor, and
      // flattening it to a literal would invent a value. Leave it named instead.
      if (e.valueFrom !== undefined) {
        unmapped.push(`env.${ e.name } (valueFrom)`);

        return;
      }
      form.env[String(e.name)] = String(e.value ?? '');
    });
  }

  // Scheduling. The manifest says it two different ways depending on the scheduler, and neither is
  // a field named "scheduler".
  const jobLabels = workload.metadata?.labels || {};
  const podLabels = podMeta?.labels || {};

  // Both gang schedulers are recognised by their schedulerName, then by their own queue label.
  // Run:AI's label is the bare word `project`, which is generic enough to appear on a pod for
  // unrelated reasons, so it is only read once runai-scheduler has already identified the pod.
  const queueSched = backendForSchedulerName(pod.schedulerName);

  if (queueSched && podQueueLabel(queueSched)) {
    const queueLabel = podQueueLabel(queueSched);

    form.scheduler = queueSched;
    form.queue = String(podLabels[queueLabel] || jobLabels[queueLabel] || '');
  } else if (jobLabels[workloadQueueLabel('kueue')]) {
    form.scheduler = 'kueue';
    form.queue = String(jobLabels[workloadQueueLabel('kueue')]);
  } else if (pod.schedulerName && pod.schedulerName !== 'default-scheduler') {
    unmapped.push(`schedulerName=${ pod.schedulerName }`);
  }
  if (pod.priorityClassName) {
    form.priorityClassName = String(pod.priorityClassName);
  }

  // Volumes, by the names and mount paths the chart uses. Anything else is a volume the form has
  // no picker for.
  const volumes: any[] = Array.isArray(pod.volumes) ? pod.volumes : [];
  const mounts: any[] = Array.isArray(c.volumeMounts) ? c.volumeMounts : [];
  const mountPathOf = (name: string) => mounts.find((m) => m?.name === name)?.mountPath || '';

  form.scratchSize = '';
  form.scratchStorageClass = '';
  form.datasetPVC = '';
  form.checkpointPVC = '';
  volumes.forEach((v: any) => {
    const claim = v?.ephemeral?.volumeClaimTemplate?.spec;

    if (claim && v.name === SCRATCH_VOLUME) {
      form.scratchSize = String(claim.resources?.requests?.storage || '');
      form.scratchStorageClass = String(claim.storageClassName || '');

      return;
    }
    if (v?.persistentVolumeClaim?.claimName) {
      const path = mountPathOf(v.name);

      if (path === '/mnt/dataset') {
        form.datasetPVC = String(v.persistentVolumeClaim.claimName);
      } else if (path === '/mnt/checkpoints') {
        form.checkpointPVC = String(v.persistentVolumeClaim.claimName);
      } else {
        unmapped.push(`volume ${ v.name } (PVC at ${ path || 'unmounted' })`);
      }

      return;
    }
    if (v?.configMap?.name) {
      if (mountPathOf(v.name) === '/mnt/config') {
        form.configMap = String(v.configMap.name);
      } else {
        unmapped.push(`volume ${ v.name } (ConfigMap)`);
      }

      return;
    }
    // dshm is the chart's own /dev/shm emptyDir and is recreated automatically, so it is not a loss.
    if (v?.emptyDir && v.name === 'dshm') {
      return;
    }
    unmapped.push(`volume ${ v?.name || '?' }`);
  });

  // Command. The skeleton's smoke command is the one shape that maps to a mode; everything else is
  // taken literally rather than guessed at.
  const cmd: string[] = Array.isArray(c.command) ? c.command.map(String) : [];
  const cargs: string[] = Array.isArray(c.args) ? c.args.map(String) : [];

  if (cmd.length === 3 && cmd[0] === 'bash' && cmd[2] === 'nvidia-smi') {
    form.mode = 'smoke';
  } else if (cmd.length) {
    form.mode = 'custom';
    form.command = joinArgs(cmd);
    form.args = joinArgs(cargs);
  }

  // Pod-level settings with no field at all. Listed rather than silently discarded, because a
  // manifest that carries them was probably written for a reason.
  const POD_UNSUPPORTED = ['initContainers', 'affinity', 'nodeSelector', 'securityContext',
    'serviceAccountName', 'imagePullSecrets', 'topologySpreadConstraints', 'runtimeClassName'];

  form.hostNetwork = !!pod.hostNetwork;

  // Tolerations are handled separately: the chart always emits the nvidia.com/gpu one and re-emits
  // it on the way back out, so reporting it would put a permanent false entry on every rendered
  // manifest. Only a toleration the form would not reproduce is a real loss.
  const extraTolerations = (Array.isArray(pod.tolerations) ? pod.tolerations : [])
    .filter((t: any) => t?.key !== GPU_LIMIT);

  if (extraTolerations.length) {
    unmapped.push(`tolerations (${ extraTolerations.map((t: any) => t?.key || '*').join(', ') })`);
  }

  POD_UNSUPPORTED.forEach((k) => {
    const v = pod[k];

    // Present but empty is the same as absent: `hostNetwork: false` and `imagePullSecrets: []` are
    // what a manifest looks like when it is not using the feature, and naming them would put a
    // permanent list of non-losses in front of the user.
    const empty = v === undefined || v === null || v === false ||
      (Array.isArray(v) && !v.length) ||
      (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);

    if (!empty) {
      unmapped.push(k);
    }
  });

  return { form, unmapped };
}

/**
 * Checks that read the cluster as it is right now, not the job: free CPU/memory on GPU nodes, GPUs
 * already taken, total GPUs, disk pressure. None of them says the job is wrong.
 */
export const POINT_IN_TIME_CHECKS = ['headroom', 'gpu-in-use', 'capacity', 'disk', 'ephemeral-free'];

/**
 * The pre-flight as a context should present it.
 * - Profile authoring: a profile is deployed later, into the user's project, when the cluster looks
 *   different, so point-in-time checks are information ("Right now: ..."), not problems.
 * - Deploying under a queueing scheduler (Kueue, KAI, Run:AI): no room right now means the run
 *   waits in its queue, so a point-in-time failure is a warning that it will wait.
 */
export function checksFor(checks: Check[], ctx: { profile: boolean; scheduler: SchedulerType }): Check[] {
  const queued = !!backendOf(ctx.scheduler).queue;

  return checks.map((c) => {
    if (!POINT_IN_TIME_CHECKS.includes(c.id) || c.severity === 'pass' || c.severity === 'info') {
      return c;
    }
    if (ctx.profile) {
      return {
        ...c, severity: 'info', title: `Right now: ${ c.title.charAt(0).toLowerCase() }${ c.title.slice(1) }`, detail: `${ c.detail ? `${ c.detail } ` : '' }This reflects the cluster at the moment and is checked again when the profile is deployed.`
      };
    }
    if (queued && c.severity === 'fail') {
      return {
        ...c, severity: 'warn', title: `${ c.title } — the run will wait in its queue`, detail: `${ c.detail ? `${ c.detail } ` : '' }With a queueing scheduler the run is admitted and starts when there is room.`
      };
    }

    return c;
  });
}

/** Checks for a volume dynamically provisioned from a StorageClass (a created checkpoint volume). */
export function storageClassChecks(id: string, label: string, size: string, className: string, nodes: number, facts: Facts, describe: string): Check[] {
  const out: Check[] = [];
  const add = (severity: Check['severity'], title: string, detail = '') => out.push({
    id, severity, title, detail
  });

  if (!size || Number.isNaN(parseMem(size))) {
    add('fail', `${ label } size must be a valid quantity`, 'e.g. 20Gi');

    return out;
  }
  const chosen = className ? facts.storageClasses.find((c) => c.name === className) : facts.storageClasses.find((c) => c.isDefault);

  if (!facts.storageClasses.length) {
    add('warn', 'No StorageClass is visible on this cluster', `${ label }: a dynamically provisioned volume needs one; the PVC would stay Pending. Or your account cannot list StorageClasses.`);

    return out;
  }
  if (className && !chosen) {
    add('fail', `StorageClass "${ className }" does not exist`, `Available: ${ facts.storageClasses.map((c) => c.name).join(', ') }.`);

    return out;
  }
  if (!chosen) {
    add('fail', `No default StorageClass for the ${ label.toLowerCase() }`, `Pick one of ${ facts.storageClasses.map((c) => c.name).join(', ') }.`);

    return out;
  }
  // ReadWriteMany for a multi-node run: node-local and block provisioners cannot provide it
  if (nodes > 1 && /local-path|hostpath|ebs\.csi|rbd\.csi|topolvm/i.test(chosen.provisioner)) {
    add('fail', `"${ chosen.name }" cannot be mounted by ${ nodes } pods at once`, `A multi-node run writes from every rank, so the volume is ReadWriteMany; ${ chosen.provisioner } provides ReadWriteOnce only. Use a shared class (Longhorn, CephFS, NFS, VAST) or one node.`);

    return out;
  }
  const wait = chosen.bindingMode === 'WaitForFirstConsumer' ? ' The class waits for the pod to be scheduled before provisioning (WaitForFirstConsumer), so the volume lands where the pod runs.' : '';

  add('pass', `${ label }: new ${ size } from "${ chosen.name }"`, `${ describe }${ wait }`);

  return out;
}
