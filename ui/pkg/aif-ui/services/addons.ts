import { createFleetBundle, type FleetBundleParams } from './fleet-bundle';

// Cluster add-ons for AI scheduling, installed from the Compute Pools page: a scheduler (KAI, Kueue,
// Volcano), a GPU-sharing layer (HAMi), or a training runtime (Kubeflow Trainer v2, KubeRay). Each is a
// Fleet HelmOp in fleet-default, from the upstream chart at a pinned version, targeting one
// downstream cluster. (Trainer v2 is the upstream chart: the SUSE Kubeflow chart cannot install
// training only; see the engineering notes, F-67.) The operator's pool discovery then reports it on that cluster's
// pools. Installing writes HelmOps, so only users who may do that see the action.

export type AddonKind = 'scheduler' | 'sharing' | 'training';

export interface Addon {
  key:          string;
  display:      string;
  kind:         AddonKind;
  /** How Compute Pools names it once installed: a scheduler, sharing or training value of the pool. */
  detectedAs:   string;
  /** The ClusterRepo holding the chart pull credentials; '' for a public chart. */
  chartRepo:    string;
  repoUrl:      string;
  chart:        string;
  version:      string;
  namespace:    string;
  release:      string;
  values:       Record<string, any>;
  /** What the admin should know before installing (prerequisites, conflicts). */
  notes:        string;
  /** Only on clusters with GPU pools. */
  gpuOnly?:     boolean;
  /**
   * Older chart versions for older Kubernetes, newest first: a cluster below the add-on's own
   * minKubernetes gets the first variant it meets.
   */
  minKubernetes?: string;
  variants?:    { minKubernetes: string; version: string; values: Record<string, any>; note: string }[];
  /** Secrets the add-on fills in itself after install (webhook certificates): not drift for Fleet. */
  ownSecrets?:  string[];
}

export const ADDONS: Addon[] = [
  {
    key:        'kai',
    display:    'KAI Scheduler',
    kind:       'scheduler',
    detectedAs: 'kai',
    chartRepo:  '',
    // a single-chart OCI repository: the URL ends in the chart's name and is used as is
    repoUrl:    'oci://ghcr.io/kai-scheduler/kai-scheduler/kai-scheduler',
    chart:      'kai-scheduler',
    version:    'v0.18.3',
    namespace:  'kai-scheduler',
    release:    'kai-scheduler',
    values:     {},
    notes:      'Gang scheduling and hierarchical GPU queues with fair share. Creates a default queue (default-queue under default-parent-queue).',
  },
  {
    key:        'kueue',
    display:    'Kueue',
    kind:       'scheduler',
    detectedAs: 'kueue',
    chartRepo:  '',
    repoUrl:    'oci://registry.k8s.io/kueue/charts',
    chart:      'kueue',
    version:    '0.20.0',
    namespace:  'kueue-system',
    release:    'kueue',
    values:     {},
    notes:      'Queue admission with quotas per ClusterQueue; runs keep the default scheduler. Create a ClusterQueue and a LocalQueue per project namespace before submitting.',
  },
  {
    key:        'volcano',
    display:    'Volcano',
    kind:       'scheduler',
    detectedAs: 'volcano',
    chartRepo:  '',
    repoUrl:    'https://volcano-sh.github.io/helm-charts',
    chart:      'volcano',
    version:    '1.15.3',
    namespace:  'volcano-system',
    release:    'volcano',
    values:     {},
    notes:      'Gang scheduling with PodGroups and queues; a "default" queue is created.',
  },
  {
    key:        'hami',
    display:    'HAMi',
    kind:       'sharing',
    detectedAs: 'hami',
    chartRepo:  '',
    repoUrl:    'https://project-hami.github.io/HAMi',
    chart:      'hami',
    version:    '2.10.0',
    namespace:  'hami-system',
    release:    'hami',
    // its device plugin runs where GPU Feature Discovery found an NVIDIA GPU
    values:     { devicePlugin: { nvidiaNodeSelector: { 'nvidia.com/gpu.present': 'true' } } },
    notes:      'Shares a GPU by memory and compute. Its device plugin replaces NVIDIA\'s on GPU nodes: turn the GPU Operator\'s device plugin off there first (devicePlugin.enabled=false), or the two fight over the GPUs.',
    gpuOnly:    true,
  },
  {
    key:        'kubeflow-trainer',
    display:    'Kubeflow Trainer v2',
    kind:       'training',
    detectedAs: 'trainer-v2',
    chartRepo:  '',
    repoUrl:    'oci://ghcr.io/kubeflow/charts',
    chart:      'kubeflow-trainer',
    version:    '2.3.0',
    namespace:  'kubeflow-system',
    release:    'kubeflow-trainer',
    // the runtimes AI Factory's training profiles use: PyTorch, DeepSpeed and JAX
    values:     {
      runtimes: {
        torchDistributed: { enabled: true }, deepspeedDistributed: { enabled: true }, jaxDistributed: { enabled: true }
      }
    },
    notes:      'Upstream Kubeflow Trainer (TrainJob, trainer.kubeflow.org) with JobSet and its PyTorch, DeepSpeed and JAX training runtimes. Not SUSE-supported. Skip it where JobSet is already installed.',
    // 2.2+ ships JobSet CRDs whose validation rules Kubernetes 1.31 cannot compile
    ownSecrets:    ['jobset-webhook-server-cert', 'kubeflow-trainer-webhook-cert'],
    minKubernetes: '1.32',
    variants:      [{
      minKubernetes: '1.29', version: '2.1.0', values: {}, note: 'Kubernetes before 1.32 gets Trainer 2.1.0, which has no built-in training runtimes.'
    }],
  },
  {
    key:        'kuberay',
    display:    'KubeRay',
    kind:       'training',
    detectedAs: 'kuberay',
    chartRepo:  '',
    repoUrl:    'https://ray-project.github.io/kuberay-helm/',
    chart:      'kuberay-operator',
    version:    '1.7.1',
    namespace:  'kuberay-system',
    release:    'kuberay-operator',
    values:     {},
    notes:      'The KubeRay operator (RayJob, RayCluster, ray.io): training runs of kind Ray start a Ray head and workers, run the driver (e.g. a Ray Train script) and remove the cluster at the end. Upstream, not SUSE-supported; runs use Ray images (rayproject/ray).',
  },
];

