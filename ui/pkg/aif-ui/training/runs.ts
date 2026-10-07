// The Workloads list: training runs (gpu-train-job releases) and inference endpoints (AI Factory
// AIWorkloads) in one table, with one vocabulary for type, profile, resources and state.
//
// Pure: the page lists the objects, passes them in, and renders what comes back.

import { GPU_RESOURCE } from './config';
import {
  BlueprintSummary, endpointUrl, findBlueprint, summarizeBlueprint, WORKLOAD_PROFILE_LABEL
} from './inference';
import { PROFILE_ANNOTATION, Profile } from './profiles';
import { gib, podMpsLimit } from './gpushare';
import { byRank } from './pods';
import { TrainingRun } from './trainingruns';

export type RunType = 'training' | 'inference';
// One set of states for both kinds, so the State filter and colours mean the same thing everywhere.
export type RunState = 'Running' | 'Queued' | 'Pending' | 'Deploying' | 'Degraded' | 'Completed' | 'Failed' | 'Suspended' | 'Cancelled' | 'Reclaimed';

export interface Run {
  key: string; // "<type>/<namespace>/<name>"
  type: RunType;
  name: string;
  namespace: string;
  profile: string; // profile name, '' when submitted from the full form
  profileLabel: string; // display name, or "Custom" for a form submission
  gpus: number;
  resources: string; // "2 × A2000"
  state: RunState;
  created: string; // ISO timestamp
  url: string; // inference only: where clients connect
  obj: any; // what Delete acts on: the AIJob, else the Helm App (or bare Job), for training; the AIWorkload for inference
  pods: any[]; // training: in rank order; inference: engine, router, gateway, database
  clusterId?: string; // where the pods are, when not on this cluster (a run in a compute pool)
  training: TrainingRun | null; // the Jobs-page row, for the detail panel
  inference: { blueprint: string; components: string[]; workload: any } | null;
}

const TRAINING_STATE: Record<string, RunState> = {
  Running: 'Running', Scheduling: 'Pending', Pending: 'Pending', Queued: 'Queued', Suspended: 'Suspended', Complete: 'Completed', Finished: 'Completed', Failed: 'Failed', Cancelled: 'Cancelled', Reclaimed: 'Reclaimed'
};

const INFERENCE_STATE: Record<string, RunState> = {
  Running: 'Running', Ready: 'Running', Pending: 'Deploying', Deploying: 'Deploying', Degraded: 'Degraded', Failed: 'Failed', Error: 'Failed'
};

/** GPUs one pod of a training run asks for: the nvidia.com/gpu limit, or its DRA claim templates' device count. */
export function gpusPerPod(podSpec: any, namespace: string, claimTemplates: any[]): number {
  const containers: any[] = podSpec?.containers || [];
  const dp = containers.reduce((n, c) => n + (parseInt(c?.resources?.limits?.[GPU_RESOURCE] || c?.resources?.requests?.[GPU_RESOURCE] || '0', 10) || 0), 0);

  if (dp > 0) {
    return dp;
  }

  return (podSpec?.resourceClaims || []).reduce((n: number, rc: any) => {
    const t = claimTemplates.find((x) => x?.metadata?.name === rc?.resourceClaimTemplateName && x?.metadata?.namespace === namespace);
    const reqs: any[] = t?.spec?.spec?.devices?.requests || [];

    // the ComputeDomain channel claim is not a GPU
    return n + reqs.filter((r) => /gpu/.test(r?.exactly?.deviceClassName || r?.deviceClassName || '')).reduce((m, r) => m + (Number(r?.exactly?.count ?? r?.count) || 1), 0);
  }, 0);
}

function podSpecOf(job: any): any {
  if (!job) {
    return null;
  }
  const specs = job.spec?.pytorchReplicaSpecs;

  return specs ? (specs.Master || specs.Worker)?.template?.spec : job.spec?.template?.spec;
}

function gpuLabel(p: Profile | undefined): string {
  return p?.gpu && p.gpu !== 'any' ? p.gpu : 'GPU';
}

