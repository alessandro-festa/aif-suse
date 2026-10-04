// Shared GPUs: one ResourceClaim, configured for MPS, that several workloads attach to by name, so
// they run on the same physical GPU at the same time. Each workload caps its own GPU memory with
// CUDA_MPS_PINNED_DEVICE_MEM_LIMIT, which MPS enforces per process (tested on an RTX A2000: a pod
// capped at 4 GiB was refused past it while another, at 6 GiB, ran beside it).
//
// The claim is the platform admin's: one per GPU to share, in each project namespace that shares,
// labelled trainingjobs/gpu-share. A workload asks for "shared, N GiB"; the page attaches it to the
// project's shared claim and the pre-flight checks the memory left on that GPU.
//
// Why not DRA consumable capacity (ConsumableShares): it needs DRA driver v0.5+ and the alpha
// DRAConsumableCapacity gate on Kubernetes 1.34/1.35, it only accounts capacity at scheduling (no
// runtime memory limit), and the driver does not support MPS with it.

import type { Check, Facts, Form } from './preflight';
import { gpuShort } from './gputypes';
import { GPU_DEVICE_CLASS } from './config';

export const GPU_SHARE_LABEL = 'trainingjobs/gpu-share';
export const MPS_LIMIT_ENV = 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT';
export const SHARED_CLAIM_MANIFEST = 'examples/training/gpu-sharing/gpu-shared-claim.yaml';

export interface SharedGpuUser { pod: string; limitMiB: number | null }

export interface SharedGpu {
  name: string;
  namespace: string;
  strategy: string; // MPS, TimeSlicing
  defaultLimitMiB: number | null; // the claim's per-client default, used for a client with no cap of its own
  allocated: boolean;
  node: string;
  product: string; // of the allocated device; '' until the first workload allocates the claim
  totalMiB: number; // memory of the allocated device; 0 until allocated
  users: SharedGpuUser[]; // pods attached to the claim that have not finished
  usedMiB: number; // sum of the users' caps (a user without one counts at the claim default)
}

const UNITS: Record<string, number> = {
  '': 1 / (1024 * 1024), K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024
};

/** MiB from an MPS limit: "0=4096M", "4G", "0=7G,1=2G" (first device), or a Kubernetes quantity "5500Mi". */
export function parseMpsLimit(v: string | undefined | null): number | null {
  if (!v) {
    return null;
  }
  const first = String(v).split(',')[0].trim();
  const m = (first.includes('=') ? first.split('=')[1] : first).trim().match(/^([0-9.]+)\s*([KMGT]?)(i?)B?$/i);

  if (!m) {
    return null;
  }

  return Math.round(parseFloat(m[1]) * (UNITS[m[2].toUpperCase()] ?? 1));
}

/** The MPS sharing config of a claim, or null when it is not a shared claim. */
function sharingOf(claim: any): { strategy: string; defaultLimitMiB: number | null } | null {
  for (const c of claim?.spec?.devices?.config || []) {
    const p = c?.opaque?.parameters;

    if (c?.opaque?.driver === GPU_DEVICE_CLASS && p?.kind === 'GpuConfig' && p?.sharing?.strategy) {
      return { strategy: String(p.sharing.strategy), defaultLimitMiB: parseMpsLimit(p.sharing.mpsConfig?.defaultPinnedDeviceMemoryLimit) };
    }
  }

  return null;
}

/** The cap a pod sets for itself (its first container that sets one). */
export function podMpsLimit(pod: any): number | null {
  for (const c of pod?.spec?.containers || []) {
    const e = (c?.env || []).find((x: any) => x?.name === MPS_LIMIT_ENV);

    if (e?.value) {
      return parseMpsLimit(e.value);
    }
  }

  return null;
}

