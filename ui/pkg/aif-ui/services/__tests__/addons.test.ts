import { describe, expect, it } from 'vitest';
// Cluster add-ons (KAI, Kueue, Volcano, HAMi) are Fleet HelmOps in fleet-default,
// one per add-on and cluster, named so the page finds them again.
import {
  ADDONS, addonBundleName, addonBundleParams, addonInstallsFrom, addonsFor
} from '../addons';

const byKey = (k: string) => ADDONS.find((a) => a.key === k)!;

describe('cluster add-ons', () => {
  it('are pinned upstream charts', () => {
    expect(ADDONS.map((a) => a.key)).toEqual(['kai', 'kueue', 'volcano', 'hami']);
    expect(addonBundleParams(byKey('kueue'), 'c-abc')).toEqual({
      bundleName: 'aif-addon-kueue-c-abc', release: 'kueue', chartRepo: '', chartRepoUrl: 'oci://registry.k8s.io/kueue/charts', chartName: 'kueue', chartVersion: '0.20.0', values: {}, targetNamespace: 'kueue-system', targetClusterIds: ['c-abc'],
    });
  });

  it('are read back from their HelmOps, with Fleet\'s state', () => {
    const got = addonInstallsFrom([
      { metadata: { name: 'aif-addon-volcano-c-xvstz' }, status: { display: { state: 'Ready' }, conditions: [{ type: 'Ready', status: 'True' }] } },
      { metadata: { name: 'aif-addon-hami-c-fg8qv' }, status: { display: { state: 'ErrApplied' }, conditions: [{ type: 'Ready', status: 'False', message: 'image pull failed' }] } },
      { metadata: { name: 'some-app' }, status: {} },
    ]);

    expect(got.map((i) => [i.clusterId, i.addon.key, i.state, i.ready, i.message])).toEqual([
      ['c-fg8qv', 'hami', 'ErrApplied', false, 'image pull failed'],
      ['c-xvstz', 'volcano', 'Ready', true, ''],
    ]);
    expect(addonBundleName(byKey('kai'), 'c-abc')).toBe('aif-addon-kai-c-abc');
  });

  it('are offered only where they are not there yet, and HAMi only with GPUs', () => {
    const pools = [
      {
        clusterId: 'c-cpu', kind: 'cpu', schedulers: ['volcano'], sharing: [], training: []
      },
      {
        clusterId: 'c-gpu', kind: 'gpu', schedulers: [], sharing: [], training: ['training-operator']
      },
    ];
    const installs = addonInstallsFrom([{ metadata: { name: 'aif-addon-kueue-c-gpu' }, status: {} }]);

    expect(addonsFor('c-cpu', pools, installs).map((a) => a.key)).toEqual(['kai', 'kueue']);
    expect(addonsFor('c-gpu', pools, installs).map((a) => a.key)).toEqual(['kai', 'volcano', 'hami']);
  });
});
