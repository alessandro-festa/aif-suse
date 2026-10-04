// Training runs as the Jobs page shows them: every Indexed Job and PyTorchJob the gpu-train-job chart
// created, every AIJob (the durable record, which outlives its Job), and every release of that chart
// whose Job is gone (ttlSecondsAfterFinished), with one phase each. Shared by the Jobs page and the Workloads list, so the two cannot disagree on a state.

import { JOB_LABEL, JOB_LABEL_VALUE } from './config';
import { KAI_QUEUE_LABEL, RUNAI_POD_QUEUE_LABEL } from './quota';

export interface TrainingInput {
  jobs: any[];
  pytorchJobs: any[];
  kueueWorkloads: any[];
  apps: any[];
  pods: any[];
  aiJobs?: any[];
}

export interface TrainingRun {
  job: any;
  app: any;
  aiJob?: any;
  name: string;
  namespace: string;
  phase: string; // Pending, Queued, Suspended, Scheduling, Running, Complete, Failed, Finished
  admitted: boolean | null;
  completions: string;
  nodes: number | string;
  image: string;
  scheduler: string;
  queue: string;
  age: string;
  pods: any[];
}

/**
 * The queue a workload was submitted to, whichever of the three schedulers put it there.
 *
 * Kueue labels the Job, KAI labels the pod template, Run:AI labels the pod template with the bare
 * word `project`. That last one is generic enough to mean something else entirely, so it only
 * counts on a pod the Run:AI scheduler owns.
 */
export function queueOf(jobLabels: Record<string, string>, podLabels: Record<string, string>, schedulerName: string): string {
  return jobLabels['kueue.x-k8s.io/queue-name'] || podLabels[KAI_QUEUE_LABEL] ||
    (schedulerName === 'runai-scheduler' ? podLabels[RUNAI_POD_QUEUE_LABEL] : '') || '';
}

function jobRows(i: TrainingInput): TrainingRun[] {
  return i.jobs
    .filter((j) => j.metadata?.labels?.[JOB_LABEL] === JOB_LABEL_VALUE)
    .map((j) => {
      const uid = j.metadata.uid;
      const wl = i.kueueWorkloads.find((w) => (w.metadata?.ownerReferences || []).some((o: any) => o.uid === uid));
      const admitted = wl ? (wl.status?.conditions || []).find((c: any) => c.type === 'Admitted')?.status === 'True' : null;
      const app = i.apps.find((a) => a.spec?.name === j.metadata.name && a.metadata.namespace === j.metadata.namespace);
      const pods = i.pods.filter((p) => p.metadata?.labels?.['job-name'] === j.metadata.name && p.metadata.namespace === j.metadata.namespace);
      const s = j.status || {};
      let phase = 'Pending';

      if (j.spec?.suspend && !s.active) {
        phase = wl ? 'Queued' : 'Suspended';
      } else if (s.succeeded >= (j.spec?.completions || 1)) {
        phase = 'Complete';
      } else if (s.failed && !s.active) {
        phase = 'Failed';
      } else if (s.active) {
        phase = pods.some((p) => p.status?.phase === 'Running') ? 'Running' : 'Scheduling';
        // KAI / Run:AI hold a pod unplaced until its queue has room: that is a queue, not scheduling
        if (phase === 'Scheduling' && pods.length && pods.every((p) => !p.spec?.nodeName && ['kai-scheduler', 'runai-scheduler'].includes(p.spec?.schedulerName))) {
          phase = 'Queued';
        }
      }

      return {
        job:         j,
        app,
        name:        j.metadata.name,
        namespace:   j.metadata.namespace,
        phase,
        admitted,
        completions: `${ s.succeeded || 0 }/${ j.spec?.completions || 1 }`,
        nodes:       j.spec?.completions || 1,
        image:       j.spec?.template?.spec?.containers?.[0]?.image || '',
        scheduler:   j.spec?.template?.spec?.schedulerName || 'default-scheduler',
        queue:       queueOf(j.metadata?.labels || {}, j.spec?.template?.metadata?.labels || {}, j.spec?.template?.spec?.schedulerName || ''),
        age:         j.metadata.creationTimestamp,
        pods,
      };
    });
}

/**
 * PyTorchJobs submitted from this extension. The Training Operator owns the pods, so state comes
 * from status.conditions (the operator's own verdict) rather than from counting pods, and
 * replicaStatuses gives succeeded/total without needing the pods at all.
 */
