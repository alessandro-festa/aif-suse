import { describe, expect, it } from 'vitest';
// The YAML tab reads back into the form. The form cannot hold everything the chart accepts, so the
// contract these pin is not "nothing is lost" — it is "nothing is lost silently": every value that
// has no field comes back in `unmapped`, and everything else survives a round trip unchanged.

import {
  automaticPlacementChecks, chartValuesFor, checksFor, DEFAULT_FORM, Facts, Form, formFromManifest, formFromValues, isTorchlessImage, joinArgs, runPreflight, splitArgs
} from '../preflight';

// A cluster where nothing is installed and nothing is wrong, so a test can turn on exactly the one
// fact it is about and read the check it expects out of the noise.
const BASE_FACTS: Facts = {
  loaded:                   true,
  namespaces:               ['default'],
  kueueInstalled:           false,
  kaiInstalled:             false,
  runaiInstalled:           false,
  runaiProjectNamespaces:   [],
  localQueues:              [],
  clusterQueues:            [],
  kaiQueues:                [],
  devicePluginGpus:         8,
  draDevices:               0,
  gpuDeviceMemory:          0,
  gpuTypes:                 [],
  gfdLabels:                false,
  sharedGpus:               [],
  draAllocated:             0,
  draAllocatedBy:           [],
  claimsClusterWide:        false,
  draClassExists:           false,
  gpuReadable:              true,
  computeDomainAvailable:   false,
  gpuNodes:                 [],
  podsReadable:             true,
  existingJobs:             [],
  configMaps:               [],
  secrets:                  [],
  pvcs:                     [],
  storageClasses:           [],
  pytorchOperatorInstalled: true,
  jobApi:                   true,
  chart:                    null,
  fetchErrors:              [],
  queueIndex:               {},
  capacity:                 {
    total: {
      gpu: 8, cpu: 64, memory: 0
    },
    free: {
      gpu: 8, cpu: 64, memory: 0
    }
  },
  namespaceQueue: null,
};

function facts(over: Partial<Facts>): Facts {
  return { ...BASE_FACTS, ...over };
}

function checkIds(form: Form, f: Facts): string[] {
  return runPreflight(form, f).filter((c) => c.severity === 'fail').map((c) => c.id);
}

// The page installs chartValuesFor(form). formFromValues is its inverse, and the round-trip test
// below is what holds the two together.
function chartValues(f: Form): any {
  return chartValuesFor(f, true);
}

describe('reading Helm values back into the form', () => {
  const filled: Form = {
    ...DEFAULT_FORM,
    namespace:           'ai-t400',
    releaseName:         'qwen-lora',
    image:               'pytorch/pytorch',
    tag:                 '2.5.1-cuda12.1-cudnn9-runtime',
    kind:                'pytorchjob',
    mode:                'custom',
    nodes:               3,
    gpusPerNode:         2,
    gpuMode:             'dra',
    scheduler:           'kai',
    queue:               'team-a',
    priorityClassName:   'high',
    rendezvous:          'etcd-v2',
    rendezvousEndpoint:  'etcd:2379',
    multusNetwork:       'nccl-macvlan',
    ncclSocketIfname:    'net1',
    script:              'print(1)',
    cpuRequest:          '2',
    memRequest:          '8Gi',
    command:             'python /mnt/config/train.py',
    args:                '--epochs 3',
    configMap:           'train-code',
    env:                 { HF_HOME: '/scratch/hf', MAX_STEPS: '60' },
    computeDomain:       true,
    ephemeralRequest:    '20Gi',
    scratchSize:         '20Gi',
    scratchStorageClass: 'lvm-thin',
    datasetPVC:          'dolly',
    checkpointPVC:       'ckpt',
    checkpointMode:      'existing',
    hostNetwork:         true,
    rdma:                true,
    ncclIbHca:           'mlx5_0:1,mlx5_1:1',
    ncclIbGidIndex:      '3',
    rdmaHostLibPath:     '/usr/lib/aarch64-linux-gnu',
    secretName:          's3cfg',
    secretMountPath:     '/secrets',
    runtimeLimitHours:   8,
    gpuProduct:          'NVIDIA RTX A2000 12GB',
    pullSecret:          'suse-ai-pull-combined',
  };

  it('round-trips every field the form can express', () => {
    const { form, unmapped } = formFromValues(chartValues(filled), DEFAULT_FORM);

    expect(unmapped).toEqual([]);
    // namespace and releaseName are not chart values — they are install arguments — so they stay
    // whatever the base form had rather than being invented from the YAML.
    expect(form).toEqual({
      ...filled, namespace: '', releaseName: ''
    });
  });

  it('keeps fields the document does not mention', () => {
    const { form } = formFromValues({ job: { nodes: 4 } }, filled);

    expect(form.nodes).toBe(4);
    expect(form.image).toBe('pytorch/pytorch');
    expect(form.scratchSize).toBe('20Gi');
  });

  it('names values that have no field instead of dropping them', () => {
    const { unmapped } = formFromValues({
      resources:   { requests: { cpu: '2', 'nvidia.com/gpu': '1' }, limits: { memory: '16Gi' } },
      storage:     { scratchSize: '10Gi', nfsServer: '10.0.0.1' },
      tolerations: [{ key: 'a' }],
    }, DEFAULT_FORM);

    expect(unmapped).toContain('resources.limits');
    expect(unmapped).toContain('resources.requests.nvidia.com/gpu');
    expect(unmapped).toContain('storage.nfsServer');
    expect(unmapped).toContain('tolerations');
    expect(unmapped).toHaveLength(4);
  });

  // The form holds one Secret mount; the chart takes a list. Reading back a two-entry list must say
  // so rather than installing with the second one silently gone.
  it('names the extra Secret mounts it cannot hold', () => {
    const { form, unmapped } = formFromValues({
      storage: {
        secretMounts: [
          { name: 's3cfg', mountPath: '/secrets' },
          { name: 'hf-token', mountPath: '/hf' },
        ]
      }
    }, DEFAULT_FORM);

    expect(form.secretName).toBe('s3cfg');
    expect(form.secretMountPath).toBe('/secrets');
    expect(unmapped).toContain('storage.secretMounts[1] (hf-token)');
  });

  it('refuses an enum value the rest of the page would have to defend against', () => {
    const { form } = formFromValues({ job: { kind: 'DaemonSet', mode: 'wat' }, scheduler: { type: 'slurm' } }, DEFAULT_FORM);

    expect(form.kind).toBe(DEFAULT_FORM.kind);
    expect(form.mode).toBe(DEFAULT_FORM.mode);
    expect(form.scheduler).toBe(DEFAULT_FORM.scheduler);
  });

  it('survives a document that is not a mapping at all', () => {
    expect(formFromValues(null, DEFAULT_FORM).form).toEqual(DEFAULT_FORM);
    expect(formFromValues('nope', DEFAULT_FORM).form).toEqual(DEFAULT_FORM);
  });
});

