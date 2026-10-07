import { describe, expect, it } from 'vitest';
import {
  createAIJob, fetchPools, fetchProjects, placedPods, placementOf, podsOfPlacedJob, poolLabel, projectClusterNamespace, projectNamespace
} from '../placement';

// A store whose cluster/request answers from a map of URL -> body, and records what was sent.
function fakeStore(routes: Record<string, any>) {
  const sent: any[] = [];

  return {
    sent,
    dispatch: (action: string, req: any) => {
      expect(action).toBe('cluster/request');
      sent.push(req);
      if (req.method === 'POST') {
        return Promise.resolve({ data: req.data });
      }
      if (!(req.url in routes)) {
        return Promise.reject(new Error(`404 ${ req.url }`));
      }

      return Promise.resolve({ data: routes[req.url] });
    },
  };
}

const pool = (name: string, cluster: string, kind: string, extra: any = {}) => ({
  metadata: { name },
  spec:     { clusterId: cluster, kind, ...extra.spec },
  status:   extra.status || {},
});

describe('placement', () => {
  it('reads the AI projects from local, and where each runs', async() => {
    const vision = { metadata: { name: 'vision' }, spec: { displayName: 'Vision', clusters: [{ clusterId: 'c-a', namespace: 'vision' }, { clusterId: 'c-b', namespace: 'vision-b' }] } };
    const store = fakeStore({ '/k8s/clusters/local/apis/ai-factory.suse.com/v1alpha1/aiprojects': { items: [vision, { metadata: { name: 'alpha' }, spec: {} }] } });
    const projects = await fetchProjects(store);

    expect(projects.map((p: any) => p.metadata.name)).toEqual(['alpha', 'vision']);
    expect(projectNamespace('vision')).toBe('aif-vision');
    expect(projectClusterNamespace(vision, 'c-b')).toBe('vision-b');
    expect(projectClusterNamespace(vision, 'c-z')).toBe('');
  });

  it('lists the usable downstream pools from local', async() => {
    const store = fakeStore({
      '/k8s/clusters/local/apis/ai-factory.suse.com/v1alpha1/computepools': {
        items: [
          pool('c-x-gpu-l40s', 'c-x', 'gpu', { status: { allocatable: { gpus: 2 }, requested: { gpus: 1 }, gpu: { models: ['L40S'] } } }),
          pool('c-x-cpu', 'c-x', 'cpu', { status: { nodes: 1 } }),
          pool('c-y-cpu', 'c-y', 'cpu', { spec: { disabled: true } }),
          pool('local-cpu', 'local', 'cpu'),
        ],
      },
    });
    const pools = await fetchPools(store, { 'c-x': 'downstream-2' });

    expect(pools.map((p) => p.name)).toEqual(['c-x-cpu', 'c-x-gpu-l40s']);
    expect(pools.map(poolLabel)).toEqual(['downstream-2 · CPU · 1 node', 'downstream-2 · GPU L40S · 1 of 2 free']);
  });

  it('creates the AIJob on local, in its namespace there', async() => {
    const store = fakeStore({});

    await createAIJob(store, { type: 'ai-factory.suse.com.aijob', metadata: { name: 'train-1', namespace: 'aif-c-x-p-team' }, spec: { pool: 'c-x-cpu' } });
    expect(store.sent[0].url).toBe('/k8s/clusters/local/apis/ai-factory.suse.com/v1alpha1/namespaces/aif-c-x-p-team/aijobs');
    expect(store.sent[0].data.type).toBeUndefined();
  });

  it('matches a placed run to its pods by cluster, namespace and job id', async() => {
    const placed = { metadata: { name: 'train-1' }, status: { placement: { clusterId: 'c-x', namespace: 'team-a' } } };
    const local = { metadata: { name: 'train-2' }, status: {} };
    const store = fakeStore({
      '/k8s/clusters/c-x/api/v1/namespaces/team-a/pods?labelSelector=ai-factory.suse.com%2Fjob-id': {
        items: [
          { metadata: { name: 'p0', namespace: 'team-a', labels: { 'ai-factory.suse.com/job-id': 'train-1' } } },
          { metadata: { name: 'p1', namespace: 'team-b', labels: { 'ai-factory.suse.com/job-id': 'train-1' } } },
          { metadata: { name: 'p2', namespace: 'team-a', labels: { 'ai-factory.suse.com/job-id': 'train-9' } } },
        ],
      },
    });
    const pods = await placedPods(store, [placed, local]);

    expect(store.sent).toHaveLength(1);
    expect(podsOfPlacedJob(placed, pods).map((p) => p.metadata.name)).toEqual(['p0']);
    expect(podsOfPlacedJob(local, pods)).toEqual([]);
    expect(placementOf(local)).toBeNull();
  });
});
