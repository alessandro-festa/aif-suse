// AI projects: the Run:AI "Project" concept expressed with objects Rancher already has.
//
// Run:AI's Project bundles three things into one cluster-scoped CRD: a namespace, a set of
// RoleBindings, and a scheduling quota. Rancher already owns the first two — a Rancher Project
// groups namespaces and carries membership through ProjectRoleTemplateBindings, with a Members UI,
// role templates and audit already built. So an AI project here is a *composition*:
//
//   Rancher Project (RBAC + namespace grouping)  +  KAI/Run:AI Queue (GPU quota)
//   joined by the namespace, which carries both:
//     annotation field.cattle.io/projectId = <clusterId>:<projectId>   -> Rancher side
//     label      kai.scheduler/queue       = <queue>                   -> scheduler side
//
// Nothing here invents an RBAC model: adding a user to the project is the stock Rancher flow, and
// this extension only reads the bindings to show who has access.
//
// Pure functions only — see quota.ts for the same reasoning.

import {
  Availability, ClusterCapacity, KAI_QUEUE_LABEL, QueueIndex, RUNAI_NS_VERSION_LABEL,
  RUNAI_QUEUE_LABEL, availability,
} from './quota';
import { QuotaBackend } from './resourcequota';

export const RANCHER_PROJECT_ANNOTATION = 'field.cattle.io/projectId';
/** Rancher also mirrors the project id into a label, without the cluster prefix. */
export const RANCHER_PROJECT_LABEL = 'field.cattle.io/projectId';

/**
 * Every Rancher cluster is created with a Default and a System project. They exist to hold the
 * namespaces Rancher itself manages, carry no GPU intent, and listing them here would mean every
 * cluster appears to have two misconfigured AI projects before anyone has done anything.
 */
export const DEFAULT_PROJECT_MARKER = 'authz.management.cattle.io/default-project';
export const SYSTEM_PROJECT_MARKER = 'authz.management.cattle.io/system-project';

export interface RancherProject {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: { displayName?: string; clusterName?: string; description?: string };
}

/** Rancher marks the two built-ins with a label; older releases used an annotation instead. */
export function isBuiltInProject(p: RancherProject): boolean {
  const meta = p?.metadata || {};

  for (const marker of [DEFAULT_PROJECT_MARKER, SYSTEM_PROJECT_MARKER]) {
    if (meta.labels?.[marker] === 'true' || meta.annotations?.[marker] === 'true') {
      return true;
    }
  }

  return false;
}

export interface NamespaceLike {
  metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
}

export interface Prtb {
  metadata?: { name?: string; namespace?: string };
  projectName?: string; // "<clusterId>:<projectId>"
  roleTemplateName?: string;
  userName?: string;
  userPrincipalName?: string;
  groupName?: string;
  groupPrincipalName?: string;
}

export interface ProjectMember {
  name: string;
  kind: 'user' | 'group';
  role: string;
}

export interface AiProject {
  /** queue name when there is one, else the Rancher project id — stable key for the list */
  id: string;
  displayName: string;
  /** Rancher project id, "<clusterId>:<projectId>", when bound to one */
  rancherProjectId: string | null;
  rancherProjectName: string | null;
  namespaces: string[];
  /** leaf queue holding the quota */
  queue: string | null;
  /** parent queue — the Run:AI "department" */
  department: string | null;
  members: ProjectMember[];
  gpu: Availability | null;
  /** how this row was discovered, so the UI can flag half-configured projects */
  source: 'complete' | 'no-queue' | 'no-rancher-project' | 'queue-only';
}

export function rancherProjectIdOf(ns: NamespaceLike): string | null {
  return ns?.metadata?.annotations?.[RANCHER_PROJECT_ANNOTATION] || null;
}

export function queueOf(ns: NamespaceLike): string | null {
  const labels = ns?.metadata?.labels || {};

  return labels[KAI_QUEUE_LABEL] || labels[RUNAI_QUEUE_LABEL] || null;
}

/**
 * What holds this namespace's GPU quota, by backend.
 *
 * Under KAI the namespace points at a queue by label, and the same queue can be shared by several
 * namespaces. Under ResourceQuota there is no indirection at all: the quota object lives in the
 * namespace, so the namespace *is* the quota scope, and it counts only when a quota actually
 * exists — otherwise the project is uncapped, which is a different state from capped-at-zero.
 */
