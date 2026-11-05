/**
 * Workloads > Scheduling: the pure part of administering Kubeflow Trainer jobs scheduled by KAI.
 *
 * The cluster side is the aif-training-runtimes chart (ClusterTrainingRuntimes + admission policies
 * + the ai-trainer ClusterRole). Data scientists submit TrainJobs from notebooks with the Kubeflow
 * SDK; this page is the admin's: queues and quotas, which namespaces may train and in which queue,
 * who may train there, the runtimes on offer, and the jobs that ran.
 */

export const MANAGED_LABEL = 'ai-factory.suse.com/managed';
export const QUEUE_LABEL = 'kai.scheduler/queue';
export const PROJECT_ID_LABEL = 'field.cattle.io/projectId';
export const TRAINER_ROLE = 'ai-trainer';
export const NOTEBOOK_SA = 'notebook';
export const RUNTIMES_PART_OF = 'aif-training-runtimes';
// The read on ClusterTrainingRuntimes the ai-trainer role relies on (Trainer's kustomize manifests
// ship it; its Helm chart does not).
export const VIEW_RUNTIMES_ROLE = 'kubeflow-trainer-view-cluster-runtimes';
export const MIN_JOBSET = '0.11.0';

// ---------- readiness ----------

export interface Check {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  /** What fixes it: a key the page can act on, or text for the admin. */
  fix?: { action?: 'create-view-runtimes' | 'create-roletemplate'; text: string };
}

export interface ReadinessInput {
  crds: string[];
  /** Container images of the running pods in the cluster's system namespaces. */
  images: string[];
  runtimes: any[];
  clusterRoles: string[];
  clusterRoleBindings: any[];
  roleTemplates: string[];
}

/** "registry/x/jobset:v0.11.0" -> "0.11.0" ('' when the tag is not a version). */
export function imageVersion(images: string[], match: string): string {
  const img = images.find((i) => i.split('@')[0].split(':')[0].endsWith(match));
  const tag = img?.split('@')[0].split(':')[1] || '';

  return /^v?\d+\.\d+/.test(tag) ? tag.replace(/^v/, '') : '';
}

export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const b = min.split(/[.-]/).map((x) => parseInt(x, 10) || 0);

  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) {
      return (a[i] || 0) > (b[i] || 0);
    }
  }

  return true;
}

function grantsAuthenticated(crbs: any[], role: string): boolean {
  return crbs.some((b) => b?.roleRef?.name === role &&
    (b.subjects || []).some((s: any) => s.kind === 'Group' && s.name === 'system:authenticated'));
}

export function readinessChecks(i: ReadinessInput): Check[] {
  const has = (crd: string) => i.crds.includes(crd);
  const kai = imageVersion(i.images, 'kai-scheduler/scheduler') || imageVersion(i.images, '/scheduler');
  const trainer = imageVersion(i.images, 'trainer-controller-manager');
  const jobset = imageVersion(i.images, 'jobset/jobset') || imageVersion(i.images, '/jobset');
  const ours = i.runtimes.filter((r) => r?.metadata?.labels?.['app.kubernetes.io/part-of'] === RUNTIMES_PART_OF);

  return [
    {
      key:    'kai',
      label:  'KAI Scheduler',
      ok:     has('queues.scheduling.run.ai') && !!kai,
      detail: has('queues.scheduling.run.ai') ? (kai ? `v${ kai }` : 'Queue CRD present, scheduler not running') : 'not installed',
      fix:    { text: 'helm install kai-scheduler oci://ghcr.io/kai-scheduler/kai-scheduler/kai-scheduler -n kai-scheduler --create-namespace' }
    },
    {
      key:    'trainer',
      label:  'Kubeflow Trainer',
      ok:     has('trainjobs.trainer.kubeflow.org') && !!trainer,
      detail: has('trainjobs.trainer.kubeflow.org') ? (trainer ? `v${ trainer }` : 'CRDs present, controller not running') : 'not installed',
      fix:    { text: 'helm install kubeflow-trainer oci://ghcr.io/kubeflow/charts/kubeflow-trainer --version 2.2.1 -n kubeflow-system --create-namespace (Kubernetes 1.32 or later)' }
    },
    {
      key:    'jobset',
      label:  `JobSet ${ MIN_JOBSET } or later`,
      ok:     has('jobsets.jobset.x-k8s.io') && !!jobset && versionAtLeast(jobset, MIN_JOBSET),
      detail: jobset ? `v${ jobset }${ versionAtLeast(jobset, MIN_JOBSET) ? '' : ': too old, runs lose their outputs volume' }` : 'not running',
      fix:    { text: 'JobSet comes with the Trainer chart; 0.10 drops volumeClaimPolicies' }
    },
    {
      key:    'runtimes',
      label:  'AI Factory training runtimes',
      ok:     ours.length > 0,
      detail: ours.length ? ours.map((r) => r.metadata.name).join(', ') : 'chart aif-training-runtimes not installed',
      fix:    { text: 'helm install aif-training-runtimes charts/aif-training-runtimes -n kubeflow-system' }
    },
    {
      key:    'trainer-role',
      label:  'ai-trainer ClusterRole',
      ok:     i.clusterRoles.includes(TRAINER_ROLE),
      detail: i.clusterRoles.includes(TRAINER_ROLE) ? 'present' : 'missing (comes with the runtimes chart)',
    },
    {
      key:    'view-runtimes',
      label:  'Runtimes readable by every user',
      ok:     grantsAuthenticated(i.clusterRoleBindings, VIEW_RUNTIMES_ROLE),
      detail: grantsAuthenticated(i.clusterRoleBindings, VIEW_RUNTIMES_ROLE) ? 'present' : 'missing: the SDK cannot list or get a runtime',
      fix:    { action: 'create-view-runtimes', text: 'Create the read-only grant' }
    },
    {
      key:    'roletemplate',
      label:  'Rancher project role "AI Trainer"',
      ok:     i.roleTemplates.includes(TRAINER_ROLE),
      detail: i.roleTemplates.includes(TRAINER_ROLE) ? 'present' : 'missing: members cannot be granted training',
      fix:    { action: 'create-roletemplate', text: 'Create the role' }
    },
  ];
}

