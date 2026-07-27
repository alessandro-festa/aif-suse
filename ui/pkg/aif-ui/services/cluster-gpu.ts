import type { Dispatchable } from '../types/rancher-types';
import { TIMEOUT_VALUES } from '../utils/constants';

/**
 * Cluster GPU detection for the Models deploy wizard.
 *
 * Reads node labels (populated by NVIDIA GPU Feature Discovery / the GPU operator)
 * to determine which GPU families a cluster exposes, so the wizard can decide
 * whether a given vLLM recipe is deployable there.
 */

export interface ClusterGpuInfo {
  clusterId: string;
  hasGpu: boolean;
  /** Normalized GPU family tokens present, e.g. ["H100"], ["T4"]. */
  families: string[];
  /** Raw product strings from nvidia.com/gpu.product, e.g. "Tesla-T4". */
  products: string[];
  /** Total advertised GPU count across nodes. */
  totalGpuCount: number;
  /** Total advertised GPU memory across all GPUs, in GB. */
  totalVramGB: number;
}

export type CompatLevel = 'validated' | 'deployable' | 'warn' | 'incompatible';

export interface CompatVerdict {
  level: CompatLevel;
  message: string;
}

// Longest tokens first so e.g. "H100" isn't shadowed by a shorter match.
const FAMILY_TOKENS = [
  'GB200', 'GB300', 'B200', 'B300', 'H200', 'H100', 'A100', 'A40', 'A30', 'A10',
  'L40S', 'L40', 'L4', 'V100', 'T4', 'MI300X', 'MI325X', 'MI355X',
];

/** Extract a known GPU family token from a raw product label. */
export function normalizeGpuFamily(product: string): string | null {
  const p = (product || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (const tok of FAMILY_TOKENS) {
    if (p.includes(tok)) return tok;
  }
  return null;
}

interface NodeItem {
  metadata?: { labels?: Record<string, string> };
  status?: { capacity?: Record<string, string> };
}

/** Fetch and summarize a cluster's GPU inventory from node labels. */
export async function getClusterGpuInfo(store: Dispatchable, clusterId: string): Promise<ClusterGpuInfo> {
  const url = `/k8s/clusters/${ encodeURIComponent(clusterId) }/api/v1/nodes`;
  const res: any = await store.dispatch('rancher/request', { url, timeout: TIMEOUT_VALUES.CLUSTER });
  const items: NodeItem[] = res?.data || res?.items || [];

  const families = new Set<string>();
  const products = new Set<string>();
  let totalGpuCount = 0;
  let totalVramMiB = 0;

  for (const node of items) {
    const labels = node.metadata?.labels || {};
    const product = labels['nvidia.com/gpu.product'];
    if (product) {
      products.add(product);
      const fam = normalizeGpuFamily(product);
      if (fam) families.add(fam);
    }
    const count = parseInt(labels['nvidia.com/gpu.count'] || node.status?.capacity?.['nvidia.com/gpu'] || '0', 10);
    if (!Number.isNaN(count)) {
      totalGpuCount += count;
      // nvidia.com/gpu.memory is per-GPU, in MiB.
      const memMiB = parseInt(labels['nvidia.com/gpu.memory'] || '0', 10);
      if (!Number.isNaN(memMiB)) totalVramMiB += count * memMiB;
    }
  }

  return {
    clusterId,
    hasGpu: products.size > 0 || totalGpuCount > 0,
    families: Array.from(families),
    products: Array.from(products),
    totalGpuCount,
    totalVramGB: Math.round(totalVramMiB / 1024),
  };
}

/**
 * Decide how a recipe deploys on a cluster, based on the cluster's GPU family vs the
 * model's supported (a recipe exists) and verified (vLLM-community-verified) families:
 * - validated:    the cluster's GPU family is community-verified for this model.
 * - deployable:   the family is supported (a recipe exists) but not verified.
 * - warn:         cluster has NVIDIA GPUs but the family is neither supported nor
 *                 verified → deployment may fail.
 * - incompatible: no NVIDIA GPU detected → deployment will fail.
 */
export function gpuCompatVerdict(
  supportedFamilies: string[],
  verifiedFamilies: string[],
  gpu: ClusterGpuInfo,
): CompatVerdict {
  if (!gpu.hasGpu) {
    return { level: 'incompatible', message: 'No NVIDIA GPU detected on this cluster — deployment will fail.' };
  }
  const norm = (f: string) => normalizeGpuFamily(f) || f;
  const detected = gpu.families.length ? gpu.families.join(', ') : (gpu.products.join(', ') || 'unknown');

  if (verifiedFamilies.some(f => gpu.families.includes(norm(f)))) {
    return { level: 'validated', message: `Cluster GPU (${ detected }) is a vLLM-community-verified configuration for this model.` };
  }
  if (supportedFamilies.some(f => gpu.families.includes(norm(f)))) {
    return { level: 'deployable', message: `Cluster GPU (${ detected }) is supported (a recipe exists) but not community-verified for this model. Deployable.` };
  }
  return {
    level:   'warn',
    message: `Cluster GPU (${ detected }) is not among this model's supported families (${ supportedFamilies.join(', ') || 'none' }). Deployment may fail.`,
  };
}
