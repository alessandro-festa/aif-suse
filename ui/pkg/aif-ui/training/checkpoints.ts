// Checkpoint volumes runs created and kept (gpu-train-job's storage.checkpointCreate with keep): the
// claim is <run>-checkpoints with the chart's labels. Only those are offered for deletion, never a
// dataset or a shared PVC, and not while a pod mounts it or the run is still active.

const CHART = 'gpu-train-job';
const SUFFIX = '-checkpoints';

export interface CheckpointVolume {
  obj: any; // the store model (promptRemove)
  name: string;
  namespace: string;
  run: string;
  size: string;
  storageClass: string;
  created: string;
  inUseBy: string[]; // pods that mount it
  runActive: boolean;
}

/** The run a PVC is the checkpoint volume of, or '' (the chart's fullname is cut to 52 characters). */
export function checkpointRun(pvc: any): string {
  const l = pvc?.metadata?.labels || {};
  const run = l['app.kubernetes.io/instance'] || '';
  const full = run.length > 52 ? run.slice(0, 52).replace(/-+$/, '') : run;

  return run && l['app.kubernetes.io/name'] === CHART && pvc?.metadata?.name === `${ full }${ SUFFIX }` ? run : '';
}

export function checkpointVolumes(pvcs: any[], pods: any[], jobs: any[]): CheckpointVolume[] {
  const mounts: Record<string, string[]> = {};

  for (const p of pods || []) {
    if (['Succeeded', 'Failed'].includes(p?.status?.phase)) {
      continue;
    }
    for (const v of p?.spec?.volumes || []) {
      const c = v?.persistentVolumeClaim?.claimName;

      if (c) {
        (mounts[`${ p.metadata.namespace }/${ c }`] = mounts[`${ p.metadata.namespace }/${ c }`] || []).push(p.metadata.name);
      }
    }
  }
  const active = new Set((jobs || []).filter((j: any) => (j?.status?.active || 0) > 0).map((j: any) => `${ j.metadata.namespace }/${ j.metadata.name }`));

  return (pvcs || []).flatMap((v: any) => {
    const run = checkpointRun(v);

    if (!run) {
      return [];
    }
    const ns = v.metadata.namespace;

    return [{
      obj:          v,
      name:         v.metadata.name,
      namespace:    ns,
      run,
      size:         v.status?.capacity?.storage || v.spec?.resources?.requests?.storage || '',
      storageClass: v.spec?.storageClassName || '',
      created:      String(v.metadata.creationTimestamp || '').replace('T', ' ').replace('Z', ''),
      inUseBy:      mounts[`${ ns }/${ v.metadata.name }`] || [],
      runActive:    active.has(`${ ns }/${ run }`),
    }];
  });
}

export type PvcRole = 'checkpoint' | 'scratch' | 'app' | 'data';

/**
 * What a volume in a project is, for the dataset and checkpoint pickers: a run's kept checkpoint
 * volume (<run>-checkpoints, made by the chart), a run's scratch, a volume another app owns (its
 * Helm release, or app.kubernetes.io/instance: a database's or a model cache's disk, which a
 * training run must not be offered), or a plain data volume.
 */
export function pvcRole(pvc: any): { role: PvcRole; run: string } {
  const labels = pvc?.metadata?.labels || {};
  const ann = pvc?.metadata?.annotations || {};
  const name = pvc?.metadata?.name || '';

  if (labels['app.kubernetes.io/name'] === 'gpu-train-job') {
    const run = labels['app.kubernetes.io/instance'] || '';

    return run && name === `${ run }-checkpoints` ? { role: 'checkpoint', run } : { role: 'scratch', run };
  }
  if (ann['meta.helm.sh/release-name'] || labels['app.kubernetes.io/instance']) {
    return { role: 'app', run: '' };
  }

  return { role: 'data', run: '' };
}
