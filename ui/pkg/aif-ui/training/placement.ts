// Where a training run goes and how the pages reach it across clusters.
//
// A run's AIJob lives on Rancher's local cluster, in its AI project's namespace there (aif-<project>,
// kept by the operator for every AIProject); the run itself goes to a compute pool on one of the
// clusters the project spans, in the project's namespace there. Pages that work on a pool's cluster
// (Submit, Deploy) still read the projects, pools, profiles and AIJobs from local, through these
// helpers rather than the cluster store, which follows the page's cluster.

import { poolRow, type ComputePoolRow } from '../services/compute-pools';
import { PROFILE_NAMESPACE } from './profiles';

export const LOCAL_CLUSTER = 'local';
const AIF_API = '/apis/ai-factory.suse.com/v1alpha1';
/** The label the operator puts on every pod of a run. */
export const JOB_ID_LABEL = 'ai-factory.suse.com/job-id';

const localURL = (path: string) => `/k8s/clusters/${ LOCAL_CLUSTER }${ path }`;
const clusterURL = (cluster: string, path: string) => `/k8s/clusters/${ encodeURIComponent(cluster) }${ path }`;

async function get(store: any, url: string): Promise<any> {
  const res = await store.dispatch('cluster/request', { url });

  return res?.data ?? res;
}

/** The namespace on local that holds an AI project's AIJobs. */
export function projectNamespace(project: string): string {
  return `aif-${ project }`;
}

/** Every AIProject (read from local). */
export async function fetchProjects(store: any): Promise<any[]> {
  const list = await get(store, localURL(`${ AIF_API }/aiprojects`));

  return (list?.items || []).sort((a: any, b: any) => (a.spec?.displayName || a.metadata.name).localeCompare(b.spec?.displayName || b.metadata.name));
}

/** The project's namespace on a cluster it spans, or '' when it does not span it. */
export function projectClusterNamespace(project: any, clusterId: string): string {
  return (project?.spec?.clusters || []).find((c: any) => c.clusterId === clusterId)?.namespace || '';
}

/** Usable pools on every downstream cluster, with their cluster's name. */
export async function fetchPools(store: any, clusterNames: Record<string, string> = {}): Promise<ComputePoolRow[]> {
  const list = await get(store, localURL(`${ AIF_API }/computepools`));

  return (list?.items || [])
    .map((p: any) => poolRow(p, clusterNames))
    .filter((r: ComputePoolRow) => r.clusterId !== LOCAL_CLUSTER && !r.disabled)
    .sort((a: ComputePoolRow, b: ComputePoolRow) => a.displayName.localeCompare(b.displayName) || a.kind.localeCompare(b.kind));
}

/** How a pool reads in a picker: its cluster, its kind and GPU model, and what is free. */
export function poolLabel(p: ComputePoolRow): string {
  if (p.kind === 'gpu') {
    const model = p.gpuModels.length ? ` ${ p.gpuModels.join('/') }` : '';

    return `${ p.displayName } · GPU${ model } · ${ Math.max(p.gpus - p.gpusRequested, 0) } of ${ p.gpus } free`;
  }

  return `${ p.displayName } · CPU · ${ p.nodes } node${ p.nodes === 1 ? '' : 's' }`;
}

/** The training and inference profiles, which live on local whatever cluster a page is on. */
export async function localProfileConfigMaps(store: any): Promise<any[]> {
  const list = await get(store, localURL(`/api/v1/namespaces/${ PROFILE_NAMESPACE }/configmaps`));

  return list?.items || [];
}

/** The Blueprints, which live on local, whatever cluster a page is on. */
export async function localBlueprints(store: any): Promise<any[]> {
  const list = await get(store, localURL(`${ AIF_API }/blueprints`));

  return list?.items || [];
}

/** The AIWorkloads (deployed blueprints, inference endpoints among them), which live on local. */
export async function localAIWorkloads(store: any): Promise<any[]> {
  const list = await get(store, localURL(`${ AIF_API }/aiworkloads`));

  return list?.items || [];
}

/** Create an AIWorkload on local. */
export async function createAIWorkload(store: any, workload: any): Promise<any> {
  const body = { apiVersion: 'ai-factory.suse.com/v1alpha1', kind: 'AIWorkload', ...workload };

  delete body.type;

  return store.dispatch('cluster/request', {
    url:    localURL(`${ AIF_API }/namespaces/${ encodeURIComponent(workload.metadata.namespace) }/aiworkloads`),
    method: 'POST',
    data:   body,
  });
}

/** Create an AIJob on local. */
export async function createAIJob(store: any, job: any): Promise<any> {
  const body = { ...job };

  delete body.type;

  return store.dispatch('cluster/request', {
    url:    localURL(`${ AIF_API }/namespaces/${ encodeURIComponent(job.metadata.namespace) }/aijobs`),
    method: 'POST',
    data:   body,
  });
}

/** Where an AIJob ran, when it ran on another cluster. */
export function placementOf(aiJob: any): { clusterId: string; namespace: string } | null {
  const p = aiJob?.status?.placement;

  return p?.clusterId && p.clusterId !== LOCAL_CLUSTER ? { clusterId: p.clusterId, namespace: p.namespace } : null;
}

/**
 * The pods of runs placed on other clusters, each marked with its cluster (`__clusterId`) so a
 * pod is matched to its run by cluster as well as by namespace and job id. Read per namespace: a
 * project member may list pods in the project's namespaces but rarely across a whole cluster. A
 * namespace that cannot be read contributes none.
 */
export async function placedPods(store: any, aiJobs: any[]): Promise<any[]> {
  const where = new Map<string, { clusterId: string; namespace: string }>();

  for (const a of aiJobs || []) {
    const p = placementOf(a);

    if (p) {
      where.set(`${ p.clusterId }/${ p.namespace }`, p);
    }
  }
  const lists = await Promise.all([...where.values()].map(async({ clusterId, namespace }) => {
    try {
      const list = await get(store, clusterURL(clusterId, `/api/v1/namespaces/${ encodeURIComponent(namespace) }/pods?labelSelector=${ encodeURIComponent(JOB_ID_LABEL) }`));

      return (list?.items || []).map((p: any) => ({ ...p, __clusterId: clusterId }));
    } catch {
      return [];
    }
  }));

  return lists.flat();
}

/** A placed run's pods, out of the pods placedPods read. */
export function podsOfPlacedJob(aiJob: any, pods: any[]): any[] {
  const p = placementOf(aiJob);

  if (!p) {
    return [];
  }

  return (pods || []).filter((pod) => pod.__clusterId === p.clusterId && pod.metadata?.namespace === p.namespace &&
    pod.metadata?.labels?.[JOB_ID_LABEL] === aiJob.metadata?.name);
}
