// GPU capacity as the Projects page shows it: physical GPUs and their memory, what is allocated and
// to which project, and what is waiting. Fractional GPUs (KAI GPU-memory shares) make "1 GPU" too
// coarse on its own, so allocation is counted both ways: in GPUs (the fraction KAI charges) and in
// GPU memory.
//
// KAI holds a GPU for its fractional pods with a reservation pod (namespace kai-resource-reservation)
// that requests the whole nvidia.com/gpu. That pod stands for the fractional pods on the GPU, so it
// is not counted itself: counting it would show the GPU as held outside any project.

import { GPU_RESOURCE } from './config';
import { isPodHoldingResources, podGpuRequest, PodLike, resolvePodQueue } from './quota';

export const KAI_RESERVATION_NAMESPACE = 'kai-resource-reservation';
const GPU_PRODUCT_LABEL = 'nvidia.com/gpu.product';
const GPU_MEMORY_LABEL = 'nvidia.com/gpu.memory'; // MiB per GPU, set by GPU Feature Discovery

export interface NodeLike { metadata?: { name?: string; labels?: Record<string, string> }; status?: { allocatable?: Record<string, string> }; spec?: { unschedulable?: boolean } }

export interface GpuModel { product: string; count: number; memoryMiB: number; nodes: string[] }

export interface PodGpu {
  /** GPUs charged: whole devices, or KAI's fraction (two decimals, rounded up) */
  gpus: number;
  /** GPU memory held, MiB (whole GPUs count their device's memory) */
  memoryMiB: number;
  fractional: boolean;
}

export interface ProjectUsage {
  gpus: number;
  memoryMiB: number;
  running: number; // GPU workloads with a running pod
  queued: number; // GPU workloads waiting (no pod placed yet)
}

export interface CapacitySummary {
  models: GpuModel[];
  gpus: number; // physical, schedulable
  memoryMiB: number; // across those GPUs (0 = unknown)
  allocatedGpus: number;
  allocatedMiB: number;
  queuedWorkloads: number;
  /** keyed by queue (the project's) */
  byQueue: Record<string, ProjectUsage>;
  /** GPU work in namespaces that belong to no project queue */
  outside: { gpus: number; memoryMiB: number; workloads: { namespace: string; name: string }[] };
}

/** The GPU models in the cluster, from node labels (GPU Feature Discovery) and allocatable GPUs. */
export function gpuModels(nodes: NodeLike[]): GpuModel[] {
  const by: Record<string, GpuModel> = {};

  for (const n of nodes || []) {
    const count = parseInt(n.status?.allocatable?.[GPU_RESOURCE] || '0', 10) || 0;

    if (count <= 0 || n.spec?.unschedulable) {
      continue;
    }
    const product = (n.metadata?.labels?.[GPU_PRODUCT_LABEL] || 'GPU').replace(/-/g, ' ');
    const memoryMiB = parseInt(n.metadata?.labels?.[GPU_MEMORY_LABEL] || '0', 10) || 0;
    const m = by[product] || (by[product] = {
      product, count: 0, memoryMiB, nodes: []
    });

    m.count += count;
    m.memoryMiB = m.memoryMiB || memoryMiB;
    m.nodes.push(n.metadata?.name || '');
  }

  return Object.values(by);
}

/**
 * What one pod holds. KAI's annotations: gpu-memory (MiB) or gpu-fraction (0..1). gpuMiB is the
 * memory of the GPU it runs on (or the cluster's, before it is placed).
 */
export function podGpu(pod: PodLike, gpuMiB: number): PodGpu | null {
  const ann = (pod as any)?.metadata?.annotations || {};
  const mem = Number(ann['gpu-memory']) || 0;
  const frac = Number(ann['gpu-fraction']) || 0;

  if (mem > 0 || frac > 0) {
    const memoryMiB = mem || frac * gpuMiB;
    const gpus = frac || (gpuMiB > 0 ? Math.ceil((mem / gpuMiB) * 100) / 100 : 0);

    return {
      gpus, memoryMiB, fractional: true
    };
  }
  const whole = podGpuRequest(pod, GPU_RESOURCE);

  return whole > 0 ? {
    gpus: whole, memoryMiB: whole * gpuMiB, fractional: false
  } : null;
}