function pytorchRows(i: TrainingInput): TrainingRun[] {
  return i.pytorchJobs
    .filter((j) => j.metadata?.labels?.[JOB_LABEL] === JOB_LABEL_VALUE)
    .map((j) => {
      const specs = j.spec?.pytorchReplicaSpecs || {};
      const replicas = Object.values(specs).reduce((n: number, r: any) => n + (r?.replicas ?? 1), 0) as number;
      const rs = j.status?.replicaStatuses || {};
      const succeeded = Object.values(rs).reduce((n: number, r: any) => n + (r?.succeeded || 0), 0) as number;
      const active = Object.values(rs).reduce((n: number, r: any) => n + (r?.active || 0), 0) as number;
      const conds = j.status?.conditions || [];
      const latest = [...conds].reverse().find((c: any) => c.status === 'True');
      const master = specs.Master?.template?.spec || specs.Worker?.template?.spec || {};
      const pods = i.pods.filter((p) => p.metadata?.labels?.['training.kubeflow.org/job-name'] === j.metadata.name &&
        p.metadata.namespace === j.metadata.namespace);
      let phase = ({
        Created: 'Pending', Running: 'Running', Restarting: 'Running', Succeeded: 'Complete', Failed: 'Failed', Suspended: 'Suspended'
      } as Record<string, string>)[latest?.type] || 'Pending';

      // The operator reports Created for a job whose pods are all still unschedulable, which for a
      // gang-scheduled run is the normal "waiting for the whole group" state, not an error.
      if (phase === 'Pending' && active) {
        phase = 'Scheduling';
      }

      return {
        job:         j,
        app:         i.apps.find((a) => a.spec?.name === j.metadata.name && a.metadata.namespace === j.metadata.namespace),
        name:        j.metadata.name,
        namespace:   j.metadata.namespace,
        phase,
        admitted:    null,
        completions: `${ succeeded }/${ replicas }`,
        nodes:       replicas,
        image:       master.containers?.[0]?.image || '',
        scheduler:   master.schedulerName || 'default-scheduler',
        queue:       queueOf(j.metadata?.labels || {}, specs.Master?.template?.metadata?.labels || {}, master.schedulerName || ''),
        age:         j.metadata.creationTimestamp,
        pods,
      };
    });
}

// An AIJob's phase in the vocabulary of the rows built from Jobs.
const AIJOB_PHASE: Record<string, string> = {
  Pending: 'Pending', Queued: 'Queued', Admitted: 'Scheduling', Running: 'Running', Succeeded: 'Complete', Failed: 'Failed', Cancelled: 'Cancelled'
};

const key = (o: any) => `${ o?.metadata?.namespace }/${ o?.metadata?.name }`;

// AIJobs whose Job is gone: the record still says what ran and how it ended.
function aiJobRows(i: TrainingInput, live: Set<string>): TrainingRun[] {
  return (i.aiJobs || [])
    .filter((a) => !live.has(key(a)))
    .map((a) => {
      const v = a.spec?.values || {};

      return {
        job:         null,
        app:         null,
        aiJob:       a,
        name:        a.metadata.name,
        namespace:   a.metadata.namespace,
        phase:       AIJOB_PHASE[a.status?.phase] || 'Pending',
        admitted:    a.status?.admittedAt ? true : null,
        completions: '—',
        nodes:       v.job?.nodes ?? '—',
        image:       v.image?.repository ? `${ v.image.repository }:${ v.image.tag || 'latest' }` : '',
        scheduler:   v.scheduler?.type || 'none',
        queue:       a.status?.queue?.name || v.scheduler?.queue || '',
        age:         a.metadata.creationTimestamp,
        pods:        [],
      };
    });
}

// Helm releases of the training chart whose Job has already been garbage-collected
// (ttlSecondsAfterFinished). Shown so users can see history and clean up the release.
function orphanReleases(i: TrainingInput, skip: Set<string>): TrainingRun[] {
  return i.apps
    .filter((a) => a.spec?.chart?.metadata?.name === JOB_LABEL_VALUE && !skip.has(`${ a.metadata.namespace }/${ a.spec?.name }`))
    .map((a) => ({
      job:         null,
      app:         a,
      name:        a.spec?.name,
      namespace:   a.metadata.namespace,
      phase:       'Finished',
      admitted:    null,
      completions: '—',
      nodes:       a.spec?.values?.job?.nodes ?? '—',
      image:       a.spec?.values?.image ? `${ a.spec.values.image.repository }:${ a.spec.values.image.tag }` : '',
      scheduler:   a.spec?.values?.scheduler?.type || 'none',
      queue:       a.spec?.values?.scheduler?.queue || '',
      age:         a.metadata.creationTimestamp,
      pods:        [],
    }));
}

/** Newest first, the order both pages list them in. */
export function trainingRuns(i: TrainingInput): TrainingRun[] {
  const records = new Map((i.aiJobs || []).map((a) => [key(a), a]));
  const live = [...jobRows(i), ...pytorchRows(i)].map((r) => ({ ...r, aiJob: records.get(`${ r.namespace }/${ r.name }`) }));
  const liveKeys = new Set(live.map((r) => `${ r.namespace }/${ r.name }`));
  const fromRecords = aiJobRows(i, liveKeys);
  // a release an AIJob owns is that job's; its row comes from the record
  const skip = new Set([...liveKeys, ...records.keys()]);

  return [...live, ...fromRecords]
    .concat(orphanReleases(i, skip))
    .sort((a, b) => (a.age < b.age ? 1 : -1));
}
