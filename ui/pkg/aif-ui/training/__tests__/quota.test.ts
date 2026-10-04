import { describe, expect, it } from 'vitest';
// Assertions for the pure quota/project logic.
//
// The repo has no test runner wired up, so this file is written to run two ways:
//   - under jest/vitest once one is added (it uses only describe/it/expect)
//   - standalone:  yarn verify-quota      (see scripts/verify-quota.mjs)
//
// The numbers in the "real cluster shapes" block are taken from a live Run:AI install (3 A2 GPUs,
// department `research` guaranteeing 3 GPUs, children `training`=3 and `inference`=1). That
// configuration is the motivating case for the whole module: 4 GPUs of child guarantees over a
// 3-GPU parent on a 3-GPU cluster, which no submit-time UI tells you about.

import {
  auditQuotas, availability, buildQueueIndex, clusterCapacity, effectiveCap, explain,
  namespaceQueueMap, ownCap, podGpuRequest, resolvePodQueue, usageFromPods, withPodUsage,
} from '../quota';
import {
  applyQuotaToQueue, assembleProjects, buildNamespaceManifest, buildProjectBindingPatch,
  buildQueueManifest, committedGpuAfter, defaultNamespaceFor, membersOf, runaiProjectsFrom,
  runaiReadinessOf, shortProjectId, validateProjectName, validateQuota,
} from '../projects';

const cap = (total: number, free: number) => ({
  total: {
    gpu: total, cpu: 0, memory: 0
  },
  free: {
    gpu: free, cpu: 0, memory: 0
  },
});

const q = (name: string, parent: string | null, quota: number, limit: number, alloc?: number) => ({
  metadata: { name },
  spec:     {
    parentQueue: parent || undefined,
    resources:   {
      gpu: {
        quota, limit, overQuotaWeight: 1
      }
    }
  },
  status: alloc === undefined ? undefined : { allocated: { gpu: alloc } },
});

const gpuPod = (namespace: string, gpu: number, labels?: Record<string, string>, phase = 'Running') => ({
  metadata: { namespace, labels },
  spec:     { containers: [{ resources: { limits: { 'nvidia.com/gpu': String(gpu) } } }] },
  status:   { phase },
});

describe('special values', () => {
  it('treats limit 0 as "nothing beyond quota"', () => {
    expect(effectiveCap('a', buildQueueIndex([q('a', null, 2, 0, 0)]), 'gpu').cap).toBe(2);
  });

  it('treats -1 as unlimited for both quota and limit', () => {
    const i = buildQueueIndex([q('b', null, -1, -1, 0)]);

    expect(effectiveCap('b', i, 'gpu').cap).toBe(Infinity);
    expect(availability('b', i, cap(8, 8), 'gpu').guaranteed).toBe(Infinity);
  });

  it('caps an unlimited queue at the physical cluster', () => {
    const a = availability('b', buildQueueIndex([q('b', null, -1, -1, 0)]), cap(8, 8), 'gpu');

    expect(a.schedulableNow).toBe(8);
    expect(a.limitedBy).toBe('cluster');
  });

  it('reports a parent with limit -1 as uncapped', () => {
    expect(ownCap(buildQueueIndex([q('p', null, 3, -1, 0)])['p'], 'gpu')).toBe(Infinity);
  });
});

