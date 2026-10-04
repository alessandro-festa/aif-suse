import { describe, expect, it } from 'vitest';
// An inference profile deploys an AI Factory blueprint as written (aif-operator 2.2.0 ignores
// per-workload overrides), so what the page can check is whether that blueprint, as written, can run
// in the chosen project: GPUs of the right kind, room on a GPU node, a model that fits, and no second
// workload fighting over the same Helm release.
import { DEFAULT_FORM, Facts } from '../preflight';
import {
  aiWorkloadFor, endpointUrl, findBlueprint, inferenceChecks, InferenceFacts, modelParamsB, summarizeBlueprint, weightsGiB
} from '../inference';
import { PROFILE_LABEL, PROFILE_NAMESPACE, profileFromConfigMap } from '../profiles';

const BP = {
  metadata: { name: 'suse-inference-endpoint-dra-1-0-1', labels: { 'ai-factory.suse.com/blueprint-name': 'suse-inference-endpoint-dra', 'ai-factory.suse.com/blueprint-version': '1.0.1' } },
  spec:     {
    displayName: 'SUSE Inference Endpoint (DRA)',
    version:     '1.0.1',
    components:  [{
      chartName: 'vllm-dra',
      chartRepo: 'gpu-train-charts',
      values:    {
        servingEngineSpec: {
          dra:       { enabled: true },
          modelSpec: [{
            name:          'qwen',
            modelURL:      'Qwen/Qwen2.5-1.5B-Instruct',
            requestGPU:    1,
            requestCPU:    2,
            requestMemory: '5Gi',
            replicaCount:  1,
            storageClass:  'longhorn',
            pvcStorage:    '20Gi',
            vllmConfig:    {
              dtype: 'half', maxModelLen: 4096, extraArgs: ['--gpu-memory-utilization', '0.85']
            }
          }],
        },
      },
    }],
  },
};
const REF = { name: 'suse-inference-endpoint-dra', version: '1.0.1' };
const GIB = 2 ** 30;

const facts = (over: Partial<Facts> = {}): Facts => ({
  loaded:           true,
  podsReadable:     true,
  gpuReadable:      true,
  draClassExists:   true,
  draDevices:       1,
  draAllocated:     0,
  draAllocatedBy:   [],
  devicePluginGpus: 0,
  secrets:          [],
  storageClasses:   [{
    name: 'longhorn', provisioner: 'driver.longhorn.io', isDefault: true
  }],
  gpuNodes: [{
    name: 'gpu-node-1', gpus: 1, cpuFree: 2.7, memFree: 6 * GIB, diskPressure: false, ephemeralFree: 0, images: []
  }],
  ...over
} as any);
const inf = (over: Partial<InferenceFacts> = {}): InferenceFacts => ({
  aifInstalled: true, blueprints: [BP], workloads: [], gpuDeviceMemory: 12282 * 2 ** 20, ...over
});
const input = { namespace: 'team-a', name: 'qwen-chat' };
const ids = (checks: any[], sev = 'fail') => checks.filter((c) => c.severity === sev).map((c) => c.id);

describe('reading a blueprint', () => {
  it('finds it by the labels the operator uses', () => {
    expect(findBlueprint([BP], REF)?.metadata.name).toBe('suse-inference-endpoint-dra-1-0-1');
    expect(findBlueprint([BP], { ...REF, version: '9.9.9' })).toBeNull();
  });

  it('summarises the vLLM component', () => {
    const s = summarizeBlueprint(BP, REF);

    expect(s.model).toBe('Qwen/Qwen2.5-1.5B-Instruct');
    expect(s.dra).toBe(true);
    expect(s.gpuMemoryUtilization).toBe(0.85);
    expect(s.releaseNames).toEqual(['vllm-dra']);
    expect(endpointUrl(s, 'team-a')).toBe('http://vllm-dra-router-service.team-a.svc/v1');
  });
});

describe('model size', () => {
  it('reads parameters from the model id', () => {
    expect(modelParamsB('Qwen/Qwen2.5-1.5B-Instruct')).toBe(1.5);
    expect(modelParamsB('meta-llama/Llama-3.1-70B-Instruct')).toBe(70);
    expect(modelParamsB('HuggingFaceTB/SmolLM2-360M-Instruct')).toBe(0.36);
    expect(modelParamsB('mistralai/Mistral-Nemo-Instruct')).toBeNull();
  });

  it('estimates fp16 weights at about 2 bytes a parameter', () => {
    expect(Math.round(weightsGiB(1.5, 'half') * 10) / 10).toBe(3.1);
  });
});

