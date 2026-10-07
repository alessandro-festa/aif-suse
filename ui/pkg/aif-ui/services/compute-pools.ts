import type { Dispatchable } from '../types/rancher-types';
import { TIMEOUT_VALUES } from '../utils/constants';
import { getAllClusterResourceMetrics, type ClusterResourceSummary } from './cluster-resources';

// Read-only view of each cluster as a compute pool: what it has (GPU or CPU only) and which
// scheduling stack runs on it. The ComputePool CRD and placement are designed in
// docs/design/ai-scheduling.md; this page is the PoC that shows the raw material.

export type SchedulerBackend = 'kai' | 'runai' | 'kueue' | 'volcano';
export type SharingBackend = 'hami';
export type TrainingRuntime = 'training-operator' | 'trainer-v2';

export interface PoolStack {
  schedulers: SchedulerBackend[];
  sharing:    SharingBackend[];
  training:   TrainingRuntime[];
}

export interface ComputePoolRow extends PoolStack {
  clusterId: string;
  name:      string;
  kind:      'gpu' | 'cpu';
  status:    ClusterResourceSummary['status'];
  nodeCount: number;
  cpu:       number;
  memoryGB:  number;
  gpuMemGB:  number;
}

// HAMi has no CRD; its device plugin registers each node's GPUs in this annotation.
const HAMI_NODE_ANNOTATION = 'hami.io/node-nvidia-register';

/**
 * Which backends a cluster runs, from its API groups and node annotations.
 * Run:AI ships KAI's scheduling.run.ai queue CRD too; only the run.ai group tells them apart.
 */
export function detectStack(groups: string[], nodeAnnotations: Record<string, string>[]): PoolStack {
  const has = (g: string) => groups.includes(g);
  const schedulers: SchedulerBackend[] = [];

  if (has('run.ai')) {
    schedulers.push('runai');
  } else if (has('scheduling.run.ai')) {
    schedulers.push('kai');
  }
  if (has('kueue.x-k8s.io')) {
    schedulers.push('kueue');
  }
  if (has('scheduling.volcano.sh')) {
    schedulers.push('volcano');
  }

  const training: TrainingRuntime[] = [];

  if (has('kubeflow.org')) {
    training.push('training-operator');
  }
  if (has('trainer.kubeflow.org')) {
    training.push('trainer-v2');
  }

  const sharing: SharingBackend[] = nodeAnnotations.some((a) => HAMI_NODE_ANNOTATION in (a || {})) ? ['hami'] : [];

  return { schedulers, sharing, training };
}

async function fetchStack(store: Dispatchable, clusterId: string): Promise<PoolStack> {
  const base = `/k8s/clusters/${ encodeURIComponent(clusterId) }`;
  const [apis, nodes] = await Promise.all([
    store.dispatch('rancher/request', { url: `${ base }/apis`, timeout: TIMEOUT_VALUES.CLUSTER }),
    store.dispatch('rancher/request', { url: `${ base }/v1/nodes?exclude=metadata.managedFields`, timeout: TIMEOUT_VALUES.CLUSTER }),
  ]);
  const groups = (apis?.data?.groups || apis?.groups || []).map((g: { name: string }) => g.name);
  const items = nodes?.data?.data || nodes?.data || [];

  return detectStack(groups, items.map((n: any) => n?.metadata?.annotations || {}));
}

export async function listComputePools(store: Dispatchable): Promise<ComputePoolRow[]> {
  const clusters = await getAllClusterResourceMetrics(store);

  return Promise.all(clusters.map(async(c) => {
    let stack: PoolStack = { schedulers: [], sharing: [], training: [] };

    if (c.status === 'ready') {
      try {
        stack = await fetchStack(store, c.clusterId);
      } catch {
        // An unreachable discovery endpoint leaves the stack unknown, not the row missing.
      }
    }
    const gpuMemGB = c.resources.gpu?.total || 0;

    return {
      clusterId: c.clusterId,
      name:      c.name,
      kind:      gpuMemGB > 0 ? 'gpu' : 'cpu',
      status:    c.status,
      nodeCount: c.nodeCount,
      cpu:       c.resources.cpu.total,
      memoryGB:  c.resources.memory.total,
      gpuMemGB,
      ...stack,
    };
  }));
}
