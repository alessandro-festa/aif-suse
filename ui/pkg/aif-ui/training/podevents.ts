// What a pod that has not started yet is doing. Until its container starts there is no log: the
// pod's events are the whole story (scheduled, volumes attached, image pulling, container
// created), the list `kubectl describe pod` ends with.

export interface PodEvent {
  reason: string;
  message: string;
  type: string; // Normal | Warning
  at: number; // ms since the epoch: the latest time the event was seen
  count: number;
}

/** A pod's events, newest first. Accepts core/v1 Events and events.k8s.io/v1 shapes. */
export function podEvents(list: any[]): PodEvent[] {
  return (list || []).map((e: any) => {
    const t = e.series?.lastObservedTime || e.lastTimestamp || e.eventTime || e.deprecatedLastTimestamp || e.firstTimestamp || e.metadata?.creationTimestamp || '';

    return {
      reason:  String(e.reason || ''),
      message: String(e.message || e.note || '').trim(),
      type:    String(e.type || 'Normal'),
      at:      Date.parse(t) || 0,
      count:   Number(e.series?.count || e.count || 1),
    };
  }).sort((a, b) => b.at - a.at);
}

/** Whether a pod is still being set up: scheduled or waiting, with no container started. */
export function isStarting(pod: any): boolean {
  if (!pod || pod.metadata?.deletionTimestamp) {
    return false;
  }
  const phase = pod.status?.phase;
  const statuses = pod.status?.containerStatuses || [];

  return phase === 'Pending' || (phase === 'Running' && statuses.length > 0 && statuses.every((c: any) => !c.state?.running && !c.state?.terminated));
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));

  return s < 60 ? `${ s }s` : s < 3600 ? `${ Math.floor(s / 60) }m${ String(s % 60).padStart(2, '0') }s` : `${ Math.floor(s / 3600) }h${ String(Math.floor(s % 3600 / 60)).padStart(2, '0') }m`;
}

/** One line for the newest event, e.g. `Pulling: Pulling image "x" · 1m50s`; flagged when a Warning. */
export function describeLatest(events: PodEvent[], now = Date.now()): { text: string; warning: boolean } | null {
  const latest = events[0];

  if (!latest) {
    return null;
  }
  const times = latest.count > 1 ? ` (x${ latest.count })` : '';

  return { text: `${ latest.reason }: ${ latest.message }${ times } · ${ ago(now - latest.at) }`, warning: latest.type === 'Warning' };
}
