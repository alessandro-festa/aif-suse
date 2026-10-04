// Which cluster the training pages act on, said in words. AI Factory is a multi-cluster product
// with Rancher's cluster switcher hidden, and its training pages, profiles and projects work on
// the cluster in the route (the management cluster, `local`). Nothing else on the page says so.

export const MANAGEMENT_CLUSTER_ID = 'local';

/** "rke2-prod", or "local (management cluster)": the ID alone says little on most installs. */
export function clusterLabel(id: string, displayName?: string): string {
  const name = (displayName || '').trim() || id;

  return id === MANAGEMENT_CLUSTER_ID ? `${ name } (management cluster)` : name;
}

/** The cluster's Rancher display name; its ID when the user cannot read the cluster object. */
export async function loadClusterLabel(store: any, id: string): Promise<string> {
  try {
    const c = await store.dispatch('management/find', { type: 'management.cattle.io.cluster', id });

    return clusterLabel(id, c?.nameDisplay || c?.spec?.displayName);
  } catch {
    return clusterLabel(id);
  }
}