describe('hierarchy', () => {
  it('binds a child to the tightest ancestor cap and names the ancestor', () => {
    const i = buildQueueIndex([q('p', null, 2, 2, 0), q('c', 'p', 8, 8, 0)]);
    const r = effectiveCap('c', i, 'gpu');

    expect(r.cap).toBe(2);
    expect(r.boundBy).toBe('p');
  });

  it('blames the ancestor when the ancestor is what is exhausted', () => {
    const i = buildQueueIndex([q('p', null, 2, 2, 2), q('c', 'p', 8, 8, 2)]);

    expect(availability('c', i, cap(16, 16), 'gpu').limitedBy).toBe('ancestor');
  });

  it('refuses to schedule onto a parent queue', () => {
    const i = buildQueueIndex([q('p', null, 4, 4, 0), q('c', 'p', 2, 2, 0)]);
    const a = availability('p', i, cap(8, 8), 'gpu');

    expect(a.limitedBy).toBe('unschedulable');
    expect(a.schedulableNow).toBe(0);
  });

  it('derives children from spec.parentQueue even before status.childQueues catches up', () => {
    const i = buildQueueIndex([q('p', null, 4, 4, 0), q('c', 'p', 2, 2, 0)]);

    expect(i['p'].children).toEqual(['c']);
    expect(i['p'].isLeaf).toBe(false);
  });

  it('drops children that status still lists but that no longer exist', () => {
    const i = buildQueueIndex([{
      metadata: { name: 'ph' },
      spec:     { resources: { gpu: { quota: 1, limit: 1 } } },
      status:   { childQueues: ['ghost'], allocated: { gpu: 0 } },
    }]);

    expect(i['ph'].isLeaf).toBe(true);
  });

  it('does not hang on a parentQueue cycle', () => {
    const i = buildQueueIndex([
      { metadata: { name: 'x' }, spec: { parentQueue: 'y', resources: { gpu: { quota: 1, limit: 1 } } } },
      { metadata: { name: 'y' }, spec: { parentQueue: 'x', resources: { gpu: { quota: 1, limit: 1 } } } },
    ]);

    expect(effectiveCap('x', i, 'gpu').cap).toBe(1);
  });
});

describe('what can actually start', () => {
  it('is the cluster when the cluster is smaller than the quota', () => {
    const a = availability('e', buildQueueIndex([q('e', null, 8, 8, 0)]), cap(2, 2), 'gpu');

    expect(a.schedulableNow).toBe(2);
    expect(a.limitedBy).toBe('cluster');
  });

  it('is the quota when the quota is exhausted', () => {
    expect(availability('d', buildQueueIndex([q('d', null, 2, 2, 2)]), cap(8, 8), 'gpu').limitedBy).toBe('quota');
  });

  it('separates guaranteed headroom from borrowable headroom', () => {
    const a = availability('t', buildQueueIndex([q('t', null, 2, 4, 1)]), cap(8, 8), 'gpu');

    expect(a.freeInQuota).toBe(1); // up to the guarantee: cannot be preempted
    expect(a.freeUpToCap).toBe(3); // up to the limit: preemptible
  });

  it('is 0 for an unknown queue rather than throwing', () => {
    expect(availability('nope', buildQueueIndex([]), cap(4, 4), 'gpu').limitedBy).toBe('unschedulable');
  });
});

describe('live usage', () => {
  it('counts pod-labelled and namespace-labelled pods, and rolls up to the parent', () => {
    const i = buildQueueIndex([q('par', null, 4, 4), q('kid', 'par', 2, 2)]);
    const u = usageFromPods(
      [gpuPod('ns1', 1, { 'kai.scheduler/queue': 'kid' }), gpuPod('ns2', 1)],
      { ns2: 'kid' },
      i,
    );

    expect(u.byQueue['kid']).toBe(2);
    expect(u.byQueue['par']).toBe(2);
  });

  it('tracks GPUs held outside any queue separately', () => {
    const i = buildQueueIndex([q('kid', null, 2, 2)]);
    const u = usageFromPods([gpuPod('other', 2)], {}, i);

    expect(u.unqueued).toBe(2);
    expect(u.byQueue['kid']).toBeUndefined();
  });

  it('ignores terminal pods', () => {
    const i = buildQueueIndex([q('kid', null, 2, 2)]);

    expect(usageFromPods([gpuPod('ns', 5, undefined, 'Succeeded')], {}, i).total).toBe(0);
  });

  it('counts sidecar init containers but not plain ones', () => {
    const plain = { spec: { initContainers: [{ resources: { limits: { 'nvidia.com/gpu': '4' } } }], containers: [{ resources: { limits: { 'nvidia.com/gpu': '1' } } }] } };
    const sidecar = { spec: { initContainers: [{ restartPolicy: 'Always', resources: { limits: { 'nvidia.com/gpu': '4' } } }], containers: [{ resources: { limits: { 'nvidia.com/gpu': '1' } } }] } };

    expect(podGpuRequest(plain)).toBe(1);
    expect(podGpuRequest(sidecar)).toBe(5);
  });

  it('backfills usage only for queues whose status the scheduler never published', () => {
    // `reported` has status, `silent` does not — the Run:AI case.
    const i = buildQueueIndex([q('reported', null, 4, 4, 1), q('silent', null, 4, 4)]);
    const u = usageFromPods([gpuPod('a', 2, { 'kai.scheduler/queue': 'reported' }), gpuPod('b', 3, { 'kai.scheduler/queue': 'silent' })], {}, i);
    const out = withPodUsage(i, u);

    expect(out['reported'].allocated.gpu).toBe(1); // status wins; it sees fractional sharing
    expect(out['silent'].allocated.gpu).toBe(3); // pods fill the gap
  });

  it('reads the queue label from either product', () => {
    expect(namespaceQueueMap([
      { metadata: { name: 'a', labels: { 'kai.scheduler/queue': 'qa' } } },
      { metadata: { name: 'b', labels: { 'runai/queue': 'qb' } } },
    ])).toEqual({ a: 'qa', b: 'qb' });
  });

  // Run:AI binds a pod to its queue with a label called `project`. Charging a queue for every pod
  // in the cluster that happens to carry that word would overstate its usage and, since usage is
  // what the submit form subtracts from the guarantee, block submissions that should go through.
  it('reads the Run:AI pod label only when the Run:AI scheduler owns the pod', () => {
    const runai = { metadata: { namespace: 'ai', labels: { project: 'training' } }, spec: { schedulerName: 'runai-scheduler' } };
    const other = { metadata: { namespace: 'ai', labels: { project: 'accounting' } }, spec: {} };

    expect(resolvePodQueue(runai, {})).toBe('training');
    expect(resolvePodQueue(other, {})).toBeNull();
    // the namespace label still applies to the non-Run:AI pod
    expect(resolvePodQueue(other, { ai: 'from-ns' })).toBe('from-ns');
  });
});