/** The workload a pod belongs to, so a multi-pod job counts once. */
function workloadKey(pod: any): string {
  const a = pod?.metadata?.annotations || {};
  const l = pod?.metadata?.labels || {};
  const owner = (pod?.metadata?.ownerReferences || [])[0]?.name;

  return `${ pod?.metadata?.namespace }/${ a['pod-group-name'] || l['job-name'] || l['app.kubernetes.io/instance'] || owner || pod?.metadata?.name }`;
}

/**
 * The capacity card and per-project usage. nsQueue maps a namespace to its project's queue; a pod
 * whose namespace (or own queue label) has none is outside project accounting.
 */
export function capacitySummary(nodes: NodeLike[], pods: PodLike[], nsQueue: Record<string, string>, queues: Set<string>): CapacitySummary {
  const models = gpuModels(nodes);
  const gpus = models.reduce((a, m) => a + m.count, 0);
  const memoryMiB = models.reduce((a, m) => a + m.count * m.memoryMiB, 0);
  const memOf: Record<string, number> = {};

  models.forEach((m) => m.nodes.forEach((n) => {
    memOf[n] = m.memoryMiB;
  }));
  const defaultMiB = models[0]?.memoryMiB || 0;
  const byQueue: Record<string, ProjectUsage> = {};
  const outside = {
    gpus: 0, memoryMiB: 0, workloads: [] as { namespace: string; name: string }[]
  };
  const workloads: Record<string, { queue: string | null; running: boolean; placed: boolean }> = {};
  let allocatedGpus = 0;
  let allocatedMiB = 0;

  for (const pod of pods || []) {
    const p: any = pod;

    if (!isPodHoldingResources(pod) || p?.metadata?.namespace === KAI_RESERVATION_NAMESPACE) {
      continue;
    }
    const g = podGpu(pod, memOf[p?.spec?.nodeName] || defaultMiB);

    if (!g) {
      continue;
    }
    const q = resolvePodQueue(pod, nsQueue);
    const queue = q && queues.has(q) ? q : null;
    const placed = !!p?.spec?.nodeName;
    const key = workloadKey(p);
    const w = workloads[key] || (workloads[key] = {
      queue, running: false, placed: false
    });

    w.running = w.running || p?.status?.phase === 'Running';
    w.placed = w.placed || placed;
    if (!placed) {
      continue; // waiting: holds nothing yet
    }
    allocatedGpus += g.gpus;
    allocatedMiB += g.memoryMiB;
    if (queue) {
      const u = byQueue[queue] || (byQueue[queue] = {
        gpus: 0, memoryMiB: 0, running: 0, queued: 0
      });

      u.gpus += g.gpus;
      u.memoryMiB += g.memoryMiB;
    } else {
      outside.gpus += g.gpus;
      outside.memoryMiB += g.memoryMiB;
    }
  }

  let queuedWorkloads = 0;

  for (const [key, w] of Object.entries(workloads)) {
    const queued = !w.placed;

    if (queued) {
      queuedWorkloads++;
    }
    if (w.queue) {
      const u = byQueue[w.queue] || (byQueue[w.queue] = {
        gpus: 0, memoryMiB: 0, running: 0, queued: 0
      });

      if (queued) {
        u.queued++;
      } else if (w.running) {
        u.running++;
      }
    } else if (!queued) {
      const [namespace, name] = key.split('/');

      outside.workloads.push({ namespace, name });
    }
  }

  return {
    models, gpus, memoryMiB, allocatedGpus: round2(allocatedGpus), allocatedMiB, queuedWorkloads, byQueue, outside: { ...outside, gpus: round2(outside.gpus) }
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
