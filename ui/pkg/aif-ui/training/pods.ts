/**
 * Naming and ordering the pods of one run.
 *
 * A distributed run is N pods that are not interchangeable: rank 0 drives it and the rest follow,
 * and when something goes wrong the question is always "which rank?". Kubernetes does not answer
 * that in the pod name — a PyTorchJob pod is `<job>-worker-1` and an Indexed Job pod is
 * `<job>-<random>` with the rank only in a label — so the rank is reconstructed here, once, and
 * every place that lists pods uses it.
 */

/** `master-0`, `worker-1`, or `#2` for an Indexed Job. Falls back to the pod name. */
export function podRank(pod: any): string {
  const labels = pod?.metadata?.labels || {};
  const replicaType = labels['training.kubeflow.org/replica-type'];

  if (replicaType) {
    return `${ replicaType }-${ labels['training.kubeflow.org/replica-index'] ?? 0 }`;
  }

  const index = labels['batch.kubernetes.io/job-completion-index'] ?? labels['apps.kubernetes.io/pod-index'];

  return index === undefined || index === null ? (pod?.metadata?.name || '') : `#${ index }`;
}

/**
 * Master first, then workers by index. Numeric, not lexical, so worker-10 does not sort before
 * worker-2 on a job big enough for that to matter.
 */
export function byRank(a: any, b: any): number {
  const group = (p: any) => (podRank(p).startsWith('master') ? 0 : 1);
  const num = (p: any) => {
    const m = podRank(p).match(/(\d+)$/);

    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };

  return group(a) - group(b) || num(a) - num(b) || podRank(a).localeCompare(podRank(b));
}

/**
 * The rank to open a log viewer on by default: rank 0, whatever its phase.
 *
 * Rank 0 prints the run's own output — the other ranks echo it at best — and a finished rank 0
 * still holds the log you want, which is why phase is not part of the choice. Only when there is
 * no rank 0 at all (a worker-only group, a pod already garbage-collected) does this fall back to
 * something Running, and then to whatever exists.
 */
export function primaryPod(pods: any[]): any {
  const ordered = [...(pods || [])].sort(byRank);

  return ordered.find((p) => /(^master|#0$|-0$)/.test(podRank(p))) ||
    ordered.find((p) => p?.status?.phase === 'Running') || ordered[0] || null;
}
