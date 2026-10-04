// GPU types: which GPU models the cluster has, from whichever source it offers.
//
//   DRA:           each ResourceSlice device for the GPU driver has a productName attribute, and a
//                  ResourceClaim's allocation names the device it took, so free counts are exact.
//   device plugin: GPU Feature Discovery labels each node nvidia.com/gpu.product (spaces as dashes)
//                  and nvidia.com/gpu.count. Allocation is per node, not per device, so the count
//                  is what the node has, and free is left unknown.
//
// A cluster with neither (device plugin without GPU Feature Discovery) has no GPU types to offer,
// and a profile's GPU type cannot be enforced there; the pre-flight says so.

import { GPU_DEVICE_CLASS, GPU_RESOURCE } from './config';

export const GFD_PRODUCT_LABEL = 'nvidia.com/gpu.product';
const GFD_COUNT_LABEL = 'nvidia.com/gpu.count';

export interface GpuType {
  product: string; // as the source names it: "NVIDIA RTX A2000 12GB" (DRA) or "NVIDIA-RTX-A2000-12GB" (GFD)
  source: 'dra' | 'gfd';
  total: number;
  free: number | null; // null = not known (device plugin)
  nodes: string[];
}

/** Compare GPU names across the two spellings: case, spaces and dashes do not matter. */
export function gpuKey(product: string): string {
  return String(product || '').toLowerCase().replace(/[\s_-]+/g, '-').replace(/^-|-$/g, '');
}

export function sameGpu(a: string, b: string): boolean {
  return !!a && !!b && gpuKey(a) === gpuKey(b);
}

/** A short label for people: "NVIDIA RTX A2000 12GB" -> "RTX A2000 12GB". */
export function gpuShort(product: string): string {
  return String(product || '').replace(/-/g, ' ').replace(/^NVIDIA\s+/i, '').trim();
}

export function gpuInventory(slices: any[], claims: any[], nodes: any[]): GpuType[] {
  const byKey = new Map<string, GpuType>();

  // DRA: one entry per device, keyed by pool/device so allocations can be matched
  const used = new Set<string>();

  (claims || []).forEach((c) => (c?.status?.allocation?.devices?.results || []).forEach((r: any) => {
    if (r?.driver === GPU_DEVICE_CLASS) {
      used.add(`${ r.pool }/${ r.device }`);
    }
  }));
  (slices || []).filter((s) => s?.spec?.driver === GPU_DEVICE_CLASS).forEach((s) => {
    const pool = s.spec?.pool?.name || s.spec?.nodeName || '';

    (s.spec?.devices || []).forEach((d: any) => {
      const product = d?.attributes?.productName?.string || d?.basic?.attributes?.productName?.string;

      if (!product || d?.attributes?.type?.string === 'channel') {
        return;
      }
      const k = gpuKey(product);
      const e: GpuType = byKey.get(k) || {
        product, source: 'dra', total: 0, free: 0, nodes: []
      };

      e.total++;
      if (!used.has(`${ pool }/${ d.name }`)) {
        e.free = (e.free || 0) + 1;
      }
      if (s.spec?.nodeName && !e.nodes.includes(s.spec.nodeName)) {
        e.nodes.push(s.spec.nodeName);
      }
      byKey.set(k, e);
    });
  });

  // GPU Feature Discovery: only for models DRA did not already report
  (nodes || []).forEach((n) => {
    const product = n?.metadata?.labels?.[GFD_PRODUCT_LABEL];

    if (!product) {
      return;
    }
    const k = gpuKey(product);

    if (byKey.get(k)?.source === 'dra') {
      return;
    }
    const count = parseInt(n.metadata.labels[GFD_COUNT_LABEL] || n.status?.allocatable?.[GPU_RESOURCE] || '0', 10) || 0;
    const e: GpuType = byKey.get(k) || {
      product, source: 'gfd', total: 0, free: null, nodes: []
    };

    e.total += count;
    e.nodes.push(n.metadata.name);
    byKey.set(k, e);
  });

  return [...byKey.values()].sort((a, b) => gpuShort(a.product).localeCompare(gpuShort(b.product)));
}

/** Whether any node carries GPU Feature Discovery's product label. */
export function hasGfdLabels(nodes: any[]): boolean {
  return (nodes || []).some((n) => !!n?.metadata?.labels?.[GFD_PRODUCT_LABEL]);
}
