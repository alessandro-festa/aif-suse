import { describe, expect, it } from 'vitest';
// Idle reclaim in the UI: a profile says what happens to its runs when they sit idle in a pool that
// reclaims, the AIJob carries it, and the run's detail reads what the operator reports back.
import { aiJobFor } from '../aijob';
import { PROFILE_LABEL, PROFILE_NAMESPACE, profileFromConfigMap } from '../profiles';
import { reclaimView } from '../reclaim';

const profile = (doc: any) => profileFromConfigMap({
  metadata: { name: 'notebook', namespace: PROFILE_NAMESPACE, labels: { [PROFILE_LABEL]: 'training' } },
  data:     { 'profile.yaml': JSON.stringify({ displayName: 'Notebook', values: {}, ...doc }) },
}, JSON.parse);

describe('a profile\'s reclaim policy', () => {
  it('is read, or left to the operator\'s default', () => {
    expect(profile({ reclaim: { policy: 'Terminate', idleTimeout: '4h' } })?.reclaim).toEqual({ policy: 'Terminate', idleTimeout: '4h' });
    expect(profile({ reclaim: { policy: 'Never' } })?.reclaim).toEqual({ policy: 'Never', idleTimeout: '' });
    expect(profile({})?.reclaim).toBeNull();
  });

  it('reports what it cannot use as a problem', () => {
    const p = profile({ reclaim: { policy: 'Pause', idleTimeout: '1w' } });

    expect(p?.reclaim).toBeNull();
    expect(p?.problems.join(' ')).toContain('reclaim.policy "Pause"');
    expect(p?.problems.join(' ')).toContain('reclaim.idleTimeout "1w"');
  });

  it('goes into the AIJob, without empty fields', () => {
    const base = { name: 'r', namespace: 'aif-vision', values: {} };

    expect(aiJobFor({ ...base, reclaim: { policy: 'Suspend', idleTimeout: '2h' } }).spec.reclaim).toEqual({ policy: 'Suspend', idleTimeout: '2h' });
    expect(aiJobFor({ ...base, reclaim: { policy: '', idleTimeout: '30m' } }).spec.reclaim).toEqual({ idleTimeout: '30m' });
    expect(aiJobFor({ ...base, reclaim: { policy: '', idleTimeout: '' } }).spec.reclaim).toBeUndefined();
    expect(aiJobFor(base).spec.reclaim).toBeUndefined();
  });
});

describe('what the run\'s detail says', () => {
  const now = new Date('2026-10-07T13:20:00Z');

  it('nothing for a run in a pool that does not reclaim', () => {
    expect(reclaimView({ status: { phase: 'Running' } }, now)).toBeNull();
  });

  it('its activity and what reclaim waits for', () => {
    const v = reclaimView({
      status: {
        phase:    'Running',
        activity: {
          source: 'cpu', utilisation: 1, sampledAt: '2026-10-07T13:19:30Z', idleSince: '2026-10-07T13:06:00Z', message: 'idle for 14m0s of 30m0s'
        },
      },
    }, now);

    expect(v?.activity).toBe('1% of its CPU request · idle for 14 min');
    expect(v?.status).toBe('idle for 14m0s of 30m0s');
    expect(v?.requeued).toBe(false);
    expect(reclaimView({ status: { activity: { source: 'gpu', utilisation: 80, sampledAt: 'x' } } }, now)?.activity).toBe('80% of its GPUs · active');
  });

  it('a run reclaimed and waiting again, newest reclaim first', () => {
    const v = reclaimView({
      status: {
        phase:          'Pending',
        conditions:     [{ type: 'Reclaimed', status: 'True' }],
        reclaimHistory: [
          { at: '2026-10-07T10:00:00Z', pool: 'c-a-cpu', policy: 'Suspend', reason: 'idle for 2h0m0s, for aif-vision/b' },
          { at: '2026-10-07T13:00:00Z', pool: 'c-b-cpu', policy: 'Suspend', reason: 'idle for 2h0m0s, for aif-vision/c' },
        ],
      },
    }, now);

    expect(v?.requeued).toBe(true);
    expect(v?.history.map((h) => h.text)).toEqual(['Requeued from c-b-cpu: idle for 2h0m0s, for aif-vision/c', 'Requeued from c-a-cpu: idle for 2h0m0s, for aif-vision/b']);
  });
});
