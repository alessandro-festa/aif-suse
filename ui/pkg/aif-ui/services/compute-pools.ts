import type { Dispatchable } from '../types/rancher-types';
import { fmtMem, parseCpu, parseMem } from '../training/preflight';
import { IDLE_DURATION } from '../training/reclaim';
import { getAllClusters } from './rancher-apps';

// The compute pools the AI Factory operator discovers on every downstream cluster Rancher manages
// (the ComputePool resource): one per GPU model and one for the CPU-only nodes, named after their
// cluster, with what each has and the scheduling stack the cluster runs. Rancher's own "local"
// cluster runs no AI work and is never shown. See docs/design/ai-scheduling.md §6.

const LOCAL_CLUSTER = 'local';

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

/** Every ComputePool, by cluster then name, and the clusters that have none yet. */
export async function listComputePools(store: Dispatchable & { getters: any }): Promise<ComputePools> {
  if (!store.getters['cluster/schemaFor']?.(COMPUTE_POOL_TYPE)) {
    return {
      installed: false, rows: [], objects: {}, undiscovered: []
    };
  }
  const [pools, clusters] = await Promise.all([
    store.dispatch('cluster/findAll', { type: COMPUTE_POOL_TYPE, opt: { force: true } }),
    getAllClusters(store),
  ]);
  const names = Object.fromEntries(clusters.map((c) => [c.id, c.name]));
  const rows = (pools || []).map((p: any) => poolRow(p, names)).filter((r: ComputePoolRow) => r.clusterId !== LOCAL_CLUSTER);

  rows.sort((a: ComputePoolRow, b: ComputePoolRow) => a.clusterName.localeCompare(b.clusterName) || a.displayName.localeCompare(b.displayName));

  return {
    installed: true, rows, objects: Object.fromEntries((pools || []).map((p: any) => [p.metadata?.name, p])), undiscovered: undiscoveredClusters(clusters, rows)
  };
}
