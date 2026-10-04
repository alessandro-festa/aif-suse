import { describe, expect, it } from 'vitest';
// Sharing one GPU between workloads with MPS: one ResourceClaim, each workload capped at its own
// GPU memory. These pin how the page reads the claims and caps, and what the pre-flight says about
// joining one, so a run that would push the GPU past its memory is refused before it starts.
import {
  gib, kaiShareChecks, parseMpsLimit, pickSharedClaim, podMpsLimit, sharedGpuChecks, sharedGpus
} from '../gpushare';
import { chartValuesFor, DEFAULT_FORM, Facts, runPreflight } from '../preflight';

const claim = (name: string, ns: string, allocated = true, limit = '11000Mi') => ({
  metadata: {
    name, namespace: ns, labels: { 'trainingjobs/gpu-share': 'mps' }
  },
  spec: {
    devices: {
      requests: [{ name: 'gpu', exactly: { deviceClassName: 'gpu.nvidia.com', count: 1 } }],
      config:   [{
        requests: ['gpu'],
        opaque:   {
          driver:     'gpu.nvidia.com',
          parameters: {
            apiVersion: 'resource.nvidia.com/v1beta1', kind: 'GpuConfig', sharing: { strategy: 'MPS', mpsConfig: { defaultActiveThreadPercentage: 100, defaultPinnedDeviceMemoryLimit: limit } }
          }
        }
      }],
    }
  },
  status: allocated ? {
    allocation: {
      devices: {
        results: [{
          driver: 'gpu.nvidia.com', pool: 'w1', device: 'gpu-0'
        }]
      }
    }
  } : {},
});
const slice = {
  spec: {
    driver:   'gpu.nvidia.com',
    nodeName: 'w1',
    pool:     { name: 'w1' },
    devices:  [{
      name: 'gpu-0', attributes: { productName: { string: 'NVIDIA RTX A2000 12GB' } }, capacity: { memory: { value: '12282Mi' } }
    }]
  }
};
const pod = (name: string, ns: string, claimName: string, limit?: string, phase = 'Running') => ({
  metadata: { name, namespace: ns },
  spec:     { resourceClaims: [{ name: 'gpu', resourceClaimName: claimName }], containers: [{ name: 'c', env: limit ? [{ name: 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT', value: limit }] : [] }] },
  status:   { phase },
});

describe('MPS limits', () => {
  it('read the formats MPS and Kubernetes use', () => {
    expect(parseMpsLimit('0=4096M')).toBe(4096);
    expect(parseMpsLimit('4G')).toBe(4096);
    expect(parseMpsLimit('0=7G,1=2G')).toBe(7168);
    expect(parseMpsLimit('5500Mi')).toBe(5500);
    expect(parseMpsLimit('')).toBeNull();
  });

  it('come from the pod that sets one', () => {
    expect(podMpsLimit(pod('a', 'ns', 'gpu-shared', '0=7168M'))).toBe(7168);
    expect(podMpsLimit(pod('a', 'ns', 'gpu-shared'))).toBeNull();
  });
});

describe('shared GPUs', () => {
  const pods = [
    pod('vllm', 'team', 'gpu-shared', '0=7168M'),
    pod('nocap', 'team', 'gpu-shared'),
    pod('done', 'team', 'gpu-shared', '0=4096M', 'Succeeded'),
    pod('elsewhere', 'other', 'gpu-shared', '0=4096M'),
  ];
  const [g] = sharedGpus([claim('gpu-shared', 'team'), { metadata: { name: 'plain', namespace: 'team' }, spec: { devices: { requests: [] } } }], pods, [slice]);

  it('are the MPS claims, with the device they got', () => {
    expect(g.name).toBe('gpu-shared');
    expect(g.product).toBe('NVIDIA RTX A2000 12GB');
    expect(g.totalMiB).toBe(12282);
  });

  it('count the running pods in that namespace, a pod without a cap at the claim default', () => {
    expect(g.users.map((u) => u.pod)).toEqual(['vllm', 'nocap']);
    expect(g.usedMiB).toBe(7168 + 11000);
  });
});

describe('joining a shared GPU', () => {
  const facts = (over: Partial<Facts> = {}): Facts => ({
    draDevices: 1, draAllocated: 1, gpuDeviceMemory: 12282 * 2 ** 20, sharedGpus: sharedGpus([claim('gpu-shared', 'team')], [pod('vllm', 'team', 'gpu-shared', '0=7168M')], [slice]), ...over
  } as any);
  const sev = (cs: any[]) => cs.filter((c) => c.severity !== 'info').map((c) => `${ c.severity }:${ c.title.slice(0, 22) }`);

  it('passes a run that fits beside what is there, and names the other user', () => {
    const c = sharedGpuChecks('team', 'gpu-shared', 4096, 1, 1, facts(), 'dra', 'none');

    expect(c[0].severity).toBe('pass');
    expect(c[0].detail).toContain('vllm 7 GiB');
  });

  it('fails a run that would push the GPU past its memory', () => {
    expect(sharedGpuChecks('team', 'gpu-shared', 6144, 1, 1, facts(), 'dra', 'none')[0].severity).toBe('fail');
  });

  it('counts every pod of the run against the memory', () => {
    expect(sharedGpuChecks('team', 'gpu-shared', 2048, 3, 1, facts(), 'dra', 'none')[0].title).toMatch(/Not enough memory/);
  });

  it('fails without DRA, without a shared GPU in the project, or with more than one GPU per pod', () => {
    expect(sev(sharedGpuChecks('team', 'gpu-shared', 4096, 1, 1, facts(), 'device-plugin', 'none'))[0]).toMatch(/^fail:Sharing a GPU needs/);
    expect(sev(sharedGpuChecks('other', '', 4096, 1, 1, facts(), 'dra', 'none'))[0]).toMatch(/^fail:No shared GPU in other/);
    expect(sev(sharedGpuChecks('team', 'gpu-shared', 4096, 1, 2, facts(), 'dra', 'none'))).toContain('fail:A shared GPU gives eac');
  });

  it('fails a shared claim that is not allocated yet when no GPU is free for it', () => {
    const f = facts({ sharedGpus: sharedGpus([claim('gpu-shared', 'team', false)], [], [slice]), draAllocated: 1 });

    expect(sharedGpuChecks('team', 'gpu-shared', 4096, 1, 1, f, 'dra', 'none')[0].title).toMatch(/not allocated, and no GPU is free/);
  });

  it('notes that Kueue does not charge a shared GPU', () => {
    expect(sharedGpuChecks('team', 'gpu-shared', 4096, 1, 1, facts(), 'dra', 'kueue').some((c) => c.severity === 'info' && /Kueue/.test(c.title))).toBe(true);
  });

  it('in the pre-flight: does not report the shared GPU as in use by others', () => {
    const checks = runPreflight({
      ...DEFAULT_FORM, namespace: 'team', releaseName: 'r', gpuMode: 'dra', gpuShareMiB: 4096, gpuSharedClaim: 'gpu-shared'
    }, {
      ...facts(),
      loaded:                   true,
      namespaces:               ['team'],
      devicePluginGpus:         0,
      podsReadable:             true,
      pytorchOperatorInstalled: true,
      chart:                    null,
      namespaceQueue:           null,
      claimsClusterWide:        true,
      gpuReadable:              true,
      draClassExists:           true,
      draAllocatedBy:           ['team'],
      gpuTypes:                 [],
      gpuNodes:                 [],
      existingJobs:             [],
      configMaps:               [],
      secrets:                  [],
      pvcs:                     [],
      storageClasses:           [],
      localQueues:              [],
      clusterQueues:            [],
      kaiQueues:                [],
      runaiProjectNamespaces:   [],
      queueIndex:               {},
      capacity:                 {
        total: {
          gpu: 0, cpu: 0, memory: 0
        },
        free: {
          gpu: 0, cpu: 0, memory: 0
        }
      },
      fetchErrors: []
    } as any);

    expect(checks.some((c) => c.id === 'gpu-in-use')).toBe(false);
    expect(checks.find((c) => c.id === 'gpu-share')?.severity).toBe('pass');
  });

  it('picks the project\'s shared claim for a form', () => {
    expect(pickSharedClaim({
      ...DEFAULT_FORM, namespace: 'team', gpuSharedClaim: ''
    }, facts())).toBe('gpu-shared');
    expect(pickSharedClaim({
      ...DEFAULT_FORM, namespace: 'other', gpuSharedClaim: 'gpu-shared'
    }, facts())).toBe('');
  });

  it('writes memory for people', () => {
    expect(gib(7168)).toBe('7 GiB');
    expect(gib(5500)).toBe('5.4 GiB');
  });
});

describe('a shared-GPU run in a Kueue project', () => {
  // Kueue marks a workload with a resourceClaimName Inadmissible; it would never start.
  it('installs without Kueue', () => {
    const v = chartValuesFor({
      ...DEFAULT_FORM, scheduler: 'kueue', queue: 'default-queue', gpuShareMiB: 4096, gpuSharedClaim: 'gpu-shared'
    }, true);

    expect(v.scheduler.type).toBe('none');
    expect(v.scheduler.queue).toBe('');
  });

  it('an exclusive run keeps its queue', () => {
    const v = chartValuesFor({
      ...DEFAULT_FORM, scheduler: 'kueue', queue: 'default-queue'
    }, true);

    expect(v.scheduler.type).toBe('kueue');
  });
});

describe('a GPU-memory share under KAI', () => {
  // No claim: KAI queues the pod by its gpu-memory annotation and HAMi-core / NvFractions caps it.
  const facts = (over: Partial<Facts> = {}): Facts => ({
    devicePluginGpus: 1, draDevices: 0, gpuNodeMemoryMiB: 12282, ...over
  } as any);

  it('is queued, and says what fraction of a GPU it is charged', () => {
    const c = kaiShareChecks(3500, 1, facts(), 'KAI scheduler');

    expect(c.length).toBe(1);
    expect(c[0].severity).toBe('info');
    expect(c[0].title).toContain('0.29 of a 12 GiB GPU');
  });

  it('refuses a share bigger than a GPU, two GPUs per pod, and a DRA-only cluster', () => {
    expect(kaiShareChecks(16384, 1, facts(), 'KAI scheduler')[0].severity).toBe('fail');
    expect(kaiShareChecks(4096, 2, facts(), 'KAI scheduler')[0].title).toContain('one GPU per pod');
    expect(kaiShareChecks(4096, 1, facts({ devicePluginGpus: 0, draDevices: 1 } as any), 'KAI scheduler')[0].title).toContain('device plugin');
  });

  it('warns that KAI skips nodes whose GPUs are also published through DRA', () => {
    expect(kaiShareChecks(4096, 1, facts({ draDevices: 1 } as any), 'KAI scheduler')[0].severity).toBe('warn');
  });

  it('installs with no claim, so the chart writes the gpu-memory annotation instead', () => {
    const v = chartValuesFor({
      ...DEFAULT_FORM, scheduler: 'kai', queue: 'team-a', gpuShareMiB: 3500, gpuSharedClaim: 'gpu-shared'
    }, true);

    expect(v.gpu.sharedClaim).toBe('');
    expect(v.gpu.sharedMemoryMiB).toBe(3500);
    expect(v.scheduler.type).toBe('kai');
  });
});