describe('formFromManifest', () => {
  // The manifest tab's own skeleton, the one document every user of this feature starts from. If
  // reading back the thing the page just wrote does not reproduce the form, nothing else will.
  // Typed, because the scheduler test adds a queue key to these: an inferred object literal type
  // has exactly the one key and rejects the second.
  const labels = (): Record<string, string> => ({ 'app.kubernetes.io/part-of': 'gpu-train-job' });
  const skeleton = (over: any = {}) => ({
    apiVersion: 'batch/v1',
    kind:       'Job',
    metadata:   {
      name: 'train-example', namespace: 'ai-demo', labels: labels()
    },
    spec: {
      backoffLimit: 0,
      template:     {
        metadata: { labels: labels() },
        spec:     {
          restartPolicy: 'Never',
          containers:    [{
            name:      'train',
            image:     'nvidia/cuda:12.5.0-runtime-ubuntu22.04',
            command:   ['bash', '-lc', 'nvidia-smi'],
            resources: { limits: { 'nvidia.com/gpu': '2' } },
          }],
          ...over,
        },
      },
    },
  });

  it('reads the page\'s own skeleton back into the fields that produced it', () => {
    const { form, unmapped } = formFromManifest([skeleton()], DEFAULT_FORM);

    expect(form.kind).toBe('job');
    expect(form.releaseName).toBe('train-example');
    expect(form.namespace).toBe('ai-demo');
    expect(form.image).toBe('nvidia/cuda');
    expect(form.tag).toBe('12.5.0-runtime-ubuntu22.04');
    expect(form.gpusPerNode).toBe(2);
    expect(form.mode).toBe('smoke');
    expect(unmapped).toHaveLength(0);
  });

  it('keeps the tag when the registry has a port', () => {
    const doc = skeleton();

    doc.spec.template.spec.containers[0].image = 'registry.example.com:5000/team/torch:2.5.1';
    const { form } = formFromManifest([doc], DEFAULT_FORM);

    expect(form.image).toBe('registry.example.com:5000/team/torch');
    expect(form.tag).toBe('2.5.1');
  });

  it('counts a PyTorchJob gang as Master plus Workers', () => {
    const spec = (replicas: number) => ({
      replicas,
      template: {
        spec: {
          containers: [{
            name: 'pytorch', image: 'a/b:1', resources: { limits: { 'nvidia.com/gpu': 4 } }
          }]
        }
      },
    });
    const { form } = formFromManifest([{
      kind:     'PyTorchJob',
      metadata: { name: 'llama', namespace: 'ai' },
      spec:     { pytorchReplicaSpecs: { Master: spec(1), Worker: spec(3) } },
    }], DEFAULT_FORM);

    expect(form.kind).toBe('pytorchjob');
    expect(form.nodes).toBe(4);
    expect(form.gpusPerNode).toBe(4);
  });

  // A PyTorchJob keeps its pod template two levels deeper than a Job does, and the queue label is
  // on that template's metadata. Reading labels off the pod *spec* instead found nothing, so every
  // rendered PyTorchJob -- including the ones a Workloads row's YAML hands you to copy -- came back with the
  // scheduler set and the queue blank, which pre-flight then refuses.
  it('reads the queue label off a PyTorchJob replica template, not the pod spec', () => {
    const replica = (replicas: number) => ({
      replicas,
      template: {
        metadata: { labels: { project: 'training' } },
        spec:     {
          schedulerName: 'runai-scheduler',
          containers:    [{ name: 'pytorch', image: 'a/b:1' }],
        },
      },
    });
    const { form } = formFromManifest([{
      kind:     'PyTorchJob',
      metadata: { name: 'ddp', namespace: 'runai-training' },
      spec:     { pytorchReplicaSpecs: { Master: replica(1), Worker: replica(2) } },
    }], DEFAULT_FORM);

    expect(form.scheduler).toBe('runai');
    expect(form.queue).toBe('training');
  });

  it('finds the scheduler, which the manifest spells two different ways', () => {
    const kai = skeleton({ schedulerName: 'kai-scheduler' });

    kai.spec.template.metadata.labels['kai.scheduler/queue'] = 'team-a';
    const fromKai = formFromManifest([kai], DEFAULT_FORM).form;

    expect(fromKai.scheduler).toBe('kai');
    expect(fromKai.queue).toBe('team-a');

    const kueue = skeleton();

    kueue.metadata.labels['kueue.x-k8s.io/queue-name'] = 'team-b';
    const fromKueue = formFromManifest([kueue], DEFAULT_FORM).form;

    expect(fromKueue.scheduler).toBe('kueue');
    expect(fromKueue.queue).toBe('team-b');
  });

  // Run:AI names its queue label `project`, which is a word anyone might label a pod with. Reading
  // it off a pod that is not Run:AI's would put a made-up queue in the form and, on submit, a
  // schedulerName the cluster has no scheduler for.
  it('reads the Run:AI queue only from a pod the Run:AI scheduler owns', () => {
    const runai = skeleton({ schedulerName: 'runai-scheduler' });

    runai.spec.template.metadata.labels.project = 'training';
    const fromRunai = formFromManifest([runai], DEFAULT_FORM).form;

    expect(fromRunai.scheduler).toBe('runai');
    expect(fromRunai.queue).toBe('training');

    const plain = skeleton();

    plain.spec.template.metadata.labels.project = 'not-a-queue';
    const fromPlain = formFromManifest([plain], DEFAULT_FORM).form;

    expect(fromPlain.scheduler).toBe('none');
    expect(fromPlain.queue).toBe('');
  });

  it('round-trips scheduler.type=runai through chart values', () => {
    const f: Form = {
      ...DEFAULT_FORM, scheduler: 'runai', queue: 'training'
    };
    const back = formFromValues(chartValues(f), DEFAULT_FORM).form;

    expect(back.scheduler).toBe('runai');
    expect(back.queue).toBe('training');
  });

  it('separates the scratch PVC from the volumes the form has no picker for', () => {
    const doc = skeleton({
      volumes: [
        { name: 'scratch', ephemeral: { volumeClaimTemplate: { spec: { storageClassName: 'lvm-thin', resources: { requests: { storage: '20Gi' } } } } } },
        { name: 'dshm', emptyDir: { medium: 'Memory' } },
        { name: 'data', persistentVolumeClaim: { claimName: 'imagenet' } },
        { name: 'code', configMap: { name: 'train-py' } },
        { name: 'host', hostPath: { path: '/var/log' } },
      ],
    });

    doc.spec.template.spec.containers[0].volumeMounts = [
      { name: 'data', mountPath: '/mnt/dataset' },
      { name: 'code', mountPath: '/mnt/config' },
      { name: 'host', mountPath: '/var/log' },
    ];
    const { form, unmapped } = formFromManifest([doc], DEFAULT_FORM);

    expect(form.scratchSize).toBe('20Gi');
    expect(form.scratchStorageClass).toBe('lvm-thin');
    expect(form.datasetPVC).toBe('imagenet');
    expect(form.configMap).toBe('train-py');
    // dshm is the chart's own and comes back on its own; hostPath is a real loss.
    expect(unmapped).toEqual(['volume host']);
  });

  it('names a secret-backed env var rather than inventing a literal for it', () => {
    const doc = skeleton();

    doc.spec.template.spec.containers[0].env = [
      { name: 'HF_HOME', value: '/scratch/hf' },
      { name: 'HF_TOKEN', valueFrom: { secretKeyRef: { name: 'hf', key: 'token' } } },
    ];
    const { form, unmapped } = formFromManifest([doc], DEFAULT_FORM);

    expect(form.env).toEqual({ HF_HOME: '/scratch/hf' });
    expect(unmapped).toContain('env.HF_TOKEN (valueFrom)');
  });

  it('reports pod settings the form cannot reproduce, but not the GPU toleration it always writes', () => {
    const doc = skeleton({
      nodeSelector:       { 'nvidia.com/gpu.product': 'H100' },
      serviceAccountName: 'trainer',
      hostNetwork:        false,
      imagePullSecrets:   [],
      tolerations:        [{ key: 'nvidia.com/gpu' }, { key: 'dedicated' }],
    });
    const { unmapped } = formFromManifest([doc], DEFAULT_FORM);

    expect(unmapped).toContain('nodeSelector');
    expect(unmapped).toContain('serviceAccountName');
    expect(unmapped).toContain('tolerations (dedicated)');
    // hostNetwork: false and an empty imagePullSecrets say nothing; reporting them is noise.
    expect(unmapped).not.toContain('hostNetwork');
    expect(unmapped).not.toContain('imagePullSecrets');
  });

  it('leaves the form alone when there is no workload to read', () => {
    const { form, unmapped } = formFromManifest([
      { kind: 'ConfigMap', metadata: { name: 'train-py' } },
      { kind: 'Service', metadata: { name: 'headless' } },
    ], DEFAULT_FORM);

    expect(form).toEqual(DEFAULT_FORM);
    expect(unmapped).toEqual(['ConfigMap/train-py', 'Service/headless']);
  });

  it('survives an empty or junk document list', () => {
    expect(formFromManifest([], DEFAULT_FORM).form).toEqual(DEFAULT_FORM);
    expect(formFromManifest([null, 'nope'] as any, DEFAULT_FORM).form).toEqual(DEFAULT_FORM);
  });
});