export function quotaScopeOf(ns: NamespaceLike, backend: QuotaBackend, queueIndex: QueueIndex): string | null {
  if (backend === 'kai') {
    return queueOf(ns);
  }
  const name = ns?.metadata?.name;

  return name && queueIndex[name] ? name : null;
}

/** "<clusterId>:<projectId>" -> projectId */
export function shortProjectId(full: string | null): string | null {
  if (!full) {
    return null;
  }
  const idx = full.indexOf(':');

  return idx === -1 ? full : full.slice(idx + 1);
}

export function membersOf(prtbs: Prtb[], rancherProjectId: string | null): ProjectMember[] {
  if (!rancherProjectId) {
    return [];
  }
  const out: ProjectMember[] = [];
  const seen = new Set<string>();

  for (const b of prtbs || []) {
    if (b?.projectName !== rancherProjectId) {
      continue;
    }
    const user = b.userName || b.userPrincipalName;
    const group = b.groupName || b.groupPrincipalName;
    const name = user || group;

    if (!name) {
      continue;
    }
    const role = b.roleTemplateName || '';
    const key = `${ name }/${ role }`;

    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      name, kind: user ? 'user' : 'group', role
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Join everything into the list the Projects page renders.
 *
 * Deliberately includes half-configured rows rather than hiding them: a Rancher project with no
 * queue (users can submit but get no quota) and a queue with no namespace (quota nobody can reach)
 * are both real misconfigurations worth surfacing, and both are easy to produce by doing half the
 * setup in one UI and half in another.
 */
export function assembleProjects(
  rancherProjects: RancherProject[],
  namespaces: NamespaceLike[],
  queueIndex: QueueIndex,
  prtbs: Prtb[],
  capacity: ClusterCapacity,
  clusterId: string,
  backend: QuotaBackend = 'kai',
): AiProject[] {
  const out: AiProject[] = [];
  const claimedQueues = new Set<string>();
  const scopeOf = (ns: NamespaceLike) => quotaScopeOf(ns, backend, queueIndex);

  const byRancherProject = new Map<string, NamespaceLike[]>();
  const unboundNamespaces: NamespaceLike[] = [];

  for (const ns of namespaces || []) {
    const pid = rancherProjectIdOf(ns);

    if (pid) {
      const list = byRancherProject.get(pid) || [];

      list.push(ns);
      byRancherProject.set(pid, list);
    } else if (scopeOf(ns)) {
      unboundNamespaces.push(ns);
    }
  }

  for (const p of (rancherProjects || []).filter((p) => !isBuiltInProject(p))) {
    const pid = `${ p.metadata?.namespace || clusterId }:${ p.metadata?.name }`;
    const nss = byRancherProject.get(pid) || [];
    // a project's namespaces should all point at one queue; if they disagree, take the first and
    // let the UI show the namespace list so the split is visible
    const queue = nss.map(scopeOf).find((q): q is string => !!q) || null;

    if (queue) {
      claimedQueues.add(queue);
    }
    const node = queue ? queueIndex[queue] : null;

    out.push({
      id:                 queue || pid,
      displayName:        p.spec?.displayName || p.metadata?.name || '',
      rancherProjectId:   pid,
      rancherProjectName: p.metadata?.name || null,
      namespaces:         nss.map((n) => n.metadata?.name || '').filter(Boolean).sort(),
      queue,
      department:         node?.parent || null,
      members:            membersOf(prtbs, pid),
      gpu:                queue ? availability(queue, queueIndex, capacity, 'gpu') : null,
      source:             queue ? 'complete' : 'no-queue',
    });
  }

  // namespaces bound to a queue but not to any Rancher project: quota without Rancher RBAC
  for (const ns of unboundNamespaces) {
    const queue = scopeOf(ns)!;

    claimedQueues.add(queue);
    out.push({
      id:                 queue,
      displayName:        ns.metadata?.name || queue,
      rancherProjectId:   null,
      rancherProjectName: null,
      namespaces:         [ns.metadata?.name || ''].filter(Boolean),
      queue,
      department:         queueIndex[queue]?.parent || null,
      members:            [],
      gpu:                availability(queue, queueIndex, capacity, 'gpu'),
      source:             'no-rancher-project',
    });
  }

  // leaf queues nothing points at: quota that is unreachable
  for (const node of Object.values(queueIndex)) {
    if (!node.isLeaf || claimedQueues.has(node.name)) {
      continue;
    }
    out.push({
      id:                 node.name,
      displayName:        node.displayName,
      rancherProjectId:   null,
      rancherProjectName: null,
      namespaces:         [],
      queue:              node.name,
      department:         node.parent,
      members:            [],
      gpu:                availability(node.name, queueIndex, capacity, 'gpu'),
      source:             'queue-only',
    });
  }

  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Badge text for an incomplete project. The `source` values are internal and use KAI's vocabulary;
 * under ResourceQuota there are no queues, so showing the raw value reads as a different product's
 * jargon rather than as a description of what is missing.
 */
export function projectSourceLabel(source: AiProject['source'], backend: QuotaBackend = 'kai'): string {
  switch (source) {
  case 'no-queue':
    return backend === 'kai' ? 'no queue' : 'no limit';
  case 'no-rancher-project':
    return 'no Rancher project';
  case 'queue-only':
    return backend === 'kai' ? 'no namespace' : 'no Rancher project';
  default:
    return '';
  }
}

export function projectWarning(source: AiProject['source'], backend: QuotaBackend = 'kai'): string {
  switch (source) {
  case 'no-queue':
    return backend === 'kai' ? 'No GPU quota: this project has no namespace labelled with a scheduler queue, so its workloads fall back to the default scheduler with no fair-share accounting.' : 'No GPU limit: nothing caps this project, so it can take the whole cluster. Set a limit to bound it.';
  case 'no-rancher-project':
    return 'No Rancher project, so Rancher membership and roles do not apply. Access follows the namespace RBAC alone.';
  case 'queue-only':
    return backend === 'kai' ? 'Quota with no namespace pointing at it. Nothing can be submitted to this queue until a namespace carries the queue label.' : 'Namespace with a GPU quota but no Rancher project. The limit is enforced; membership and roles are not. Move it under a project from Cluster → Projects/Namespaces.';
  default:
    return '';
  }
}

// ---------------------------------------------------------------------------------------------
// Manifest builders
//
// Kept as plain object builders (rather than inline in the Vue page) so the exact shape can be
// asserted in tests and pasted into a GitOps repo — the same objects a `kubectl apply` would take.

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export function validateProjectName(name: string): string {
  if (!name) {
    return 'Enter a project name';
  }
  if (!DNS_LABEL.test(name)) {
    return 'Lowercase letters, digits and dashes only; must start and end alphanumeric.';
  }
  if (name.length > 53) {
    return 'Name must be 53 characters or fewer (the namespace prefix needs the rest).';
  }

  return '';
}

export interface QuotaSpec {
  /** -1 unlimited, 0 none */
  quota: number;
  /** -1 uncapped, 0 = no over-quota borrowing beyond the guarantee */
  limit: number;
  overQuotaWeight: number;
}

/**
 * Shared by the create and edit forms. A limit below the guarantee is the one combination the
 * scheduler cannot honour: it would admit up to `quota` and then refuse its own guarantee.
 */
export function validateQuota(gpu: QuotaSpec): string {
  if (!Number.isInteger(gpu.quota) || !Number.isInteger(gpu.limit)) {
    return 'Quota and limit must be whole numbers of GPUs.';
  }
  if (gpu.quota < -1 || gpu.limit < -1) {
    return 'Use -1 for unlimited, 0 for none; no other negative values.';
  }
  if (gpu.limit > 0 && gpu.quota > 0 && gpu.limit < gpu.quota) {
    return `Limit (${ gpu.limit }) is below the guarantee (${ gpu.quota }); the guarantee could never be honoured.`;
  }
  if (gpu.overQuotaWeight < 0) {
    return 'Over-quota weight cannot be negative.';
  }

  return '';
}

/**
 * ResourceQuota has one number, a ceiling, and no sentinel for "unlimited" — the way to express
 * that is to have no quota object at all, which the form offers as leaving the cap empty. So unlike
 * validateQuota there is no -1 here, and 0 is a real (if severe) choice: admit no GPU pods.
 */
export function validateCap(gpuLimit: number): string {
  if (!Number.isInteger(gpuLimit)) {
    return 'GPU limit must be a whole number.';
  }
  if (gpuLimit < 0) {
    return 'GPU limit cannot be negative. Use 0 to block GPU workloads, or clear the field for no limit.';
  }

  return '';
}

/**
 * Guaranteed GPUs across all leaf queues once `queue` is set to `newQuota`. Pass queue = null to
 * price a project that does not exist yet. Unlimited (-1) guarantees contribute nothing, because
 * there is no number to add up — auditQuotas flags those separately.
 */
export function committedGpuAfter(queues: { name: string; isLeaf: boolean; gpuQuota: number }[], queue: string | null, newQuota: number): number {
  const others = queues
    .filter((q) => q.isLeaf && q.name !== queue)
    .reduce((sum, q) => sum + (q.gpuQuota === -1 ? 0 : Math.max(0, q.gpuQuota)), 0);

  return others + (newQuota === -1 ? 0 : Math.max(0, newQuota));
}

/**
 * The body for changing a queue's GPU quota in place. Only the gpu block is touched so cpu/memory
 * and anything an admin tuned by hand on the queue survive the edit.
 */
export function applyQuotaToQueue(queueSpec: any, gpu: QuotaSpec): any {
  const spec = { ...(queueSpec || {}) };

  spec.resources = {
    ...(spec.resources || {}),
    gpu: {
      ...(spec.resources?.gpu || {}),
      quota:           gpu.quota,
      limit:           gpu.limit,
      overQuotaWeight: gpu.overQuotaWeight,
    },
  };

  return spec;
}

export function buildQueueManifest(name: string, gpu: QuotaSpec, parentQueue: string | null, displayName?: string) {
  return {
    apiVersion: 'scheduling.run.ai/v2',
    kind:       'Queue',
    metadata:   { name },
    spec:       {
      displayName: displayName || name,
      ...(parentQueue ? { parentQueue } : {}),
      priority:    100,
      resources:   {
        gpu: {
          quota: gpu.quota, limit: gpu.limit, overQuotaWeight: gpu.overQuotaWeight
        },
        // cpu/memory left unbounded on purpose: GPUs are the contended resource, and a surprise
        // CPU cap is a confusing way to discover a quota system. Admins can tighten these later.
        cpu: {
          quota: -1, limit: -1, overQuotaWeight: 1
        },
        memory: {
          quota: -1, limit: -1, overQuotaWeight: 1
        },
      },
    },
  };
}

/**
 * A projectId that stringified something missing is worse than no projectId at all: Rancher reads
 * the annotation, finds no such project, and the namespace ends up in no project while looking to
 * the page as though it is in one. Throw instead, so the caller rolls the whole thing back.
 */
function assertProjectId(namespace: string, rancherProjectId: string | null, short: string | null) {
  if (short === 'undefined' || short === 'null' || (rancherProjectId && !short)) {
    throw new Error(`Refusing to write namespace ${ namespace }: Rancher project id is "${ rancherProjectId }"`);
  }
}

export function buildNamespaceManifest(
  namespace: string,
  queue: string,
  clusterId: string,
  rancherProjectId: string | null,
  backend: QuotaBackend = 'kai',
) {
  const short = shortProjectId(rancherProjectId);

  assertProjectId(namespace, rancherProjectId, short);

  return {
    apiVersion: 'v1',
    kind:       'Namespace',
    metadata:   {
      name:   namespace,
      labels: {
        // Only under a queueing scheduler. With ResourceQuota the cap lives in the namespace, so a
        // queue label would name a queue that does not exist and mislead anyone reading the object.
        // KAI reads kai.scheduler/queue; Run:AI reads runai/queue. Both are set so the namespace
        // works under either and survives a migration in or out of Run:AI.
        // runai/namespace-version is not decoration: Run:AI's webhooks and its queue accounting
        // treat an unversioned namespace as a pre-v2 one, and a namespace it does not consider v2
        // gets none of the v2 quota behaviour. KAI ignores the label entirely.
        ...(backend === 'kai' ? {
          [KAI_QUEUE_LABEL]: queue, [RUNAI_QUEUE_LABEL]: queue, [RUNAI_NS_VERSION_LABEL]: 'v2'
        } : {}),
        ...(short ? { [RANCHER_PROJECT_LABEL]: short } : {}),
      } as Record<string, string>,
      annotations: rancherProjectId ? { [RANCHER_PROJECT_ANNOTATION]: `${ clusterId }:${ short }` } : {},
    },
  };
}

// ============================ Run:AI-owned projects ============================
//
// On a commercial Run:AI cluster this page cannot create a project, and should not pretend to.
// Run:AI's own admission webhook refuses a Project written into the cluster —
//
//   admission webhook "runai-project-controller.runai.svc" denied the request: operation not allowed
//
// — because projects are created in the Run:AI control plane and synced down. Its controller then
// creates the namespace and the ~26 RoleBindings the scheduler needs to bind a pod there. A
// namespace this page creates instead has the queue label and none of the bindings, so its pods are
// scheduled and then refused at bind time: Pending, with nothing written on the pod to say why.
//
// What Run:AI does *not* do is put that namespace into a Rancher project, so Rancher membership and
// roles do not reach it. That is the one real gap, and the only thing left to automate: adopt the
// namespace Run:AI already made.

export interface RunaiProject {
  name: string;
  /** status.namespace — empty while the controller is still provisioning, and unusable until then */
  namespace: string;
  department: string;
  /** spec.queues[].resources.gpu, summed over node pools; null when the project sets none */
  gpuDeserved: number | null;
  gpuLimit: number | null;
  ready: boolean;
}

/** Normalise `projects.run.ai` objects down to what this page shows and writes. */
export function runaiProjectsFrom(raw: any[]): RunaiProject[] {
  return (raw || []).map((p: any) => {
    const queues = p?.spec?.queues || [];
    const sum = (pick: (gpu: any) => unknown) => {
      const vals = queues.map((q: any) => pick(q?.resources?.gpu)).filter((v: unknown) => typeof v === 'number');

      // -1 is Run:AI's "unlimited" sentinel, not a quantity, so it wins over any sibling node pool.
      return vals.length ? (vals.includes(-1) ? -1 : vals.reduce((a: number, b: number) => a + b, 0)) : null;
    };

    return {
      name:        p?.metadata?.name || '',
      namespace:   p?.status?.namespace || '',
      department:  p?.spec?.department || '',
      gpuDeserved: sum((gpu: any) => gpu?.deserved),
      gpuLimit:    sum((gpu: any) => gpu?.limit),
      ready:       p?.status?.phase === 'Ready',
    };
  }).filter((p: RunaiProject) => !!p.name);
}

export type RunaiState = 'ready' | 'provisioning' | 'none';

export interface RunaiReadiness {
  state: RunaiState;
  /** the run.ai Project that owns one of these namespaces, when there is one */
  project: string | null;
  namespace: string | null;
  label: string;
  detail: string;
}

/**
 * Can a Run:AI job actually run in this AI project? The only thing that decides it is whether a
 * `projects.run.ai` object claims one of its namespaces — not the queue label, not the quota, not
 * the Rancher project. Shown per row so the answer is on the page instead of being discovered when
 * a pod sits Pending with an empty events list.
 */
export function runaiReadinessOf(namespaces: string[], runaiProjects: RunaiProject[]): RunaiReadiness {
  const owned = runaiProjects.find((p) => p.namespace && namespaces.includes(p.namespace));

  if (!owned) {
    return {
      state:     'none',
      project:   null,
      namespace: null,
      label:     'not Run:AI bindable',
      detail:    'No Run:AI project. Submit with the default scheduler instead.',
    };
  }
  if (!owned.ready) {
    return {
      state:     'provisioning',
      project:   owned.name,
      namespace: owned.namespace,
      label:     'Run:AI provisioning',
      detail:    `Run:AI project "${ owned.name }" claims ${ owned.namespace } but has not reported Ready. Its RoleBindings may still be going in; jobs submitted now can fail to bind.`,
    };
  }

  return {
    state:     'ready',
    project:   owned.name,
    namespace: owned.namespace,
    label:     'Run:AI ready',
    detail:    `Run:AI project "${ owned.name }" owns ${ owned.namespace }. Submit with scheduler Run:AI and queue "${ owned.name }".`,
  };
}

/**
 * The patch that puts an *existing* namespace into a Rancher project — adoption, not creation.
 * Only the two Rancher fields are written: whoever owns the namespace keeps everything else,
 * which on a Run:AI cluster matters because its controller reconciles the rest.
 */
export function buildProjectBindingPatch(namespace: string, clusterId: string, rancherProjectId: string) {
  const short = shortProjectId(rancherProjectId);

  assertProjectId(namespace, rancherProjectId, short);
  if (!short) {
    throw new Error(`Refusing to bind namespace ${ namespace }: no Rancher project id`);
  }

  return {
    labels:      { [RANCHER_PROJECT_LABEL]: short },
    annotations: { [RANCHER_PROJECT_ANNOTATION]: `${ clusterId }:${ short }` },
  };
}

export function buildRancherProjectManifest(clusterId: string, displayName: string, description = '') {
  return {
    apiVersion: 'management.cattle.io/v3',
    kind:       'Project',
    // No metadata.name. Rancher assigns project ids itself and discards whatever we send, so
    // asking for one only creates a name we might believe in — see resolveCreatedProject.
    metadata:   { generateName: 'p-', namespace: clusterId },
    spec:       {
      clusterName: clusterId,
      displayName,
      description,
    },
  };
}

/**
 * The project id out of whatever `save()` handed back, or null if it did not hand back a usable one.
 *
 * A `management.cattle.io.project` model does not save itself. The shell's Project model proxies
 * save() to Norman (`/v3/projects`) and returns the *Norman* project, whose `id` is already
 * "<clusterId>:<projectId>" — the authoritative answer, available immediately and with no polling.
 *
 * That is an implementation detail of @rancher/shell rather than a contract, so anything that does
 * not look right returns null and the caller falls back to reading the project list.
 */
export function projectIdFromSaveResult(saved: any, clusterId: string): string | null {
  const id = typeof saved?.id === 'string' ? saved.id : '';
  const match = /^([^:/]+):(p-[a-z0-9]+)$/.exec(id);

  if (match && match[1] === clusterId) {
    return id;
  }

  // Steve-shaped result rather than Norman-shaped: a bare name under metadata.
  const name = saved?.metadata?.name;

  if (typeof name === 'string' && /^p-[a-z0-9]+$/.test(name)) {
    return `${ clusterId }:${ name }`;
  }

  return null;
}

/**
 * The project Rancher actually created, found by polling until it appears.
 *
 * The fallback for when projectIdFromSaveResult comes back empty.
 *
 * Creating the project and creating its namespace cannot be one step: the namespace has to name
 * the project in an annotation, so the project's id must be known first. Two earlier attempts at
 * getting that id were both wrong on a real cluster:
 *
 *   - reading `metadata.name` off the model after `save()` gave `undefined`, and the namespace went
 *     out annotated `<cluster>:undefined`;
 *   - choosing the id ourselves and sending it as `metadata.name` gave a namespace annotated with a
 *     project that does not exist, because Rancher assigns the id server-side and ignored ours.
 *
 * Both produced the same visible symptom — a project and a namespace that never joined up. The only
 * source of truth is Rancher's own project list, and the project is not in it the instant `save()`
 * resolves, so this waits for it. A project is ours if it is on this cluster, was not there before
 * the create, and carries the display name we asked for.
 */
export async function resolveCreatedProject(opts: {
  /** Re-reads the project list from the server, bypassing any cache. */
  list: () => Promise<any[]>;
  clusterId: string;
  displayName: string;
  /** Project names present before the create; anything else is new. */
  known: Iterable<string>;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<any> {
  const known = new Set(opts.known);
  const attempts = opts.attempts ?? 20;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; attempt < attempts; attempt++) {
    const mine = (await opts.list()).filter((p: any) => p?.metadata?.name &&
      !known.has(p.metadata.name) &&
      p.metadata.namespace === opts.clusterId &&
      p.spec?.displayName === opts.displayName);

    if (mine.length === 1) {
      return mine[0];
    }

    // Two new projects with the same display name means someone else created one at the same
    // moment. Picking either would attach this namespace to a stranger's project, so stop.
    if (mine.length > 1) {
      throw new Error(`Found ${ mine.length } new Rancher projects named "${ opts.displayName }" — cannot tell which one is ours`);
    }
    if (attempt < attempts - 1) {
      await sleep(250);
    }
  }
  throw new Error(`Timed out waiting for Rancher to register project "${ opts.displayName }"`);
}

/**
 * Default namespace name for a project, matching Run:AI's `runai-<project>` convention. A name
 * that already starts with the prefix keeps it: someone who calls the project "ai-t400-demo" means
 * that namespace, not "ai-ai-t400-demo", and the doubled form is the one people then mistype.
 */
export function defaultNamespaceFor(projectName: string): string {
  return projectName.startsWith('ai-') ? projectName : `ai-${ projectName }`;
}
