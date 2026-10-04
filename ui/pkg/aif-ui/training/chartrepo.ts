/**
 * Whether this cluster can install the job chart, and what to say when it cannot.
 *
 * A ClusterRepo is per-cluster and is not replicated by Rancher, so a cluster someone submits from
 * can be entirely healthy -- GPUs visible, quotas right, every preflight green -- and still have no
 * chart to install. The failure reads as "Job template not found" on the Submit page, which sounds
 * like a bug in the extension rather than a missing object in this cluster.
 *
 * Reading the state is kept here, away from the page, because the interesting part is not "does a
 * repo exist" but "is it the right one and has it actually downloaded", and that is worth testing.
 */

export interface ChartRepoState {
  /** A ClusterRepo of the expected name exists in this cluster. */
  present: boolean;
  /** Its spec.url, or '' when absent. */
  url: string;
  /** The repo has fetched its index, so the chart is installable now. */
  ready: boolean;
  /** Why it is not ready, in the words the cluster used. '' when ready or absent. */
  message: string;
}

export const ABSENT: ChartRepoState = {
  present: false, url: '', ready: false, message: ''
};

/**
 * OCI repos and HTTP repos report success through different conditions, and each leaves the other
 * one absent rather than False. Picking by URL scheme avoids reading "no OCIDownloaded condition"
 * on a plain HTTP repo as a failure.
 */
function readyCondition(url: string): string {
  return url.startsWith('oci://') ? 'OCIDownloaded' : 'Downloaded';
}

export function chartRepoState(repos: any[], name: string): ChartRepoState {
  const repo = (Array.isArray(repos) ? repos : []).find((r) => r?.metadata?.name === name);

  if (!repo) {
    return { ...ABSENT };
  }

  const url = String(repo.spec?.url || '');
  const conditions: any[] = Array.isArray(repo.status?.conditions) ? repo.status.conditions : [];
  const wanted = readyCondition(url);
  const cond = conditions.find((c) => c?.type === wanted);

  if (cond?.status === 'True') {
    return {
      present: true, url, ready: true, message: ''
    };
  }

  // A repo that has never been reconciled has no conditions at all. That is a normal few seconds
  // after creation, not an error, so it gets a wait message rather than a failure.
  const failed = conditions.find((c) => c?.status === 'False' && c?.message);
  const message = cond?.message || failed?.message ||
    (conditions.length ? `${ wanted } is not True yet` : 'waiting for Rancher to fetch the repository');

  return {
    present: true, url, ready: false, message
  };
}

/**
 * The URL a repo should have, so a repo pointing somewhere else is reported rather than treated as
 * good enough. Someone who created `gpu-train-charts` by hand against the local cluster's in-cluster
 * Service is the case this catches: the object exists, the name matches, and it can never resolve.
 */
export function urlMismatch(state: ChartRepoState, expected: string): boolean {
  return state.present && !!expected && state.url !== expected;
}

/** The ClusterRepo to create. Kept next to the reader so the two cannot disagree about the shape. */
export function chartRepoManifest(name: string, url: string): any {
  return {
    type:       'catalog.cattle.io.clusterrepo',
    apiVersion: 'catalog.cattle.io/v1',
    kind:       'ClusterRepo',
    metadata:   { name },
    spec:       { url },
  };
}

/**
 * Cluster-scoped object, so this is a cluster-admin action. A project owner can use the extension
 * perfectly well without it and should be shown the command rather than a button that 403s.
 */
export function canCreateChartRepo(schema: any): boolean {
  const methods: string[] = schema?.collectionMethods || [];

  return methods.map((m) => m.toLowerCase()).includes('post');
}
