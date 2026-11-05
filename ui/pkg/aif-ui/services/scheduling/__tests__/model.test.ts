import { describe, it, expect } from 'vitest';
import {
  imageVersion, versionAtLeast, readinessChecks, queueRows, queueManifest, validateQueue,
  namespaceRows, namespaceLabelPatch, trainerBinding, notebookAccessManifests, runtimeRows,
  jobPhase, jobQueue, jobRows, MANAGED_LABEL, QUEUE_LABEL, VIEW_RUNTIMES_ROLE
} from '../model';

describe('versions', () => {
  it('reads the tag of a matching image', () => {
    expect(imageVersion(['registry.k8s.io/jobset/jobset:v0.11.0'], 'jobset/jobset')).toBe('0.11.0');
    expect(imageVersion(['x/jobset/jobset:latest'], 'jobset/jobset')).toBe('');
    expect(imageVersion(['a/b@sha256:abc'], 'a/b')).toBe('');
  });
  it('compares versions', () => {
    expect(versionAtLeast('0.11.0', '0.11.0')).toBe(true);
    expect(versionAtLeast('0.10.1', '0.11.0')).toBe(false);
    expect(versionAtLeast('1.0', '0.11.0')).toBe(true);
  });
});

describe('readinessChecks', () => {
  const ready = {
    crds:   ['queues.scheduling.run.ai', 'trainjobs.trainer.kubeflow.org', 'jobsets.jobset.x-k8s.io'],
    images: [
      'ghcr.io/kai-scheduler/kai-scheduler/scheduler:v0.18.3',
      'ghcr.io/kubeflow/trainer/trainer-controller-manager:v2.2.1',
      'registry.k8s.io/jobset/jobset:v0.11.0'
    ],
    runtimes:            [{ metadata: { name: 'aif-cpu', labels: { 'app.kubernetes.io/part-of': 'aif-training-runtimes' } } }],
    clusterRoles:        ['ai-trainer'],
    clusterRoleBindings: [{ roleRef: { name: VIEW_RUNTIMES_ROLE }, subjects: [{ kind: 'Group', name: 'system:authenticated' }] }],
    roleTemplates:       ['ai-trainer'],
  };

  it('is all green on a ready cluster', () => {
    expect(readinessChecks(ready).every((c) => c.ok)).toBe(true);
  });

  it('flags the pieces this lab found missing, with a fix', () => {
    const c = readinessChecks({
      ...ready, clusterRoleBindings: [], roleTemplates: [], images: ready.images.map((i) => i.replace('v0.11.0', 'v0.10.1'))
    });
    const byKey = Object.fromEntries(c.map((x) => [x.key, x]));

    expect(byKey['view-runtimes'].ok).toBe(false);
    expect(byKey['view-runtimes'].fix?.action).toBe('create-view-runtimes');
    expect(byKey.roletemplate.fix?.action).toBe('create-roletemplate');
    expect(byKey.jobset.ok).toBe(false);
    expect(byKey.jobset.detail).toContain('too old');
  });

  it('tells a CRD without a controller apart from nothing', () => {
    const c = readinessChecks({ ...ready, images: [] });

    expect(c.find((x) => x.key === 'kai')?.detail).toContain('not running');
  });
});

