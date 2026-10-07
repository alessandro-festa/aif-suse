import { describe, expect, it } from 'vitest';
import {
  listComputePools, poolRow, reclaimDraft, reclaimErrors, reclaimSpec, reclaimText, undiscoveredClusters
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
    const store = { getters: { 'cluster/schemaFor': () => null }, dispatch: () => Promise.reject(new Error('not called')) };

    expect(await listComputePools(store)).toEqual({
      installed: false, rows: [], objects: {}, undiscovered: []
    });
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
