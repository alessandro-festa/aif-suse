import { describe, expect, it } from 'vitest';
// Only a run's own kept checkpoint volume is offered for deletion, with who still uses it.
import { checkpointRun, checkpointVolumes, pvcRole } from '../checkpoints';

const chart = (run: string) => ({ 'app.kubernetes.io/name': 'gpu-train-job', 'app.kubernetes.io/instance': run });
const pvc = (name: string, labels: any) => ({
  metadata: {
    name, namespace: 'team-a', labels, creationTimestamp: '2026-10-03T02:00:00Z'
  },
  spec:   { storageClassName: 'longhorn', resources: { requests: { storage: '5Gi' } } },
  status: { capacity: { storage: '5Gi' } },
});

describe('run checkpoint volumes', () => {
  it('recognises <run>-checkpoints made by the chart, and nothing else', () => {
    expect(checkpointRun(pvc('dev-1-checkpoints', chart('dev-1')))).toBe('dev-1');
    expect(checkpointRun(pvc('dolly', {}))).toBe('');
    expect(checkpointRun(pvc('dev-1-0-x-scratch', chart('dev-1')))).toBe('');
    expect(checkpointRun(pvc('other-checkpoints', chart('dev-1')))).toBe('');
  });

  it('says who mounts it and whether its run is still active', () => {
    const pods = [{
      metadata: { name: 'reader', namespace: 'team-a' }, spec: { volumes: [{ persistentVolumeClaim: { claimName: 'dev-1-checkpoints' } }] }, status: { phase: 'Running' }
    }];
    const jobs = [{ metadata: { name: 'dev-1', namespace: 'team-a' }, status: { active: 1 } }];
    const [k] = checkpointVolumes([pvc('dev-1-checkpoints', chart('dev-1')), pvc('dolly', {})], pods, jobs);

    expect(k.inUseBy).toEqual(['reader']);
    expect(k.runActive).toBe(true);
    expect(checkpointVolumes([pvc('dev-1-checkpoints', chart('dev-1'))], [], []).length).toBe(1);
  });
});

describe('pvcRole', () => {
  const pvc = (name: string, labels: any = {}, annotations: any = {}) => ({ metadata: { name, labels, annotations } });

  it('tells checkpoint, scratch, app-owned and data volumes apart', () => {
    const chart = { 'app.kubernetes.io/name': 'gpu-train-job', 'app.kubernetes.io/instance': 'train-1' };

    expect(pvcRole(pvc('train-1-checkpoints', chart))).toEqual({ role: 'checkpoint', run: 'train-1' });
    expect(pvcRole(pvc('scratch-train-1-0', chart)).role).toBe('scratch');
    expect(pvcRole(pvc('vllm-storage-claim', { 'app.kubernetes.io/managed-by': 'Helm' }, { 'meta.helm.sh/release-name': 'vllm' })).role).toBe('app');
    expect(pvcRole(pvc('data-litellm-postgresql-0', { 'app.kubernetes.io/instance': 'litellm' })).role).toBe('app');
    expect(pvcRole(pvc('training-data')).role).toBe('data');
  });
});
