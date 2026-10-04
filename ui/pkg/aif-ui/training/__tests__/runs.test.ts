import { describe, expect, it } from 'vitest';
// The Workloads list puts training runs and inference endpoints in one table. These pin the shared
// vocabulary (type, profile, resources, state) and the table mechanics (filter, sort, page).
import {
  ago, ALL_RUNS, filterRuns, gpusPerPod, inferenceToRuns, pageOf, podRole, Run, sortRuns, trainingToRuns, workloadPods
} from '../runs';
import { trainingRuns } from '../trainingruns';
import { PROFILE_LABEL, PROFILE_NAMESPACE, profileFromConfigMap } from '../profiles';

const prof = (name: string, type: string, doc: any) => profileFromConfigMap({
  metadata: {
    name, namespace: PROFILE_NAMESPACE, labels: { [PROFILE_LABEL]: type }
  },
  data: { 'profile.yaml': JSON.stringify(doc) }
}, JSON.parse) as any;
const PROFILES = [
  prof('gpu-smoke', 'training', { displayName: 'GPU Smoke Test', gpu: 'any' }),
  prof('pytorch-distributed', 'training', { displayName: 'PyTorch Distributed', gpu: 'A2000' }),
  prof('vllm-qwen', 'inference', {
    displayName: 'vLLM · Qwen', gpu: 'A2000', blueprint: { name: 'bp', version: '1.0.0' }
  }),
];

const app = (name: string, profile?: string) => ({
  metadata: {
    name, namespace: 'team-a', creationTimestamp: '2026-09-30T10:00:00Z'
  },
  spec: { name, chart: { metadata: { name: 'gpu-train-job', annotations: profile ? { 'trainingjobs/profile': profile } : {} } } },
});
const draJob = (name: string, completions: number, over: any = {}) => ({
  metadata: {
    name, namespace: 'team-a', uid: name, creationTimestamp: '2026-09-30T11:00:00Z', labels: { 'app.kubernetes.io/name': 'gpu-train-job' }
  },
  spec:   { completions, template: { spec: { containers: [{ name: 'trainer' }], resourceClaims: [{ name: 'gpu', resourceClaimTemplateName: `${ name }-gpu` }] } } },
  status: { active: completions },
  ...over,
});
const rct = (name: string, count: number) => ({ metadata: { name, namespace: 'team-a' }, spec: { spec: { devices: { requests: [{ name: 'gpu', exactly: { deviceClassName: 'gpu.nvidia.com', count } }] } } } });
const pod = (job: string) => ({ metadata: { namespace: 'team-a', labels: { 'job-name': job } }, status: { phase: 'Running' } });

describe('training runs', () => {
  const runs = trainingRuns({
    jobs: [draJob('ddp', 2)], pytorchJobs: [], kueueWorkloads: [], apps: [app('ddp', 'pytorch-distributed'), app('old')], pods: [pod('ddp')]
  });
  const rows = trainingToRuns(runs, PROFILES, [rct('ddp-gpu', 1)]);

  it('are the jobs of the chart plus releases whose job is gone, newest first', () => {
    expect(runs.map((r) => `${ r.name }:${ r.phase }`)).toEqual(['ddp:Running', 'old:Finished']);
  });

  it('take their profile from the release annotation, and are Custom without one', () => {
    expect(rows.map((r) => r.profileLabel)).toEqual(['PyTorch Distributed', 'Custom']);
  });

  it('count DRA GPUs from the claim template, times the pods', () => {
    expect(rows[0].resources).toBe('2 × A2000');
    expect(rows[1].resources).toBe('—');
  });

  it('map phases onto the shared states', () => {
    expect(rows.map((r) => r.state)).toEqual(['Running', 'Completed']);
  });

  it('count device-plugin GPUs from the container limit, and skip the ComputeDomain channel claim', () => {
    expect(gpusPerPod({ containers: [{ resources: { limits: { 'nvidia.com/gpu': '4' } } }] }, 'x', [])).toBe(4);
    expect(gpusPerPod({ containers: [{}], resourceClaims: [{ resourceClaimTemplateName: 'cd' }] }, 'x', [{ metadata: { name: 'cd', namespace: 'x' }, spec: { spec: { devices: { requests: [{ exactly: { deviceClassName: 'compute-domain-default-channel.nvidia.com' } }] } } } }])).toBe(0);
  });
});

