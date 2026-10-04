// What the AI Factory Overview shows about GPUs and projects, read the way the Projects page reads
// it: GPU capacity (in GPUs and GPU memory) and, per project, its entitlement and what it uses.
// Loaded once per refresh from the local cluster's store; read-only.

import { CapacitySummary, capacitySummary, gpuModels } from './capacity';
import { GPU_RESOURCE, TYPES } from './config';
import {
  QueueIndex, buildQueueIndex, clusterCapacity, namespaceQueueMap, usageFromPods, withPodUsage
} from './quota';
import { AiProject, assembleProjects } from './projects';
import { buildIndexFromResourceQuotas, isGpuQuota } from './resourcequota';

export interface OverviewProject {
  id: string;
  name: string;
  /** "1 GPU guaranteed", "Up to 2 GPU", "No limit" */
  entitlement: string;
  gpus: number;
  memoryMiB: number;
  running: number;
  queued: number;
}

export interface Overview {
  capacity: CapacitySummary;
  projects: OverviewProject[];
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** The entitlement as the Projects page words it. Guarantees exist only under a queueing backend. */
export function entitlementText(p: AiProject, guarantees: boolean): string {
  const g = p.gpu?.guaranteed;
  const cap = p.gpu?.cap;

  if (!guarantees) {
    return cap === undefined || cap === Infinity ? 'No limit' : `Up to ${ fmt(cap) } GPU`;
  }
  const base = g === undefined || g === 0 ? 'No guarantee' : g === Infinity ? 'Unlimited' : `${ fmt(g) } GPU guaranteed`;
  const upTo = cap === undefined ? '' : cap === Infinity ? ' · can borrow' : cap !== g ? ` · up to ${ fmt(cap) }` : '';

  return base + upTo;
}

/** Overview rows for the projects of one cluster, busiest first. */
export function overviewProjects(projects: AiProject[], summary: CapacitySummary, guarantees: boolean): OverviewProject[] {
  return projects
    .filter((p) => p.source !== 'queue-only')
    .map((p) => {
      const u = (p.queue && summary.byQueue[p.queue]) || {
        gpus: p.gpu?.allocated || 0, memoryMiB: 0, running: 0, queued: 0
      };

      return {
        id: p.id, name: p.displayName, entitlement: entitlementText(p, guarantees), gpus: u.gpus, memoryMiB: u.memoryMiB, running: u.running, queued: u.queued
      };
    })
    .sort((a, b) => b.gpus - a.gpus || b.running - a.running || a.name.localeCompare(b.name));
}

async function findAll(store: any, which: 'cluster' | 'management', type: string): Promise<any[]> {
  if (!store.getters[`${ which }/schemaFor`](type)) {
    return [];
  }
  try {
    return await store.dispatch(`${ which }/findAll`, { type, opt: { force: true } });
  } catch (e) {
    return [];
  }
}

export async function loadOverview(store: any, clusterId: string): Promise<Overview> {
  const kai = !!store.getters['cluster/schemaFor'](TYPES.KAI_QUEUE);
  const [queues, namespaces, nodes, pods, rancherProjects, resourceQuotas] = await Promise.all([
    kai ? findAll(store, 'cluster', TYPES.KAI_QUEUE) : Promise.resolve([]),
    findAll(store, 'cluster', TYPES.NAMESPACE),
    findAll(store, 'cluster', TYPES.NODE),
    findAll(store, 'cluster', TYPES.POD),
    findAll(store, 'management', TYPES.RANCHER_PROJECT),
    kai ? Promise.resolve([]) : findAll(store, 'cluster', TYPES.RESOURCE_QUOTA),
  ]);
  const gpuMiB = Math.max(0, ...gpuModels(nodes).map((m) => m.memoryMiB));
  let index: QueueIndex;
  let nsQueue: Record<string, string>;
  let gpuInUse: number;

  if (kai) {
    nsQueue = namespaceQueueMap(namespaces);
    const usage = usageFromPods(pods, nsQueue, buildQueueIndex(queues), GPU_RESOURCE, gpuMiB);

    index = withPodUsage(buildQueueIndex(queues), usage);
    gpuInUse = usage.total;
  } else {
    index = buildIndexFromResourceQuotas(resourceQuotas.filter((rq: any) => isGpuQuota(rq, GPU_RESOURCE)), GPU_RESOURCE);
    nsQueue = Object.fromEntries(Object.keys(index).map((n) => [n, n]));
    gpuInUse = usageFromPods(pods, nsQueue, index).total;
  }
  const summary = capacitySummary(nodes, pods, nsQueue, new Set(Object.keys(index)));
  const capacity = clusterCapacity({
    nodes:           nodes.map((n: any) => ({ allocatable: n.status?.allocatable, unschedulable: n.spec?.unschedulable })),
    gpuInUse,
    gpuResourceName: GPU_RESOURCE,
  });
  const projects = assembleProjects(
    rancherProjects.filter((p: any) => p.metadata?.namespace === clusterId), namespaces, index, [], capacity, clusterId, kai ? 'kai' : 'resourcequota'
  );

  return { capacity: summary, projects: overviewProjects(projects, summary, kai) };
}