export function viewRuntimesManifests(): any[] {
  return [
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind:       'ClusterRole',
      metadata:   { name: VIEW_RUNTIMES_ROLE, labels: { 'app.kubernetes.io/part-of': 'aif-scheduling' } },
      rules:      [{ apiGroups: ['trainer.kubeflow.org'], resources: ['clustertrainingruntimes'], verbs: ['get', 'list', 'watch'] }]
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind:       'ClusterRoleBinding',
      metadata:   { name: VIEW_RUNTIMES_ROLE, labels: { 'app.kubernetes.io/part-of': 'aif-scheduling' } },
      roleRef:    { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: VIEW_RUNTIMES_ROLE },
      subjects:   [{ kind: 'Group', apiGroup: 'rbac.authorization.k8s.io', name: 'system:authenticated' }]
    }
  ];
}

/**
 * The project role. external: its rules are the downstream cluster's ClusterRole of the same name.
 * Rancher's member picker hides external roles, so this page grants it itself (trainerBinding).
 */
export function roleTemplateManifest(): any {
  return {
    apiVersion:  'management.cattle.io/v3',
    kind:        'RoleTemplate',
    metadata:    { name: TRAINER_ROLE },
    displayName: 'AI Trainer',
    description: 'Submit and follow Kubeflow training runs in the project',
    context:     'project',
    external:    true
  };
}

// ---------- queues ----------

export interface QueueRow {
  name: string;
  parent: string;
  children: string[];
  gpuQuota: number;
  gpuLimit: number;
  cpuQuota: number;
  memoryQuota: number;
  allocatedGpu: string;
  namespaces: string[];
}

const num = (v: any, d = -1) => (typeof v === 'number' ? v : (v === undefined || v === null || v === '' ? d : Number(v)));

export function queueRows(queues: any[], namespaces: any[]): QueueRow[] {
  return queues.map((q) => {
    const r = q?.spec?.resources || {};
    const alloc = q?.status?.allocated || {};

    return {
      name:         q.metadata.name,
      parent:       q.spec?.parentQueue || '',
      children:     q.status?.childQueues || queues.filter((c) => c.spec?.parentQueue === q.metadata.name).map((c) => c.metadata.name),
      gpuQuota:     num(r.gpu?.quota),
      gpuLimit:     num(r.gpu?.limit),
      cpuQuota:     num(r.cpu?.quota),
      memoryQuota:  num(r.memory?.quota),
      allocatedGpu: String(alloc['nvidia.com/gpu'] ?? alloc.gpu ?? '0'),
      namespaces:   namespaces.filter((n) => n.metadata?.labels?.[QUEUE_LABEL] === q.metadata.name).map((n) => n.metadata.name),
    };
  }).sort((a, b) => (a.parent || a.name).localeCompare(b.parent || b.name) || (a.parent ? 1 : -1) - (b.parent ? 1 : -1) || a.name.localeCompare(b.name));
}

export interface QueueForm {
  name: string;
  parent: string;
  gpuQuota: number;
  gpuLimit: number;
  /** -1 = unlimited. KAI's units: CPU in millicores, memory in megabytes. */
  cpuQuota: number;
  memoryQuota: number;
}

