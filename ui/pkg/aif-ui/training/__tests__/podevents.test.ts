import { describe, it, expect } from 'vitest';
import { describeLatest, isStarting, podEvents } from '../podevents';

const T = Date.parse('2026-10-04T13:00:00Z');

describe('podEvents', () => {
  it('orders a pod\'s events newest first, from either Events API', () => {
    const ev = podEvents([
      { reason: 'Scheduled', message: 'Successfully assigned', type: 'Normal', lastTimestamp: '2026-10-04T12:58:00Z' },
      { reason: 'Pulling', note: 'Pulling image "pytorch/pytorch:2.5.1"', type: 'Normal', eventTime: '2026-10-04T12:58:10Z' },
    ]);

    expect(ev.map((e) => e.reason)).toEqual(['Pulling', 'Scheduled']);
    expect(ev[0].message).toBe('Pulling image "pytorch/pytorch:2.5.1"');
  });
});

describe('describeLatest', () => {
  it('says what the pod is doing and for how long', () => {
    const d = describeLatest(podEvents([{ reason: 'Pulling', message: 'Pulling image "x"', type: 'Normal', lastTimestamp: '2026-10-04T12:58:10Z' }]), T);

    expect(d).toEqual({ text: 'Pulling: Pulling image "x" · 1m50s', warning: false });
  });

  it('marks a warning, with how often it repeated', () => {
    const d = describeLatest(podEvents([{ reason: 'FailedMount', message: 'MountVolume.SetUp failed', type: 'Warning', count: 4, lastTimestamp: '2026-10-04T12:59:55Z' }]), T);

    expect(d?.warning).toBe(true);
    expect(d?.text).toBe('FailedMount: MountVolume.SetUp failed (x4) · 5s');
  });

  it('is nothing without events', () => {
    expect(describeLatest([], T)).toBeNull();
  });
});

describe('isStarting', () => {
  it('is a pending pod, or one whose containers have not started', () => {
    expect(isStarting({ status: { phase: 'Pending' } })).toBe(true);
    expect(isStarting({ status: { phase: 'Running', containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }] } })).toBe(true);
    expect(isStarting({ status: { phase: 'Running', containerStatuses: [{ state: { running: {} } }] } })).toBe(false);
    expect(isStarting({ status: { phase: 'Succeeded' } })).toBe(false);
    expect(isStarting({ metadata: { deletionTimestamp: 'x' }, status: { phase: 'Pending' } })).toBe(false);
  });
});