describe('audit', () => {
  it('fails a limit below its own quota', () => {
    const issues = auditQuotas(buildQueueIndex([q('f', null, 4, 2, 0)]), cap(8, 8));

    expect(issues.filter((x) => x.severity === 'fail')).toHaveLength(1);
  });

  it('warns when children collectively out-promise the parent', () => {
    // the live altra-ai shape: research=3, training=3, inference=1
    const i = buildQueueIndex([q('research', null, 3, -1, 0), q('training', 'research', 3, 3, 0), q('inference', 'research', 1, 1, 0)]);
    const ids = auditQuotas(i, cap(3, 3)).map((x) => x.id);

    expect(ids).toContain('oversubscribed/research/gpu');
  });

  it('warns when top-level guarantees exceed the hardware', () => {
    const i = buildQueueIndex([q('a', null, 4, 4, 0), q('b', null, 4, 4, 0)]);

    expect(auditQuotas(i, cap(3, 3)).map((x) => x.id)).toContain('cluster-oversubscribed/gpu');
  });

  it('flags a leaf that can never run anything', () => {
    expect(auditQuotas(buildQueueIndex([q('g', null, 0, 0, 0)]), cap(8, 8)).some((x) => x.id.startsWith('zero-cap/'))).toBe(true);
  });
});

describe('explain', () => {
  const i = buildQueueIndex([q('t', null, 2, 4, 1)]);

  it('says a request inside the guarantee cannot be preempted', () => {
    expect(explain(availability('t', i, cap(8, 8), 'gpu'), 1)).toMatch(/cannot be preempted/);
  });

  it('warns that over-quota work can be reclaimed', () => {
    expect(explain(availability('t', i, cap(8, 8), 'gpu'), 3)).toMatch(/reclaimed/);
  });

  it('blames the hardware, with agreeing grammar, when that is the constraint', () => {
    expect(explain(availability('t', i, cap(8, 1), 'gpu'), 3)).toContain('only 1 GPU is unallocated');
  });
});

describe('cluster capacity', () => {
  it('sums allocatable GPUs and skips cordoned nodes', () => {
    const c = clusterCapacity({
      nodes: [
        { allocatable: { 'nvidia.com/gpu': '1' } },
        { allocatable: { 'nvidia.com/gpu': '1' } },
        { allocatable: { 'nvidia.com/gpu': '1' }, unschedulable: true },
      ],
      gpuInUse: 1,
    });

    expect(c.total.gpu).toBe(2);
    expect(c.free.gpu).toBe(1);
  });
});