export const QUEUE_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export function validateQueue(f: QueueForm, existing: string[], editing: boolean): string[] {
  const e: string[] = [];

  if (!QUEUE_NAME.test(f.name)) {
    e.push('Name: lowercase letters, digits and dashes');
  }
  if (!editing && existing.includes(f.name)) {
    e.push(`A queue named ${ f.name } exists`);
  }
  if (f.parent === f.name) {
    e.push('A queue cannot be its own parent');
  }
  if (f.gpuLimit !== -1 && f.gpuQuota > f.gpuLimit) {
    e.push('The GPU limit is below the quota');
  }

  return e;
}

export function queueManifest(f: QueueForm, base?: any): any {
  const res = (quota: number, limit = -1) => ({ quota, limit, overQuotaWeight: 1 });
  const spec: any = {
    ...(base?.spec || {}),
    resources: {
      ...(base?.spec?.resources || {}),
      gpu:    res(f.gpuQuota, f.gpuLimit),
      cpu:    { ...res(f.cpuQuota), ...(base?.spec?.resources?.cpu?.limit !== undefined ? { limit: base.spec.resources.cpu.limit } : {}) },
      memory: { ...res(f.memoryQuota), ...(base?.spec?.resources?.memory?.limit !== undefined ? { limit: base.spec.resources.memory.limit } : {}) },
    }
  };

  if (f.parent) {
    spec.parentQueue = f.parent;
  } else {
    delete spec.parentQueue;
  }

  return {
    apiVersion: 'scheduling.run.ai/v2',
    kind:       'Queue',
    metadata:   base?.metadata ? { ...base.metadata } : { name: f.name },
    spec
  };
}

// ---------- projects & namespaces ----------

export interface NamespaceRow {
  name: string;
  projectId: string;
  managed: boolean;
  queue: string;
  /** Can train: managed, with a queue that exists. */
  ready: boolean;
  problem: string;
}