// The default form is torchrun on a PyTorch image. That pairing is load-bearing: the chart execs
// torchrun with no install step, so a torchless image exits 127 and reads as a failed training run.
describe('torchless images', () => {
  it('flags the base images that have no torch, and leaves unknown ones alone', () => {
    expect(isTorchlessImage('nvidia/cuda')).toBe(true);
    expect(isTorchlessImage('nvcr.io/nvidia/cuda')).toBe(true);
    expect(isTorchlessImage('registry.suse.com/bci/bci-base')).toBe(true);
    expect(isTorchlessImage('docker.io/ubuntu')).toBe(true); // registry prefix stripped
    expect(isTorchlessImage('NVIDIA/CUDA')).toBe(true); // repositories are case-insensitive here

    // deny-list, not allow-list: anything we are not sure about must pass
    expect(isTorchlessImage('nvcr.io/nvidia/pytorch')).toBe(false);
    expect(isTorchlessImage('pytorch/pytorch')).toBe(false);
    expect(isTorchlessImage('registry.example.com/team/our-trainer')).toBe(false);
    expect(isTorchlessImage('')).toBe(false);
  });

  it('defaults to torchrun on an image that actually has it', () => {
    expect(DEFAULT_FORM.mode).toBe('torchrun');
    expect(isTorchlessImage(DEFAULT_FORM.image)).toBe(false);
  });
});

