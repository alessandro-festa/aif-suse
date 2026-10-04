import { describe, expect, it } from 'vitest';
// Tier-1 quota: ResourceQuota normalised onto the same shape the KAI path produces, so the rest of
// the UI never branches on the backend. These tests pin the normalisation and the places where the
// two backends genuinely differ.

import {
  applyGpuToResourceQuota, buildIndexFromResourceQuotas, buildResourceQuotaManifest, gpuHard,
  gpuUsed, isGpuQuota,
} from '../resourcequota';
import {
  assembleProjects, buildNamespaceManifest, buildRancherProjectManifest, isBuiltInProject,
  projectIdFromSaveResult, projectSourceLabel, quotaScopeOf, resolveCreatedProject, validateCap,
} from '../projects';
import { availability } from '../quota';

const GPU = 'nvidia.com/gpu';

const rq = (namespace: string, hard: Record<string, string>, used: Record<string, string> = {}) => ({
  metadata: { name: 'ai-gpu-quota', namespace },
  spec:     { hard },
  status:   { hard, used },
});

const capacity = (total: number, free: number) => ({
  total: {
    gpu: total, cpu: 0, memory: 0
  },
  free: {
    gpu: free, cpu: 0, memory: 0
  },
});

describe('reading a GPU cap off a ResourceQuota', () => {
  it('accepts the three spellings an admin might have used', () => {
    expect(gpuHard(rq('a', { 'requests.nvidia.com/gpu': '4' }), GPU)).toBe(4);
    expect(gpuHard(rq('a', { 'limits.nvidia.com/gpu': '2' }), GPU)).toBe(2);
    expect(gpuHard(rq('a', { 'nvidia.com/gpu': '1' }), GPU)).toBe(1);
  });

  it('ignores quotas that do not constrain GPUs at all', () => {
    expect(isGpuQuota(rq('a', { 'requests.cpu': '10', pods: '5' }), GPU)).toBe(false);
    expect(gpuHard(rq('a', { 'requests.cpu': '10' }), GPU)).toBeNull();
  });

  it('does not count count/ quotas, which bound objects rather than devices', () => {
    expect(isGpuQuota(rq('a', { 'count/nvidia.com/gpu': '3' }), GPU)).toBe(false);
  });

  it('prefers what the server accepted over what was asked for', () => {
    const obj = {
      metadata: { namespace: 'a' },
      spec:     { hard: { 'requests.nvidia.com/gpu': '9' } },
      status:   { hard: { 'requests.nvidia.com/gpu': '4' }, used: {} },
    };

    expect(gpuHard(obj, GPU)).toBe(4);
  });

  it('falls back to spec before the quota controller has written status', () => {
    expect(gpuHard({ metadata: { namespace: 'a' }, spec: { hard: { 'requests.nvidia.com/gpu': '4' } } }, GPU)).toBe(4);
  });

  it('reads usage as zero when the controller has not reported any', () => {
    expect(gpuUsed(rq('a', { 'requests.nvidia.com/gpu': '4' }), GPU)).toBe(0);
    expect(gpuUsed(rq('a', { 'requests.nvidia.com/gpu': '4' }, { 'requests.nvidia.com/gpu': '3' }), GPU)).toBe(3);
  });
});

describe('normalising quotas into the queue index', () => {
  it('makes every namespace a parentless leaf, with cap as both floor and ceiling', () => {
    const index = buildIndexFromResourceQuotas([rq('ai-vision', { 'requests.nvidia.com/gpu': '2' })], GPU);
    const node = index['ai-vision'];

    expect(node.isLeaf).toBe(true);
    expect(node.parent).toBeNull();
    expect(node.quota.gpu).toBe(2);
    expect(node.limit.gpu).toBe(2);
  });

  it('never reports stale: status.used comes from the quota controller, not a scheduler', () => {
    const index = buildIndexFromResourceQuotas([rq('a', { 'requests.nvidia.com/gpu': '1' })], GPU);

    expect(index.a.statusMissing).toBe(false);
  });

  it('takes the tightest cap when several quotas constrain one namespace', () => {
    const index = buildIndexFromResourceQuotas([
      rq('a', { 'requests.nvidia.com/gpu': '8' }),
      rq('a', { 'requests.nvidia.com/gpu': '3' }),
    ], GPU);

    // Kubernetes enforces every quota in the namespace, so the effective cap is the smallest.
    expect(index.a.limit.gpu).toBe(3);
  });

  it('skips quotas with no namespace or no GPU key', () => {
    const index = buildIndexFromResourceQuotas([
      rq('', { 'requests.nvidia.com/gpu': '1' }),
      rq('b', { 'requests.cpu': '4' }),
    ], GPU);

    expect(Object.keys(index)).toEqual([]);
  });
});

