import { describe, expect, it } from 'vitest';
// The chart repo is per-cluster and the extension is cluster-scoped, so "this cluster cannot
// install the chart" is a normal state, not a broken one. What these pin is that the three cases
// stay distinguishable: absent, present but not downloaded, and present but pointing somewhere
// this cluster can never reach.

import { canCreateChartRepo, chartRepoManifest, chartRepoState, urlMismatch } from '../chartrepo';

const NAME = 'gpu-train-charts';
const OCI = 'oci://registry.example.com/charts/gpu-train-job';

const repo = (url: string, conditions: any[] = []) => ({
  metadata: { name: NAME },
  spec:     { url },
  status:   { conditions },
});

describe('chartRepoState', () => {
  it('reports absent rather than failing when the cluster has no such repo', () => {
    const state = chartRepoState([{ metadata: { name: 'rancher-charts' } }], NAME);

    expect(state.present).toBe(false);
    expect(state.ready).toBe(false);
    expect(state.message).toBe('');
  });

  it('reads an OCI repo through OCIDownloaded', () => {
    const state = chartRepoState([repo(OCI, [{ type: 'OCIDownloaded', status: 'True' }])], NAME);

    expect(state.present).toBe(true);
    expect(state.ready).toBe(true);
    expect(state.url).toBe(OCI);
  });

  it('does not require OCIDownloaded of an http repo, which never gets one', () => {
    const url = 'http://training-jobs-server-svc.cattle-ui-plugin-system:8080/charts';
    const state = chartRepoState([repo(url, [{ type: 'Downloaded', status: 'True' }])], NAME);

    expect(state.ready).toBe(true);
  });

  it('does not accept Downloaded on an OCI repo, where it means something else', () => {
    // Downloaded can be True on an OCI repo whose artifact fetch failed; OCIDownloaded is the one
    // the Submit page's chart lookup actually depends on.
    const state = chartRepoState([repo(OCI, [
      { type: 'Downloaded', status: 'True' },
      {
        type: 'OCIDownloaded', status: 'False', message: 'unauthorized'
      },
    ])], NAME);

    expect(state.ready).toBe(false);
    expect(state.message).toBe('unauthorized');
  });

  it('calls a repo with no conditions yet a wait, not a failure', () => {
    const state = chartRepoState([repo(OCI)], NAME);

    expect(state.present).toBe(true);
    expect(state.ready).toBe(false);
    expect(state.message).toContain('waiting');
  });

  it('surfaces the cluster\'s own words when something else went wrong', () => {
    const state = chartRepoState([repo(OCI, [
      {
        type: 'FollowerDownloaded', status: 'False', message: 'dial tcp: i/o timeout'
      },
    ])], NAME);

    expect(state.message).toBe('dial tcp: i/o timeout');
  });

  it('survives a cluster that returned nothing at all', () => {
    expect(chartRepoState([], NAME).present).toBe(false);
    expect(chartRepoState(null as any, NAME).present).toBe(false);
  });
});

describe('urlMismatch', () => {
  it('catches a repo of the right name pointing at the local cluster Service', () => {
    // The classic hand-rolled mistake: copied from catalog.yaml, so the name matches and the URL
    // resolves only inside the Rancher local cluster.
    const state = chartRepoState([repo('http://training-jobs-server-svc.cattle-ui-plugin-system:8080/charts')], NAME);

    expect(urlMismatch(state, OCI)).toBe(true);
  });

  it('is not a mismatch when the repo is absent or the expectation is unset', () => {
    expect(urlMismatch(chartRepoState([], NAME), OCI)).toBe(false);
    expect(urlMismatch(chartRepoState([repo('http://elsewhere')], NAME), '')).toBe(false);
  });
});

describe('canCreateChartRepo', () => {
  it('is true only when the schema says POST', () => {
    expect(canCreateChartRepo({ collectionMethods: ['GET', 'POST'] })).toBe(true);
    // Steve has returned these lower-cased in places; a project owner seeing a button that 403s is
    // worse than a cluster admin seeing the kubectl line.
    expect(canCreateChartRepo({ collectionMethods: ['get', 'post'] })).toBe(true);
    expect(canCreateChartRepo({ collectionMethods: ['GET'] })).toBe(false);
    expect(canCreateChartRepo(null)).toBe(false);
  });
});

describe('chartRepoManifest', () => {
  it('builds what the reader expects to find', () => {
    const m = chartRepoManifest(NAME, OCI);
    const state = chartRepoState([m], NAME);

    expect(state.present).toBe(true);
    expect(state.url).toBe(OCI);
    expect(m.kind).toBe('ClusterRepo');
  });
});
