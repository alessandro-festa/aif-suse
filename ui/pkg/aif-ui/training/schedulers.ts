// The scheduler backends a training run can be queued by, and how a run is bound to each. This is
// charts/gpu-train-job/schedulers.yaml -- the table the chart's templates and the operator read --
// as TypeScript; __tests__/schedulers-parity.test.ts fails when the two disagree. Change the YAML
// first, then this.

export type SchedulerType = 'none' | 'kueue' | 'kai' | 'runai' | 'volcano';

export interface SchedulerBackend {
  display: string;
  /** Installed when the cluster serves API group `group` and not `unless`. null: always there. */
  detect: { group: string; unless?: string } | null;
  /** Pod spec.schedulerName; '' is the default kube-scheduler. */
  schedulerName: string;
  /**
   * How a run names its queue: a label on every pod template ('pod') or on the Job / PyTorchJob
   * ('workload'). as 'annotation': the key is a pod annotation (Volcano). default: the queue a run
   * without one goes to. namespaceLabel: the namespace must carry it with the queue name too.
   */
  queue: { target: 'pod' | 'workload'; label: string; as?: 'annotation'; default?: string; namespaceLabel?: string } | null;
  /** scheduler: it holds the pods until it binds them. suspend: the workload is created suspended. */
  admission: 'scheduler' | 'suspend' | 'none';
  /** podgroup: the chart creates a Volcano PodGroup of minMember = nodes. */
  gang: 'podgrouper' | 'admission' | 'podgroup' | 'none';
  /** Where GPU entitlement lives: scheduling.run.ai/v2 Queues, Kueue ClusterQueues, Volcano Queues, or nowhere. */
  quota: 'queue-tree' | 'clusterqueue' | 'volcano-queue' | 'none';
  /** GPU-sharing modes it places. kai-fraction: the pod's gpu-memory annotation. */
  sharing: 'kai-fraction'[];
  /** Sharing layers (SHARING_LAYERS) a run under it may use instead. */
  sharingWith: SharingLayerName[];
}

export type SharingLayerName = 'hami';

/** A GPU-sharing layer a run can use beside its scheduler (schedulers.yaml sharingLayers). */
export interface SharingLayer {
  display: string;
  /** Installed when a node carries this annotation (the layer's device registration). */
  detect: { nodeAnnotation: string };
  /** Pod spec.schedulerName for a run under a scheduler that sets none. */
  schedulerName: string;
  /** Extended resources a pod asks for: one GPU slot, MiB of GPU memory, percent of compute. */
  resources: { gpu: string; memory: string; cores: string };
}

export const SHARING_LAYERS: Record<SharingLayerName, SharingLayer> = {
  hami: {
    display:       'HAMi',
    detect:        { nodeAnnotation: 'hami.io/node-nvidia-register' },
    schedulerName: 'hami-scheduler',
    resources:     {
      gpu: 'nvidia.com/gpu', memory: 'nvidia.com/gpumem', cores: 'nvidia.com/gpucores'
    },
  },
};

/** The sharing layers installed, from the nodes' registrations. */
export function sharingLayersOn(nodes: any[]): SharingLayerName[] {
  return (Object.keys(SHARING_LAYERS) as SharingLayerName[])
    .filter((k) => (nodes || []).some((n) => n?.metadata?.annotations?.[SHARING_LAYERS[k].detect.nodeAnnotation] !== undefined));
}

/** A run under scheduler s may share a GPU through layer l. */
export function worksWithLayer(s: SchedulerType, l: SharingLayerName): boolean {
  return backendOf(s).sharingWith.includes(l);
}