// A Run:AI namespace is provisioned by a Project, not by a label. Getting the label right and the
// Project wrong produces a pod that schedules onto a node and then fails to bind, because the
// scheduler has no RoleBinding to create a BindRequest in that namespace — so the failure surfaces
// as a Run:AI internal RBAC error rather than anything about the namespace. Catch it before submit.
describe('run.ai project ownership of the namespace', () => {
  const form: Form = {
    ...DEFAULT_FORM, scheduler: 'runai', queue: 'training', namespace: 'ai-altra'
  };
  const runaiCluster = {
    kaiInstalled: true, runaiInstalled: true, namespaceQueue: 'training'
  };

  it('fails a hand-labelled namespace that no Project claims', () => {
    const f = facts({ ...runaiCluster, runaiProjectNamespaces: ['runai-training'] });
    const check = runPreflight(form, f).find((c) => c.id === 'runai-project');

    expect(check?.severity).toBe('fail');
    // the fix has to be actionable, so the namespaces that would work are named
    expect(check?.detail).toContain('runai-training');
  });

  it('passes a namespace a Project owns', () => {
    const f = facts({ ...runaiCluster, runaiProjectNamespaces: ['runai-training', 'ai-altra'] });

    expect(checkIds(form, f)).not.toContain('runai-project');
  });

  // Listing Projects needs RBAC most submitters do not have. Unreadable must mean "no opinion",
  // never "fail", or the check blocks the people it was written to help.
  it('skips when the Projects could not be read', () => {
    expect(checkIds(form, facts({ ...runaiCluster, runaiProjectNamespaces: [] }))).not.toContain('runai-project');
  });

  // KAI has no Projects at all, so the same namespace must not be flagged there.
  it('does not apply to KAI', () => {
    const f = facts({
      kaiInstalled: true, namespaceQueue: 'training', runaiProjectNamespaces: ['runai-training']
    });

    expect(checkIds({ ...form, scheduler: 'kai' }, f)).not.toContain('runai-project');
  });
});

// An RDMA rail exists only on the host's NICs. Half-configured, the run still completes — over TCP,
// at a fraction of the bandwidth — so nothing about the result says the fabric was never used. These
// checks are the only place that says it.
describe('RDMA fabric', () => {
  const rdmaForm: Form = {
    ...DEFAULT_FORM, rdma: true, hostNetwork: true, ncclIbHca: 'mlx5_0:1,mlx5_1:1'
  };

  it('blocks verbs devices on the pod network', () => {
    expect(checkIds({ ...rdmaForm, hostNetwork: false }, facts({}))).toContain('rdma');
  });

  it('warns when NCCL is left to pick a device on a dual-rail fabric', () => {
    const check = runPreflight({ ...rdmaForm, ncclIbHca: '' }, facts({})).find((c) => c.id === 'rdma');

    expect(check?.severity).toBe('warn');
  });

  it('says nothing when both switches agree', () => {
    expect(runPreflight(rdmaForm, facts({})).filter((c) => c.id === 'rdma')).toEqual([]);
  });

  // Host network is legal on its own — the port collision is worth knowing about, not blocking.
  it('notes that host network means one run per node', () => {
    const check = runPreflight({
      ...DEFAULT_FORM, hostNetwork: true, nodes: 3
    }, facts({})).find((c) => c.id === 'hostnet');

    expect(check?.severity).toBe('info');
    expect(checkIds({
      ...DEFAULT_FORM, hostNetwork: true, nodes: 3
    }, facts({}))).not.toContain('hostnet');
  });
});