describe('projects', () => {
  const clusterId = 'c-m-czpzkwxv';
  const idx = buildQueueIndex([q('research', null, 3, -1, 0), q('training', 'research', 3, 3, 0)]);

  it('joins a Rancher project to its queue through the namespace', () => {
    const projects = assembleProjects(
      [{ metadata: { name: 'p-abc', namespace: clusterId }, spec: { displayName: 'Vision' } }],
      [{
        metadata: {
          name: 'ai-training', labels: { 'kai.scheduler/queue': 'training' }, annotations: { 'field.cattle.io/projectId': `${ clusterId }:p-abc` }
        }
      }],
      idx,
      [{
        projectName: `${ clusterId }:p-abc`, roleTemplateName: 'project-owner', userName: 'u1'
      }],
      cap(3, 3),
      clusterId,
    );
    const vision = projects.find((p) => p.displayName === 'Vision')!;

    expect(vision.source).toBe('complete');
    expect(vision.queue).toBe('training');
    expect(vision.department).toBe('research');
    expect(vision.members).toHaveLength(1);
    expect(vision.gpu!.schedulableNow).toBe(3);
  });

  it('surfaces a Rancher project with no quota', () => {
    const projects = assembleProjects(
      [{ metadata: { name: 'p-abc', namespace: clusterId }, spec: { displayName: 'NoQuota' } }],
      [{ metadata: { name: 'plain', annotations: { 'field.cattle.io/projectId': `${ clusterId }:p-abc` } } }],
      idx, [], cap(3, 3), clusterId,
    );

    expect(projects.find((p) => p.displayName === 'NoQuota')!.source).toBe('no-queue');
  });

  it('surfaces a quota-bearing namespace with no Rancher project (the Run:AI shape)', () => {
    const projects = assembleProjects(
      [],
      [{ metadata: { name: 'runai-training', labels: { 'runai/queue': 'training' } } }],
      idx, [], cap(3, 3), clusterId,
    );
    const p = projects.find((x) => x.queue === 'training')!;

    expect(p.source).toBe('no-rancher-project');
    expect(p.members).toHaveLength(0);
  });

  it('surfaces a leaf queue nothing points at', () => {
    const projects = assembleProjects([], [], idx, [], cap(3, 3), clusterId);

    expect(projects.find((p) => p.queue === 'training')!.source).toBe('queue-only');
  });

  it('never lists a parent queue as a project', () => {
    const projects = assembleProjects([], [], idx, [], cap(3, 3), clusterId);

    expect(projects.some((p) => p.queue === 'research')).toBe(false);
  });

  it('matches members by fully-qualified projectName, not by binding namespace', () => {
    // a PRTB lives in "<clusterId>-<projectId>", so anything keyed on the cluster id alone misses
    const prtbs = [
      {
        metadata: { namespace: `${ clusterId }-p-abc` }, projectName: `${ clusterId }:p-abc`, roleTemplateName: 'project-owner', userName: 'u1'
      },
      {
        metadata: { namespace: `${ clusterId }-p-xyz` }, projectName: `${ clusterId }:p-xyz`, roleTemplateName: 'project-member', userName: 'u2'
      },
    ];

    expect(membersOf(prtbs, `${ clusterId }:p-abc`)).toEqual([{
      name: 'u1', kind: 'user', role: 'project-owner'
    }]);
  });

  it('de-duplicates a user bound twice with the same role', () => {
    const b = {
      projectName: 'c:p', roleTemplateName: 'project-owner', userName: 'u1'
    };

    expect(membersOf([b, { ...b }], 'c:p')).toHaveLength(1);
  });

  it('distinguishes groups from users', () => {
    expect(membersOf([{
      projectName: 'c:p', roleTemplateName: 'r', groupPrincipalName: 'g1'
    }], 'c:p')[0].kind).toBe('group');
  });
});

