import { describe, expect, it } from 'vitest';
import {
  describeRuns, listComputePools, poolRow, reclaimDraft, reclaimErrors, reclaimSpec, reclaimText, undiscoveredClusters
} from '../compute-pools';

const h100 = {
  metadata: { name: 'c-abc-gpu-nvidia-h100-80gb-hbm3' },
  spec:     { clusterId: 'c-abc', kind: 'gpu', displayName: 'NVIDIA-H100-80GB-HBM3 on prod' },
  status:   {
    nodes:       2,
    allocatable: { cpu: '128', memory: '1Ti', gpus: 16 },
    requested:   { cpu: '10500m', memory: '72Gi', gpus: 5 },
    gpu:         { models: ['NVIDIA-H100-80GB-HBM3'], memoryMiB: 81559 },
    schedulers:  ['kai'],
    sharing:     ['kai-fraction'],
    training:    ['training-operator'],
    conditions:  [{ type: 'Connected', status: 'True', reason: 'Read' }],
  },
};

describe('compute pool rows', () => {
  it('show what the operator read', () => {
    const r = poolRow(h100, { 'c-abc': 'prod' });

    expect(r.clusterName).toBe('prod');
    expect(r.kind).toBe('gpu');
    expect(r.connected).toBe(true);
    expect(r.gpus).toBe(16);
    expect(r.gpusRequested).toBe(5);
    expect(r.cpu).toBe('10.5 / 128');
    expect(r.memory).toBe('72.0Gi / 1024.0Gi');
    expect(r.gpuModels).toEqual(['NVIDIA-H100-80GB-HBM3']);
    expect(r.schedulers).toEqual(['kai']);
  });

  it('say why a cluster cannot be read', () => {
    const r = poolRow({
      metadata: { name: 'c-x-cpu' },
      spec:     { clusterId: 'c-x', kind: 'cpu', disabled: true },
      status:   { conditions: [{ type: 'Connected', status: 'False', reason: 'NoRancherToken', message: 'no Rancher API token' }] },
    });

    expect(r.connected).toBe(false);
    expect(r.reason).toBe('NoRancherToken');
    expect(r.disabled).toBe(true);
    expect(r.clusterName).toBe('c-x');
    expect(r.displayName).toBe('c-x'); // the cluster ID when its name is not known
  });

  it('have no connection state before the first read', () => {
    expect(poolRow({ metadata: { name: 'p' }, spec: { clusterId: 'local', kind: 'cpu' } }).connected).toBeNull();
  });

  it('are not listed when the operator does not serve ComputePool', async() => {
    const store = { dispatch: () => Promise.reject(Object.assign(new Error('Not Found'), { status: 404 })) };

    expect(await listComputePools(store)).toEqual({
      installed: false, rows: [], objects: {}, undiscovered: []
    });
  });

  it('are read from local, whatever cluster the page is on', async() => {
    const urls: string[] = [];
    const store = {
      dispatch: async(action: string, p: any) => {
        if (action === 'management/findAll') {
          return [{ id: 'c-abc', spec: { displayName: 'prod' }, metadata: { name: 'c-abc' } }];
        }
        urls.push(p.url);

        return p.url.endsWith('/computepools') ? { items: [h100] } : { items: [] };
      },
    };
    const got = await listComputePools(store);

    expect(got.installed).toBe(true);
    expect(got.rows.map((r) => r.name)).toEqual(['c-abc-gpu-nvidia-h100-80gb-hbm3']);
    expect(urls).toEqual(['/k8s/clusters/local/apis/ai-factory.suse.com/v1alpha1/computepools', '/k8s/clusters/local/apis/ai-factory.suse.com/v1alpha1/aijobs']);
  });

  it('say what is free and who takes the rest', () => {
    const r = poolRow({
      ...h100,
      status: {
        ...h100.status,
        consumers: [
          {
            kind: 'run', namespace: 'vision', name: 'train-a', pods: 2, requested: { cpu: '8', memory: '32Gi', gpus: 4 }
          },
          {
            kind: 'workload', namespace: 'gpu-operator', pods: 3, requested: { cpu: '1500m', memory: '1Gi' }, used: { cpu: '120m', memory: '300Mi' }
          },
        ],
      },
    });

    expect(r.free).toEqual({ cpu: '117.5', memory: '952.0Gi', gpus: 11 });
    expect(r.consumers[0]).toEqual({
      kind: 'run', namespace: 'vision', name: 'train-a', pods: 2, cpu: '8', memory: '32.0Gi', gpus: 4, usedCpu: '', usedMemory: ''
    });
    expect(r.used).toBeNull();
    expect(r.consumers[1]).toMatchObject({
      kind: 'workload', namespace: 'gpu-operator', cpu: '1.5', gpus: 0, usedCpu: '0.12', usedMemory: '300Mi'
    });
    expect(poolRow({ ...h100, status: { ...h100.status, used: { cpu: '2345m', memory: '3Gi' } } }).used).toEqual({ cpu: '2.35', memory: '3.0Gi' });

    describeRuns([r], [{
      metadata: { name: 'train-a', namespace: 'aif-vision' },
      status:   {
        phase: 'Running', placement: { clusterId: 'c-abc', namespace: 'vision', pool: r.name }, activity: { sampledAt: 'x', utilisation: 2, source: 'gpu', idleSince: 'y' }
      },
    }]);
    expect(r.consumers[0]).toMatchObject({ project: 'vision', phase: 'Running', activity: '2% of its GPUs, idle' });
    expect(r.consumers[1].project).toBeUndefined();

    const gone = poolRow({
      ...h100,
      status: {
        ...h100.status,
        consumers: [{
          kind: 'run', namespace: 'vision', name: 'deleted-run', pods: 1, requested: { cpu: '1' }
        }]
      }
    });

    describeRuns([gone], []);
    expect(gone.consumers[0].phase).toBe('Deleted, stopping');
  });

  it('name the clusters that have no pool yet', () => {
    const clusters = [{ id: 'local', name: 'local' }, { id: 'c-xvstz', name: 'downstream-1' }];

    expect(undiscoveredClusters(clusters, [])).toEqual([{ id: 'c-xvstz', name: 'downstream-1' }]);
    expect(undiscoveredClusters(clusters, [poolRow({ metadata: { name: 'c-xvstz-cpu' }, spec: { clusterId: 'c-xvstz', kind: 'cpu' } })])).toEqual([]);
  });

  it('are named after their cluster', () => {
    expect(poolRow({ metadata: { name: 'c-fg8qv-gpu-l40s' }, spec: { clusterId: 'c-fg8qv', kind: 'gpu' } }, { 'c-fg8qv': 'downstream-2' }).displayName).toBe('downstream-2');
  });
});