export function trainingToRuns(runs: TrainingRun[], profiles: Profile[], claimTemplates: any[]): Run[] {
  return runs.map((r): Run => {
    // the release annotation (UI installs through Rancher) or the Job label (chart value profile: CLI, SDK)
    // ... or the AIJob, which keeps it after the Job and release are gone
    const name = r.app?.spec?.chart?.metadata?.annotations?.[PROFILE_ANNOTATION] || r.job?.metadata?.labels?.[PROFILE_ANNOTATION] ||
      r.aiJob?.spec?.profile || '';
    const p = profiles.find((x) => x.name === name);
    const nodes = typeof r.nodes === 'number' ? r.nodes : parseInt(String(r.nodes), 10) || 0;
    const spec = podSpecOf(r.job);
    const shared = (spec?.resourceClaims || []).some((rc: any) => rc?.resourceClaimName);
    const cap = shared ? podMpsLimit({ spec }) : null;
    const per = shared ? 1 : gpusPerPod(spec, r.namespace, claimTemplates);
    // A KAI GPU-memory share: the pod template's annotation, or the AIJob's values once the Job is gone.
    const shareMiB = Number(r.job?.spec?.template?.metadata?.annotations?.['gpu-memory']) || Number(r.aiJob?.spec?.values?.gpu?.sharedMemoryMiB) || 0;
    // what the AIJob recorded while the pods existed
    const recorded = Number(r.aiJob?.status?.resources?.gpuCount) || 0;
    const gpus = nodes * per || recorded;

    return {
      key:          `training/${ r.namespace }/${ r.name }`,
      type:         'training',
      name:         r.name,
      namespace:    r.namespace,
      profile:      name,
      profileLabel: p?.displayName || name || 'Custom',
      gpus,
      // a release whose Job is gone has no pod spec left to count from
      resources:    shareMiB ? `${ gib(shareMiB * Math.max(1, nodes)) } of ${ gpuLabel(p) } (share)` : shared ? `${ cap ? gib(cap * nodes) : 'share' } of ${ gpuLabel(p) } (shared)` : gpus > 0 ? `${ gpus } × ${ gpuLabel(p) }` : r.job ? `${ nodes } pod${ nodes === 1 ? '' : 's' }` : '—',
      state:        TRAINING_STATE[r.phase] || 'Pending',
      created:      r.age || '',
      url:          '',
      // deleting an AIJob uninstalls its release first (the operator's finalizer)
      obj:          r.aiJob || r.app || r.job,
      pods:         [...(r.pods || [])].sort(byRank),
      clusterId:    r.clusterId,
      training:     r,
      inference:    null,
    };
  });
}

// Order an endpoint's pods by what they do: the engine first, since that is where a slow start or
// an out-of-memory shows, then the router, the gateway and its database, then anything else.
const ROLE_ORDER = ['serving-engine', 'router', 'litellm', 'postgresql'];

/** What a pod does within an endpoint: its component label, or its name label. */
export function podRole(pod: any): string {
  const l = pod?.metadata?.labels || {};

  return l['app.kubernetes.io/component'] || l['app.kubernetes.io/name'] || '';
}

function roleRank(pod: any): number {
  const i = ROLE_ORDER.indexOf(podRole(pod));

  return i < 0 ? ROLE_ORDER.length : i;
}

/**
 * The pods an AIWorkload's blueprint installed: those in its namespace whose Helm instance label is
 * one of the blueprint's release names. Every chart the blueprints use sets that label.
 */
export function workloadPods(pods: any[], namespace: string, releaseNames: string[]): any[] {
  return pods
    .filter((p) => p?.metadata?.namespace === namespace && releaseNames.includes(p?.metadata?.labels?.['app.kubernetes.io/instance']))
    .sort((a, b) => roleRank(a) - roleRank(b) || String(a.metadata.name).localeCompare(String(b.metadata.name)));
}

