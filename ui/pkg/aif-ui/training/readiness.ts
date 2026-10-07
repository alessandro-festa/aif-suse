// Readiness: the pre-flight as the person deploying from a profile reads it.
//
// runPreflight() speaks to whoever can fix the cluster ("gpu-node-1 has 2.51 CPU free"). Someone
// deploying from a profile usually cannot, so this regroups the same checks by what they are about,
// says each blocking one in terms of the deployment, and keeps the technical text as detail rather
// than dropping it. It also separates the profile's limits from what the cluster can run right now,
// which the worker field shows as it is edited.

import {
  Check, Facts, fmtMem, Form, parseCpu, parseMem, Severity
} from './preflight';

export interface ReadinessItem {
  id: string;
  severity: Severity;
  title: string; // in terms of the deployment
  hint: string; // what the person deploying can do, or what it means for them
  detail: string; // the pre-flight's own text, for whoever needs the cluster view
}

export interface ReadinessGroup { key: string; label: string; severity: Severity; count: number }

export interface Readiness {
  ready: boolean;
  blocking: ReadinessItem[];
  recommendations: ReadinessItem[];
  groups: ReadinessGroup[];
  counts: { total: number; passed: number; blocked: number; warnings: number };
}

// Check ids by what they are about. Unlisted ids fall into "Workload".
const GROUPS: { key: string; label: string; ids: RegExp }[] = [
  {
    key: 'policy', label: 'Profile policy', ids: /^profile/
  },
  {
    key: 'project', label: 'Project and quota', ids: /^(namespace|queue.*|quota.*|scheduler|runai-project|rbac|kind.*|chart|pool|project|name|aif|blueprint|required-secret)$/
  },
  {
    key: 'capacity', label: 'GPU capacity', ids: /^(gpu|gpu-in-use|gpu-type|gpu-share|capacity|headroom|cd|model-fit)$/
  },
  {
    key: 'storage', label: 'Storage', ids: /^(ephemeral|ephemeral-free|scratch|disk|ckpt|dataset|pvc.*|configmap|secret|storage-class|hf-token)$/
  },
  {
    key: 'image', label: 'Image', ids: /^(image.*|command)$/
  },
  {
    key: 'network', label: 'Networking', ids: /^(rdzv|nccl|rdma|hostnet)$/
  },
];
const OTHER = { key: 'workload', label: 'Workload' };

const RANK: Record<Severity, number> = {
  fail: 3, warn: 2, info: 1, pass: 0
};

export function groupOf(id: string): { key: string; label: string } {
  return GROUPS.find((g) => g.ids.test(id)) || OTHER;
}

/** The deployment-level wording for a check, or the check's own title when there is none. */
function reword(c: Check, form: Form): { title: string; hint: string } {
  const perWorker = `${ form.cpuRequest } CPU and ${ form.memRequest } memory`;

  if (c.severity === 'fail' || c.severity === 'warn') {
    switch (c.id) {
    case 'headroom':
      return c.severity === 'fail' ? { title: 'No GPU node has room for a worker right now', hint: `Each worker needs ${ perWorker }. Try again when capacity frees up, or ask for a profile with smaller workers.` } : { title: 'Not every worker can start right now', hint: `${ c.title }. The rest wait until capacity frees up. Fewer workers would start now.` };
    case 'ephemeral':
      return { title: 'The profile asks for more local disk than any GPU node has', hint: `${ c.detail } The profile sets this; ask the platform team to lower it. Data, checkpoints and scratch have their own volumes.` };
    case 'ephemeral-free':
      return c.severity === 'fail' ? { title: 'Not enough free local disk on any GPU node', hint: `Each worker needs ${ form.ephemeralRequest } of node disk. Try again later, or ask for a profile that needs less.` } : { title: 'Not enough free local disk right now', hint: `${ c.title }. The run waits in its queue until a node has room.` };
    case 'gpu':
      return /Cannot see/.test(c.title) ? { title: 'Your account cannot see this cluster\'s GPUs', hint: 'Ask your platform admin for the AI Scheduler Cluster Read role in this cluster. Without it the deployment cannot tell how to request a GPU.' } : { title: c.title, hint: 'This cluster has no GPUs available to deployments. Contact your platform admin.' };
    case 'capacity':
      return { title: 'More GPUs than the cluster has', hint: 'The deployment would wait until they exist. Reduce the number of workers.' };
    case 'gpu-in-use':
      return { title: 'GPUs are in use by other workloads', hint: 'The deployment waits until they are released, or reduce the number of workers.' };
    case 'required-secret':
      return { title: c.title, hint: c.severity === 'fail' ? 'The profile needs this Secret in your project before it can run. See Details for how to create it, or ask your platform admin.' : 'Your account cannot list Secrets here, so this was not checked.' };
    case 'gpu-share':
      return { title: c.title, hint: /memory left/.test(c.title) ? 'Other workloads on the shared GPU hold the rest. Ask for less GPU memory, or wait for one to finish.' : /No shared GPU/.test(c.title) ? 'Ask your platform admin to set up a shared GPU for this project.' : '' };
    case 'gpu-type':
      return { title: c.title, hint: c.severity === 'warn' ? 'The run waits until enough GPUs of this model are free.' : 'The profile asks for a GPU model this cluster cannot give it. Ask the platform team.' };
    case 'model-fit':
      return { title: c.title, hint: 'The profile\'s model needs more GPU memory than one device has. Ask the platform team for a profile with a smaller model or more GPUs per replica.' };
    case 'storage-class':
      return { title: 'The model cache cannot be created', hint: 'The profile names a storage class this cluster does not have. Tell the platform team.' };
    case 'image-cache':
      return { title: 'Image not cached yet', hint: 'The first start downloads it, which can take several minutes.' };
    case 'ckpt':
      return { title: 'No checkpoint storage', hint: 'Training state will not survive a worker being replaced. Pick a checkpoint volume under Data.' };
    case 'profile-name':
    case 'profile-nodes':
    case 'profile-image':
    case 'profile-runtime':
    case 'profile-fixed':
      return { title: c.title, hint: 'Set by the profile. Change the value, or ask the platform team for a different profile.' };
    }
  }

  return { title: c.title, hint: '' };
}

