import { describe, expect, it } from 'vitest';
import { aiJobFor, AIJOB_TYPE } from '../aijob';

const input = {
  name: 'train-a1b2c', namespace: 'team-a', repoName: 'training', chartName: 'train-job', version: '1.2.0'
};

describe('aiJobFor', () => {
  it('names the job after the run and points at the chart', () => {
    const j = aiJobFor({ ...input, values: { job: { nodes: 2 } } });

    expect(j.type).toBe(AIJOB_TYPE);
    expect(j.metadata).toEqual({ name: 'train-a1b2c', namespace: 'team-a' });
    expect(j.spec.category).toBe('training');
    expect(j.spec.source).toEqual({ repoName: 'training', chartName: 'train-job', version: '1.2.0' });
    expect(j.spec.values.job).toEqual({ nodes: 2 });
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
