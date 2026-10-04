// A pod's log, as text, through Rancher's cluster proxy. Recent Kubernetes API servers refuse
// `Accept: text/plain` on the log endpoint (406, "only the following media types are accepted:
// application/json, ..."), yet answer `application/json` with the plain log. So ask for JSON first
// and keep the body as text rather than letting it be parsed.

export const LOG_ACCEPT = 'application/json, text/plain, */*';

export async function readPodLog(store: any, cluster: string, namespace: string, pod: string, query = ''): Promise<string> {
  const res = await store.dispatch('cluster/request', {
    url:          `/k8s/clusters/${ encodeURIComponent(cluster) }/api/v1/namespaces/${ encodeURIComponent(namespace) }/pods/${ encodeURIComponent(pod) }/log${ query ? `?${ query }` : '' }`,
    headers:      { accept: LOG_ACCEPT },
    responseType: 'text',
  });
  const body = typeof res === 'string' ? res : res?.data;

  return typeof body === 'string' ? body : body == null ? '' : JSON.stringify(body);
}
