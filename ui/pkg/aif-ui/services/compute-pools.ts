import type { Dispatchable } from '../types/rancher-types';
import { fmtMem, parseCpu, parseMem } from '../training/preflight';
import { IDLE_DURATION } from '../training/reclaim';
import { getAllClusters } from './rancher-apps';

// The compute pools the AI Factory operator discovers on every downstream cluster Rancher manages
// (the ComputePool resource): one per GPU model and one for the CPU-only nodes, named after their
// cluster, with what each has and the scheduling stack the cluster runs. Rancher's own "local"
// cluster runs no AI work and is never shown. See docs/design/ai-scheduling.md §6.
//
// Pools, and the AIJobs that tell who a run belongs to, live on local: they are read from there
// explicitly, not through the cluster store, which follows whatever cluster the page is on.

const LOCAL_CLUSTER = 'local';
const AIF_API = `/k8s/clusters/${ LOCAL_CLUSTER }/apis/ai-factory.suse.com/v1alpha1`;

export const COMPUTE_POOL_TYPE = 'ai-factory.suse.com.computepool';

export interface ComputePoolRow {
  name:          string;
  displayName:   string;
  clusterId:     string;
  clusterName:   string;
  kind:          'gpu' | 'cpu';
  disabled:      boolean;
  /** null until the operator has read the cluster once. */
  connected:     boolean | null;
  reason:        string;
  message:       string;
  nodes:         number;
  cpu:           string; // "requested / allocatable" cores
  memory:        string;
  gpus:          number;
  gpusRequested: number;
  gpuModels:     string[];
  gpuMemoryMiB:  number;
  schedulers:    string[];
  sharing:       string[];
  training:      string[];
  /** The pool's idle reclaim settings; null = nothing on it is reclaimed. */
  reclaim:       PoolReclaim | null;
  /** What is left: allocatable minus requested. */
  free:          { cpu: string; memory: string; gpus: number };
  /** What takes the capacity, largest first, as the operator last read it. */
  consumers:     PoolConsumer[];
}

export interface PoolConsumer {
  kind:      'run' | 'workload' | 'rest';
  namespace: string;
  name:      string; // the run's job ID (its AIJob's name)
  pods:      number;
  cpu:       string;
  memory:    string;
  gpus:      number;
  // runs only, from the AIJob on local
  project?:  string;
  phase?:    string;
  activity?: string; // "3% of its CPU request", when the pool samples it
}

/** ComputePool.spec.reclaim. Durations are a number and m, h or d ("30m", "2h", "3d"). */
export interface PoolReclaim {
  idleTimeout:        string;
  maxIdleTimeout?:    string;
  idleThreshold?:     number;
  onlyWhenContended?: boolean;
}

const UNITS: Record<string, string> = { m: 'min', h: 'h', d: 'd' };

/** "30m" -> "30 min", "2h" -> "2 h". */
export function idleDurationText(d: string): string {
  const m = String(d || '').match(IDLE_DURATION);

  return m ? `${ d.slice(0, -1) } ${ UNITS[m[1]] }` : String(d || '');
}

/** How a pool's reclaim settings read in its row. */
export function reclaimText(r: PoolReclaim | null): string {
  if (!r) {
    return 'Off';
  }
  const parts = [`after ${ idleDurationText(r.idleTimeout) } under ${ r.idleThreshold || 5 }%`];

  if (r.maxIdleTimeout) {
    parts.push(`runs may ask up to ${ idleDurationText(r.maxIdleTimeout) }`);
  }
  if (r.onlyWhenContended === false) {
    parts.push('even with no run waiting');
  }

  return parts.join(' · ');
}

/** What the reclaim editor works on. */
export interface ReclaimDraft {
  enabled:           boolean;
  idleTimeout:       string;
  maxIdleTimeout:    string;
  idleThreshold:     number;
  onlyWhenContended: boolean;
}

export function reclaimDraft(r: PoolReclaim | null): ReclaimDraft {
  return {
    enabled:           !!r,
    idleTimeout:       r?.idleTimeout || '2h',
    maxIdleTimeout:    r?.maxIdleTimeout || '',
    idleThreshold:     r?.idleThreshold || 5,
    onlyWhenContended: r?.onlyWhenContended !== false,
  };
}