// A Secret is mounted by name and never created by the chart, so a typo is not an error at install
// time: the pod sits in ContainerCreating until someone reads the events.
describe('mounted Secrets', () => {
  const withSecret: Form = {
    ...DEFAULT_FORM, namespace: 'default', secretName: 's3cfg'
  };

  it('fails a Secret the namespace does not have', () => {
    expect(checkIds(withSecret, facts({ secrets: ['hf-token'] }))).toContain('secret');
  });

  it('passes one it does', () => {
    expect(checkIds(withSecret, facts({ secrets: ['hf-token', 's3cfg'] }))).not.toContain('secret');
  });

  // Unreadable Secrets are the common case for a submitter with namespace-scoped rights; an empty
  // list means "could not look", so it must not be read as "not there".
  it('skips the existence check when no Secrets could be listed', () => {
    expect(checkIds(withSecret, facts({ secrets: [] }))).not.toContain('secret');
  });

  it('fails an empty mount path, which would mount over the container root', () => {
    expect(checkIds({ ...withSecret, secretMountPath: '' }, facts({ secrets: ['s3cfg'] }))).toContain('secret');
  });
});

// Kueue counts only GPUs taken through its own queues. A claim held by anything else (a notebook, a
// job submitted without a queue) is invisible to admission, so the job is admitted and then sits
// Pending on "cannot allocate all claims". The pre-flight reads the claims directly.
describe('GPUs already allocated through DRA', () => {
  const draForm: Form = {
    ...DEFAULT_FORM, gpuMode: 'dra', nodes: 1, gpusPerNode: 2
  };
  const draFacts = (over: Partial<Facts>) => facts({
    draClassExists: true, draDevices: 4, ...over
  });
  const inUse = (form: Form, f: Facts) => runPreflight(form, f).find((c) => c.id === 'gpu-in-use');

  it('says nothing when no claim holds a GPU', () => {
    expect(inUse(draForm, draFacts({}))).toBeUndefined();
  });

  it('notes the allocation when enough GPUs are still free', () => {
    const c = inUse(draForm, draFacts({ draAllocated: 2, draAllocatedBy: ['team-a'] }));

    expect(c?.severity).toBe('info');
    expect(c?.title).toContain('team-a');
  });

  it('fails without a scheduler when the free GPUs are too few', () => {
    expect(inUse({ ...draForm, scheduler: 'none' }, draFacts({ draAllocated: 3, draAllocatedBy: ['team-a'] }))?.severity).toBe('fail');
  });

  it('only warns under Kueue, which may still admit it', () => {
    const c = inUse({ ...draForm, scheduler: 'kueue' }, draFacts({ draAllocated: 3, draAllocatedBy: ['team-a'] }));

    expect(c?.severity).toBe('warn');
    expect(c?.detail).toContain('Kueue');
  });

  it('calls the count a lower bound when claims could not be listed cluster-wide', () => {
    expect(inUse(draForm, draFacts({ draAllocated: 1, claimsClusterWide: false }))?.title).toMatch(/^At least/);
    expect(inUse(draForm, draFacts({ draAllocated: 1, claimsClusterWide: true }))?.title).toMatch(/^1 of 4/);
  });

  it('does not apply in device-plugin mode', () => {
    expect(inUse({ ...draForm, gpuMode: 'device-plugin' }, draFacts({ draAllocated: 4 }))).toBeUndefined();
  });
});

// A user without cluster-wide GPU reads sees an empty node and DeviceClass list. That is "cannot see",
// not "there are none", and the fix is a role, not the GPU Operator.
describe('GPU inventory the user cannot read', () => {
  const gpu = (f: Facts) => runPreflight({
    ...DEFAULT_FORM, namespace: 'default', releaseName: 'r'
  }, f).find((c) => c.id === 'gpu');

  it('names the missing role instead of blaming the GPU Operator', () => {
    const c = gpu(facts({ gpuReadable: false, devicePluginGpus: 0 }));

    expect(c?.severity).toBe('fail');
    expect(c?.title).toMatch(/Cannot see/);
    expect(c?.detail).toContain('AI Scheduler Cluster Read');
  });

  it('still says no GPUs when the user can read and there are none', () => {
    expect(gpu(facts({ gpuReadable: true, devicePluginGpus: 0 }))?.title).toBe('No GPUs visible');
  });
});