/** The Fleet HelmOp an add-on is installed as on a cluster. */
export function addonBundleName(a: Addon, clusterId: string): string {
  return `aif-addon-${ a.key }-${ clusterId }`.slice(0, 63).replace(/-+$/, '');
}

/** "v1.31.0+k3s1" -> [1, 31]. */
function minor(v: string): [number, number] {
  const m = String(v || '').match(/(\d+)\.(\d+)/);

  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

function atLeast(have: string, want: string): boolean {
  const [a, b] = minor(have);
  const [c, d] = minor(want);

  return a > c || (a === c && b >= d);
}

/**
 * The chart version and values an add-on installs on a cluster of this Kubernetes version (''
 * when unknown: the add-on's own). null when the cluster is too old for every version.
 */
export function addonRelease(a: Addon, kubernetes = ''): { version: string; values: Record<string, any>; note: string } | null {
  if (!kubernetes || !a.minKubernetes || atLeast(kubernetes, a.minKubernetes)) {
    return { version: a.version, values: a.values, note: '' };
  }
  const v = (a.variants || []).find((x) => atLeast(kubernetes, x.minKubernetes));

  return v ? { version: v.version, values: v.values, note: v.note } : null;
}

/** What createFleetBundle needs to install the add-on on one cluster. */
export function addonBundleParams(a: Addon, clusterId: string, kubernetes = ''): FleetBundleParams {
  const r = addonRelease(a, kubernetes) || { version: a.version, values: a.values };

  return {
    bundleName:       addonBundleName(a, clusterId),
    release:          a.release,
    chartRepo:        a.chartRepo,
    chartRepoUrl:     a.repoUrl,
    chartName:        a.chart,
    chartVersion:     r.version,
    values:           r.values,
    targetNamespace:  a.namespace,
    targetClusterIds: [clusterId],
    ...(a.ownSecrets?.length ? {
      diff: {
        comparePatches: a.ownSecrets.map((name) => ({
          apiVersion: 'v1', kind: 'Secret', namespace: a.namespace, name, operations: [{ op: 'remove', path: '/data' }]
        }))
      }
    } : {}),
    ...(a.chartRepo === 'suse-ai-registry' ? { library: 'suse-ai' as const } : {}),
  };
}

export async function installAddon(store: any, a: Addon, clusterId: string, kubernetes = ''): Promise<void> {
  await createFleetBundle(store, addonBundleParams(a, clusterId, kubernetes));
}

/** Each downstream cluster's Kubernetes version, from Rancher's cluster objects. */
export async function clusterVersions(store: any): Promise<Record<string, string>> {
  try {
    const all: any[] = await store.dispatch('management/findAll', { type: 'management.cattle.io.cluster' });

    return Object.fromEntries((all || []).map((c: any) => [c.id, c.status?.version?.gitVersion || '']));
  } catch {
    return {};
  }
}

const HELMOPS = '/k8s/clusters/local/apis/fleet.cattle.io/v1alpha1/namespaces/fleet-default/helmops';

/** Uninstall: delete its HelmOp; Fleet removes the release from the cluster. */
export async function uninstallAddon(store: any, a: Addon, clusterId: string): Promise<void> {
  await store.dispatch('cluster/request', { url: `${ HELMOPS }/${ addonBundleName(a, clusterId) }`, method: 'DELETE' });
}

export interface AddonInstall {
  addon:     Addon;
  clusterId: string;
  state:     string; // Fleet's display state (Ready, NotReady, WaitApplied, ErrApplied…), or 'Pending'
  ready:     boolean;
  message:   string;
}

/** The add-on installs among fleet-default's HelmOps, by their names. */
export function addonInstallsFrom(helmOps: any[]): AddonInstall[] {
  const out: AddonInstall[] = [];

  for (const h of helmOps || []) {
    const name = String(h?.metadata?.name || '');

    for (const a of ADDONS) {
      const prefix = `aif-addon-${ a.key }-`;

      if (!name.startsWith(prefix)) {
        continue;
      }
      const st = h.status || {};
      const conds: any[] = st.conditions || [];
      // Fleet can say Ready while it could not even fetch the chart (Accepted False, 0/0 deployed):
      // ready means accepted and every bundle deployment ready
      const problem = conds.find((c: any) => c?.status === 'False' && c?.message);
      const counts = String(st.display?.readyBundleDeployments || '').match(/^(\d+)\/(\d+)$/);
      const deployed = !!counts && Number(counts[2]) > 0 && counts[1] === counts[2];
      const ready = !problem && deployed;
      const state = ready ? 'Ready' : problem ? (problem.type === 'Accepted' ? 'Not accepted' : String(st.display?.state || 'Error')) : 'Installing';

      out.push({
        addon:     a,
        clusterId: name.slice(prefix.length),
        state,
        ready,
        message:   String(problem?.message || st.display?.message || ''),
      });
    }
  }

  return out.sort((x, y) => x.clusterId.localeCompare(y.clusterId) || x.addon.display.localeCompare(y.addon.display));
}

export async function listAddonInstalls(store: any): Promise<AddonInstall[]> {
  try {
    const res: any = await store.dispatch('cluster/request', { url: HELMOPS });

    return addonInstallsFrom((res?.data ?? res)?.items || []);
  } catch {
    return [];
  }
}

/** Whether the user may install add-ons: create HelmOps in fleet-default. */
export async function canInstallAddons(store: any): Promise<boolean> {
  try {
    const res: any = await store.dispatch('cluster/request', {
      url:    '/k8s/clusters/local/apis/authorization.k8s.io/v1/selfsubjectaccessreviews',
      method: 'POST',
      data:   {
        apiVersion: 'authorization.k8s.io/v1',
        kind:       'SelfSubjectAccessReview',
        spec:       {
          resourceAttributes: {
            group: 'fleet.cattle.io', resource: 'helmops', verb: 'create', namespace: 'fleet-default'
          }
        },
      },
    });

    return !!(res?.data ?? res)?.status?.allowed;
  } catch {
    return false;
  }
}

/**
 * The add-ons a cluster could still get: not detected on its pools and not being installed there.
 * GPU-only ones need a GPU pool on the cluster.
 */
export function addonsFor(clusterId: string, pools: { clusterId: string; kind: string; schedulers: string[]; sharing: string[]; training: string[] }[], installs: AddonInstall[], kubernetes = ''): Addon[] {
  const mine = pools.filter((p) => p.clusterId === clusterId);
  const detected = new Set(mine.flatMap((p) => [...p.schedulers, ...p.sharing, ...p.training]));
  const pending = new Set(installs.filter((i) => i.clusterId === clusterId).map((i) => i.addon.key));
  const hasGpu = mine.some((p) => p.kind === 'gpu');

  return ADDONS.filter((a) => !detected.has(a.detectedAs) && !pending.has(a.key) && (!a.gpuOnly || hasGpu) && addonRelease(a, kubernetes) !== null);
}