describe('manifests', () => {
  it('labels the namespace for both schedulers and annotates it for Rancher', () => {
    const ns = buildNamespaceManifest('ai-vision', 'vision', 'c-1', 'c-1:p-abc');

    expect(ns.metadata.labels['kai.scheduler/queue']).toBe('vision');
    expect(ns.metadata.labels['runai/queue']).toBe('vision');
    // Without the version label Run:AI treats the namespace as pre-v2 and applies none of the v2
    // queue accounting, so the queue label alone would look right and do nothing.
    expect(ns.metadata.labels['runai/namespace-version']).toBe('v2');
    expect(ns.metadata.annotations['field.cattle.io/projectId']).toBe('c-1:p-abc');
    // Rancher's label form is the short id, the annotation is cluster-qualified
    expect(ns.metadata.labels['field.cattle.io/projectId']).toBe('p-abc');
  });

  it('omits the Rancher annotation when there is no project', () => {
    expect(buildNamespaceManifest('ai-x', 'x', 'c-1', null).metadata.annotations).toEqual({});
  });

  it('writes a queue on the API version both products serve', () => {
    const m = buildQueueManifest('vision', {
      quota: 2, limit: 4, overQuotaWeight: 1
    }, 'research');

    expect(m.apiVersion).toBe('scheduling.run.ai/v2');
    expect(m.spec.parentQueue).toBe('research');
    expect(m.spec.resources.gpu).toEqual({
      quota: 2, limit: 4, overQuotaWeight: 1
    });
    expect(m.spec.resources.cpu.limit).toBe(-1);
  });

  it('omits parentQueue for a top-level queue', () => {
    expect(buildQueueManifest('top', {
      quota: 1, limit: 1, overQuotaWeight: 1
    }, null).spec).not.toHaveProperty('parentQueue');
  });

  it('validates project names against the namespace they have to fit into', () => {
    expect(validateProjectName('')).toMatch(/Enter/);
    expect(validateProjectName('Bad_Name')).toMatch(/Lowercase/);
    expect(validateProjectName('x'.repeat(60))).toMatch(/53/);
    expect(validateProjectName('team-vision')).toBe('');
  });

  it('derives the namespace and short project id', () => {
    expect(defaultNamespaceFor('vision')).toBe('ai-vision');
    // A project already called ai-something does not get a second prefix: ai-ai-t400-demo is a
    // namespace people then have to type into a manifest, and mistype.
    expect(defaultNamespaceFor('ai-t400-demo')).toBe('ai-t400-demo');
    expect(shortProjectId('c-1:p-abc')).toBe('p-abc');
    expect(shortProjectId(null)).toBeNull();
  });
});

describe('editing a quota', () => {
  const q = (quota: number, limit: number, overQuotaWeight = 1) => ({
    quota, limit, overQuotaWeight
  });

  it('rejects a cap the guarantee could never fit under', () => {
    expect(validateQuota(q(4, 2))).toMatch(/below the guarantee/);
    // 0 and -1 are sentinels, not small caps, so neither is "below" anything
    expect(validateQuota(q(4, 0))).toBe('');
    expect(validateQuota(q(4, -1))).toBe('');
    expect(validateQuota(q(0, 0))).toBe('');
    expect(validateQuota(q(2, 4))).toBe('');
  });

  it('rejects values the Queue API has no meaning for', () => {
    expect(validateQuota(q(1.5, 4))).toMatch(/whole numbers/);
    expect(validateQuota(q(-2, 4))).toMatch(/-1 for unlimited/);
    expect(validateQuota(q(1, 1, -1))).toMatch(/weight cannot be negative/);
  });

  it('prices a change against the other leaves, not against the old value', () => {
    const leaves = [
      {
        name: 'research', isLeaf: false, gpuQuota: 3
      },
      {
        name: 'training', isLeaf: true, gpuQuota: 3
      },
      {
        name: 'inference', isLeaf: true, gpuQuota: 1
      },
    ];

    // parents do not add to the total: only leaves can hold work
    expect(committedGpuAfter(leaves, null, 0)).toBe(4);
    // raising training 3 -> 5 replaces its own contribution rather than stacking on it
    expect(committedGpuAfter(leaves, 'training', 5)).toBe(6);
    expect(committedGpuAfter(leaves, 'training', 0)).toBe(1);
    // an unlimited guarantee is not a number, so it contributes nothing to the sum
    expect(committedGpuAfter(leaves, 'training', -1)).toBe(1);
    // a project that does not exist yet
    expect(committedGpuAfter(leaves, null, 2)).toBe(6);
  });

  it('rewrites only the gpu block, leaving hand-tuned fields on the queue alone', () => {
    const spec = {
      displayName: 'Training',
      parentQueue: 'research',
      priority:    100,
      resources:   {
        gpu: {
          quota: 3, limit: -1, overQuotaWeight: 1
        },
        cpu: {
          quota: 40, limit: 80, overQuotaWeight: 2
        },
      },
    };
    const next = applyQuotaToQueue(spec, q(5, 6, 3));

    expect(next.resources.gpu).toEqual({
      quota: 5, limit: 6, overQuotaWeight: 3
    });
    expect(next.resources.cpu).toEqual({
      quota: 40, limit: 80, overQuotaWeight: 2
    });
    expect(next.parentQueue).toBe('research');
    expect(next.priority).toBe(100);
    // the original is not mutated: the form can be cancelled after a failed save
    expect(spec.resources.gpu.quota).toBe(3);
  });

  it('adds a gpu block to a queue that had none', () => {
    expect(applyQuotaToQueue({ displayName: 'x' }, q(2, -1)).resources.gpu).toEqual({
      quota: 2, limit: -1, overQuotaWeight: 1
    });
    expect(applyQuotaToQueue(undefined, q(2, -1)).resources.gpu.quota).toBe(2);
  });
});