describe('queues', () => {
  const queues = [
    { metadata: { name: 'aif-root' }, spec: { resources: { gpu: { quota: -1, limit: -1 } } }, status: { childQueues: ['aif-submit'] } },
    {
      metadata: { name: 'aif-submit' },
      spec:     { parentQueue: 'aif-root', resources: { gpu: { quota: 1, limit: 2 }, cpu: { quota: -1 }, memory: { quota: -1 } } },
      status:   { allocated: { 'nvidia.com/gpu': '1' } }
    },
  ];
  const ns = [{ metadata: { name: 'team-a', labels: { [QUEUE_LABEL]: 'aif-submit' } } }];

  it('builds rows with namespaces and use', () => {
    const rows = queueRows(queues, ns);

    expect(rows.map((r) => r.name)).toEqual(['aif-root', 'aif-submit']);
    expect(rows[1]).toMatchObject({
      parent: 'aif-root', gpuQuota: 1, gpuLimit: 2, allocatedGpu: '1', namespaces: ['team-a']
    });
  });

  it('writes a v2 Queue and keeps fields it does not edit', () => {
    const q = queueManifest({
      name: 'aif-submit', parent: 'aif-root', gpuQuota: 2, gpuLimit: -1, cpuQuota: -1, memoryQuota: -1
    }, { metadata: { name: 'aif-submit', resourceVersion: '7' }, spec: { priority: 100, parentQueue: 'x' } });

    expect(q.apiVersion).toBe('scheduling.run.ai/v2');
    expect(q.metadata.resourceVersion).toBe('7');
    expect(q.spec.priority).toBe(100);
    expect(q.spec.parentQueue).toBe('aif-root');
    expect(q.spec.resources.gpu).toEqual({ quota: 2, limit: -1, overQuotaWeight: 1 });
  });

  it('drops the parent for a top-level queue', () => {
    expect(queueManifest({
      name: 'r', parent: '', gpuQuota: 0, gpuLimit: -1, cpuQuota: -1, memoryQuota: -1
    }).spec.parentQueue).toBeUndefined();
  });

  it('validates', () => {
    const f = {
      name: 'Bad_Name', parent: '', gpuQuota: 4, gpuLimit: 2, cpuQuota: -1, memoryQuota: -1
    };

    expect(validateQueue(f, [], false)).toHaveLength(2);
    expect(validateQueue({ ...f, name: 'aif-submit', gpuLimit: -1 }, ['aif-submit'], false)).toEqual(['A queue named aif-submit exists']);
    expect(validateQueue({ ...f, name: 'aif-submit', gpuLimit: -1 }, ['aif-submit'], true)).toEqual([]);
  });
});

describe('namespaces', () => {
  const ns = (name: string, labels: Record<string, string>) => ({ metadata: { name, labels: { 'field.cattle.io/projectId': 'p-1', ...labels } } });

  it('says why a namespace cannot train', () => {
    const rows = namespaceRows([
      ns('ok', { [MANAGED_LABEL]: 'true', [QUEUE_LABEL]: 'q' }),
      ns('noq', { [MANAGED_LABEL]: 'true' }),
      ns('gone', { [MANAGED_LABEL]: 'true', [QUEUE_LABEL]: 'missing' }),
      ns('unmanaged', { [QUEUE_LABEL]: 'q' }),
      ns('off', {}),
      { metadata: { name: 'kube-system', labels: {} } },
    ], ['q']);

    expect(rows.map((r) => r.name)).toEqual(['gone', 'noq', 'off', 'ok', 'unmanaged']);
    expect(rows.find((r) => r.name === 'ok')?.ready).toBe(true);
    expect(rows.find((r) => r.name === 'noq')?.problem).toContain('refused');
    expect(rows.find((r) => r.name === 'gone')?.problem).toContain('does not exist');
    expect(rows.find((r) => r.name === 'unmanaged')?.problem).toContain('not managed');
    expect(rows.find((r) => r.name === 'off')?.problem).toBe('');
  });

  it('patches the labels on and off', () => {
    expect(namespaceLabelPatch('q').metadata.labels).toEqual({ [MANAGED_LABEL]: 'true', [QUEUE_LABEL]: 'q' });
    expect(namespaceLabelPatch(null).metadata.labels).toEqual({ [MANAGED_LABEL]: null, [QUEUE_LABEL]: null });
  });

  it('binds AI Trainer in the project backing namespace', () => {
    const b = trainerBinding('local', 'p-f57d6', 'local-p-f57d6', 'u-1');

    expect(b).toMatchObject({
      projectName: 'local:p-f57d6', roleTemplateName: 'ai-trainer', userName: 'u-1', metadata: { namespace: 'local-p-f57d6' }
    });
  });

  it('gives a notebook ai-trainer and get on its own namespace only', () => {
    const m = notebookAccessManifests('team-a');
    const role = m.find((x) => x.kind === 'Role');

    expect(m.map((x) => x.kind)).toEqual(['ServiceAccount', 'RoleBinding', 'Role', 'RoleBinding']);
    expect(m[1].roleRef.name).toBe('ai-trainer');
    expect(role.rules).toEqual([{ apiGroups: [''], resources: ['namespaces'], resourceNames: ['team-a'], verbs: ['get'] }]);
  });
});