describe('inference endpoints', () => {
  const bp = {
    metadata: { labels: { 'ai-factory.suse.com/blueprint-name': 'bp', 'ai-factory.suse.com/blueprint-version': '1.0.0' } },
    spec:     {
      components: [{
        chartName: 'vllm-dra',
        values:    {
          servingEngineSpec: {
            dra:       { enabled: true },
            modelSpec: [{
              modelURL: 'Qwen/Qwen2.5-1.5B-Instruct', requestGPU: 1, replicaCount: 2
            }]
          }
        }
      }]
    },
  };
  const w = (name: string, phase: string, labelled = true) => ({
    metadata: {
      name, namespace: 'team-a', creationTimestamp: '2026-09-30T12:00:00Z', labels: labelled ? { 'trainingjobs/profile': 'vllm-qwen' } : {}
    },
    spec:   { targetNamespace: 'team-a', source: { blueprint: { name: 'bp', version: '1.0.0' } } },
    status: { phase },
  });
  const rows = inferenceToRuns([w('chat', 'Running'), w('new', 'Pending'), w('slim-rag', 'Running', false)], [bp], PROFILES);

  it('are only the AIWorkloads made from profiles', () => {
    expect(rows.map((r) => r.name)).toEqual(['chat', 'new']);
  });

  it('take GPUs from the blueprint (per replica × replicas) and the label from the profile', () => {
    expect(rows[0].resources).toBe('2 × A2000');
    expect(rows[0].profileLabel).toBe('vLLM · Qwen');
    expect(rows[0].url).toBe('http://vllm-dra-router-service.team-a.svc/v1');
  });

  it('read a Pending AIWorkload as Deploying', () => {
    expect(rows.map((r) => r.state)).toEqual(['Running', 'Deploying']);
  });
});

describe('the table', () => {
  const mk = (name: string, type: 'training' | 'inference', ns: string, state: any, created: string, gpus = 1, profile = ''): Run => ({
    key: `${ type }/${ ns }/${ name }`, type, name, namespace: ns, profile, profileLabel: profile || 'Custom', gpus, resources: `${ gpus } × GPU`, state, created, url: '', obj: null, pods: [], training: null, inference: null
  });
  const all = [
    mk('llama-chat', 'inference', 'genomics', 'Running', '2026-09-30T12:00:00Z', 2, 'vllm'),
    mk('llama-finetune', 'training', 'genomics', 'Running', '2026-09-30T11:00:00Z', 4, 'pytorch'),
    mk('protein-folding', 'training', 'research', 'Queued', '2026-09-30T10:00:00Z', 8, 'pytorch'),
    mk('test-model', 'training', 'nlp', 'Completed', '2026-09-29T10:00:00Z', 1),
  ];
  const names = (rs: Run[]) => rs.map((r) => r.name);

  it('filters by tab, project, profile, state and words together', () => {
    expect(names(filterRuns(all, { ...ALL_RUNS, type: 'training' }))).toEqual(['llama-finetune', 'protein-folding', 'test-model']);
    expect(names(filterRuns(all, {
      ...ALL_RUNS, project: 'genomics', state: 'Running'
    }))).toEqual(['llama-chat', 'llama-finetune']);
    expect(names(filterRuns(all, { ...ALL_RUNS, profile: '(custom)' }))).toEqual(['test-model']);
    expect(names(filterRuns(all, { ...ALL_RUNS, text: 'llama inference' }))).toEqual(['llama-chat']);
  });

  it('sorts resources by GPU count and created by time', () => {
    expect(names(sortRuns(all, 'resources', true))).toEqual(['protein-folding', 'llama-finetune', 'llama-chat', 'test-model']);
    expect(names(sortRuns(all, 'created', true))[0]).toBe('llama-chat');
  });

  it('pages, clamping a page past the end', () => {
    expect(pageOf(all, 2, 3)).toEqual({
      items: [all[3]], page: 2, pages: 2, from: 4, to: 4
    });
    expect(pageOf(all, 9, 3).page).toBe(2);
    expect(pageOf([], 1, 10)).toEqual({
      items: [], page: 1, pages: 1, from: 0, to: 0
    });
  });

  it('writes created times the way the mock-up does', () => {
    const now = Date.parse('2026-09-30T12:12:00Z');

    expect(ago('2026-09-30T12:00:00Z', now)).toBe('12m ago');
    expect(ago('2026-09-30T10:00:00Z', now)).toBe('2h ago');
    expect(ago('2026-09-29T10:00:00Z', now)).toBe('1d ago');
  });
});