// SUSE Application Collection and registry.suse.com need credentials. A pod that has none sits in
// ImagePullBackOff, which reads like a cluster problem; the pre-flight says it before submit.
describe('image pull credentials', () => {
  const pull = (form: Partial<Form>, f: Partial<Facts> = {}) => runPreflight({
    ...DEFAULT_FORM, namespace: 'team-a', releaseName: 'r', ...form
  }, facts(f)).find((c) => c.id === 'image-pull');

  it('says nothing about credentials for a public SUSE image (BCI), but does for SUSE AI\'s registry path', () => {
    expect(pull({ image: 'registry.suse.com/bci/bci-base', tag: '15.7' })).toBeUndefined();
    expect(pull({ image: 'registry.suse.com/ai/containers/litellm', tag: '1' })?.severity).toBe('info');
  });

  it('notes that an Application Collection image relies on the default ServiceAccount when no secret is set', () => {
    const c = pull({ image: 'dp.apps.rancher.io/containers/pytorch', tag: '2.14.0-nvidia-2.1' });

    expect(c?.severity).toBe('info');
    expect(c?.detail).toContain('suse-ai-pull-combined');
  });

  it('says nothing for public registries', () => {
    expect(pull({ image: 'pytorch/pytorch', tag: 'x' })).toBeUndefined();
  });

  it('fails a named secret the namespace does not have, and passes one it has', () => {
    expect(pull({
      image: 'dp.apps.rancher.io/containers/pytorch', tag: 'x', pullSecret: 'appco'
    }, { secrets: ['other'] })?.severity).toBe('fail');
    expect(pull({
      image: 'dp.apps.rancher.io/containers/pytorch', tag: 'x', pullSecret: 'appco'
    }, { secrets: ['appco'] })?.severity).toBe('pass');
  });

  it('cannot tell when Secrets are not listable, and does not fail', () => {
    expect(pull({
      image: 'dp.apps.rancher.io/containers/pytorch', tag: 'x', pullSecret: 'appco'
    }, { secrets: [] })?.severity).toBe('pass');
  });
});

describe('pre-flight in context', () => {
  // A profile is deployed later and elsewhere; a queued run waits rather than fails.
  const headroom = {
    id: 'headroom', severity: 'fail' as const, title: 'No GPU node has enough free CPU/memory for this pod', detail: 'Most headroom: gpu-node-1 has 0.04 CPU.'
  };
  const config = {
    id: 'queue', severity: 'fail' as const, title: 'Queue "x" not found', detail: ''
  };

  it('turns point-in-time failures into information when authoring a profile, and keeps config failures', () => {
    const out = checksFor([headroom, config], { profile: true, scheduler: 'kai' });

    expect(out[0].severity).toBe('info');
    expect(out[0].title).toContain('Right now: no GPU node');
    expect(out[1].severity).toBe('fail');
  });

  it('turns them into a wait under a queueing scheduler, and leaves them failing without one', () => {
    expect(checksFor([headroom], { profile: false, scheduler: 'kueue' })[0].severity).toBe('warn');
    expect(checksFor([headroom], { profile: false, scheduler: 'kai' })[0].title).toContain('will wait in its queue');
    expect(checksFor([headroom], { profile: false, scheduler: 'none' })[0].severity).toBe('fail');
  });
});

describe('checkpoint and scratch storage', () => {
  const f = (over: Partial<Form>): Form => ({
    ...DEFAULT_FORM, releaseName: 'run1', ...over
  });

  it('creates a checkpoint volume from a storage class and reads it back', () => {
    const v = chartValuesFor(f({
      checkpointMode: 'create', checkpointSize: '50Gi', checkpointStorageClass: 'longhorn', checkpointKeep: false
    }), true);

    expect(v.storage.checkpointCreate).toEqual({
      enabled: true, size: '50Gi', storageClass: 'longhorn', keep: false
    });
    expect(v.storage.checkpointPVC).toBe('');
    const back = formFromValues(v, DEFAULT_FORM).form;

    expect(back.checkpointMode).toBe('create');
    expect(back.checkpointSize).toBe('50Gi');
    expect(back.checkpointKeep).toBe(false);
  });

  it('treats a picked PVC as existing, and node-local scratch as an emptyDir medium', () => {
    expect(chartValuesFor(f({ checkpointPVC: 'ckpt' }), true).storage.checkpointPVC).toBe('ckpt');
    expect(formFromValues({ storage: { checkpointPVC: 'ckpt' } }, DEFAULT_FORM).form.checkpointMode).toBe('existing');
    expect(chartValuesFor(f({ scratchSize: '10Gi', scratchMedium: 'node' }), true).storage.scratchMedium).toBe('node');
  });
});

describe('local disk per worker', () => {
  const GIB = 1024 ** 3;
  const node = (free: number, total: number) => ({
    name: 'gpu-node-1', gpus: 1, cpuFree: 8, memFree: 32 * GIB, diskPressure: false, ephemeralFree: free * GIB, ephemeralTotal: total * GIB, images: []
  });
  const form = { ...DEFAULT_FORM, ephemeralRequest: '20Gi' };

  it('fails a request above every GPU node\'s total, which no wait can meet', () => {
    const c = runPreflight(form, facts({ podsReadable: true, gpuNodes: [node(13, 14)] }));

    expect(c.find((x) => x.id === 'ephemeral')?.severity).toBe('fail');
    expect(c.find((x) => x.id === 'ephemeral-free')).toBeUndefined();
  });

  it('marks a request that fits a node but not its free disk as a wait under a queueing scheduler', () => {
    const c = runPreflight(form, facts({ podsReadable: true, gpuNodes: [node(10, 100)] }));

    expect(c.find((x) => x.id === 'ephemeral-free')?.severity).toBe('fail');
    expect(checksFor(c, { profile: false, scheduler: 'kai' }).find((x) => x.id === 'ephemeral-free')?.severity).toBe('warn');
  });
});

