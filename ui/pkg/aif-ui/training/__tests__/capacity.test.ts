import { describe, expect, it } from 'vitest';
// GPU capacity for the Projects page: physical GPUs and memory, allocation in GPUs and GiB with
// fractional shares at their real size, per-project running/queued workloads, and what sits outside
// any project. KAI's reservation pod must not show up as a GPU held outside every project.
import { capacitySummary, gpuModels, podGpu } from '../capacity';
import { usageFromPods } from '../quota';

const node = {
  metadata: { name: 'gpu-node-1', labels: { 'nvidia.com/gpu.product': 'NVIDIA-RTX-A2000-12GB', 'nvidia.com/gpu.memory': '12282' } },
  status:   { allocatable: { 'nvidia.com/gpu': '1' } },
};
const pod = (ns: string, name: string, opts: { mem?: string; gpu?: string; phase?: string; node?: string; job?: string; queue?: string } = {}) => ({
  metadata: {
    namespace: ns, name, annotations: opts.mem ? { 'gpu-memory': opts.mem } : {}, labels: { ...(opts.job ? { 'job-name': opts.job } : {}), ...(opts.queue ? { 'kai.scheduler/queue': opts.queue } : {}) }
  },
  spec:   { nodeName: opts.node, containers: [{ resources: opts.gpu ? { limits: { 'nvidia.com/gpu': opts.gpu } } : {} }] },
  status: { phase: opts.phase || 'Running' },
});
const pods = [
  pod('team-a', 'vllm-0', { mem: '5120', node: 'gpu-node-1' }),
  pod('team-a', 'dev-1-0', {
    mem: '4096', node: 'gpu-node-1', job: 'dev-1'
  }),
  pod('team-a', 'dev-2-0', {
    mem: '4096', phase: 'Pending', job: 'dev-2'
  }),
  pod('kai-resource-reservation', 'gpu-reservation-x', { gpu: '1', node: 'gpu-node-1' }),
];

describe('GPU capacity', () => {
  it('reads GPU models and memory from GPU Feature Discovery labels', () => {
    expect(gpuModels([node])).toEqual([{
      product: 'NVIDIA RTX A2000 12GB', count: 1, memoryMiB: 12282, nodes: ['gpu-node-1']
    }]);
  });

  it('sizes a KAI share as memory and the fraction KAI charges', () => {
    expect(podGpu(pods[0], 12282)).toEqual({
      gpus: 0.42, memoryMiB: 5120, fractional: true
    });
    expect(podGpu(pod('x', 'w', { gpu: '2' }), 12282)?.memoryMiB).toBe(24564);
  });

  it('counts placed shares toward their project, waiting ones as queued, and skips the reservation pod', () => {
    const s = capacitySummary([node], pods, { 'team-a': 'team-a' }, new Set(['team-a']));

    expect(s.gpus).toBe(1);
    expect(s.memoryMiB).toBe(12282);
    expect(s.allocatedMiB).toBe(9216);
    expect(s.allocatedGpus).toBe(0.76);
    expect(s.queuedWorkloads).toBe(1);
    expect(s.byQueue['team-a']).toEqual({
      gpus: 0.76, memoryMiB: 9216, running: 2, queued: 1
    });
    expect(s.outside.gpus).toBe(0);
  });

  it('reports GPU work in a namespace with no project queue as outside project accounting', () => {
    const s = capacitySummary([node], [pod('default', 'stray', { gpu: '1', node: 'gpu-node-1' })], {}, new Set());

    expect(s.outside.gpus).toBe(1);
    expect(s.outside.workloads).toEqual([{ namespace: 'default', name: 'stray' }]);
  });
});

describe('queue usage from pods with shares', () => {
  it('charges a share at its fraction and does not count the reservation pod as unqueued', () => {
    const index: any = {
      'team-a': {
        name: 'team-a', parent: null, children: [], isLeaf: true, quota: { gpu: 1 }
      }
    };
    const u = usageFromPods(pods as any, { 'team-a': 'team-a' }, index, 'nvidia.com/gpu', 12282);

    expect(u.unqueued).toBe(0);
    expect(Math.round(u.byQueue['team-a'] * 100) / 100).toBe(1.1);
  });
});
