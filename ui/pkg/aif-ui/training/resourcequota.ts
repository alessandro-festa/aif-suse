// Tier-1 GPU quota: a plain Kubernetes ResourceQuota, with no scheduler to install.
//
// Quota enforcement and scheduling policy are separable, and the extension treats them that way:
//
//   enforcement  the API server's ResourceQuota admission controller rejects a pod whose GPU
//                requests would exceed the namespace's hard cap. This happens regardless of which
//                scheduler runs, and is available on every cluster.
//   policy       ordering, gang admission, preemption and borrowing between projects. Only a
//                queueing scheduler (KAI, Kueue) provides these.
//
// So a cluster with nothing but kube-scheduler can still give every project a hard GPU cap. What it
// cannot give is a *guarantee*: ResourceQuota has no floor, only a ceiling, and nothing stops the
// sum of every project's cap exceeding the hardware. auditQuotas already flags that overcommit.
//
// Everything here normalises a ResourceQuota onto the same QueueNode shape the KAI path produces,
// so the rest of the UI does not branch on which backend is in use. In this mapping
// quota === limit: a project may always use up to its cap (hardware permitting) and never beyond,
// which is exactly what a hard cap means.

import { QueueIndex, QueueNode, ResourceName, toNumber } from './quota';

/** Name of the ResourceQuota this extension creates and edits. Distinct from Rancher's own
 *  `default-quota`, which its project-quota controller owns — we never touch that one. */
export const RESOURCE_QUOTA_NAME = 'ai-gpu-quota';

export type QuotaBackend = 'kai' | 'resourcequota';

export interface RawResourceQuota {
  metadata?: { name?: string; namespace?: string };
  spec?: { hard?: Record<string, string | number> };
  status?: { hard?: Record<string, string | number>; used?: Record<string, string | number> };
}

/**
 * A GPU cap can be written three ways. `requests.<res>` is what we create and what the scheduler
 * actually admits against; the others are accepted so a quota an admin wrote by hand still reads.
 * `count/` is deliberately excluded — it counts objects, not devices.
 */
export function gpuQuotaKeys(gpuResource: string): string[] {
  return [`requests.${ gpuResource }`, `limits.${ gpuResource }`, gpuResource];
}

function pick(hard: Record<string, string | number> | undefined, keys: string[]): number | null {
  for (const k of keys) {
    if (hard && hard[k] !== undefined) {
      return toNumber(hard[k]);
    }
  }

  return null;
}

/** The hard cap, preferring status.hard (what the server accepted) over spec.hard (what was asked). */
export function gpuHard(rq: RawResourceQuota, gpuResource: string): number | null {
  const keys = gpuQuotaKeys(gpuResource);

  return pick(rq?.status?.hard, keys) ?? pick(rq?.spec?.hard, keys);
}

/** GPUs currently charged against the quota. Only status carries this. */
export function gpuUsed(rq: RawResourceQuota, gpuResource: string): number {
  return pick(rq?.status?.used, gpuQuotaKeys(gpuResource)) ?? 0;
}

/** True when this ResourceQuota constrains GPUs at all — others (cpu, pods) are not our business. */
export function isGpuQuota(rq: RawResourceQuota, gpuResource: string): boolean {
  return gpuHard(rq, gpuResource) !== null;
}

function zero(): Record<ResourceName, number> {
  return {
    gpu: 0, cpu: 0, memory: 0
  };
}

/**
 * One QueueNode per namespace that has a GPU ResourceQuota. Flat by construction: ResourceQuota has
 * no hierarchy, so every node is a parentless leaf and effectiveCap() resolves to the node's own cap.
 *
 * Several ResourceQuotas may constrain the same namespace; Kubernetes enforces all of them, so the
 * effective cap is the smallest.
 */
export function buildIndexFromResourceQuotas(rqs: RawResourceQuota[], gpuResource: string): QueueIndex {
  const index: QueueIndex = {};

  for (const rq of rqs || []) {
    const ns = rq?.metadata?.namespace;
    const hard = ns ? gpuHard(rq, gpuResource) : null;

    if (!ns || hard === null) {
      continue;
    }

    const used = gpuUsed(rq, gpuResource);
    const existing = index[ns];

    if (existing) {
      existing.quota.gpu = Math.min(existing.quota.gpu, hard);
      existing.limit.gpu = existing.quota.gpu;
      existing.allocated.gpu = Math.max(existing.allocated.gpu, used);
      existing.requested.gpu = existing.allocated.gpu;
      continue;
    }

    const node: QueueNode = {
      name:            ns,
      displayName:     ns,
      parent:          null,
      children:        [],
      priority:        100,
      isLeaf:          true,
      // A hard cap is both the ceiling and, for scheduling purposes, everything the project may
      // ever have — so guarantee and limit are the same number. It is not a reservation: see the
      // overcommit audit for what happens when the caps outrun the hardware.
      quota:           { ...zero(), gpu: hard },
      limit:           { ...zero(), gpu: hard },
      overQuotaWeight: zero(),
      allocated:       { ...zero(), gpu: used },
      requested:       { ...zero(), gpu: used },
      // status.used is maintained by the quota controller, not by a scheduler, so it is never stale
      // in the way an unobserved Queue is.
      statusMissing:   false,
    };

    index[ns] = node;
  }

  return index;
}

export function buildResourceQuotaManifest(namespace: string, gpuHardCap: number, gpuResource: string) {
  return {
    apiVersion: 'v1',
    kind:       'ResourceQuota',
    metadata:   { name: RESOURCE_QUOTA_NAME, namespace },
    spec:       {
      // Only the GPU is capped. Adding cpu/memory here would silently constrain every pod in the
      // namespace, including ones that ask for no GPU at all.
      hard: { [`requests.${ gpuResource }`]: String(gpuHardCap) },
    },
  };
}

/** The body for changing an existing quota in place, preserving any other resources it caps. */
export function applyGpuToResourceQuota(spec: any, gpuHardCap: number, gpuResource: string): any {
  const next = { ...(spec || {}) };
  const hard = { ...(next.hard || {}) };

  // Rewrite whichever spelling is already present so we do not leave a second, tighter key behind.
  const present = gpuQuotaKeys(gpuResource).filter((k) => hard[k] !== undefined);

  if (present.length) {
    for (const k of present) {
      hard[k] = String(gpuHardCap);
    }
  } else {
    hard[`requests.${ gpuResource }`] = String(gpuHardCap);
  }
  next.hard = hard;

  return next;
}