describe('idle reclaim settings', () => {
  it('reads off, or when and how runs are reclaimed', () => {
    expect(reclaimText(null)).toBe('Off');
    expect(reclaimText({ idleTimeout: '2h', idleThreshold: 5 })).toBe('after 2 h under 5%');
    expect(reclaimText({
      idleTimeout: '30m', idleThreshold: 10, maxIdleTimeout: '3d', onlyWhenContended: false
    })).toBe('after 30 min under 10% · runs may ask up to 3 d · even with no run waiting');
    expect(poolRow({ spec: { clusterId: 'c-a', kind: 'cpu', reclaim: { idleTimeout: '2h' } } }).reclaim).toEqual({ idleTimeout: '2h' });
    expect(poolRow({ spec: { clusterId: 'c-a', kind: 'cpu' } }).reclaim).toBeNull();
  });

  it('edits round-trip, and an empty or default field is left out', () => {
    const r = {
      idleTimeout: '30m', idleThreshold: 10, maxIdleTimeout: '1d', onlyWhenContended: false
    };

    expect(reclaimSpec(reclaimDraft(r))).toEqual(r);
    expect(reclaimSpec(reclaimDraft({ idleTimeout: '2h' }))).toEqual({ idleTimeout: '2h', idleThreshold: 5 });
    expect(reclaimSpec({ ...reclaimDraft(r), enabled: false })).toBeNull();
    expect(reclaimDraft(null)).toMatchObject({ enabled: false, idleTimeout: '2h', idleThreshold: 5, onlyWhenContended: true });
  });

  it('refuses what the CRD would', () => {
    const ok = reclaimDraft({ idleTimeout: '2h' });

    expect(reclaimErrors(ok)).toEqual({});
    expect(Object.keys(reclaimErrors({
      ...ok, idleTimeout: '90', maxIdleTimeout: '1w', idleThreshold: 0
    })).sort()).toEqual(['idleThreshold', 'idleTimeout', 'maxIdleTimeout']);
    expect(reclaimErrors({ ...ok, enabled: false, idleTimeout: 'x' }), 'nothing to check when off').toEqual({});
  });
});