describe('code that needs more than a torch-only image has', () => {
  const suse = 'dp.apps.rancher.io/containers/pytorch';
  const code = 'import torch\nfrom torchvision import datasets, transforms\n';

  it('warns when the code imports torchvision on the SUSE torch-only image', () => {
    const c = runPreflight({ ...DEFAULT_FORM, mode: 'torchrun', image: suse, script: code } as any, facts({}));

    expect(c.find((x) => x.id === 'image-packages')?.title).toContain('torchvision');
  });

  it('reads the chosen ConfigMap\'s train.py too, and says nothing for an image that has them', () => {
    const fromCm = runPreflight({ ...DEFAULT_FORM, mode: 'torchrun', image: suse, script: '', configMap: 'mnist' } as any, facts({ configMapCode: { mnist: code } }));

    expect(fromCm.find((x) => x.id === 'image-packages')?.severity).toBe('warn');
    expect(runPreflight({ ...DEFAULT_FORM, mode: 'torchrun', image: 'pytorch/pytorch', script: code } as any, facts({})).find((x) => x.id === 'image-packages')).toBeUndefined();
  });
});

describe('commands survive the form', () => {
  const script = '#!/bin/sh\n# a comment\necho "PASS  it\'s fine"\nx=$(nvidia-smi -L | wc -l)\n';

  it('round-trips sh -c with a multi-line script through joinArgs and splitArgs', () => {
    const parts = ['sh', '-c', script];

    expect(splitArgs(joinArgs(parts))).toEqual(parts);
  });

  it('keeps a profile\'s custom command whole from values to the values it installs', () => {
    const { form } = formFromValues({ job: { mode: 'custom', command: ['sh', '-c', script] } }, DEFAULT_FORM);

    expect(chartValuesFor(form, true).job.command).toEqual(['sh', '-c', script]);
  });

  it('still splits what people type', () => {
    expect(splitArgs('python /mnt/config/train.py --lr "2e-5" --name \'my run\'')).toEqual(['python', '/mnt/config/train.py', '--lr', '2e-5', '--name', 'my run']);
  });
});

// Only a scheduler whose table entry places kai-fraction shares gets one: the chart refuses a
// GPU-memory share under any other unless it names an MPS claim, so the form must not drop it.
describe('GPU-memory shares follow the scheduler table', () => {
  const share = { ...DEFAULT_FORM, gpuShareMiB: 4096, gpuSharedClaim: 'team-mps', queue: 'q' };

  it('KAI places the share itself: no claim', () => {
    expect(chartValuesFor({ ...share, scheduler: 'kai' }, true).gpu.sharedClaim).toBe('');
  });

  it('Run:AI is given the shared claim, as the chart requires', () => {
    expect(chartValuesFor({ ...share, scheduler: 'runai' }, true).gpu.sharedClaim).toBe('team-mps');
  });
});

// Where a run goes: an AI project, and a compute pool of one of its clusters.
describe('AI project and compute pool checks', () => {
  const form = { ...DEFAULT_FORM, namespace: 'vision' };
  const check = (f: Facts, id: string) => runPreflight(form, f).find((c) => c.id === id);

  it('asks for an AI project first', () => {
    expect(check(facts({ poolsAvailable: 2, aiProjectNamespace: null }), 'project')?.severity).toBe('fail');
  });

  it('then for a pool', () => {
    expect(check(facts({ poolsAvailable: 2, aiProjectNamespace: 'aif-vision', pool: '' }), 'pool')?.severity).toBe('fail');
  });

  it('passes with both', () => {
    const f = facts({ poolsAvailable: 2, pool: 'c-a-gpu', aiProjectNamespace: 'aif-vision' });

    expect(check(f, 'pool')).toBeUndefined();
    expect(check(f, 'project')?.severity).toBe('pass');
  });

  it('says nothing on a page that does not place runs', () => {
    expect(check(facts({}), 'pool')).toBeUndefined();
    expect(check(facts({}), 'project')).toBeUndefined();
  });

  it('keeps only the checks that do not depend on a cluster when placement is automatic', () => {
    const all = runPreflight({ ...form, releaseName: 'BAD NAME' }, facts({ poolsAvailable: 2, aiProjectNamespace: null }));
    const auto = automaticPlacementChecks(all, 'vision');

    expect(auto.map((c) => c.id)).toContain('name');
    expect(auto.find((c) => c.id === 'name')?.severity).toBe('fail');
    expect(auto.some((c) => ['namespace', 'queue', 'gpu', 'scheduler', 'capacity'].includes(c.id))).toBe(false);
    expect(auto.find((c) => c.id === 'project')?.severity).toBe('pass');
    expect(auto.find((c) => c.id === 'pool')?.severity).toBe('info');
  });
});

