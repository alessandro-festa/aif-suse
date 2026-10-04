// Queue quota model for KAI Scheduler / Run:AI (API group scheduling.run.ai/v2).
//
// Both products use the same Queue CRD, so everything here works against a cluster running the
// Apache-2.0 KAI Scheduler *or* a licensed Run:AI install. Pure functions only — no store access —
// so this can be unit tested, reused by a CLI, or run inside a validating admission policy.
//
// Units, per the KAI queue docs:
//   cpu    millicores (1000 = 1 core)
//   memory megabytes  (10^6 bytes)
//   gpu    devices    (fractional values allowed when GPU sharing is on)
//
// Special values, which are the part everyone gets wrong:
//   quota: -1        unlimited guarantee        quota: 0 / unset   no guarantee
//   limit: -1        no cap                     limit: 0 / unset   no resources beyond quota
//
// A queue therefore cannot be read on its own: its real ceiling is the minimum of its own cap and
// every ancestor's cap. That chain is what `effectiveCap` walks, and what lets the UI answer
// "why can't I get another GPU?" with a specific reason instead of a pending pod.

export type ResourceName = 'gpu' | 'cpu' | 'memory';
export const RESOURCES: ResourceName[] = ['gpu', 'cpu', 'memory'];

export const UNLIMITED = -1;

export interface RawQueue {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: {
    displayName?: string;
    parentQueue?: string;
    priority?: number;
    resources?: Partial<Record<ResourceName, { quota?: number; limit?: number; overQuotaWeight?: number }>>;
  };
  status?: {
    allocated?: Record<string, number | string>;
    requested?: Record<string, number | string>;
    childQueues?: string[];
  };
}

export interface QueueNode {
  name: string;
  displayName: string;
  parent: string | null;
  children: string[];
  priority: number;
  isLeaf: boolean;
  /** run:ai calls this "deserved"; KAI calls it "quota". Guaranteed floor. */
  quota: Record<ResourceName, number>;
  limit: Record<ResourceName, number>;
  overQuotaWeight: Record<ResourceName, number>;
  /** status.allocated — live usage of this queue *and its children*. */
  allocated: Record<ResourceName, number>;
  /** status.requested — allocated plus anything still pending. */
  requested: Record<ResourceName, number>;
  /** true when the queue reports no status at all (scheduler has not observed it yet). */
  statusMissing: boolean;
}

export type QueueIndex = Record<string, QueueNode>;

/** status.allocated values are int-or-string; treat anything unparseable as 0. */
export function toNumber(v: number | string | undefined | null): number {
  if (v === undefined || v === null || v === '') {
    return 0;
  }
  const n = typeof v === 'number' ? v : parseFloat(String(v));

  return Number.isFinite(n) ? n : 0;
}

/** -1 means unlimited everywhere in this API; map it to Infinity for arithmetic. */
export function expand(v: number): number {
  return v === UNLIMITED ? Infinity : Math.max(0, v);
}

function zero(): Record<ResourceName, number> {
  return {
    gpu: 0, cpu: 0, memory: 0
  };
}

export function buildQueueIndex(raw: RawQueue[]): QueueIndex {
  const index: QueueIndex = {};

  for (const q of raw || []) {
    const name = q?.metadata?.name;

    if (!name) {
      continue;
    }
    const res = q.spec?.resources || {};
    const quota = zero(); const limit = zero(); const oqw = zero();
    const allocated = zero(); const requested = zero();

    for (const r of RESOURCES) {
      // `quota` unset defaults to 0 (no guarantee); `limit` unset defaults to 0, which the API
      // reads as "nothing beyond quota" — resolved in ownCap, not here.
      quota[r] = res[r]?.quota ?? 0;
      limit[r] = res[r]?.limit ?? 0;
      oqw[r] = res[r]?.overQuotaWeight ?? 0;
      allocated[r] = toNumber(q.status?.allocated?.[r]);
      requested[r] = toNumber(q.status?.requested?.[r]);
    }

    index[name] = {
      name,
      displayName:     q.spec?.displayName || name,
      parent:          q.spec?.parentQueue || null,
      children:        [...(q.status?.childQueues || [])],
      priority:        q.spec?.priority ?? 0,
      isLeaf:          true, // fixed up below
      quota,
      limit,
      overQuotaWeight: oqw,
      allocated,
      requested,
      statusMissing:   !q.status || (!q.status.allocated && !q.status.requested),
    };
  }

  // status.childQueues is written by the queue controller and can lag a freshly created child, so
  // derive the hierarchy from spec.parentQueue too and union the two.
  for (const node of Object.values(index)) {
    if (node.parent && index[node.parent] && !index[node.parent].children.includes(node.name)) {
      index[node.parent].children.push(node.name);
    }
  }
  for (const node of Object.values(index)) {
    // drop children the controller still lists but that no longer exist
    node.children = node.children.filter((c) => !!index[c]);
    node.isLeaf = node.children.length === 0;
  }

  return index;
}