describe('availability over a ResourceQuota index', () => {
  it('reports a cap with room as schedulable, bounded by the hardware', () => {
    const index = buildIndexFromResourceQuotas(
      [rq('a', { 'requests.nvidia.com/gpu': '4' }, { 'requests.nvidia.com/gpu': '1' })], GPU,
    );
    const a = availability('a', index, capacity(4, 3));

    expect(a.allocated).toBe(1);
    expect(a.freeUpToCap).toBe(3);
    expect(a.schedulableNow).toBe(3);
  });

  it('blames the quota, not the cluster, when the project is at its cap with GPUs free', () => {
    const index = buildIndexFromResourceQuotas(
      [rq('a', { 'requests.nvidia.com/gpu': '1' }, { 'requests.nvidia.com/gpu': '1' })], GPU,
    );
    const a = availability('a', index, capacity(4, 3));

    expect(a.schedulableNow).toBe(0);
    expect(a.limitedBy).toBe('quota');
  });

  it('blames the cluster when the cap has room but the hardware does not', () => {
    const index = buildIndexFromResourceQuotas([rq('a', { 'requests.nvidia.com/gpu': '4' })], GPU);
    const a = availability('a', index, capacity(4, 1));

    expect(a.schedulableNow).toBe(1);
    expect(a.limitedBy).toBe('cluster');
  });

  it('treats a cap of 0 as admitting nothing', () => {
    const index = buildIndexFromResourceQuotas([rq('a', { 'requests.nvidia.com/gpu': '0' })], GPU);

    expect(availability('a', index, capacity(4, 4)).schedulableNow).toBe(0);
  });
});

describe('which object holds the quota', () => {
  const ns = (name: string, labels: Record<string, string> = {}) => ({ metadata: { name, labels } });

  it('follows the queue label under KAI', () => {
    const tagged = ns('ai-a', { 'kai.scheduler/queue': 'team-a' });

    expect(quotaScopeOf(tagged, 'kai', {})).toBe('team-a');
  });

  it('uses the namespace itself under ResourceQuota, but only when a quota exists', () => {
    const index = buildIndexFromResourceQuotas([rq('ai-a', { 'requests.nvidia.com/gpu': '1' })], GPU);

    expect(quotaScopeOf(ns('ai-a'), 'resourcequota', index)).toBe('ai-a');
    // uncapped is a different state from capped-at-zero, and must not read as a quota
    expect(quotaScopeOf(ns('ai-b'), 'resourcequota', index)).toBeNull();
  });

  it('ignores a stray queue label when no scheduler is installed to honour it', () => {
    const tagged = ns('ai-a', { 'kai.scheduler/queue': 'team-a' });

    expect(quotaScopeOf(tagged, 'resourcequota', {})).toBeNull();
  });
});

describe('Rancher built-in projects', () => {
  it('recognises Default and System by label or annotation', () => {
    expect(isBuiltInProject({ metadata: { labels: { 'authz.management.cattle.io/default-project': 'true' } } })).toBe(true);
    expect(isBuiltInProject({ metadata: { annotations: { 'authz.management.cattle.io/system-project': 'true' } } })).toBe(true);
    expect(isBuiltInProject({ metadata: { name: 'p-abcde' } })).toBe(false);
  });

  it('keeps them out of the project list entirely', () => {
    const projects = assembleProjects(
      [
        {
          metadata: {
            name: 'p-def', namespace: 'c-1', labels: { 'authz.management.cattle.io/default-project': 'true' }
          },
          spec: { displayName: 'Default' }
        },
        {
          metadata: {
            name: 'p-sys', namespace: 'c-1', labels: { 'authz.management.cattle.io/system-project': 'true' }
          },
          spec: { displayName: 'System' }
        },
        { metadata: { name: 'p-real', namespace: 'c-1' }, spec: { displayName: 'Vision' } },
      ],
      [], {}, [], capacity(1, 1), 'c-1', 'resourcequota',
    );

    expect(projects.map((p) => p.displayName)).toEqual(['Vision']);
  });
});

