import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { queueOf } from '../trainingruns';
import {
  backendForSchedulerName, defaultQueue, holdsPods, placesGpuMemoryShares, POD_HOLDING_SCHEDULERS, podQueueAnnotation, podQueueLabel, SCHEDULER_BACKENDS, SHARING_LAYERS, sharingLayersOn, usesQueueTree, workloadQueueLabel, worksWithLayer
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
    expect(POD_HOLDING_SCHEDULERS).toEqual(['kai-scheduler', 'runai-scheduler', 'volcano']);
    expect(podQueueLabel('volcano')).toBe(''); // Volcano names its queue in an annotation
    expect(podQueueAnnotation('volcano')).toBe('scheduling.volcano.sh/queue-name');
    expect(defaultQueue('volcano')).toBe('default');
    expect(defaultQueue('kai')).toBe('');
    expect(holdsPods('volcano') && !usesQueueTree('volcano')).toBe(true);
    expect(backendForSchedulerName('volcano')).toBe('volcano');
  });
});

describe('a run\'s queue in the Jobs list', () => {
  it('is read from the label or annotation its scheduler uses', () => {
    expect(queueOf({}, { 'kai.scheduler/queue': 'team-a' }, 'kai-scheduler')).toBe('team-a');
    expect(queueOf({}, {}, 'volcano', { 'scheduling.volcano.sh/queue-name': 'team-b' })).toBe('team-b');
    expect(queueOf({}, {}, 'default-scheduler', { 'scheduling.volcano.sh/queue-name': 'x' })).toBe('');
  });
});

describe('GPU-sharing layers', () => {
  it('are the chart\'s schedulers.yaml sharingLayers', () => {
    expect(SHARING_LAYERS).toEqual(chartTable.sharingLayers);
  });

  it('are found on the nodes, and work with the default scheduler and Kueue only', () => {
    expect(sharingLayersOn([{ metadata: { annotations: { 'hami.io/node-nvidia-register': 'GPU-a,10,23034,100,NVIDIA-L4,0,true' } } }])).toEqual(['hami']);
    expect(sharingLayersOn([{ metadata: {} }])).toEqual([]);
    expect(['none', 'kueue'].every((s) => worksWithLayer(s as any, 'hami'))).toBe(true);
    expect(['kai', 'runai', 'volcano'].some((s) => worksWithLayer(s as any, 'hami'))).toBe(false);
  });
});