export function sharedGpus(claims: any[], pods: any[], slices: any[]): SharedGpu[] {
  return (claims || []).map((c): SharedGpu | null => {
    const sharing = sharingOf(c);

    // MPS shares by construction; the label marks claims meant for sharing under other strategies
    if (!sharing || (sharing.strategy !== 'MPS' && !c?.metadata?.labels?.[GPU_SHARE_LABEL])) {
      return null;
    }
    const r = c.status?.allocation?.devices?.results?.[0];
    let product = ''; let totalMiB = 0; let node = '';

    if (r) {
      const s = (slices || []).find((x) => x?.spec?.driver === GPU_DEVICE_CLASS && (x.spec?.pool?.name || x.spec?.nodeName) === r.pool);
      const d = (s?.spec?.devices || []).find((x: any) => x?.name === r.device);

      product = d?.attributes?.productName?.string || '';
      totalMiB = parseMpsLimit(d?.capacity?.memory?.value) || 0;
      node = s?.spec?.nodeName || r.pool || '';
    }
    const users = (pods || [])
      .filter((p) => p?.metadata?.namespace === c.metadata.namespace && !['Succeeded', 'Failed'].includes(p?.status?.phase) &&
        (p?.spec?.resourceClaims || []).some((rc: any) => rc?.resourceClaimName === c.metadata.name))
      .map((p) => ({ pod: p.metadata.name, limitMiB: podMpsLimit(p) }));

    return {
      name:            c.metadata.name,
      namespace:       c.metadata.namespace,
      strategy:        sharing.strategy,
      defaultLimitMiB: sharing.defaultLimitMiB,
      allocated:       !!r,
      node,
      product,
      totalMiB,
      users,
      usedMiB:         users.reduce((n, u) => n + (u.limitMiB ?? sharing.defaultLimitMiB ?? 0), 0),
    };
  }).filter((x): x is SharedGpu => !!x);
}

export function gib(mib: number): string {
  return `${ (mib / 1024).toFixed(1).replace(/\.0$/, '') } GiB`;
}

/**
 * The checks for running on a shared GPU: the project has one, the run asks for one GPU per pod,
 * and the memory the run asks for fits next to what the other users capped themselves at.
 * `pods` is how many pods of this run attach (each is an MPS client with its own cap).
 */
export function sharedGpuChecks(namespace: string, claimName: string, requestMiB: number, pods: number, gpusPerPod: number, f: Facts, mode: string, scheduler: string): Check[] {
  const out: Check[] = [];
  const add = (severity: Check['severity'], title: string, detail = '') => out.push({
    id: 'gpu-share', severity, title, detail
  });

  if (mode !== 'dra') {
    add('fail', 'Sharing a GPU needs KAI or DRA', 'Either schedule with KAI (Scheduling: KAI scheduler; a project bound to a KAI queue picks it), which queues GPU-memory shares, or use GPU request mode dra with the project\'s MPS shared claim. Or use exclusive allocation.');

    return out;
  }
  const inNs = (f.sharedGpus || []).filter((g) => g.namespace === namespace);
  const g = inNs.find((x) => x.name === claimName) || (!claimName ? inNs[0] : undefined);

  if (!g) {
    add('fail', `No shared GPU in ${ namespace || 'this project' }`, inNs.length ? `Claim ${ claimName } is not one of this project's shared GPUs (${ inNs.map((x) => x.name).join(', ') }).` : `A platform admin creates one for the project: a ResourceClaim configured for MPS, labelled ${ GPU_SHARE_LABEL } (kubectl apply -f ${ SHARED_CLAIM_MANIFEST }, with its namespace changed).`);

    return out;
  }
  if (gpusPerPod !== 1) {
    add('fail', 'A shared GPU gives each pod one GPU', `Set GPUs per worker to 1 (now ${ gpusPerPod }).`);
  }
  if (requestMiB <= 0) {
    add('fail', 'Set how much GPU memory this run may use', 'Each workload on a shared GPU is capped; the cap is what keeps one from starving the others.');

    return out;
  }
  const total = g.totalMiB || f.gpuDeviceMemory / (1024 * 1024);
  const want = requestMiB * Math.max(1, pods);
  const free = Math.max(0, total - g.usedMiB);
  const who = g.users.length ? ` In use: ${ g.users.map((u) => `${ u.pod } ${ u.limitMiB === null ? `(claim default ${ g.defaultLimitMiB === null ? '?' : gib(g.defaultLimitMiB) })` : gib(u.limitMiB) }`).join(', ') }.` : '';
  const where = g.product ? `${ gpuShort(g.product) } on ${ g.node }` : 'not allocated yet';

  if (!g.allocated && f.draDevices - f.draAllocated < 1) {
    add('fail', `Shared GPU ${ g.name } is not allocated, and no GPU is free for it`, 'The first workload to use the shared claim allocates a free GPU, and every GPU is held by another claim.');
  } else if (total > 0 && want > free) {
    add('fail', `Not enough memory left on shared GPU ${ g.name }`, `${ gib(want) } requested${ pods > 1 ? ` (${ pods } pods × ${ gib(requestMiB) })` : '' }, ${ gib(free) } of ${ gib(total) } left (${ where }).${ who }`);
  } else {
    add('pass', `Shared GPU ${ g.name }: ${ gib(want) } of ${ total > 0 ? `${ gib(free) } left` : 'memory' }`, `${ g.strategy }, ${ where }. MPS enforces this run's cap.${ who }`);
  }
  if (scheduler === 'kueue') {
    out.push({
      id: 'gpu-share', severity: 'info', title: 'Not queued by Kueue', detail: 'Kueue cannot admit a pod that attaches to an existing ResourceClaim (it marks the workload Inadmissible), so a run on a shared GPU starts without the queue and is not charged to it. The shared GPU is already allocated; MPS caps each run\'s memory.'
    });
  }

  return out;
}

