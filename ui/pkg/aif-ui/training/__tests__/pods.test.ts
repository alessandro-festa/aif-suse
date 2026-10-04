import { describe, expect, it } from 'vitest';
// Which rank is which, and which one a log viewer should open on. Both operators hide the rank in
// a different label and neither puts it in the pod name, so this is the only place that knows.

import { byRank, podRank, primaryPod } from '../pods';

const kubeflow = (type: string, index: number, phase = 'Running') => ({
  id:       `ns/ddp-${ type }-${ index }`,
  metadata: {
    name:   `ddp-${ type }-${ index }`,
    labels: { 'training.kubeflow.org/replica-type': type, 'training.kubeflow.org/replica-index': String(index) },
  },
  status: { phase },
});

const indexed = (index: number, phase = 'Running') => ({
  id:       `ns/train-${ index }`,
  metadata: { name: `train-abc${ index }`, labels: { 'batch.kubernetes.io/job-completion-index': String(index) } },
  status:   { phase },
});

describe('podRank', () => {
  it('reads the rank out of whichever operator created the pod', () => {
    expect(podRank(kubeflow('master', 0))).toBe('master-0');
    expect(podRank(kubeflow('worker', 2))).toBe('worker-2');
    expect(podRank(indexed(1))).toBe('#1');
  });

  // Index 0 is falsy, and a rank named after the pod instead of "0" is the one case where the
  // label matters most -- it is the pod the Logs button defaults to.
  it('does not lose index 0', () => {
    expect(podRank(indexed(0))).toBe('#0');
  });

  it('falls back to the pod name when nothing labels it', () => {
    expect(podRank({ metadata: { name: 'loose-pod' } })).toBe('loose-pod');
    expect(podRank(undefined)).toBe('');
  });
});

describe('byRank', () => {
  it('puts master first and orders workers numerically', () => {
    const pods = [kubeflow('worker', 10), kubeflow('worker', 2), kubeflow('master', 0)];

    expect(pods.sort(byRank).map(podRank)).toEqual(['master-0', 'worker-2', 'worker-10']);
  });

  it('orders an indexed job by index', () => {
    expect([indexed(3), indexed(0), indexed(1)].sort(byRank).map(podRank)).toEqual(['#0', '#1', '#3']);
  });
});

describe('primaryPod', () => {
  // The bug this pins: picking the first Running pod gave whichever rank the API happened to list
  // first -- usually a worker -- so "Logs" showed a rank that only echoes the real output.
  it('picks rank 0 even when a worker is listed first', () => {
    expect(podRank(primaryPod([kubeflow('worker', 1), kubeflow('worker', 0), kubeflow('master', 0)]))).toBe('master-0');
    expect(podRank(primaryPod([indexed(2), indexed(0)]))).toBe('#0');
  });

  // A finished rank 0 still holds the log you came for; phase is not part of the choice.
  it('prefers a completed rank 0 over a running worker', () => {
    expect(podRank(primaryPod([kubeflow('worker', 1), kubeflow('master', 0, 'Succeeded')]))).toBe('master-0');
  });

  it('falls back to something Running when there is no rank 0', () => {
    expect(podRank(primaryPod([kubeflow('worker', 1, 'Pending'), kubeflow('worker', 2)]))).toBe('worker-2');
  });

  it('returns null for a job with no pods yet', () => {
    expect(primaryPod([])).toBeNull();
    expect(primaryPod(undefined as any)).toBeNull();
  });
});