export function readiness(checks: Check[], form: Form): Readiness {
  const items = checks.map((c): ReadinessItem => ({
    id: c.id, severity: c.severity, ...reword(c, form), detail: c.detail
  }));
  const groups: ReadinessGroup[] = [];

  checks.forEach((c) => {
    const g = groupOf(c.id);
    let entry = groups.find((x) => x.key === g.key);

    if (!entry) {
      entry = {
        key: g.key, label: g.label, severity: 'pass', count: 0
      };
      groups.push(entry);
    }
    entry.count++;
    if (RANK[c.severity] > RANK[entry.severity] && c.severity !== 'info') {
      entry.severity = c.severity;
    }
  });
  // fixed order, so the list does not reshuffle as checks change
  const order = [...GROUPS.map((g) => g.key), OTHER.key];

  groups.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

  const blocking = items.filter((i) => i.severity === 'fail');
  const recommendations = items.filter((i) => i.severity === 'warn');

  return {
    ready:  blocking.length === 0,
    blocking,
    recommendations,
    groups,
    counts: {
      total: checks.length, passed: checks.filter((c) => c.severity === 'pass').length, blocked: blocking.length, warnings: recommendations.length
    },
  };
}

export interface WorkersNow {
  available: number | null; // null = cannot tell
  gpuOnly: boolean; // CPU/memory could not be read, so only GPUs were counted: an upper bound
  limitedBy: 'gpu' | 'cpu' | 'memory' | 'disk' | '';
}

/**
 * How many workers of this shape the cluster could start right now: GPUs free for the request mode,
 * and on each GPU node how many workers its free CPU, memory and ephemeral storage hold.
 */
export function workersSchedulableNow(form: Form, facts: Facts, gpuMode: 'device-plugin' | 'dra'): WorkersNow {
  const per = Math.max(1, Number(form.gpusPerNode) || 1);
  const gpuFree = gpuMode === 'dra' ? Math.max(0, facts.draDevices - facts.draAllocated) : Math.max(0, facts.capacity?.free?.gpu ?? 0);
  const byGpu = Math.floor(gpuFree / per);

  if (!facts.loaded) {
    return {
      available: null, gpuOnly: false, limitedBy: ''
    };
  }
  if (!facts.podsReadable || !facts.gpuNodes.length) {
    return {
      available: byGpu, gpuOnly: !facts.podsReadable, limitedBy: 'gpu'
    };
  }

  const cpu = parseCpu(form.cpuRequest); const mem = parseMem(form.memRequest) || 0; const eph = parseMem(form.ephemeralRequest) || 0;
  const tally = {
    cpu: 0, memory: 0, disk: 0
  };

  facts.gpuNodes.filter((n) => !n.diskPressure).forEach((n) => {
    tally.cpu += cpu > 0 ? Math.floor(n.cpuFree / cpu) : Infinity;
    tally.memory += mem > 0 ? Math.floor(n.memFree / mem) : Infinity;
    tally.disk += eph > 0 ? Math.floor(n.ephemeralFree / eph) : Infinity;
  });
  // Each resource is summed over nodes separately, so this is an upper bound when different nodes
  // are short of different things; the pre-flight's own headroom check is per node and exact.
  const candidates: [WorkersNow['limitedBy'], number][] = [['gpu', byGpu], ['cpu', tally.cpu], ['memory', tally.memory], ['disk', tally.disk]];
  const [limitedBy, available] = candidates.reduce((a, b) => (b[1] < a[1] ? b : a));

  return {
    available, gpuOnly: false, limitedBy
  };
}

/** Totals for the resource summary: what the whole deployment asks for. */
export function resourceTotals(form: Form): { label: string; value: string }[] {
  const n = Math.max(1, Number(form.nodes) || 1);
  const cpu = parseCpu(form.cpuRequest) * n;
  const mem = (parseMem(form.memRequest) || 0) * n;
  const out = [
    { label: 'GPUs', value: `${ n * (Number(form.gpusPerNode) || 1) }` },
    { label: 'CPU', value: `${ Number.isFinite(cpu) ? +cpu.toFixed(2) : '?' }` },
    { label: 'Memory', value: mem ? fmtMem(mem) : '?' },
  ];

  if (form.scratchSize) {
    out.push({ label: 'Scratch', value: `${ form.scratchSize } per worker` });
  }
  if (form.ephemeralRequest) {
    out.push({ label: 'Local disk', value: `${ form.ephemeralRequest } per worker` });
  }
  out.push({ label: 'Runtime', value: form.runtimeLimitHours ? `≤ ${ form.runtimeLimitHours } h` : 'no limit' });

  return out;
}