/**
 * Checks for a GPU-memory share under KAI: KAI places the pod on a GPU by its gpu-memory annotation,
 * waits in the queue while no GPU has the memory free, and HAMi-core or NvFractions caps it. No claim
 * is involved, so the questions are only whether the share is well formed and can ever fit.
 */
export function kaiShareChecks(requestMiB: number, gpusPerPod: number, f: Facts, scheduler: string): Check[] {
  const out: Check[] = [];
  const add = (severity: Check['severity'], title: string, detail = '') => out.push({
    id: 'gpu-share', severity, title, detail
  });
  const gpuMiB = f.gpuNodeMemoryMiB || 0;

  if (gpusPerPod !== 1) {
    add('fail', 'A GPU-memory share is part of one GPU per pod', `Set GPUs per worker to 1 (now ${ gpusPerPod }).`);
  }
  if (requestMiB <= 0) {
    add('fail', 'Set how much GPU memory this run may use', 'The share is what the scheduler reserves and what the run is capped at.');

    return out;
  }
  if (!f.devicePluginGpus) {
    add('fail', `${ scheduler } shares GPUs through the device plugin`, 'No node advertises nvidia.com/gpu. KAI does not place GPU-memory shares on GPUs published only through DRA.');
  } else if (f.draDevices > 0) {
    add('warn', 'Some GPUs are published through DRA', `${ scheduler } refuses GPU-memory shares on a node whose GPUs appear in a DRA ResourceSlice ("not yet supported on DRA-only nodes"). Shares only land on device-plugin GPU nodes.`);
  }
  if (gpuMiB > 0 && requestMiB > gpuMiB) {
    add('fail', `${ gib(requestMiB) } is more than a whole GPU (${ gib(gpuMiB) })`, 'Use exclusive allocation, or a smaller share.');
  } else {
    const frac = gpuMiB > 0 ? Math.ceil((requestMiB / gpuMiB) * 100) / 100 : null;

    add('info', `Queued by ${ scheduler }: ${ gib(requestMiB) }${ frac ? ` (${ frac } of a ${ gib(gpuMiB) } GPU)` : '' }`,
      `The run waits in its queue until a GPU has ${ gib(requestMiB) } free, then starts beside other workloads. The cap is enforced by KAI's GPU sharing (HAMi-core or NvFractions).${ gpuMiB ? '' : ' GPU memory per node is unknown (no nvidia.com/gpu.memory label), so the fraction is not shown.' }`);
  }

  return out;
}

/** The shared claim a form should attach to: the one it names if the namespace has it, else the namespace's first. */
export function pickSharedClaim(form: Form, f: Facts): string {
  const inNs = (f.sharedGpus || []).filter((g) => g.namespace === form.namespace);

  return inNs.find((g) => g.name === form.gpuSharedClaim)?.name || inNs[0]?.name || '';
}
