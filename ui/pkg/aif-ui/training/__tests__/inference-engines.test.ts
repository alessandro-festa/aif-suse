import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
// The engine blueprints in examples/training/blueprints: vLLM and Ollama from the Application
// Collection, llama.cpp and SGLang from the Inference Engines Apps. Each is read for its model,
// GPUs and endpoint, and a CPU engine is not asked GPU questions.
import { Facts } from '../preflight';
import { aiWorkloadFor, endpointUrl, inferenceChecks, summarizeBlueprint } from '../inference';

const load = (name: string) => yaml.load(readFileSync(path.resolve(__dirname, `../../../../../examples/training/blueprints/${ name }-1-0-0.yaml`), 'utf8')) as any;
const ref = (name: string) => ({ name, version: '1.0.0' });
const summary = (name: string) => summarizeBlueprint(load(name), ref(name));

const cpuFacts = {
  loaded: true, podsReadable: true, gpuReadable: true, draClassExists: false, draDevices: 0, draAllocated: 0, draAllocatedBy: [], devicePluginGpus: 0, secrets: [], storageClasses: [], gpuNodes: []
} as unknown as Facts;

describe('engine blueprints', () => {
  it('reads vLLM from its model spec', () => {
    const s = summary('inference-vllm');

    expect(s).toMatchObject({ engine: 'vllm', model: 'Qwen/Qwen2.5-1.5B-Instruct', gpusPerReplica: 1, service: null });
    expect(endpointUrl(s, 'team-a')).toBe('http://vllm-router-service.team-a.svc/v1');
  });

  it('reads Ollama: the model it runs, on CPU, behind its own Service', () => {
    const s = summary('inference-ollama');

    expect(s).toMatchObject({
      engine: 'ollama', model: 'granite4:350m-h', gpusPerReplica: 0, cpu: '2', memory: '2Gi', cacheSize: '20Gi'
    });
    expect(endpointUrl(s, 'team-a')).toBe('http://ollama.team-a.svc:11434/v1');
  });

  it('reads llama.cpp and SGLang from their own charts', () => {
    const l = summary('inference-llamacpp');
    const g = summary('inference-sglang');

    expect(l).toMatchObject({
      engine: 'llamacpp', model: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', gpusPerReplica: 0, maxModelLen: 4096
    });
    expect(g).toMatchObject({
      engine: 'sglang', model: 'Qwen/Qwen2.5-1.5B-Instruct', gpusPerReplica: 1, memory: '8Gi'
    });
    expect(endpointUrl(l, 'team-a')).toBe('http://llama-cpp.team-a.svc:8000/v1');
    expect(endpointUrl(g, 'team-a')).toBe('http://sglang.team-a.svc:8000/v1');
  });

  it('asks a CPU engine no GPU questions', () => {
    const fails = inferenceChecks({ namespace: 'team-a', name: 'chat' }, ref('inference-llamacpp'), cpuFacts, {
      aifInstalled: true, blueprints: [load('inference-llamacpp')], workloads: [], gpuDeviceMemory: 0
    }).filter((c) => c.severity !== 'pass');

    expect(fails).toEqual([]);
  });

  it('still asks a GPU engine for a GPU', () => {
    const fails = inferenceChecks({ namespace: 'team-a', name: 'chat' }, ref('inference-sglang'), cpuFacts, {
      aifInstalled: true, blueprints: [load('inference-sglang')], workloads: [], gpuDeviceMemory: 0
    }).filter((c) => c.severity === 'fail').map((c) => c.id);

    expect(fails).toEqual(['gpu']);
  });
});

describe('an endpoint in a pool', () => {
  it('is recorded in the AI project namespace on local and runs in the project namespace on the cluster', () => {
    const w = aiWorkloadFor({ namespace: 'team-a', name: 'chat' }, ref('inference-ollama'), 'engine-ollama', 'Ollama — chat', 'c-xvstz', 'aif-team-a');

    expect(w.metadata.namespace).toBe('aif-team-a');
    expect(w.spec.targetNamespace).toBe('team-a');
    expect(w.spec.targetClusters).toEqual(['c-xvstz']);
  });
});