/** Ancestors nearest-first, stopping on a cycle so a malformed parentQueue cannot hang the UI. */
export function ancestors(name: string, index: QueueIndex): QueueNode[] {
  const out: QueueNode[] = [];
  const seen = new Set<string>([name]);
  let cur = index[name]?.parent;

  while (cur && index[cur] && !seen.has(cur)) {
    seen.add(cur);
    out.push(index[cur]);
    cur = index[cur].parent;
  }

  return out;
}

/**
 * The ceiling this queue alone imposes.
 *  limit > 0   -> that limit
 *  limit == -1 -> no ceiling
 *  limit == 0  -> "no resources beyond quota", so the quota *is* the ceiling
 *                 (and an unlimited quota means no ceiling)
 */
export function ownCap(node: QueueNode, res: ResourceName): number {
  const lim = node.limit[res];

  if (lim === UNLIMITED) {
    return Infinity;
  }
  if (lim > 0) {
    return lim;
  }

  return expand(node.quota[res]);
}

export interface CapResult {
  cap: number;
  /** which queue in the chain produced the binding cap ('' when nothing constrains it) */
  boundBy: string;
}

/** Effective ceiling = tightest cap across this queue and every ancestor. */
export function effectiveCap(name: string, index: QueueIndex, res: ResourceName): CapResult {
  const node = index[name];

  if (!node) {
    return { cap: 0, boundBy: '' };
  }
  let cap = ownCap(node, res);
  let boundBy = Number.isFinite(cap) ? node.name : '';

  for (const a of ancestors(name, index)) {
    const c = ownCap(a, res);

    if (c < cap) {
      cap = c;
      boundBy = a.name;
    }
  }

  return { cap, boundBy };
}

export type LimitedBy = 'none' | 'quota' | 'ancestor' | 'cluster' | 'unschedulable';

export interface Availability {
  queue: string;
  resource: ResourceName;
  /** guaranteed floor for this queue (Infinity when quota is -1) */
  guaranteed: number;
  /** tightest ceiling across the ancestor chain */
  cap: number;
  /** queue name that imposed `cap` */
  capBoundBy: string;
  /** live usage from status.allocated (includes child queues) */
  allocated: number;
  /** allocated + still-pending, from status.requested */
  requested: number;
  /** headroom inside the guarantee — always schedulable, never preemptible */
  freeInQuota: number;
  /** headroom up to the ceiling — needs over-quota borrowing, may be preempted */
  freeUpToCap: number;
  /** physically unused capacity in the cluster right now */
  clusterFree: number;
  /** what can actually start right now: min(freeUpToCap, clusterFree) */
  schedulableNow: number;
  /** the reason schedulableNow is not larger */
  limitedBy: LimitedBy;
  /** true when the scheduler has not reported status for this queue yet */
  stale: boolean;
}

export interface ClusterCapacity {
  /** total physical units in the cluster */
  total: Record<ResourceName, number>;
  /** currently unused physical units */
  free: Record<ResourceName, number>;
}

export function availability(
  queueName: string,
  index: QueueIndex,
  capacity: ClusterCapacity,
  res: ResourceName = 'gpu',
): Availability {
  const node = index[queueName];
  const clusterFree = Math.max(0, capacity.free[res] ?? 0);

  if (!node) {
    return {
      queue:          queueName,
      resource:       res,
      guaranteed:     0,
      cap:            0,
      capBoundBy:     '',
      allocated:      0,
      requested:      0,
      freeInQuota:    0,
      freeUpToCap:    0,
      clusterFree,
      schedulableNow: 0,
      limitedBy:      'unschedulable',
      stale:          true,
    };
  }

  const guaranteed = expand(node.quota[res]);
  const { cap, boundBy } = effectiveCap(queueName, index, res);
  const allocated = node.allocated[res];
  const requested = node.requested[res];

  const freeInQuota = Math.max(0, guaranteed - allocated);
  const freeUpToCap = Math.max(0, cap - allocated);
  const schedulableNow = Math.min(freeUpToCap, clusterFree);

  let limitedBy: LimitedBy = 'none';

  if (!node.isLeaf) {
    // KAI only schedules onto leaf queues; a parent is an accounting node.
    limitedBy = 'unschedulable';
  } else if (schedulableNow <= 0 && cap <= allocated) {
    limitedBy = boundBy && boundBy !== queueName ? 'ancestor' : 'quota';
  } else if (clusterFree < freeUpToCap) {
    limitedBy = 'cluster';
  }

  return {
    queue:          queueName,
    resource:       res,
    guaranteed,
    cap,
    capBoundBy:     boundBy,
    allocated,
    requested,
    freeInQuota,
    freeUpToCap,
    clusterFree,
    schedulableNow: node.isLeaf ? schedulableNow : 0,
    limitedBy,
    stale:          node.statusMissing,
  };
}

