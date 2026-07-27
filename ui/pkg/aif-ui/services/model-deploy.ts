import type { Dispatchable } from '../types/rancher-types';
import { listClusterRepos, ensureRegistrySecretSimple } from './rancher-apps';
import { createFleetBundle, buildBundleNameForCluster } from './fleet-bundle';
import { getRegistryCredentials, createAIWorkload } from '../utils/operator-api';

/**
 * Deploy a Models-wizard vLLM configuration to a target cluster.
 *
 * Uses the Fleet-bundle path (the product's cross-cluster deploy mechanism, working
 * for both the local management cluster and downstream clusters): it schedules a Fleet
 * HelmOp that installs the SUSE Application Collection vLLM chart with the generated
 * values, then records an AIWorkload CR so the deployment shows on the Workloads page.
 */

const APPCO_OCI = 'oci://dp.apps.rancher.io/charts';
const APPCO_REPO_NAME = 'application-collection';
const VLLM_CHART = 'vllm';
const VLLM_VERSION = '0.1.10';

export interface ModelDeployOpts {
  clusterId:   string;
  namespace:   string;
  release:     string;
  values:      Record<string, any>;
  displayName: string;
}

export interface ModelDeployResult {
  bundleName: string;
  crName:     string;
}

function crName(release: string, clusterId: string): string {
  return `${ release }-${ clusterId }`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 253);
}

export async function deployModel(
  store: Dispatchable,
  o: ModelDeployOpts,
  onProgress?: (pct: number, msg: string) => void,
): Promise<ModelDeployResult> {
  const progress = onProgress || (() => {});

  progress(10, 'Resolving Application Collection repository…');
  const repos = await listClusterRepos(store);
  const repoObj =
    repos.find((r: any) => (r?.spec?.url || r?.spec?.ociRepo || '') === APPCO_OCI) ||
    repos.find((r: any) => r?.metadata?.name === APPCO_REPO_NAME);
  const chartRepo = repoObj?.metadata?.name || APPCO_REPO_NAME;
  const chartRepoUrl = repoObj?.spec?.url || repoObj?.spec?.ociRepo || APPCO_OCI;

  progress(30, 'Creating image pull secrets on the target cluster…');
  let creds: { applicationCollection?: any; suseRegistry?: any; nvidia?: any } = {};
  try {
    creds = await getRegistryCredentials(8000);
  } catch (e: any) {
    console.warn('[SUSE-AI] Models deploy: registry credentials unavailable:', e?.message || e);
  }
  const secretNames: string[] = [];
  for (const cred of [creds.applicationCollection, creds.suseRegistry, creds.nvidia]) {
    if (!cred) continue;
    try {
      const hostSlug = cred.registryHost.replace(/[^a-z0-9]/g, '-');
      const name = await ensureRegistrySecretSimple(
        store, o.clusterId, o.namespace, cred.registryHost, hostSlug, cred.username, cred.password,
      );
      if (name) secretNames.push(name);
    } catch (e: any) {
      console.warn('[SUSE-AI] Models deploy: pull-secret skipped:', e?.message || e);
    }
  }

  progress(55, 'Scheduling Fleet bundle…');
  const bundleName = buildBundleNameForCluster(o.release, o.namespace, o.clusterId);
  await createFleetBundle(store, {
    bundleName,
    release:                   o.release,
    chartRepo,
    chartRepoUrl,
    chartName:                 VLLM_CHART,
    chartVersion:              VLLM_VERSION,
    values:                    o.values,
    targetNamespace:           o.namespace,
    targetClusterIds:          [o.clusterId],
    additionalPullSecretNames: [...new Set(secretNames)],
    library:                   'suse-ai',
  });

  progress(85, 'Recording workload…');
  const name = crName(o.release, o.clusterId);
  await createAIWorkload(
    o.namespace,
    name,
    {
      displayName: o.displayName,
      source: {
        sourceType: 'App',
        app: { chartRepo, chartName: VLLM_CHART, chartVersion: VLLM_VERSION, release: o.release, vendor: 'suse' },
      },
      targetNamespace:  o.namespace,
      targetClusters:   [o.clusterId],
      deployStrategy:   'FleetBundle',
      componentValues:  [{ componentName: VLLM_CHART, values: o.values }],
      fleetBundleNames: [bundleName],
    } as any,
    { phase: 'Running', clusterStatuses: [{ clusterId: o.clusterId, phase: 'Running', message: 'Scheduled via Fleet' }] } as any,
  );

  progress(100, 'Scheduled for deployment');
  return { bundleName, crName: name };
}
