import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
  backendForSchedulerName, holdsPods, placesGpuMemoryShares, POD_HOLDING_SCHEDULERS, podQueueLabel, SCHEDULER_BACKENDS,
  usesQueueTree, workloadQueueLabel
} from '../schedulers';

// schedulers.ts is a copy of the chart's schedulers.yaml, which the chart's templates and the
// operator read. A backend changed in one and not the other would bind a run one way in the
// form and another in the cluster.
const chartTable = yaml.load(readFileSync(path.resolve(__dirname, '../../../../../charts/gpu-train-job/schedulers.yaml'), 'utf8')) as any;

describe('scheduler backends', () => {
  it('are the chart\'s schedulers.yaml', () => {
    expect(SCHEDULER_BACKENDS).toEqual(chartTable.backends);
  });

  it('answer the questions the forms ask', () => {
    expect(['kai', 'runai'].every((s) => holdsPods(s as any))).toBe(true);
    expect(holdsPods('kueue') || holdsPods('none')).toBe(false);
    expect(usesQueueTree('kai') && usesQueueTree('runai') && !usesQueueTree('kueue')).toBe(true);
    expect(placesGpuMemoryShares('kai')).toBe(true);
    expect(placesGpuMemoryShares('runai')).toBe(false);
    expect(podQueueLabel('runai')).toBe('project');
    expect(podQueueLabel('kueue')).toBe('');
    expect(workloadQueueLabel('kueue')).toBe('kueue.x-k8s.io/queue-name');
    expect(backendForSchedulerName('runai-scheduler')).toBe('runai');
    expect(backendForSchedulerName('')).toBeUndefined();
    expect(backendForSchedulerName('default-scheduler')).toBeUndefined();
    expect(POD_HOLDING_SCHEDULERS).toEqual(['kai-scheduler', 'runai-scheduler']);
  });
});
