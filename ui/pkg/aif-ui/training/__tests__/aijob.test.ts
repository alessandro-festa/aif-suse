import { describe, expect, it } from 'vitest';
import { aiJobFor, AIJOB_TYPE } from '../aijob';

const input = { name: 'train-a1b2c', namespace: 'team-a' };

describe('aiJobFor', () => {
  it('names the job after the run and leaves the chart to the operator', () => {
    const j = aiJobFor({ ...input, values: { job: { nodes: 2 } } });

    expect(j.type).toBe(AIJOB_TYPE);
    expect(j.metadata).toEqual({ name: 'train-a1b2c', namespace: 'team-a' });
    expect(j.spec.category).toBe('training');
    expect('source' in j.spec).toBe(false);
    expect(j.spec.values.job).toEqual({ nodes: 2 });
  });

  it('points at a custom chart when one is given', () => {
    const source = { repoName: 'training', chartName: 'train-job', version: '1.2.0' };

    expect(aiJobFor({ ...input, source, values: {} }).spec.source).toEqual(source);
  });

  it('turns off the capacity check and keeps the other pre-flight settings', () => {
    const j = aiJobFor({ ...input, values: { preflight: { enabled: true, checkHeadroom: true } } });

    expect(j.spec.values.preflight).toEqual({ enabled: true, checkHeadroom: false });
  });

  it('records the profile the run came from', () => {
    expect(aiJobFor({ ...input, values: { profile: 'single-gpu-dev' } }).spec.profile).toBe('single-gpu-dev');
    expect(aiJobFor({ ...input, values: {} }).spec.profile).toBeUndefined();
  });

  it('does not change the values it was given', () => {
    const values = { preflight: { checkHeadroom: true } };

    aiJobFor({ ...input, values });
    expect(values.preflight.checkHeadroom).toBe(true);
  });
});

describe('aiJobFor in a pool', () => {
  it('names the pool and the namespace there', () => {
    const j = aiJobFor({ name: 'train-1', namespace: 'aif-c-x-p-team', pool: 'c-x-gpu', targetNamespace: 'team-a', values: {} });

    expect(j.metadata.namespace).toBe('aif-c-x-p-team');
    expect(j.spec.pool).toBe('c-x-gpu');
    expect(j.spec.targetNamespace).toBe('team-a');
    expect('pool' in aiJobFor({ name: 'b', namespace: 'n', values: {} }).spec).toBe(false);
  });
});
