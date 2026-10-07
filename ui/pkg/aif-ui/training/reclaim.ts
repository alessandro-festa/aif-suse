// Idle reclaim, as a run's AIJob reports it. In a compute pool that reclaims idle runs the operator
// samples the run about every minute (status.activity) and, once it has been idle past its timeout
// with a run waiting for the pool, uninstalls it: back to the queue (Suspend) or ended Reclaimed
// (Terminate). status.reclaimHistory keeps the last ten.

/** An idle timeout: a number and m, h or d ("30m", "2h", "3d"), as the CRDs take it. */
export const IDLE_DURATION = /^[1-9][0-9]*(m|h|d)$/;

export const RECLAIM_POLICIES = ['Suspend', 'Terminate', 'Never'] as const;
export type ReclaimPolicy = typeof RECLAIM_POLICIES[number];

export const RECLAIM_POLICY_HELP: Record<ReclaimPolicy, string> = {
  Suspend:   'Uninstalled and put back in the queue, in its original order; its checkpoint volume is kept',
  Terminate: 'Uninstalled; the run ends Reclaimed',
  Never:     'Left running; it is only reported idle',
};

export interface ReclaimView {
  activity: string; // "1% of its CPU · idle for 14 min", '' when not sampled
  status: string; // what reclaim is waiting for, or why it is not sampled
  history: { at: string; text: string }[];
  requeued: boolean; // waiting in the queue because it was reclaimed
}

function minutes(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));

  if (m < 60) {
    return `${ m } min`;
  }
  const h = Math.floor(m / 60);

  return h < 48 ? `${ h } h ${ m % 60 } min` : `${ Math.floor(h / 24) } d ${ h % 24 } h`;
}

/** What the run's AIJob says about idle reclaim; null when it says nothing. */
export function reclaimView(aiJob: any, now: Date = new Date()): ReclaimView | null {
  const st = aiJob?.status || {};
  const a = st.activity;
  const hist: any[] = st.reclaimHistory || [];

  if (!a && !hist.length) {
    return null;
  }
  let activity = '';

  if (a?.sampledAt) {
    const of = String(a.source || '').startsWith('gpu') ? 'its GPUs' : 'its CPU request';

    activity = `${ a.utilisation ?? 0 }% of ${ of }`;
    activity += a.idleSince ? ` · idle for ${ minutes(now.getTime() - new Date(a.idleSince).getTime()) }` : ' · active';
  }
  const reclaimed = (st.conditions || []).find((c: any) => c?.type === 'Reclaimed');

  return {
    activity,
    status:   String(a?.message || ''),
    history:  hist.slice().reverse().map((h) => ({
      at:   String(h.at || ''),
      text: `${ h.policy === 'Terminate' ? 'Ended' : 'Requeued' } from ${ h.pool }: ${ h.reason }`,
    })),
    requeued: reclaimed?.status === 'True' && st.phase === 'Pending',
  };
}
