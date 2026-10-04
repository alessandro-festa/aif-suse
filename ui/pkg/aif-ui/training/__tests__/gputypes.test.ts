import { describe, expect, it } from 'vitest';
// A profile's GPU type has to mean the same thing on a DRA cluster and on a device-plugin cluster.
// These pin where the inventory comes from in each, how the two spellings of a model are matched,
// and what the pre-flight says when the type cannot be enforced at all.
import {
  gpuInventory, gpuKey, gpuShort, hasGfdLabels, sameGpu
} from '../gputypes';
import { DEFAULT_FORM, Facts, runPreflight } from '../preflight';

const slice = (node: string, devices: [string, string][]) => ({
  spec: {
    driver: 'gpu.nvidia.com', nodeName: node, pool: { name: node }, devices: devices.map(([name, product]) => ({ name, attributes: { productName: { string: product }, type: { string: 'gpu' } } }))
  }
});
const claim = (node: string, device: string) => ({
  status: {
    allocation: {
      devices: {
        results: [{
          driver: 'gpu.nvidia.com', pool: node, device
        }]
      }
    }
  }
});
const gfdNode = (name: string, product: string, count: number) => ({ metadata: { name, labels: { 'nvidia.com/gpu.product': product, 'nvidia.com/gpu.count': String(count) } }, status: { allocatable: {} } });

describe('GPU names', () => {
  it('match across the DRA and GPU Feature Discovery spellings', () => {
    expect(sameGpu('NVIDIA RTX A2000 12GB', 'NVIDIA-RTX-A2000-12GB')).toBe(true);
    expect(sameGpu('NVIDIA A100-SXM4-80GB', 'NVIDIA A100 SXM4 80GB')).toBe(true);
    expect(sameGpu('NVIDIA T400', 'NVIDIA T4')).toBe(false);
    expect(gpuKey(' NVIDIA  RTX A2000 ')).toBe('nvidia-rtx-a2000');
  });

  it('shorten for people', () => {
    expect(gpuShort('NVIDIA RTX A2000 12GB')).toBe('RTX A2000 12GB');
    expect(gpuShort('NVIDIA-RTX-A2000-12GB')).toBe('RTX A2000 12GB');
  });
});

describe('the GPU inventory', () => {
  it('counts DRA devices per model, and free ones from claim allocations', () => {
    const inv = gpuInventory([slice('w1', [['gpu-0', 'NVIDIA A100 80GB'], ['gpu-1', 'NVIDIA A100 80GB']]), slice('w2', [['gpu-0', 'NVIDIA T4']])], [claim('w1', 'gpu-1')], []);

    expect(inv.map((t) => `${ gpuShort(t.product) }:${ t.free }/${ t.total }:${ t.source }`)).toEqual(['A100 80GB:1/2:dra', 'T4:1/1:dra']);
  });

  it('counts device-plugin GPUs from GPU Feature Discovery labels, with free unknown', () => {
    const inv = gpuInventory([], [], [gfdNode('a', 'NVIDIA-L40S', 4), gfdNode('b', 'NVIDIA-L40S', 4), { metadata: { name: 'cpu', labels: {} } }]);

    expect(inv).toEqual([{
      product: 'NVIDIA-L40S', source: 'gfd', total: 8, free: null, nodes: ['a', 'b']
    }]);
  });

  it('reports a model once when both sources see it, keeping the DRA counts', () => {
    const inv = gpuInventory([slice('w1', [['gpu-0', 'NVIDIA RTX A2000 12GB']])], [], [gfdNode('w1', 'NVIDIA-RTX-A2000-12GB', 1)]);

    expect(inv.length).toBe(1);
    expect(inv[0].source).toBe('dra');
  });

  it('ignores the ComputeDomain channel devices', () => {
    const s = slice('w1', [['gpu-0', 'NVIDIA GB200']]);

    s.spec.devices.push({ name: 'channel-0', attributes: { type: { string: 'channel' } } } as any);
    expect(gpuInventory([s], [], [])[0].total).toBe(1);
  });

  it('knows whether GPU Feature Discovery labels exist at all', () => {
    expect(hasGfdLabels([gfdNode('a', 'NVIDIA-L40S', 1)])).toBe(true);
    expect(hasGfdLabels([{ metadata: { name: 'x', labels: {} } }])).toBe(false);
  });
});

describe('the GPU type check', () => {
  const base = (over: Partial<Facts>): Facts => ({
    loaded:                 true,
    namespaces:             ['default'],
    gpuReadable:            true,
    devicePluginGpus:       0,
    draDevices:             0,
    draAllocated:           0,
    draAllocatedBy:         [],
    draClassExists:         false,
    gpuTypes:               [],
    gfdLabels:              false,
    gpuNodes:               [],
    existingJobs:           [],
    configMaps:             [],
    secrets:                [],
    pvcs:                   [],
    storageClasses:         [],
    localQueues:            [],
    clusterQueues:          [],
    kaiQueues:              [],
    runaiProjectNamespaces: [],
    queueIndex:             {},
    capacity:               {
      total: {
        gpu: 0, cpu: 0, memory: 0
      },
      free: {
        gpu: 0, cpu: 0, memory: 0
      }
    },
    fetchErrors: [],
    ...over
  } as any);
  const form = (gpuMode: any, gpuProduct: string, gpusPerNode = 1) => ({
    ...DEFAULT_FORM, namespace: 'default', releaseName: 'r', gpuMode, gpuProduct, gpusPerNode
  });
  const check = (f: any, facts: Facts) => runPreflight(f, facts).find((c) => c.id === 'gpu-type');
  const a2000 = {
    product: 'NVIDIA RTX A2000 12GB', source: 'dra' as const, total: 1, free: 1, nodes: ['w1']
  };

  it('says nothing when any GPU will do', () => {
    expect(check(form('dra', ''), base({
      draClassExists: true, draDevices: 1, gpuTypes: [a2000]
    }))).toBeUndefined();
  });

  it('DRA: passes a model that is free, and names the node', () => {
    const c = check(form('dra', 'NVIDIA RTX A2000 12GB'), base({
      draClassExists: true, draDevices: 1, gpuTypes: [a2000]
    }));

    expect(c?.severity).toBe('pass');
    expect(c?.detail).toContain('w1');
  });

  it('DRA: warns when the model exists but not enough are free, fails when it does not exist', () => {
    expect(check(form('dra', 'NVIDIA RTX A2000 12GB', 2), base({
      draClassExists: true, draDevices: 1, gpuTypes: [a2000]
    }))?.severity).toBe('warn');
    expect(check(form('dra', 'NVIDIA H100 80GB'), base({
      draClassExists: true, draDevices: 1, gpuTypes: [a2000]
    }))?.severity).toBe('fail');
  });

  it('device plugin: fails without GPU Feature Discovery, since the node selector would match nothing', () => {
    const c = check(form('device-plugin', 'NVIDIA L40S'), base({ devicePluginGpus: 8 }));

    expect(c?.severity).toBe('fail');
    expect(c?.detail).toMatch(/GPU Feature Discovery/);
  });

  it('device plugin: passes a model GPU Feature Discovery reports, matched across spellings', () => {
    expect(check(form('device-plugin', 'NVIDIA L40S'), base({
      devicePluginGpus: 8,
      gfdLabels:        true,
      gpuTypes:         [{
        product: 'NVIDIA-L40S', source: 'gfd', total: 8, free: null, nodes: ['a', 'b']
      }]
    }))?.severity).toBe('pass');
  });
});