// Run:AI clusters are a different animal: the product owns projects, namespaces and the RoleBindings
// the scheduler needs, and refuses anything this page tries to create. So the page reads its state
// rather than writing it, and the only thing it writes is the Rancher binding Run:AI never makes.
describe('run:ai projects', () => {
  const raw = (over: any = {}) => ({
    metadata: { name: 'training' },
    spec:     {
      department: 'research',
      queues:     [{
        name:      'training',
        nodepool:  'default',
        resources: {
          gpu: {
            deserved: 3, limit: 3, overQuotaWeight: 1
          }
        }
      }],
    },
    status: { namespace: 'runai-training', phase: 'Ready' },
    ...over,
  });

  it('reads the namespace, department and GPU quota off a Project', () => {
    const [p] = runaiProjectsFrom([raw()]);

    expect(p).toEqual({
      name: 'training', namespace: 'runai-training', department: 'research', gpuDeserved: 3, gpuLimit: 3, ready: true
    });
  });

  it('sums the quota across node pools, but treats -1 as unlimited rather than adding it', () => {
    const [p] = runaiProjectsFrom([raw({
      spec: {
        queues: [
          {
            name: 'a', nodepool: 'default', resources: { gpu: { deserved: 2, limit: -1 } }
          },
          {
            name: 'b', nodepool: 'spot', resources: { gpu: { deserved: 3, limit: 4 } }
          },
        ],
      },
    })]);

    expect(p.gpuDeserved).toBe(5);
    expect(p.gpuLimit).toBe(-1);
  });

  it('is not ready before the controller has provisioned a namespace', () => {
    const [p] = runaiProjectsFrom([raw({ status: { phase: 'Pending' } })]);

    expect(p.namespace).toBe('');
    expect(p.ready).toBe(false);
  });

  it('calls a project usable only when a run.ai Project owns one of its namespaces', () => {
    const projects = runaiProjectsFrom([raw()]);

    expect(runaiReadinessOf(['runai-training'], projects).state).toBe('ready');
    expect(runaiReadinessOf(['runai-training'], projects).project).toBe('training');
    // The label and the quota are not what lets the scheduler bind -- the Project is. A namespace
    // this extension created and labelled runai/queue reads exactly like this one and runs nothing.
    expect(runaiReadinessOf(['ai-altra'], projects).state).toBe('none');
    expect(runaiReadinessOf([], projects).state).toBe('none');
  });

  it('flags a Project that claims a namespace but has not reported Ready', () => {
    const projects = runaiProjectsFrom([raw({ status: { namespace: 'runai-training', phase: 'Creating' } })]);
    const r = runaiReadinessOf(['runai-training'], projects);

    expect(r.state).toBe('provisioning');
    expect(r.detail).toContain('has not reported Ready');
  });

  it('binds an existing namespace to a Rancher project without touching anything else', () => {
    const patch = buildProjectBindingPatch('runai-training', 'c-1', 'c-1:p-abc');

    expect(patch).toEqual({
      labels:      { 'field.cattle.io/projectId': 'p-abc' },
      annotations: { 'field.cattle.io/projectId': 'c-1:p-abc' },
    });
  });

  it('refuses to bind a namespace to a project id that stringified something missing', () => {
    expect(() => buildProjectBindingPatch('runai-training', 'c-1', 'c-1:undefined')).toThrow(/Refusing/);
    expect(() => buildProjectBindingPatch('runai-training', 'c-1', '')).toThrow(/Refusing/);
  });
});