/** What is wrong with a draft, by field; empty when it can be saved. */
export function reclaimErrors(d: ReclaimDraft): Record<string, string> {
  const out: Record<string, string> = {};

  if (!d.enabled) {
    return out;
  }
  if (!IDLE_DURATION.test(d.idleTimeout)) {
    out.idleTimeout = 'A number and m, h or d, e.g. 30m, 2h, 3d';
  }
  if (d.maxIdleTimeout && !IDLE_DURATION.test(d.maxIdleTimeout)) {
    out.maxIdleTimeout = 'A number and m, h or d, or empty';
  }
  const t = Number(d.idleThreshold);

  if (!Number.isInteger(t) || t < 1 || t > 100) {
    out.idleThreshold = 'A whole percentage from 1 to 100';
  }

  return out;
}

/** The spec.reclaim a draft saves as; null turns reclaim off. */
export function reclaimSpec(d: ReclaimDraft): PoolReclaim | null {
  if (!d.enabled) {
    return null;
  }
  const out: PoolReclaim = { idleTimeout: d.idleTimeout, idleThreshold: Number(d.idleThreshold) };

  if (d.maxIdleTimeout) {
    out.maxIdleTimeout = d.maxIdleTimeout;
  }
  if (!d.onlyWhenContended) {
    out.onlyWhenContended = false;
  }

  return out;
}

/** A ComputePool object as the page shows it. */
export function poolRow(p: any, clusterNames: Record<string, string> = {}): ComputePoolRow {
  const spec = p?.spec || {};
  const st = p?.status || {};
  const conn = (st.conditions || []).find((c: any) => c?.type === 'Connected');
  const alloc = st.allocatable || {};
  const req = st.requested || {};
  const cores = (q: any) => Math.round(parseCpu(q) * 10) / 10;
  const freeCores = Math.max(0, Math.round((parseCpu(alloc.cpu) - parseCpu(req.cpu)) * 10) / 10);
  const freeMem = Math.max(0, (parseMem(alloc.memory) || 0) - (parseMem(req.memory) || 0));

  return {
    name:          p?.metadata?.name || '',
    displayName:   spec.displayName || clusterNames[spec.clusterId] || spec.clusterId || p?.metadata?.name || '',
    clusterId:     spec.clusterId || '',
    clusterName:   clusterNames[spec.clusterId] || spec.clusterId || '',
    kind:          spec.kind === 'gpu' ? 'gpu' : 'cpu',
    disabled:      !!spec.disabled,
    connected:     conn ? conn.status === 'True' : null,
    reason:        conn?.reason || '',
    message:       conn?.message || '',
    nodes:         Number(st.nodes) || 0,
    cpu:           `${ cores(req.cpu) } / ${ cores(alloc.cpu) }`,
    memory:        `${ fmtMem(parseMem(req.memory)) } / ${ fmtMem(parseMem(alloc.memory)) }`,
    gpus:          Number(alloc.gpus) || 0,
    gpusRequested: Number(req.gpus) || 0,
    gpuModels:     st.gpu?.models || [],
    gpuMemoryMiB:  Number(st.gpu?.memoryMiB) || 0,
    schedulers:    st.schedulers || [],
    sharing:       st.sharing || [],
    training:      st.training || [],
    reclaim:       spec.reclaim?.idleTimeout ? { ...spec.reclaim } : null,
    free:          { cpu: String(freeCores), memory: fmtMem(freeMem), gpus: Math.max(0, (Number(alloc.gpus) || 0) - (Number(req.gpus) || 0)) },
    consumers:     (st.consumers || []).map((c: any): PoolConsumer => ({
      kind:      c.kind === 'run' || c.kind === 'rest' ? c.kind : 'workload',
      namespace: c.namespace || '',
      name:      c.name || '',
      pods:      Number(c.pods) || 0,
      cpu:       String(cores(c.requested?.cpu)),
      memory:    fmtMem(parseMem(c.requested?.memory) || 0),
      gpus:      Number(c.requested?.gpus) || 0,
    })),
  };
}

export interface ComputePools {
  /** false when the operator on this Rancher does not serve ComputePool yet (an older AI Factory). */
  installed:    boolean;
  rows:         ComputePoolRow[];
  /** The ComputePool objects, by name, for saving changes. */
  objects:      Record<string, any>;
  /**
   * Downstream clusters with no pool at all: the operator has not been able to read them yet,
   * usually for want of a Rancher token, and they would otherwise not appear anywhere.
   */
  undiscovered: { id: string; name: string }[];
}

