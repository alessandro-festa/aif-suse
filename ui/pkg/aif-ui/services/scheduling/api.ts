/**
 * Workloads > Scheduling: cluster calls, through Rancher's cluster proxy (/k8s/clusters/<id>), so
 * the same page administers the local cluster or any downstream one with the admin's own rights.
 */
import type { Dispatchable } from '../../types/rancher-types';
import {
  readinessChecks, viewRuntimesManifests, roleTemplateManifest, queueManifest, namespaceLabelPatch,
  trainerBinding, notebookAccessManifests, type Check, type QueueForm
} from './model';

const k8s = (cluster: string) => `/k8s/clusters/${ encodeURIComponent(cluster) }`;

async function req(store: Dispatchable, url: string, opts: Record<string, any> = {}): Promise<any> {
  const res = await store.dispatch('rancher/request', { url, ...opts });

  return res?.data ?? res;
}

async function list(store: Dispatchable, url: string): Promise<any[]> {
  try {
    const d = await req(store, url);

    return Array.isArray(d?.items) ? d.items : [];
  } catch {
    return []; // absent CRD (404) or no right to read: the page shows what it can see
  }
}

function msg(e: any): string {
  return e?.data?.message || e?.message || e?._statusText || String(e);
}

/** Create, or replace an existing object of the same name (409). */
async function apply(store: Dispatchable, collection: string, obj: any): Promise<void> {
  try {
    await req(store, collection, { method: 'POST', data: obj });
  } catch (e: any) {
    if (e?._status !== 409 && e?.status !== 409) {
      throw new Error(msg(e));
    }
    const cur = await req(store, `${ collection }/${ obj.metadata.name }`);

    await req(store, `${ collection }/${ obj.metadata.name }`, {
      method: 'PUT', data: { ...obj, metadata: { ...cur.metadata, ...obj.metadata, resourceVersion: cur.metadata.resourceVersion } }
    });
  }
}

const QUEUES = '/apis/scheduling.run.ai/v2/queues';
const RUNTIMES = '/apis/trainer.kubeflow.org/v1alpha1/clustertrainingruntimes';
const TRAINJOBS = '/apis/trainer.kubeflow.org/v1alpha1/trainjobs';
const RBAC = '/apis/rbac.authorization.k8s.io/v1';

export async function readiness(store: Dispatchable, cluster: string): Promise<Check[]> {
  const base = k8s(cluster);
  const [crds, pods, runtimes, crs, crbs, rts] = await Promise.all([
    list(store, `${ base }/apis/apiextensions.k8s.io/v1/customresourcedefinitions`),
    list(store, `${ base }/api/v1/pods?limit=2000`),
    list(store, `${ base }${ RUNTIMES }`),
    list(store, `${ base }${ RBAC }/clusterroles`),
    list(store, `${ base }${ RBAC }/clusterrolebindings`),
    list(store, `${ k8s('local') }/apis/management.cattle.io/v3/roletemplates`),
  ]);

  return readinessChecks({
    crds:                crds.map((c) => c.metadata.name),
    images:              pods.filter((p) => p.status?.phase === 'Running').flatMap((p) => (p.spec?.containers || []).map((c: any) => c.image)),
    runtimes,
    clusterRoles:        crs.map((c) => c.metadata.name),
    clusterRoleBindings: crbs,
    roleTemplates:       rts.map((r) => r.metadata.name),
  });
}

export async function fixReadiness(store: Dispatchable, cluster: string, action: string): Promise<void> {
  if (action === 'create-view-runtimes') {
    const [role, binding] = viewRuntimesManifests();

    await apply(store, `${ k8s(cluster) }${ RBAC }/clusterroles`, role);
    await apply(store, `${ k8s(cluster) }${ RBAC }/clusterrolebindings`, binding);
  } else if (action === 'create-roletemplate') {
    // RoleTemplates live in Rancher (the local cluster), whichever cluster is administered
    await apply(store, `${ k8s('local') }/apis/management.cattle.io/v3/roletemplates`, roleTemplateManifest());
  }
}

// ---------- queues ----------

export const listQueues = (store: Dispatchable, cluster: string) => list(store, `${ k8s(cluster) }${ QUEUES }`);
export const listNamespaces = (store: Dispatchable, cluster: string) => list(store, `${ k8s(cluster) }/api/v1/namespaces`);

export async function saveQueue(store: Dispatchable, cluster: string, form: QueueForm, base?: any): Promise<void> {
  const obj = queueManifest(form, base);

  try {
    if (base) {
      await req(store, `${ k8s(cluster) }${ QUEUES }/${ form.name }`, { method: 'PUT', data: obj });
    } else {
      await req(store, `${ k8s(cluster) }${ QUEUES }`, { method: 'POST', data: obj });
    }
  } catch (e) {
    throw new Error(msg(e));
  }
}

export async function deleteQueue(store: Dispatchable, cluster: string, name: string): Promise<void> {
  try {
    await req(store, `${ k8s(cluster) }${ QUEUES }/${ name }`, { method: 'DELETE' });
  } catch (e) {
    throw new Error(msg(e));
  }
}

// ---------- projects ----------

export interface ProjectInfo { id: string; name: string; backingNamespace: string }
export interface UserInfo { id: string; label: string }
export interface MemberInfo { id: string; userId: string; user: string; role: string; bindingName: string; bindingNamespace: string }

export async function listProjects(store: Dispatchable, cluster: string): Promise<ProjectInfo[]> {
  const items = await list(store, `${ k8s('local') }/apis/management.cattle.io/v3/namespaces/${ cluster }/projects`);

  return items.map((p) => ({
    id: p.metadata.name, name: p.spec?.displayName || p.metadata.name, backingNamespace: p.status?.backingNamespace || p.metadata.name
  }));
}