describe('Volcano', () => {
  const form: Form = {
    ...DEFAULT_FORM, namespace: 'default', releaseName: 'train-1', scheduler: 'volcano', queue: '', nodes: 2, gpusPerNode: 1
  };
  const queues = [
    { name: 'default', state: 'Open', gpuCapability: null },
    { name: 'team-a', state: 'Open', gpuCapability: 1 },
    { name: 'old', state: 'Closed', gpuCapability: null },
  ];
  const sev = (f: Form, over: Partial<Facts>, id: string) => runPreflight(f, facts(over)).filter((c) => c.id === id).map((c) => c.severity);

  it('must be installed', () => {
    expect(checkIds(form, facts({}))).toContain('scheduler');
    expect(sev(form, { volcanoInstalled: true, volcanoQueues: queues }, 'scheduler')).toEqual(['pass']);
  });

  it('puts a run that names no queue in its default queue', () => {
    expect(sev(form, { volcanoInstalled: true, volcanoQueues: queues }, 'queue')).toEqual(['pass']);
  });

  it('refuses a queue that is missing, closed, or capped below the request', () => {
    const on = { volcanoInstalled: true, volcanoQueues: queues };

    expect(sev({ ...form, queue: 'nope' }, on, 'queue')).toEqual(['fail']);
    expect(sev({ ...form, queue: 'old' }, on, 'queue')).toEqual(['fail']);
    expect(sev({ ...form, queue: 'team-a' }, on, 'queue')).toEqual(['fail']); // 2 GPUs, capped at 1
    expect(sev({ ...form, queue: 'team-a', nodes: 1 }, on, 'queue')).toEqual(['pass']);
    expect(sev(form, { volcanoInstalled: true, volcanoQueues: [] }, 'queue'), 'queues not readable: a warning').toEqual(['warn']);
  });
});

describe('HAMi', () => {
  const form: Form = {
    ...DEFAULT_FORM, namespace: 'default', releaseName: 'train-1', gpuShareMiB: 4096, gpuSharing: 'hami', gpuCoresPercent: 30, gpusPerNode: 1
  };
  const share = (f: Form, over: Partial<Facts>) => runPreflight(f, facts(over)).filter((c) => c.id === 'gpu-share').map((c) => c.severity);

  it('needs HAMi on the cluster and a scheduler it works with', () => {
    expect(share(form, { sharingLayers: ['hami'] })).toEqual(['pass']);
    expect(share(form, {})).toEqual(['fail']);
    expect(share({ ...form, scheduler: 'kai', queue: 'q' }, { sharingLayers: ['hami'], kaiInstalled: true })).toEqual(['fail']);
    expect(share({ ...form, gpuCoresPercent: 120 }, { sharingLayers: ['hami'] })).toEqual(['fail']);
  });

  it('installs as gpu.sharing with its compute cap, and stays under Kueue', () => {
    const v = chartValues({ ...form, scheduler: 'kueue', queue: 'q' });

    expect(v.gpu).toMatchObject({
      sharing: 'hami', sharedMemoryMiB: 4096, sharedCoresPercent: 30, sharedClaim: ''
    });
    expect(v.scheduler).toMatchObject({ type: 'kueue', queue: 'q' });
    const back = formFromValues(v, DEFAULT_FORM);

    expect(back.unmapped).toEqual([]);
    expect(back.form).toMatchObject({ gpuSharing: 'hami', gpuCoresPercent: 30, gpuShareMiB: 4096 });
    expect(chartValues({ ...form, gpuShareMiB: 0 }).gpu).toMatchObject({ sharing: '', sharedCoresPercent: 0 });
  });

  it('a Volcano run reads back as Volcano', () => {
    expect(formFromValues({ scheduler: { type: 'volcano', queue: 'team-a' } }, DEFAULT_FORM).form.scheduler).toBe('volcano');
  });
});

describe('Ray (KubeRay RayJob)', () => {
  const form: Form = {
    ...DEFAULT_FORM, namespace: 'default', releaseName: 'ray-1', kind: 'rayjob', mode: 'custom', command: 'python train.py', image: 'rayproject/ray', tag: '2.49.2', gpusPerNode: 0, nodes: 2, rayRuntimeEnv: 'pip: [torch]'
  };
  const kind = (f: Form, over: Partial<Facts>) => runPreflight(f, facts(over)).filter((c) => c.id.startsWith('kind')).map((c) => [c.id, c.severity]);

  it('needs KubeRay, a custom command, and a Ray image', () => {
    expect(kind(form, { kuberayInstalled: true })).toEqual([['kind', 'pass']]);
    expect(kind(form, {})).toEqual([['kind', 'fail']]);
    expect(kind({ ...form, mode: 'torchrun' }, { kuberayInstalled: true })).toEqual([['kind', 'fail']]);
    expect(kind({ ...form, image: 'registry.suse.com/bci/bci-base' }, { kuberayInstalled: true })).toEqual([['kind', 'pass'], ['kind-image', 'warn']]);
  });

  it('installs as job.kind=rayjob with its runtime environment, and reads back', () => {
    const v = chartValues(form);

    expect(v.job.kind).toBe('rayjob');
    expect(v.ray).toEqual({ runtimeEnv: 'pip: [torch]' });
    expect(chartValues({ ...form, kind: 'job' }).ray).toBeUndefined();
    const back = formFromValues(v, DEFAULT_FORM);

    expect(back.unmapped).toEqual([]);
    expect(back.form).toMatchObject({ kind: 'rayjob', rayRuntimeEnv: 'pip: [torch]' });
  });
});