describe('assembling projects on the ResourceQuota backend', () => {
  it('joins a project to its quota through the namespace, with no queue label anywhere', () => {
    const index = buildIndexFromResourceQuotas(
      [rq('ai-vision', { 'requests.nvidia.com/gpu': '2' }, { 'requests.nvidia.com/gpu': '1' })], GPU,
    );
    const namespaces = [{
      metadata: {
        name: 'ai-vision', labels: {}, annotations: { 'field.cattle.io/projectId': 'c-1:p-real' }
      },
    }];
    const [p] = assembleProjects(
      [{ metadata: { name: 'p-real', namespace: 'c-1' }, spec: { displayName: 'Vision' } }],
      namespaces, index, [], capacity(4, 3), 'c-1', 'resourcequota',
    );

    expect(p.source).toBe('complete');
    expect(p.queue).toBe('ai-vision');
    expect(p.gpu?.cap).toBe(2);
    expect(p.gpu?.allocated).toBe(1);
  });

  it('flags a project whose namespace has no quota as uncapped rather than hiding it', () => {
    const namespaces = [{
      metadata: {
        name: 'ai-vision', labels: {}, annotations: { 'field.cattle.io/projectId': 'c-1:p-real' }
      },
    }];
    const [p] = assembleProjects(
      [{ metadata: { name: 'p-real', namespace: 'c-1' }, spec: { displayName: 'Vision' } }],
      namespaces, {}, [], capacity(4, 4), 'c-1', 'resourcequota',
    );

    expect(p.source).toBe('no-queue');
    expect(p.gpu).toBeNull();
  });
});

describe('writing a ResourceQuota', () => {
  it('caps only the GPU, so non-GPU pods in the namespace are unaffected', () => {
    const m = buildResourceQuotaManifest('ai-vision', 2, GPU);

    expect(m.metadata).toEqual({ name: 'ai-gpu-quota', namespace: 'ai-vision' });
    expect(m.spec.hard).toEqual({ 'requests.nvidia.com/gpu': '2' });
  });

  it('keeps other resources when editing an existing quota', () => {
    const next = applyGpuToResourceQuota({ hard: { 'requests.cpu': '10', 'requests.nvidia.com/gpu': '1' } }, 4, GPU);

    expect(next.hard).toEqual({ 'requests.cpu': '10', 'requests.nvidia.com/gpu': '4' });
  });

  it('rewrites whichever spelling was already there instead of leaving a tighter one behind', () => {
    const next = applyGpuToResourceQuota({ hard: { 'limits.nvidia.com/gpu': '1' } }, 4, GPU);

    expect(next.hard).toEqual({ 'limits.nvidia.com/gpu': '4' });
  });

  it('adds a GPU cap to a quota that had none', () => {
    expect(applyGpuToResourceQuota({ hard: { pods: '10' } }, 2, GPU).hard)
      .toEqual({ pods: '10', 'requests.nvidia.com/gpu': '2' });
  });

  it('tolerates a quota with no spec at all', () => {
    expect(applyGpuToResourceQuota(undefined, 1, GPU).hard).toEqual({ 'requests.nvidia.com/gpu': '1' });
  });
});

describe('validating a cap', () => {
  it('has no unlimited sentinel: -1 is a KAI concept, not a ResourceQuota one', () => {
    expect(validateCap(-1)).toContain('cannot be negative');
  });

  it('accepts 0 as a real choice', () => {
    expect(validateCap(0)).toBe('');
  });

  it('rejects fractions, which the GPU device plugin cannot express', () => {
    expect(validateCap(1.5)).toContain('whole number');
  });
});

describe('badge wording for an incomplete project', () => {
  it('drops queue vocabulary when no queueing scheduler is installed', () => {
    expect(projectSourceLabel('no-queue', 'resourcequota')).toBe('no limit');
    expect(projectSourceLabel('queue-only', 'resourcequota')).toBe('no Rancher project');
  });

  it('keeps queue vocabulary under KAI, where queues are the real object', () => {
    expect(projectSourceLabel('no-queue', 'kai')).toBe('no queue');
    expect(projectSourceLabel('queue-only', 'kai')).toBe('no namespace');
  });

  it('says nothing about a complete project', () => {
    expect(projectSourceLabel('complete', 'resourcequota')).toBe('');
    expect(projectSourceLabel('complete', 'kai')).toBe('');
  });
});