describe('runtimes', () => {
  it('reads what the chart annotates, and skips other runtimes', () => {
    const rows = runtimeRows([
      {
        metadata: {
          name:        'aif-share-4g',
          labels:      { 'app.kubernetes.io/part-of': 'aif-training-runtimes', 'ai-factory.suse.com/runtime-kind': 'share' },
          annotations: {
            'ai-factory.suse.com/display-name': '4 GiB GPU share', 'ai-factory.suse.com/gpu-memory-mib': '4096', 'ai-factory.suse.com/max-nodes': '1', 'ai-factory.suse.com/registries': 'pytorch/,nvcr.io/nvidia/'
          }
        },
        spec: { template: { spec: { replicatedJobs: [{ template: { spec: { template: { spec: { containers: [{ name: 'node', image: 'pytorch/pytorch:2.7.1' }] } } } } }] } } }
      },
      { metadata: { name: 'torch-distributed', labels: {} } },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      displayName: '4 GiB GPU share', kind: 'share', gpuMemoryMiB: '4096', image: 'pytorch/pytorch:2.7.1', registries: ['pytorch/', 'nvcr.io/nvidia/']
    });
  });
});

describe('TrainJobs', () => {
  // shapes from the lab: SDK 0.4.1 job s71e2236bfc0 on aif-cpu
  const job = {
    metadata: { name: 'j1', namespace: 'aif-submit', creationTimestamp: '2026-11-05T13:35:31Z' },
    spec:     {
      runtimeRef:     { name: 'aif-cpu' },
      runtimePatches: [{ manager: 'trainer.kubeflow.org/kubeflow-sdk', trainingRuntimeSpec: { template: { spec: { replicatedJobs: [{ name: 'node', template: { spec: { template: { metadata: { labels: { 'kai.scheduler/queue': 'aif-submit' } } } } } }] } } } }]
    },
    status: { conditions: [{ type: 'Complete', status: 'True', message: 'jobset completed successfully' }] }
  };
  const pod = (phase: string, extra: any = {}) => ({
    metadata: { name: 'j1-node-0-0', namespace: 'aif-submit', labels: { 'jobset.sigs.k8s.io/jobset-name': 'j1', 'kai.scheduler/queue': 'aif-submit' } },
    spec:     { schedulerName: 'kai-scheduler', nodeName: 'w1' },
    status:   { phase, ...extra }
  });

  it('reads the phase', () => {
    expect(jobPhase(job, []).phase).toBe('Complete');
    expect(jobPhase({ ...job, status: { conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] } }, []).message).toBe('BackoffLimitExceeded');
    expect(jobPhase({ ...job, spec: { suspend: true }, status: {} }, []).phase).toBe('Suspended');
    expect(jobPhase({ ...job, status: {} }, [pod('Running')]).phase).toBe('Running');
    const pending = jobPhase({ ...job, status: {} }, [pod('Pending', { conditions: [{ type: 'PodScheduled', status: 'False', message: 'queue over quota' }] })]);

    expect(pending).toEqual({ phase: 'Pending', message: 'queue over quota' });
  });

  it('reads the queue from the pods, else from the runtime patches', () => {
    expect(jobQueue(job, [])).toBe('aif-submit');
    expect(jobQueue({ spec: {} }, [])).toBe('');
  });

  it('matches pods to their job', () => {
    const rows = jobRows([job], [pod('Succeeded'), { ...pod('Running'), metadata: { name: 'other', namespace: 'aif-submit', labels: { 'jobset.sigs.k8s.io/jobset-name': 'j2' } } }]);

    expect(rows[0]).toMatchObject({
      runtime: 'aif-cpu', queue: 'aif-submit', phase: 'Complete', pods: [{ name: 'j1-node-0-0', scheduler: 'kai-scheduler', node: 'w1', phase: 'Succeeded' }]
    });
  });
});