export const SCHEDULER_BACKENDS: Record<SchedulerType, SchedulerBackend> = {
  none: {
    display:       'Default scheduler',
    detect:        null,
    schedulerName: '',
    queue:         null,
    admission:     'none',
    gang:          'none',
    quota:         'none',
    sharing:       [],
    sharingWith: ['hami'],
  },
  kueue: {
    display:       'Kueue',
    detect:        { group: 'kueue.x-k8s.io' },
    schedulerName: '',
    queue:         { target: 'workload', label: 'kueue.x-k8s.io/queue-name' },
    admission:     'suspend',
    gang:          'admission',
    quota:         'clusterqueue',
    sharing:       [],
    sharingWith: ['hami'],
  },
  kai: {
    display:       'KAI scheduler',
    detect:        { group: 'scheduling.run.ai', unless: 'run.ai' },
    schedulerName: 'kai-scheduler',
    queue:         { target: 'pod', label: 'kai.scheduler/queue' },
    admission:     'scheduler',
    gang:          'podgrouper',
    quota:         'queue-tree',
    sharing:       ['kai-fraction'],
    sharingWith: [],
  },
  runai: {
    display:       'Run:AI scheduler',
    detect:        { group: 'run.ai' },
    schedulerName: 'runai-scheduler',
    queue:         { target: 'pod', label: 'project', namespaceLabel: 'runai/queue' },
    admission:     'scheduler',
    gang:          'podgrouper',
    quota:         'queue-tree',
    sharing:       [],
    sharingWith: [],
  },
  volcano: {
    display:       'Volcano',
    detect:        { group: 'scheduling.volcano.sh' },
    schedulerName: 'volcano',
    queue:         {
      target: 'pod', label: 'scheduling.volcano.sh/queue-name', as: 'annotation', default: 'default'
    },
    admission: 'scheduler',
    gang:      'podgroup',
    quota:     'volcano-queue',
    sharing:   [],
    sharingWith: [],
  },
};

export function backendOf(s: SchedulerType): SchedulerBackend {
  return SCHEDULER_BACKENDS[s] || SCHEDULER_BACKENDS.none;
}

/** The scheduler keeps the pods unplaced until its queue has room, and gang-schedules them (KAI, Run:AI). */
export function holdsPods(s: SchedulerType): boolean {
  return backendOf(s).admission === 'scheduler';
}

/** Its queues are scheduling.run.ai/v2 Queues (KAI, Run:AI). */
export function usesQueueTree(s: SchedulerType): boolean {
  return backendOf(s).quota === 'queue-tree';
}

/** It places a GPU-memory share (part of one GPU) from the pod's gpu-memory annotation. */
export function placesGpuMemoryShares(s: SchedulerType): boolean {
  return backendOf(s).sharing.includes('kai-fraction');
}

/** The pod label naming the queue, for a backend that binds by pod label; '' otherwise. */
export function podQueueLabel(s: SchedulerType): string {
  const q = backendOf(s).queue;

  return q?.target === 'pod' && q.as !== 'annotation' ? q.label : '';
}

/** The pod annotation naming the queue, for a backend that binds by pod annotation (Volcano); '' otherwise. */
export function podQueueAnnotation(s: SchedulerType): string {
  const q = backendOf(s).queue;

  return q?.target === 'pod' && q.as === 'annotation' ? q.label : '';
}

/** The queue a run goes to when it names none; '' when it must name one. */
export function defaultQueue(s: SchedulerType): string {
  return backendOf(s).queue?.default || '';
}

/** The label on the Job / PyTorchJob naming the queue, for a backend that binds the workload; '' otherwise. */
export function workloadQueueLabel(s: SchedulerType): string {
  const q = backendOf(s).queue;

  return q?.target === 'workload' ? q.label : '';
}

/** The backend whose scheduler a pod asked for (its spec.schedulerName), if it is one of ours. */
export function backendForSchedulerName(name: string | undefined): SchedulerType | undefined {
  if (!name) {
    return undefined;
  }

  return (Object.keys(SCHEDULER_BACKENDS) as SchedulerType[]).find((k) => SCHEDULER_BACKENDS[k].schedulerName === name);
}

/** Every schedulerName that holds pods for a queue (kai-scheduler, runai-scheduler, volcano). */
export const POD_HOLDING_SCHEDULERS: string[] = (Object.keys(SCHEDULER_BACKENDS) as SchedulerType[])
  .filter(holdsPods).map((k) => SCHEDULER_BACKENDS[k].schedulerName);