/** Downstream clusters no pool is on. */
export function undiscoveredClusters(clusters: { id: string; name: string }[], rows: ComputePoolRow[]): { id: string; name: string }[] {
  const seen = new Set(rows.map((r) => r.clusterId));

  return clusters.filter((c) => c.id !== LOCAL_CLUSTER && !seen.has(c.id)).map((c) => ({ id: c.id, name: c.name }));
}

async function getLocal(store: Dispatchable, path: string): Promise<any> {
  const res: any = await store.dispatch('cluster/request', { url: `${ AIF_API }${ path }` });

  return res?.data ?? res;
}

/** Each placed run's project, phase and activity, from its AIJob on local. */
export function describeRuns(rows: ComputePoolRow[], aiJobs: any[]): void {
  const byPlace = new Map<string, any>();

  for (const j of aiJobs || []) {
    const at = j?.status?.placement;

    if (at?.clusterId) {
      byPlace.set(`${ at.clusterId }/${ at.namespace }/${ j.metadata?.name }`, j);
    }
  }
  for (const r of rows) {
    for (const c of r.consumers) {
      const j = c.kind === 'run' ? byPlace.get(`${ r.clusterId }/${ c.namespace }/${ c.name }`) : null;

      if (!j) {
        continue;
      }
      const ns = String(j.metadata?.namespace || '');
      const a = j.status?.activity;

      c.project = ns.startsWith('aif-') ? ns.slice(4) : ns;
      c.phase = j.status?.phase || '';
      if (a?.sampledAt) {
        c.activity = `${ a.utilisation ?? 0 }% of its ${ String(a.source || '').startsWith('gpu') ? 'GPUs' : 'CPU request' }${ a.idleSince ? ', idle' : '' }`;
      }
    }
  }
}

/** Every ComputePool, by cluster then name, and the clusters that have none yet. */
export async function listComputePools(store: Dispatchable & { getters?: any }): Promise<ComputePools> {
  let list: any;

  try {
    list = await getLocal(store, '/computepools');
  } catch (e: any) {
    if (e?.status === 404 || e?._status === 404 || e?.response?.status === 404) {
      return {
        installed: false, rows: [], objects: {}, undiscovered: []
      };
    }
    throw e;
  }
  const [clusters, aiJobs] = await Promise.all([
    getAllClusters(store),
    getLocal(store, '/aijobs').then((l: any) => l?.items || []).catch(() => []),
  ]);
  const pools: any[] = list?.items || [];
  const names = Object.fromEntries(clusters.map((c) => [c.id, c.name]));
  const rows = pools.map((p: any) => poolRow(p, names)).filter((r: ComputePoolRow) => r.clusterId !== LOCAL_CLUSTER);

  rows.sort((a: ComputePoolRow, b: ComputePoolRow) => a.clusterName.localeCompare(b.clusterName) || a.displayName.localeCompare(b.displayName));
  describeRuns(rows, aiJobs);

  return {
    installed: true, rows, objects: Object.fromEntries(pools.map((p: any) => [p.metadata?.name, p])), undiscovered: undiscoveredClusters(clusters, rows)
  };
}

/** Whether the user may change compute pools (patch on local). */
export async function canEditPools(store: Dispatchable): Promise<boolean> {
  try {
    const res: any = await store.dispatch('cluster/request', {
      url:    `/k8s/clusters/${ LOCAL_CLUSTER }/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`,
      method: 'POST',
      data:   {
        apiVersion: 'authorization.k8s.io/v1',
        kind:       'SelfSubjectAccessReview',
        spec:       { resourceAttributes: { group: 'ai-factory.suse.com', resource: 'computepools', verb: 'patch' } },
      },
    });

    return !!(res?.data ?? res)?.status?.allowed;
  } catch {
    return false;
  }
}

/** Set a pool's idle reclaim settings on local; null turns reclaim off. */
export async function savePoolReclaim(store: Dispatchable, name: string, reclaim: PoolReclaim | null): Promise<void> {
  await store.dispatch('cluster/request', {
    url:     `${ AIF_API }/computepools/${ encodeURIComponent(name) }`,
    method:  'PATCH',
    headers: { 'content-type': 'application/merge-patch+json' },
    data:    { spec: { reclaim } },
  });
}