/** Human sentence explaining an Availability, for the pre-flight panel. */
export function explain(a: Availability, requestedUnits: number): string {
  const unit = a.resource === 'gpu' ? 'GPU' : a.resource;
  const cap = Number.isFinite(a.cap) ? `${ a.cap }` : 'unlimited';

  if (a.limitedBy === 'unschedulable') {
    return `Queue "${ a.queue }" is a parent queue. Only leaf queues can run workloads — submit to one of its children.`;
  }
  const base = `Queue ${ a.queue }: ${ a.allocated } of ${ cap } ${ unit } in use, ${ a.guaranteed === Infinity ? 'unlimited' : a.guaranteed } guaranteed.`;

  if (requestedUnits <= a.freeInQuota) {
    return `${ base } Your ${ requestedUnits } ${ unit } fits inside the guarantee, so it cannot be preempted.`;
  }
  if (requestedUnits <= a.schedulableNow) {
    return `${ base } Your ${ requestedUnits } ${ unit } needs over-quota borrowing — it will start now but can be reclaimed when another queue wants its guarantee back.`;
  }
  if (a.limitedBy === 'cluster') {
    const n = a.clusterFree;

    return `${ base } Quota allows ${ a.freeUpToCap } more, but ${ n === 1 ? `only 1 ${ unit } is` : `only ${ n } ${ unit } are` } unallocated, so the job waits.`;
  }
  if (a.limitedBy === 'ancestor') {
    return `${ base } The cap comes from parent queue "${ a.capBoundBy }", not from this queue — raising this queue's limit alone will not help.`;
  }

  return `${ base } Quota is exhausted; the job waits until something finishes.`;
}

export interface QuotaIssue {
  id: string;
  severity: 'fail' | 'warn' | 'info';
  queue: string;
  resource: ResourceName;
  title: string;
  detail: string;
}

/**
 * Cluster-wide consistency audit. This catches the configurations that look fine in the run:ai UI
 * but silently mean "some project can never get what it was promised" — the exact situation on the
 * altra-ai cluster, where department `research` guarantees 3 GPUs while its children `training` (3)
 * and `inference` (1) together claim 4, on a 3-GPU cluster.
 */