describe('inference pre-flight', () => {
  it('passes the blueprint on an RTX A2000', () => {
    expect(ids(inferenceChecks(input, REF, facts(), inf()))).toEqual([]);
  });

  it('stops early when AI Factory or the blueprint is missing', () => {
    expect(ids(inferenceChecks(input, REF, facts(), inf({ aifInstalled: false })))).toEqual(['aif']);
    expect(ids(inferenceChecks(input, REF, facts(), inf({ blueprints: [] })))).toEqual(['blueprint']);
  });

  it('fails a second workload from the same blueprint in one project, which would share its Helm release', () => {
    const c = inferenceChecks(input, REF, facts(), inf({
      workloads: [{
        name: 'other', namespace: 'team-a', blueprint: 'suse-inference-endpoint-dra'
      }]
    }));

    expect(ids(c)).toContain('name');
    expect(c.find((x) => x.id === 'name' && x.severity === 'fail')?.detail).toMatch(/Helm release vllm-dra/);
  });

  it('allows the same blueprint in another project', () => {
    expect(ids(inferenceChecks(input, REF, facts(), inf({
      workloads: [{
        name: 'other', namespace: 'team-b', blueprint: 'suse-inference-endpoint-dra'
      }]
    })))).toEqual([]);
  });

  it('fails when the only GPU is already claimed', () => {
    expect(ids(inferenceChecks(input, REF, facts({ draAllocated: 1, draAllocatedBy: ['team-a'] }), inf()))).toContain('gpu-in-use');
  });

  it('fails a DRA blueprint on a device-plugin-only cluster, and says which way round', () => {
    expect(ids(inferenceChecks(input, REF, facts({ draClassExists: false, devicePluginGpus: 4 }), inf()))).toContain('gpu');
  });

  it('fails when no GPU node has the memory the engine requests', () => {
    expect(ids(inferenceChecks(input, REF, facts({
      gpuNodes: [{
        name: 'w', gpus: 1, cpuFree: 4, memFree: 2 * GIB, diskPressure: false, ephemeralFree: 0, images: []
      }]
    }), inf()))).toContain('headroom');
  });

  it('fails a model too big for the GPU', () => {
    const big = JSON.parse(JSON.stringify(BP));

    big.spec.components[0].values.servingEngineSpec.modelSpec[0].modelURL = 'Qwen/Qwen2.5-14B-Instruct';
    expect(ids(inferenceChecks(input, REF, facts(), inf({ blueprints: [big] })))).toContain('model-fit');
  });

  it('fails a model cache on a storage class the cluster does not have', () => {
    expect(ids(inferenceChecks(input, REF, facts({
      storageClasses: [{
        name: 'local-path', provisioner: 'x', isDefault: true
      }]
    }), inf()))).toContain('storage-class');
  });
});

describe('the AIWorkload a deployment creates', () => {
  it('installs the profile blueprint into the project namespace, labelled with the profile', () => {
    const w = aiWorkloadFor(input, REF, 'vllm-qwen', 'Qwen chat', 'local');

    expect(w.metadata).toEqual({
      name: 'qwen-chat', namespace: 'team-a', labels: { 'trainingjobs/profile': 'vllm-qwen' }
    });
    expect(w.spec.source).toEqual({ sourceType: 'Blueprint', blueprint: REF });
    expect(w.spec.targetNamespace).toBe('team-a');
    expect(w.spec.targetClusters).toEqual(['local']);
  });
});

describe('inference profiles', () => {
  const cm = (doc: any) => profileFromConfigMap({
    metadata: {
      name: 'vllm-qwen', namespace: PROFILE_NAMESPACE, labels: { [PROFILE_LABEL]: 'inference' }
    },
    data: { 'profile.yaml': JSON.stringify(doc) }
  }, JSON.parse);

  it('carry the blueprint they deploy', () => {
    expect(cm({ displayName: 'x', blueprint: REF })?.blueprint).toEqual(REF);
  });

  it('report a missing blueprint as a problem', () => {
    expect(cm({ displayName: 'x' })?.problems[0]).toMatch(/blueprint/);
  });

  it('do not disturb training profiles', () => {
    expect(DEFAULT_FORM.nodes).toBe(1);
  });
});

describe('a blueprint with the LiteLLM gateway', () => {
  const withGw = JSON.parse(JSON.stringify(BP));

  withGw.spec.components.push({
    chartName: 'litellm', chartRepo: 'suse-ai-registry', values: { service: { port: 4000 } }
  });

  it('points clients at the gateway, not at vLLM', () => {
    expect(endpointUrl(summarizeBlueprint(withGw, REF), 'team-a')).toBe('http://litellm.team-a.svc:4000/v1');
  });

  const need = [{ name: 'litellm-credentials', hint: 'kubectl create secret generic litellm-credentials ...' }];

  it('fails when a required Secret is missing, with the profile hint', () => {
    const c = inferenceChecks(input, REF, facts({ secrets: ['other'] }), inf({ blueprints: [withGw] }), need);

    expect(c.find((x) => x.id === 'required-secret')?.severity).toBe('fail');
    expect(c.find((x) => x.id === 'required-secret')?.detail).toContain('kubectl create secret');
  });

  it('passes when it exists, and only warns when Secrets cannot be listed', () => {
    expect(inferenceChecks(input, REF, facts({ secrets: ['litellm-credentials'] }), inf({ blueprints: [withGw] }), need).find((x) => x.id === 'required-secret')?.severity).toBe('pass');
    expect(inferenceChecks(input, REF, facts({ secrets: [] }), inf({ blueprints: [withGw] }), need).find((x) => x.id === 'required-secret')?.severity).toBe('warn');
  });
});