describe('an endpoint\'s pods', () => {
  const p = (name: string, ns: string, instance: string, component?: string) => ({
    metadata: {
      name, namespace: ns, labels: { 'app.kubernetes.io/instance': instance, ...(component ? { 'app.kubernetes.io/component': component } : { 'app.kubernetes.io/name': instance }) }
    }
  });
  const pods = [
    p('litellm-postgresql-0', 'team-a', 'litellm', 'postgresql'),
    p('litellm-abc', 'team-a', 'litellm'),
    p('vllm-dra-router-x', 'team-a', 'vllm-dra', 'router'),
    p('vllm-dra-qwen-y', 'team-a', 'vllm-dra', 'serving-engine'),
    p('vllm-dra-qwen-z', 'team-b', 'vllm-dra', 'serving-engine'),
    p('unrelated', 'team-a', 'other'),
  ];

  it('are the blueprint releases\' pods in the workload namespace, engine first', () => {
    expect(workloadPods(pods, 'team-a', ['vllm-dra', 'litellm']).map((x) => x.metadata.name)).toEqual(['vllm-dra-qwen-y', 'vllm-dra-router-x', 'litellm-abc', 'litellm-postgresql-0']);
  });

  it('are labelled by what they do', () => {
    expect(workloadPods(pods, 'team-a', ['vllm-dra', 'litellm']).map(podRole)).toEqual(['serving-engine', 'router', 'litellm', 'postgresql']);
  });
});

describe('training runs from AIJobs', () => {
  const aiJob = (name: string, phase: string, extra: any = {}) => ({
    metadata: { name, namespace: 'team-a', creationTimestamp: '2026-10-01T00:00:00Z' },
    spec:     { values: { job: { nodes: 2 }, image: { repository: 'pytorch', tag: '2.5' }, scheduler: { type: 'kueue', queue: 'team-a' } } },
    status:   { phase, ...extra },
  });
  const empty = {
    jobs: [], pytorchJobs: [], kueueWorkloads: [], apps: [], pods: []
  };

  it('lists a finished job from its record once the Job is gone', () => {
    const [r] = trainingRuns({ ...empty, aiJobs: [aiJob('train-1', 'Succeeded')] });

    expect(r.name).toBe('train-1');
    expect(r.phase).toBe('Complete');
    expect(r.nodes).toBe(2);
    expect(r.image).toBe('pytorch:2.5');
    expect(r.aiJob.metadata.name).toBe('train-1');
  });

  it('keeps a cancelled job as Cancelled', () => {
    expect(trainingRuns({ ...empty, aiJobs: [aiJob('train-1', 'Cancelled')] })[0].phase).toBe('Cancelled');
  });

  it('does not list the release of a job its record covers', () => {
    const app = { metadata: { namespace: 'team-a', creationTimestamp: '2026-10-01T00:00:00Z' }, spec: { name: 'train-1', chart: { metadata: { name: 'gpu-train-job' } } } };
    const runs = trainingRuns({ ...empty, apps: [app], aiJobs: [aiJob('train-1', 'Running')] });

    expect(runs.length).toBe(1);
    expect(runs[0].aiJob).toBeTruthy();
  });
});

describe('training rows from an AIJob whose Job is gone', () => {
  const run = (aiJob: any) => trainingRuns({
    jobs: [], pytorchJobs: [], kueueWorkloads: [], apps: [], pods: [], aiJobs: [aiJob]
  });
  const job = (values: any, status: any = {}) => ({
    metadata: { name: 'train-1', namespace: 'team-a', creationTimestamp: '2026-10-01T00:00:00Z' },
    spec:     { profile: 'shared-gpu-dev', values: { job: { nodes: 1 }, ...values } },
    status:   { phase: 'Succeeded', ...status },
  });

  it('takes the profile from the record', () => {
    const [r] = trainingToRuns(run(job({})), [], []);

    expect(r.profile).toBe('shared-gpu-dev');
  });

  it('shows a GPU-memory share from the values', () => {
    const [r] = trainingToRuns(run(job({ gpu: { sharedMemoryMiB: 6144 } })), [], []);

    expect(r.resources).toContain('6 GiB');
    expect(r.resources).toContain('share');
  });

  it('shows the GPUs the record counted', () => {
    const [r] = trainingToRuns(run(job({}, { resources: { gpuCount: 2 } })), [], []);

    expect(r.gpus).toBe(2);
    expect(r.resources).toMatch(/^2 ×/);
  });
});