export function auditQuotas(index: QueueIndex, capacity: ClusterCapacity, resources: ResourceName[] = ['gpu']): QuotaIssue[] {
  const out: QuotaIssue[] = [];
  const nodes = Object.values(index);

  for (const res of resources) {
    const unit = res === 'gpu' ? 'GPU' : res;

    for (const node of nodes) {
      const q = node.quota[res];
      const lim = node.limit[res];

      // limit below quota is self-contradictory: the guarantee can never be honoured.
      if (lim > 0 && q > 0 && lim < q) {
        out.push({
          id:       `limit-below-quota/${ node.name }/${ res }`,
          severity: 'fail',
          queue:    node.name,
          resource: res,
          title:    `${ node.name }: ${ unit } limit (${ lim }) is below its quota (${ q })`,
          detail:   `The queue guarantees ${ q } ${ unit } but caps consumption at ${ lim }. Raise the limit to at least the quota, or lower the quota.`,
        });
      }

      // a guarantee no ancestor can honour
      const parentCap = node.parent ? effectiveCap(node.parent, index, res).cap : Infinity;
      const guarantee = expand(q);

      if (node.parent && Number.isFinite(parentCap) && guarantee > parentCap) {
        out.push({
          id:       `quota-above-parent/${ node.name }/${ res }`,
          severity: 'warn',
          queue:    node.name,
          resource: res,
          title:    `${ node.name } is guaranteed more ${ unit } than its parent allows`,
          detail:   `Quota ${ guarantee } ${ unit }, but the chain through "${ node.parent }" caps it at ${ parentCap }. The extra is unreachable.`,
        });
      }

      // children collectively promised more than the parent guarantees
      if (node.children.length) {
        const childSum = node.children.reduce((s, c) => s + expand(index[c].quota[res]), 0);
        const own = expand(q);

        if (Number.isFinite(childSum) && Number.isFinite(own) && childSum > own) {
          out.push({
            id:       `oversubscribed/${ node.name }/${ res }`,
            severity: 'warn',
            queue:    node.name,
            resource: res,
            title:    `${ node.name } is oversubscribed: children guarantee ${ childSum } ${ unit }, parent only ${ own }`,
            detail:   `${ node.children.map((c) => `${ c }=${ expand(index[c].quota[res]) }`).join(', ') }. Under contention the scheduler cannot satisfy every child's guarantee at once; over-quota weights decide who loses.`,
          });
        }
      }

      // a leaf that can never run anything
      if (node.isLeaf && ownCap(node, res) === 0 && res === 'gpu') {
        out.push({
          id:       `zero-cap/${ node.name }/${ res }`,
          severity: 'info',
          queue:    node.name,
          resource: res,
          title:    `${ node.name } cannot run ${ unit } workloads`,
          detail:   `Both quota and limit are 0, so every ${ unit } request in this queue stays pending. Set a quota, or a limit for over-quota-only access.`,
        });
      }
    }

    // roots promising more than the hardware has
    const roots = nodes.filter((n) => !n.parent);
    const rootSum = roots.reduce((s, n) => s + expand(n.quota[res]), 0);
    const total = capacity.total[res] ?? 0;

    if (Number.isFinite(rootSum) && total > 0 && rootSum > total) {
      out.push({
        id:       `cluster-oversubscribed/${ res }`,
        severity: 'warn',
        queue:    '',
        resource: res,
        title:    `Top-level queues guarantee ${ rootSum } ${ unit } but the cluster has ${ total }`,
        detail:   `${ roots.map((r) => `${ r.name }=${ expand(r.quota[res]) === Infinity ? '∞' : expand(r.quota[res]) }`).join(', ') }. Guarantees are only meaningful up to physical capacity.`,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------------------------
// Live usage
//
// status.allocated is the documented source for "what is this queue using", and KAI's queue
// controller does populate it. Run:AI's does not always: on the altra-ai cluster every Queue has an
// empty status block except for childQueues. Trusting status alone therefore reports 0 GPUs in use
// on a full cluster, which is worse than reporting nothing. So we always compute usage from pods
// and fall back to it whenever a queue's status is missing.
//
// The two products also bind workloads to queues differently:
//   KAI    label kai.scheduler/queue on the pod (propagated from the Job/PyTorchJob by PodGrouper)
//   Run:AI label runai/queue on the *namespace*, and label project on the pod
// All three are checked, pod labels first.

export const KAI_QUEUE_LABEL = 'kai.scheduler/queue';
export const RUNAI_QUEUE_LABEL = 'runai/queue';
/** Run:AI's pod-side queue binding. Deliberately generic, so only read as a last resort. */
export const RUNAI_POD_QUEUE_LABEL = 'project';
/**
 * Run:AI treats an unversioned namespace as pre-v2 and gives it none of the v2 queue accounting,
 * so a namespace meant for Run:AI carries this alongside runai/queue. KAI ignores it.
 */
export const RUNAI_NS_VERSION_LABEL = 'runai/namespace-version';

export interface PodLike {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: { nodeName?: string; schedulerName?: string; containers?: any[]; initContainers?: any[] };
  status?: { phase?: string };
}

/** namespace name -> queue name, from the namespace labels either product may set. */
export function namespaceQueueMap(namespaces: { metadata?: { name?: string; labels?: Record<string, string> } }[]): Record<string, string> {
  const out: Record<string, string> = {};

  for (const ns of namespaces || []) {
    const name = ns?.metadata?.name;
    const labels = ns?.metadata?.labels || {};
    const q = labels[KAI_QUEUE_LABEL] || labels[RUNAI_QUEUE_LABEL];

    if (name && q) {
      out[name] = q;
    }
  }

  return out;
}

export function resolvePodQueue(pod: PodLike, nsQueue: Record<string, string>): string | null {
  const labels = pod?.metadata?.labels || {};

  // `project` last, and only for a pod the Run:AI scheduler owns: on any other pod the word means
  // whatever its author meant by it, and a wrong match bills someone else's queue.
  const runaiPodQueue = pod?.spec?.schedulerName === 'runai-scheduler' ? labels[RUNAI_POD_QUEUE_LABEL] : undefined;

  return labels[KAI_QUEUE_LABEL] || labels[RUNAI_QUEUE_LABEL] || runaiPodQueue ||
    nsQueue[pod?.metadata?.namespace || ''] || null;
}

/**
 * GPU units a pod holds. Devices are integer-ish and cannot be overcommitted, so the limit is the
 * truth; requests are only consulted when no limit is set. Init containers run before the app
 * containers, so their devices are not held concurrently — except for sidecars (restartPolicy
 * Always), which are.
 */
export function podGpuRequest(pod: PodLike, gpuResourceName = 'nvidia.com/gpu'): number {
  const of = (c: any): number => {
    const r = c?.resources || {};

    return toNumber(r.limits?.[gpuResourceName] ?? r.requests?.[gpuResourceName]);
  };
  let total = 0;

  for (const c of pod?.spec?.containers || []) {
    total += of(c);
  }
  for (const c of pod?.spec?.initContainers || []) {
    if (c?.restartPolicy === 'Always') {
      total += of(c);
    }
  }

  return total;
}

export function isPodHoldingResources(pod: PodLike): boolean {
  return !['Succeeded', 'Failed'].includes(pod?.status?.phase || '');
}

export interface PodUsage {
  /** per-queue GPU usage, already rolled up so a parent includes its descendants */
  byQueue: Record<string, number>;
  /** GPU units held by pods that belong to no queue at all (DaemonSets, default-scheduler work) */
  unqueued: number;
  /** total GPU units held cluster-wide */
  total: number;
}

export function usageFromPods(
  pods: PodLike[],
  nsQueue: Record<string, string>,
  index: QueueIndex,
  gpuResourceName = 'nvidia.com/gpu',
  // MiB per GPU, to charge a KAI gpu-memory share as a fraction of one; 0 = unknown
  gpuMiB = 0,
): PodUsage {
  const byQueue: Record<string, number> = {};
  let unqueued = 0;
  let total = 0;

  for (const pod of pods || []) {
    // KAI's reservation pod holds a whole GPU on behalf of the fractional pods sharing it; those
    // are charged below, so counting it would also bill the GPU to no project.
    if (!isPodHoldingResources(pod) || (pod as any)?.metadata?.namespace === 'kai-resource-reservation') {
      continue;
    }
    const ann = (pod as any)?.metadata?.annotations || {};
    const frac = Number(ann['gpu-fraction']) || (gpuMiB > 0 && Number(ann['gpu-memory']) ? Math.ceil((Number(ann['gpu-memory']) / gpuMiB) * 100) / 100 : 0);
    const gpu = frac || podGpuRequest(pod, gpuResourceName);

    if (gpu <= 0) {
      continue;
    }
    total += gpu;

    const q = resolvePodQueue(pod, nsQueue);

    if (!q || !index[q]) {
      unqueued += gpu;
      continue;
    }
    // charge the queue and every ancestor, matching status.allocated semantics
    byQueue[q] = (byQueue[q] || 0) + gpu;
    for (const a of ancestors(q, index)) {
      byQueue[a.name] = (byQueue[a.name] || 0) + gpu;
    }
  }

  return {
    byQueue, unqueued, total
  };
}

/**
 * Returns a copy of the index with GPU usage filled in from pods for any queue whose status the
 * scheduler has not reported. Queues that do publish status keep it, since the scheduler sees
 * fractional GPU sharing that pod specs alone do not express.
 */
export function withPodUsage(index: QueueIndex, usage: PodUsage): QueueIndex {
  const out: QueueIndex = {};

  for (const [name, node] of Object.entries(index)) {
    if (!node.statusMissing) {
      out[name] = node;
      continue;
    }
    const gpu = usage.byQueue[name] || 0;

    out[name] = {
      ...node,
      allocated: { ...node.allocated, gpu },
      requested: { ...node.requested, gpu },
    };
  }

  return out;
}

/**
 * Physical cluster capacity from node objects plus the pods actually holding devices.
 * GPU "free" is deliberately computed from pod requests rather than from queue status: a pod from
 * outside any queue (a DaemonSet, or anything on the default scheduler) still consumes the device,
 * and quota accounting would not see it.
 */
export interface CapacityInputs {
  nodes: { allocatable?: Record<string, string | number>; unschedulable?: boolean }[];
  /** GPU units requested by non-terminal pods */
  gpuInUse: number;
  gpuResourceName?: string;
}

export function clusterCapacity({ nodes, gpuInUse, gpuResourceName = 'nvidia.com/gpu' }: CapacityInputs): ClusterCapacity {
  let gpuTotal = 0;

  for (const n of nodes || []) {
    if (n.unschedulable) {
      continue;
    }
    gpuTotal += toNumber(n.allocatable?.[gpuResourceName]);
  }

  return {
    total: {
      gpu: gpuTotal, cpu: 0, memory: 0
    },
    free: {
      gpu: Math.max(0, gpuTotal - Math.max(0, gpuInUse)), cpu: 0, memory: 0
    },
  };
}