export function inferenceToRuns(workloads: any[], blueprints: any[], profiles: Profile[], pods: any[] = []): Run[] {
  return workloads
    .filter((w) => w?.metadata?.labels?.[WORKLOAD_PROFILE_LABEL])
    .map((w): Run => {
      const name = w.metadata.labels[WORKLOAD_PROFILE_LABEL];
      const p = profiles.find((x) => x.name === name);
      const ref = w.spec?.source?.blueprint;
      const obj = ref ? findBlueprint(blueprints, ref) : null;
      const s: BlueprintSummary | null = ref && obj ? summarizeBlueprint(obj, ref) : null;
      const gpus = s ? s.gpusPerReplica * s.replicas : 0;

      return {
        key:          `inference/${ w.metadata.namespace }/${ w.metadata.name }`,
        type:         'inference',
        name:         w.metadata.name,
        namespace:    w.metadata.namespace,
        profile:      name,
        profileLabel: p?.displayName || name,
        gpus,
        resources:    s?.sharedClaim ? `${ s.mpsLimitMiB ? gib(s.mpsLimitMiB * s.replicas) : 'share' } of ${ gpuLabel(p) } (shared)` : gpus > 0 ? `${ gpus } × ${ gpuLabel(p) }` : '—',
        state:        INFERENCE_STATE[w.status?.phase || 'Pending'] || 'Deploying',
        created:      w.metadata.creationTimestamp || '',
        url:          s ? endpointUrl(s, w.spec?.targetNamespace || w.metadata.namespace) : '',
        obj:          w,
        pods:         s ? workloadPods(pods, w.spec?.targetNamespace || w.metadata.namespace, s.releaseNames) : [],
        training:     null,
        inference:    {
          blueprint: ref ? `${ s?.displayName || ref.name } ${ ref.version }` : '—', components: s?.components || [], workload: w
        },
      };
    });
}

// ---- filter, sort, page ----

export interface RunFilter {
  type: '' | RunType; // the tab
  text: string;
  project: string;
  profile: string;
  state: '' | RunState;
}

export const ALL_RUNS: RunFilter = {
  type: '', text: '', project: '', profile: '', state: ''
};

export function filterRuns(runs: Run[], f: RunFilter): Run[] {
  const words = f.text.toLowerCase().split(/\s+/).filter(Boolean);

  return runs.filter((r) => (!f.type || r.type === f.type) &&
    (!f.project || r.namespace === f.project) &&
    (!f.profile || r.profile === f.profile || (f.profile === '(custom)' && !r.profile)) &&
    (!f.state || r.state === f.state) &&
    words.every((w) => [r.name, r.namespace, r.profileLabel, r.resources, r.state, r.type].join(' ').toLowerCase().includes(w)));
}

export type RunSortKey = 'name' | 'type' | 'profile' | 'project' | 'resources' | 'state' | 'created';

export function sortRuns(runs: Run[], key: RunSortKey, desc: boolean): Run[] {
  const val = (r: Run): string | number => ({
    name: r.name, type: r.type, profile: r.profileLabel, project: r.namespace, resources: r.gpus, state: r.state, created: r.created
  })[key];
  const out = [...runs].sort((a, b) => {
    const x = val(a); const y = val(b);

    return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
  });

  return desc ? out.reverse() : out;
}

export function pageOf<T>(items: T[], page: number, size: number): { items: T[]; page: number; pages: number; from: number; to: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(1, page), pages);
  const start = (p - 1) * size;

  return {
    items: items.slice(start, start + size), page: p, pages, from: items.length ? start + 1 : 0, to: Math.min(items.length, start + size)
  };
}

/** "12m ago", "3h ago", "2d ago": the Created column. */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);

  if (!Number.isFinite(t)) {
    return '—';
  }
  const s = Math.max(0, Math.round((now - t) / 1000));

  if (s < 60) {
    return `${ s }s ago`;
  }
  if (s < 3600) {
    return `${ Math.floor(s / 60) }m ago`;
  }
  if (s < 86400) {
    return `${ Math.floor(s / 3600) }h ago`;
  }

  return `${ Math.floor(s / 86400) }d ago`;
}