export async function listUsers(store: Dispatchable): Promise<UserInfo[]> {
  const items = await list(store, `${ k8s('local') }/apis/management.cattle.io/v3/users`);

  return items
    .filter((u) => u.username && !(u.principalIds || []).some((p: string) => p.startsWith('system://')))
    .map((u) => ({ id: u.metadata.name, label: u.displayName ? `${ u.displayName } (${ u.username })` : u.username }));
}

export async function listMembers(store: Dispatchable, cluster: string, project: ProjectInfo, users: UserInfo[]): Promise<MemberInfo[]> {
  const items = await list(store, `${ k8s('local') }/apis/management.cattle.io/v3/namespaces/${ project.backingNamespace }/projectroletemplatebindings`);

  return items
    .filter((b) => b.projectName === `${ cluster }:${ project.id }` && b.userName)
    .map((b) => ({
      id:               b.metadata.name,
      userId:           b.userName,
      user:             users.find((u) => u.id === b.userName)?.label || b.userName,
      role:             b.roleTemplateName,
      bindingName:      b.metadata.name,
      bindingNamespace: b.metadata.namespace,
    }));
}

export async function grantTrainer(store: Dispatchable, cluster: string, project: ProjectInfo, userId: string): Promise<void> {
  try {
    await req(store, `${ k8s('local') }/apis/management.cattle.io/v3/namespaces/${ project.backingNamespace }/projectroletemplatebindings`, {
      method: 'POST', data: trainerBinding(cluster, project.id, project.backingNamespace, userId)
    });
  } catch (e) {
    throw new Error(msg(e));
  }
}

export async function revokeMember(store: Dispatchable, m: MemberInfo): Promise<void> {
  try {
    await req(store, `${ k8s('local') }/apis/management.cattle.io/v3/namespaces/${ m.bindingNamespace }/projectroletemplatebindings/${ m.bindingName }`, { method: 'DELETE' });
  } catch (e) {
    throw new Error(msg(e));
  }
}

export async function setNamespaceTraining(store: Dispatchable, cluster: string, namespace: string, queue: string | null): Promise<void> {
  try {
    await req(store, `${ k8s(cluster) }/api/v1/namespaces/${ namespace }`, {
      method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, data: namespaceLabelPatch(queue)
    });
  } catch (e) {
    throw new Error(msg(e));
  }
}

export async function hasNotebookAccess(store: Dispatchable, cluster: string, namespace: string): Promise<boolean> {
  try {
    await req(store, `${ k8s(cluster) }${ RBAC }/namespaces/${ namespace }/rolebindings/notebook-ai-trainer`);

    return true;
  } catch {
    return false;
  }
}

export async function enableNotebookAccess(store: Dispatchable, cluster: string, namespace: string): Promise<void> {
  for (const obj of notebookAccessManifests(namespace)) {
    const coll = obj.kind === 'ServiceAccount' ? `/api/v1/namespaces/${ namespace }/serviceaccounts` : `${ RBAC }/namespaces/${ namespace }/${ obj.kind === 'Role' ? 'roles' : 'rolebindings' }`;

    await apply(store, `${ k8s(cluster) }${ coll }`, obj);
  }
}

// ---------- runtimes & jobs ----------

export const listRuntimes = (store: Dispatchable, cluster: string) => list(store, `${ k8s(cluster) }${ RUNTIMES }`);
export const listTrainJobs = (store: Dispatchable, cluster: string) => list(store, `${ k8s(cluster) }${ TRAINJOBS }`);
export const listJobPods = (store: Dispatchable, cluster: string) => list(store, `${ k8s(cluster) }/api/v1/pods?labelSelector=jobset.sigs.k8s.io/jobset-name`);

export async function deleteTrainJob(store: Dispatchable, cluster: string, namespace: string, name: string): Promise<void> {
  try {
    await req(store, `${ k8s(cluster) }/apis/trainer.kubeflow.org/v1alpha1/namespaces/${ namespace }/trainjobs/${ name }`, { method: 'DELETE' });
  } catch (e) {
    throw new Error(msg(e));
  }
}

export async function suspendTrainJob(store: Dispatchable, cluster: string, namespace: string, name: string, suspend: boolean): Promise<void> {
  try {
    await req(store, `${ k8s(cluster) }/apis/trainer.kubeflow.org/v1alpha1/namespaces/${ namespace }/trainjobs/${ name }`, {
      method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, data: { spec: { suspend } }
    });
  } catch (e) {
    throw new Error(msg(e));
  }
}

export async function podLog(store: Dispatchable, cluster: string, namespace: string, pod: string): Promise<string> {
  try {
    const d = await req(store, `${ k8s(cluster) }/api/v1/namespaces/${ namespace }/pods/${ pod }/log?tailLines=300`, { responseType: 'text' });

    return typeof d === 'string' ? d : JSON.stringify(d);
  } catch (e) {
    return `could not read the log: ${ msg(e) }`;
  }
}

export async function listClusters(store: Dispatchable): Promise<{ id: string; label: string }[]> {
  const items = await list(store, `${ k8s('local') }/apis/management.cattle.io/v3/clusters`);

  return items
    .map((c) => ({ id: c.metadata.name, label: c.spec?.displayName || c.metadata.name }))
    .sort((a, b) => (a.id === 'local' ? -1 : b.id === 'local' ? 1 : a.label.localeCompare(b.label)));
}