export function namespaceRows(namespaces: any[], queueNames: string[]): NamespaceRow[] {
  return namespaces
    .filter((n) => !!n.metadata?.labels?.[PROJECT_ID_LABEL] || !!n.metadata?.annotations?.[PROJECT_ID_LABEL])
    .map((n) => {
      const labels = n.metadata.labels || {};
      const managed = labels[MANAGED_LABEL] === 'true';
      const queue = labels[QUEUE_LABEL] || '';
      let problem = '';

      if (managed && !queue) {
        problem = 'managed but no queue: every TrainJob is refused';
      } else if (queue && !queueNames.includes(queue)) {
        problem = `queue ${ queue } does not exist`;
      } else if (!managed && queue) {
        problem = 'has a queue but is not managed: the policy does not check it';
      }

      return {
        name:      n.metadata.name,
        projectId: (labels[PROJECT_ID_LABEL] || n.metadata.annotations?.[PROJECT_ID_LABEL] || '').split(':').pop(),
        managed,
        queue,
        ready:     managed && !!queue && queueNames.includes(queue),
        problem,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Merge patch for a namespace: training on (with a queue) or off. */
export function namespaceLabelPatch(queue: string | null): any {
  return queue ? { metadata: { labels: { [MANAGED_LABEL]: 'true', [QUEUE_LABEL]: queue } } } : { metadata: { labels: { [MANAGED_LABEL]: null, [QUEUE_LABEL]: null } } };
}

/** A Rancher ProjectRoleTemplateBinding granting AI Trainer in a project to a user. */
export function trainerBinding(clusterId: string, projectId: string, backingNamespace: string, userId: string): any {
  return {
    apiVersion:       'management.cattle.io/v3',
    kind:             'ProjectRoleTemplateBinding',
    metadata:         { generateName: 'prtb-ai-trainer-', namespace: backingNamespace },
    projectName:      `${ clusterId }:${ projectId }`,
    roleTemplateName: TRAINER_ROLE,
    userName:         userId,
  };
}

/**
 * What a notebook running in the namespace needs to submit as itself: a service account bound to
 * ai-trainer, plus `get` on its own Namespace, which the SDK option reads for the queue label and
 * ai-trainer does not grant.
 */
export function notebookAccessManifests(namespace: string): any[] {
  const labels = { 'app.kubernetes.io/part-of': 'aif-scheduling' };

  return [
    {
      apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: NOTEBOOK_SA, namespace, labels }
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind:       'RoleBinding',
      metadata:   { name: `${ NOTEBOOK_SA }-${ TRAINER_ROLE }`, namespace, labels },
      roleRef:    { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: TRAINER_ROLE },
      subjects:   [{ kind: 'ServiceAccount', name: NOTEBOOK_SA, namespace }]
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind:       'Role',
      metadata:   { name: `${ NOTEBOOK_SA }-read-namespace`, namespace, labels },
      rules:      [{ apiGroups: [''], resources: ['namespaces'], resourceNames: [namespace], verbs: ['get'] }]
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind:       'RoleBinding',
      metadata:   { name: `${ NOTEBOOK_SA }-read-namespace`, namespace, labels },
      roleRef:    { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: `${ NOTEBOOK_SA }-read-namespace` },
      subjects:   [{ kind: 'ServiceAccount', name: NOTEBOOK_SA, namespace }]
    },
  ];
}

// ---------- runtimes ----------

export interface RuntimeRow {
  name: string;
  displayName: string;
  kind: string;
  description: string;
  gpuMemoryMiB: string;
  maxNodes: string;
  maxGpusPerNode: string;
  maxRuntimeHours: string;
  image: string;
  registries: string[];
}

export function runtimeRows(runtimes: any[]): RuntimeRow[] {
  return runtimes
    .filter((r) => r?.metadata?.labels?.['app.kubernetes.io/part-of'] === RUNTIMES_PART_OF)
    .map((r) => {
      const a = r.metadata.annotations || {};
      const job = (r.spec?.template?.spec?.replicatedJobs || [])[0];
      const c = (job?.template?.spec?.template?.spec?.containers || []).find((x: any) => x.name === 'node') ||
        (job?.template?.spec?.template?.spec?.containers || [])[0];

      return {
        name:            r.metadata.name,
        displayName:     a['ai-factory.suse.com/display-name'] || r.metadata.name,
        kind:            r.metadata.labels?.['ai-factory.suse.com/runtime-kind'] || '',
        description:     a.description || '',
        gpuMemoryMiB:    a['ai-factory.suse.com/gpu-memory-mib'] || '',
        maxNodes:        a['ai-factory.suse.com/max-nodes'] || '',
        maxGpusPerNode:  a['ai-factory.suse.com/max-gpus-per-node'] || '',
        maxRuntimeHours: a['ai-factory.suse.com/max-runtime-hours'] || '',
        image:           c?.image || '',
        registries:      (a['ai-factory.suse.com/registries'] || '').split(',').filter(Boolean),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- TrainJobs ----------

export type JobPhase = 'Complete' | 'Failed' | 'Suspended' | 'Running' | 'Pending';

export interface JobRow {
  name: string;
  namespace: string;
  runtime: string;
  queue: string;
  phase: JobPhase;
  message: string;
  created: string;
  nodes: number;
  pods: { name: string; phase: string; node: string; scheduler: string }[];
}

function cond(job: any, type: string): any {
  return (job?.status?.conditions || []).find((c: any) => c.type === type && c.status === 'True');
}

export function jobPhase(job: any, pods: any[]): { phase: JobPhase; message: string } {
  const done = cond(job, 'Complete');
  const failed = cond(job, 'Failed');
  const suspended = cond(job, 'Suspended');

  if (done) {
    return { phase: 'Complete', message: done.message || '' };
  }
  if (failed) {
    return { phase: 'Failed', message: failed.message || failed.reason || '' };
  }
  if (suspended || job?.spec?.suspend) {
    return { phase: 'Suspended', message: suspended?.message || '' };
  }
  if (pods.some((p) => p.status?.phase === 'Running')) {
    return { phase: 'Running', message: '' };
  }

  const waiting = pods.find((p) => p.status?.phase === 'Pending');
  const unsched = (waiting?.status?.conditions || []).find((c: any) => c.type === 'PodScheduled' && c.status === 'False');

  return { phase: 'Pending', message: unsched?.message || (pods.length ? '' : 'no pods yet') };
}

/** The queue a job asked for: its pods' label, else the label its runtimePatches set. */
export function jobQueue(job: any, pods: any[]): string {
  const fromPod = pods.map((p) => p.metadata?.labels?.[QUEUE_LABEL]).find(Boolean);

  if (fromPod) {
    return fromPod;
  }

  const patches = JSON.stringify(job?.spec?.runtimePatches || job?.spec?.podTemplateOverrides || []);
  const m = patches.match(/"kai\.scheduler\/queue":"([^"]+)"/);

  return m ? m[1] : '';
}

export function jobRows(jobs: any[], pods: any[]): JobRow[] {
  return jobs.map((j) => {
    const mine = pods.filter((p) => p.metadata?.namespace === j.metadata.namespace &&
      (p.metadata?.labels?.['jobset.sigs.k8s.io/jobset-name'] === j.metadata.name));
    const { phase, message } = jobPhase(j, mine);

    return {
      name:      j.metadata.name,
      namespace: j.metadata.namespace,
      runtime:   j.spec?.runtimeRef?.name || '',
      queue:     jobQueue(j, mine),
      phase,
      message,
      created:   j.metadata.creationTimestamp || '',
      nodes:     j.spec?.trainer?.numNodes || 1,
      pods:      mine.map((p) => ({
        name: p.metadata.name, phase: p.status?.phase || '', node: p.spec?.nodeName || '', scheduler: p.spec?.schedulerName || ''
      })),
    };
  }).sort((a, b) => b.created.localeCompare(a.created));
}