// Regression: creating a project produced a Rancher project *and* a namespace that did not belong
// to it, so the page listed them as two broken halves. It happened twice, for two different
// reasons, and both are pinned here.
//
//   1. The namespace was annotated "<cluster>:undefined" — metadata.name was read off the model
//      after save() and was not there.
//   2. The fix for (1) chose the id client-side and sent it as metadata.name. Rancher assigns
//      project ids itself and discarded it, so the namespace named a project that did not exist:
//      we asked for p-t7o1q and the cluster created p-7gv2s.
//
// So the id can only come from reading Rancher's project list back, and the namespace builder
// refuses a stringified miss rather than writing one to the cluster.
describe('linking a new namespace to its Rancher project', () => {
  const project = (name: string, displayName: string, clusterId = 'c-m-abc') => ({
    metadata: { name, namespace: clusterId },
    spec:     { displayName, clusterName: clusterId },
  });
  const noWait = () => Promise.resolve();

  it('does not ask for a project id, because Rancher will not honour one', () => {
    const manifest: any = buildRancherProjectManifest('c-m-abc', 'Team A');

    expect(manifest.metadata).not.toHaveProperty('name');
    expect(manifest.metadata.generateName).toBe('p-');
    expect(manifest.spec.displayName).toBe('Team A');
  });

  // The normal path: the shell's Project model proxies save() to Norman and hands back the Norman
  // project, whose id is already "<cluster>:<project>". Reading it there is exact and needs no
  // polling — but it is an implementation detail, so anything unexpected has to fall through.
  it('takes the id straight off what save() returned', () => {
    expect(projectIdFromSaveResult({ id: 'c-m-abc:p-7gv2s' }, 'c-m-abc')).toBe('c-m-abc:p-7gv2s');
  });

  it('accepts a steve-shaped result by qualifying the bare name', () => {
    expect(projectIdFromSaveResult({ metadata: { name: 'p-7gv2s' } }, 'c-m-abc')).toBe('c-m-abc:p-7gv2s');
  });

  it('falls back rather than trusting an id for another cluster, or no id at all', () => {
    expect(projectIdFromSaveResult({ id: 'c-m-xyz:p-7gv2s' }, 'c-m-abc')).toBeNull();
    expect(projectIdFromSaveResult({ id: 'p-7gv2s' }, 'c-m-abc')).toBeNull();
    expect(projectIdFromSaveResult({ metadata: { name: undefined } }, 'c-m-abc')).toBeNull();
    expect(projectIdFromSaveResult(undefined, 'c-m-abc')).toBeNull();
  });

  it('waits for the project to become listable instead of trusting save()', async() => {
    const existing = [project('p-old', 'Other')];
    // Empty twice: the create has returned but the project is not in the list yet.
    const pages = [existing, existing, [...existing, project('p-real', 'Team A')]];
    const found = await resolveCreatedProject({
      list:        () => Promise.resolve(pages.shift() ?? []),
      clusterId:   'c-m-abc',
      known:       ['p-old'],
      displayName: 'Team A',
      sleep:       noWait,
    });

    expect(found.metadata.name).toBe('p-real');
  });

  it('ignores projects that were already there, and ones on another cluster', async() => {
    const list = [
      project('p-old', 'Team A'), // same display name, but pre-existing
      project('p-elsewhere', 'Team A', 'c-m-xyz'), // same display name, wrong cluster
      project('p-real', 'Team A'),
    ];
    const found = await resolveCreatedProject({
      list: () => Promise.resolve(list), clusterId: 'c-m-abc', known: ['p-old'], displayName: 'Team A', sleep: noWait,
    });

    expect(found.metadata.name).toBe('p-real');
  });

  it('refuses to guess when two new projects share the display name', async() => {
    const list = [project('p-one', 'Team A'), project('p-two', 'Team A')];
    let err = '';

    await resolveCreatedProject({
      list: () => Promise.resolve(list), clusterId: 'c-m-abc', known: [], displayName: 'Team A', sleep: noWait,
    }).catch((e) => {
      err = e.message;
    });
    expect(err).toMatch(/cannot tell which one is ours/);
  });

  it('gives up rather than annotating a namespace with nothing', async() => {
    let err = '';
    let calls = 0;

    await resolveCreatedProject({
      list: () => {
        calls++;

        return Promise.resolve([]);
      },
      clusterId:   'c-m-abc',
      known:       [],
      displayName: 'Team A',
      attempts:    3,
      sleep:       noWait,
    }).catch((e) => {
      err = e.message;
    });
    expect(err).toMatch(/Timed out/);
    expect(calls).toBe(3);
  });

  it('writes both the annotation and the label Rancher matches on', () => {
    const ns: any = buildNamespaceManifest('ai-team-a', 'team-a', 'c-m-abc', 'c-m-abc:p-xy12z', 'resourcequota');

    expect(ns.metadata.annotations['field.cattle.io/projectId']).toBe('c-m-abc:p-xy12z');
    expect(ns.metadata.labels['field.cattle.io/projectId']).toBe('p-xy12z');
  });

  it('refuses to write a namespace whose project id stringified something missing', () => {
    expect(() => buildNamespaceManifest('ai-team-a', 'team-a', 'c-m-abc', 'c-m-abc:undefined', 'resourcequota'))
      .toThrow(/Rancher project id/);
  });

  it('still allows a namespace with no project at all, which is a different thing', () => {
    const ns: any = buildNamespaceManifest('ai-team-a', 'team-a', 'c-m-abc', null, 'resourcequota');

    expect(ns.metadata.annotations).toEqual({});
    expect(ns.metadata.labels).toEqual({});
  });
});
