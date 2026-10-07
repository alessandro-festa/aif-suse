import { describe, expect, it } from 'vitest';
// Cluster add-ons (KAI, Kueue, Volcano, HAMi, Kubeflow Trainer) are Fleet HelmOps in fleet-default,
// one per add-on and cluster, named so the page finds them again.
import {
  ADDONS, addonBundleName, addonBundleParams, addonInstallsFrom, addonRelease, addonsFor
} from '../addons';

const byKey = (k: string) => ADDONS.find((a) => a.key === k)!;

describe('cluster add-ons', () => {
  it('are pinned upstream charts', () => {
    expect(ADDONS.map((a) => a.key)).toEqual(['kai', 'kueue', 'volcano', 'hami', 'kubeflow-trainer']);
    expect(addonBundleParams(byKey('kubeflow-trainer'), 'c-abc')).toMatchObject({
      chartRepoUrl: 'oci://ghcr.io/kubeflow/charts', chartName: 'kubeflow-trainer', chartVersion: '2.3.0', targetNamespace: 'kubeflow-system'
    });
    expect(addonBundleParams(byKey('kueue'), 'c-abc')).toEqual({
      bundleName: 'aif-addon-kueue-c-abc', release: 'kueue', chartRepo: '', chartRepoUrl: 'oci://registry.k8s.io/kueue/charts', chartName: 'kueue', chartVersion: '0.20.0', values: {}, targetNamespace: 'kueue-system', targetClusterIds: ['c-abc'],
    });
  });

  it('are read back from their HelmOps, Ready only when Fleet really deployed them', () => {
    const got = addonInstallsFrom([
      { metadata: { name: 'aif-addon-volcano-c-xvstz' }, status: { display: { readyBundleDeployments: '1/1' }, conditions: [{ type: 'Ready', status: 'True' }, { type: 'Accepted', status: 'True' }] } },
      { metadata: { name: 'aif-addon-hami-c-fg8qv' }, status: { display: { readyBundleDeployments: '0/1', state: 'ErrApplied' }, conditions: [{ type: 'Ready', status: 'False', message: 'image pull failed' }] } },
      // what a bad chart reference looks like: Ready, but not accepted and nothing deployed
      { metadata: { name: 'aif-addon-kai-c-fg8qv' }, status: { display: { readyBundleDeployments: '0/0' }, conditions: [{ type: 'Ready', status: 'True' }, { type: 'Accepted', status: 'False', message: 'denied' }] } },
      { metadata: { name: 'aif-addon-kueue-c-fg8qv' }, status: { display: { readyBundleDeployments: '0/1' }, conditions: [{ type: 'Ready', status: 'True' }] } },
      { metadata: { name: 'some-app' }, status: {} },
    ]);

    expect(got.map((i) => [i.clusterId, i.addon.key, i.state, i.ready, i.message])).toEqual([
      ['c-fg8qv', 'hami', 'ErrApplied', false, 'image pull failed'],
      ['c-fg8qv', 'kai', 'Not accepted', false, 'denied'],
      ['c-fg8qv', 'kueue', 'Installing', false, ''],
      ['c-xvstz', 'volcano', 'Ready', true, ''],
    ]);
    expect(addonBundleName(byKey('kai'), 'c-abc')).toBe('aif-addon-kai-c-abc');
  });

  it('pick the chart version the cluster\'s Kubernetes can run', () => {
    const t = byKey('kubeflow-trainer');

    expect(addonRelease(t, 'v1.33.2+k3s1')).toMatchObject({ version: '2.3.0', note: '' });
    expect(addonRelease(t, 'v1.31.0')).toMatchObject({ version: '2.1.0', values: {} });
    expect(addonRelease(t, 'v1.27.0')).toBeNull();
    expect(addonRelease(t, '')).toMatchObject({ version: '2.3.0' });
    expect(addonBundleParams(t, 'c-x', 'v1.31.0').chartVersion).toBe('2.1.0');
    expect(addonRelease(byKey('volcano'), 'v1.27.0')).toMatchObject({ version: '1.15.3' });
    expect(addonBundleParams(byKey('kai'), 'c-x').chartRepoUrl).toBe('oci://ghcr.io/kai-scheduler/kai-scheduler/kai-scheduler');
    expect(addonBundleParams(t, 'c-x').diff?.comparePatches.map((p: any) => p.name)).toEqual(['jobset-webhook-server-cert', 'kubeflow-trainer-webhook-cert']);
    expect(addonBundleParams(byKey('kueue'), 'c-x').diff).toBeUndefined();
  });

  it('are offered only where they are not there yet, and HAMi only with GPUs', () => {
    const pools = [
      {
        clusterId: 'c-cpu', kind: 'cpu', schedulers: ['volcano'], sharing: [], training: []
      },
      {
        clusterId: 'c-gpu', kind: 'gpu', schedulers: [], sharing: [], training: ['trainer-v2']
      },
    ];
    const installs = addonInstallsFrom([{ metadata: { name: 'aif-addon-kueue-c-gpu' }, status: {} }]);

    expect(addonsFor('c-cpu', pools, installs).map((a) => a.key)).toEqual(['kai', 'kueue', 'kubeflow-trainer']);
    expect(addonsFor('c-gpu', pools, installs).map((a) => a.key)).toEqual(['kai', 'volcano', 'hami']);
  });
});