describe('an engine on a shared GPU', () => {
  const shared = (util: string, cap: string) => {
    const b = JSON.parse(JSON.stringify(BP));
    const e = b.spec.components[0].values.servingEngineSpec;

    e.dra.sharedClaim = 'gpu-shared';
    e.modelSpec[0].env = [{ name: 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT', value: cap }];
    e.modelSpec[0].vllmConfig.extraArgs = ['--gpu-memory-utilization', util];

    return b;
  };
  const sharedFacts = facts({
    sharedGpus: [{
      name: 'gpu-shared', namespace: 'team-a', strategy: 'MPS', defaultLimitMiB: 11000, allocated: true, node: 'gpu-node-1', product: 'NVIDIA RTX A2000 12GB', totalMiB: 12282, users: [], usedMiB: 0
    }]
  } as any);
  const shareFails = (b: any) => inferenceChecks(input, REF, sharedFacts, inf({ blueprints: [b] })).filter((c) => c.id === 'gpu-share' && c.severity === 'fail').map((c) => c.title);

  it('fails a utilization that, with vLLM overhead, passes its MPS cap (the 1.2.0 crash)', () => {
    expect(shareFails(shared('0.55', '0=7168M'))).toEqual(['vLLM would not fit under its GPU memory cap']);
  });

  it('passes one that leaves room under the cap (1.2.1)', () => {
    expect(shareFails(shared('0.45', '0=7168M'))).toEqual([]);
  });

  it('checks memory on the shared claim, not a free GPU', () => {
    const c = inferenceChecks(input, REF, facts({ ...sharedFacts, draAllocated: 1 } as any), inf({ blueprints: [shared('0.45', '0=7168M')] }));

    expect(c.some((x) => x.id === 'gpu-in-use')).toBe(false);
    expect(c.find((x) => x.id === 'gpu-share')?.severity).toBe('pass');
  });
});

describe('an endpoint on a KAI GPU-memory share', () => {
  // Blueprint 1.3.0: the engine asks KAI for 5 GiB (gpu-memory) instead of a GPU or a claim.
  const KAI_BP = JSON.parse(JSON.stringify(BP));
  const REF130 = { name: 'suse-inference-endpoint-dra', version: '1.3.0' };

  KAI_BP.metadata.labels['ai-factory.suse.com/blueprint-version'] = '1.3.0';
  KAI_BP.spec.version = '1.3.0';
  Object.assign(KAI_BP.spec.components[0].values.servingEngineSpec, {
    dra: { enabled: false }, schedulerName: 'kai-scheduler', labels: { 'kai.scheduler/queue': 'team-a' }
  });
  Object.assign(KAI_BP.spec.components[0].values.servingEngineSpec.modelSpec[0], { requestGPU: 0, podAnnotations: { 'gpu-memory': '5120' } });
  const kaiFacts = (over: any = {}) => facts({
    draClassExists: false, draDevices: 0, devicePluginGpus: 1, kaiInstalled: true, namespaceQueue: 'team-a', gpuNodeMemoryMiB: 12282, ...over
  } as any);

  it('reads the share and the queue from the blueprint', () => {
    const s = summarizeBlueprint(KAI_BP, REF130);

    expect(s.kaiMemoryMiB).toBe(5120);
    expect(s.kaiQueue).toBe('team-a');
    expect(s.gpusPerReplica).toBe(0);
  });

  it('passes under KAI, and the model fits 85% of the share', () => {
    const c = inferenceChecks(input, REF130, kaiFacts(), inf({ blueprints: [KAI_BP], gpuDeviceMemory: 0 }));

    expect(ids(c)).toEqual([]);
    expect(c.find((x: any) => x.id === 'model-fit')?.title).toContain('of 4.3 GiB');
    expect(c.find((x: any) => x.id === 'gpu-share')?.title).toContain('Queued by KAI');
  });

  it('fails without KAI, and warns when the project is in another queue', () => {
    expect(ids(inferenceChecks(input, REF130, kaiFacts({ kaiInstalled: false }), inf({ blueprints: [KAI_BP] })))).toContain('queue');
    expect(ids(inferenceChecks(input, REF130, kaiFacts({ namespaceQueue: 'team-b' }), inf({ blueprints: [KAI_BP] })), 'warn')).toContain('queue');
  });
});
