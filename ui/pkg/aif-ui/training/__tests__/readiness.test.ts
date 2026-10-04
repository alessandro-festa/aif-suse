import { describe, expect, it } from 'vitest';
// The Deploy page shows the pre-flight to someone who usually cannot change the cluster. These pin
// that nothing is lost in the translation (every blocking check is still blocking, with its original
// text as detail) and that "can start now" is kept apart from "the profile allows".
import { Check, DEFAULT_FORM, Facts, Form } from '../preflight';
import { groupOf, readiness, resourceTotals, workersSchedulableNow } from '../readiness';

const FORM: Form = {
  ...DEFAULT_FORM, nodes: 4, gpusPerNode: 1, cpuRequest: '4', memRequest: '16Gi', ephemeralRequest: '20Gi'
};

const check = (id: string, severity: Check['severity'], title = id, detail = ''): Check => ({
  id, severity, title, detail
});

describe('readiness', () => {
  const checks = [
    check('profile', 'pass'),
    check('profile-image', 'pass'),
    check('queue', 'pass'),
    check('headroom', 'fail', 'No GPU node has enough free CPU/memory for this pod', 'Most headroom: gpu-node-1 has 2.51 CPU'),
    check('ephemeral', 'fail'),
    check('image-cache', 'warn'),
    check('ckpt', 'warn'),
    check('rdzv', 'info'),
  ];
  const r = readiness(checks, FORM);

  it('is not ready while anything fails, and counts what it saw', () => {
    expect(r.ready).toBe(false);
    expect(r.counts).toEqual({
      total: 8, passed: 3, blocked: 2, warnings: 2
    });
  });

  it('says a blocking check in deployment terms and keeps the cluster text as detail', () => {
    const h = r.blocking.find((i) => i.id === 'headroom');

    expect(h?.title).toBe('No GPU node has room for a worker right now');
    expect(h?.hint).toContain('4 CPU and 16Gi memory');
    expect(h?.detail).toContain('gpu-node-1');
  });

  it('keeps the check title for anything it has no wording for', () => {
    const r2 = readiness([check('rdma', 'fail', 'RDMA needs host network')], FORM);

    expect(r2.blocking[0].title).toBe('RDMA needs host network');
  });

  it('rolls checks up into groups in a fixed order, worst severity winning, info ignored', () => {
    expect(r.groups.map((g) => `${ g.key }:${ g.severity }`)).toEqual([
      'policy:pass', 'project:pass', 'capacity:fail', 'storage:fail', 'image:warn', 'network:pass',
    ]);
  });

  it('files profile checks under policy', () => {
    expect(groupOf('profile-runtime').key).toBe('policy');
    expect(groupOf('something-new').key).toBe('workload');
  });
});

describe('workers that can start now', () => {
  const node = (over: any = {}) => ({
    name: 'n', gpus: 2, cpuFree: 8, memFree: 64 * 2 ** 30, diskPressure: false, ephemeralFree: 100 * 2 ** 30, images: [], ...over
  });
  const facts = (over: Partial<Facts>): Facts => ({
    loaded:       true,
    podsReadable: true,
    draDevices:   0,
    draAllocated: 0,
    gpuNodes:     [],
    capacity:     {
      total: {
        gpu: 8, cpu: 0, memory: 0
      },
      free: {
        gpu: 8, cpu: 0, memory: 0
      }
    },
    ...over
  } as any);

  it('is limited by free GPUs', () => {
    expect(workersSchedulableNow(FORM, facts({
      gpuNodes: [node()],
      capacity: {
        total: {
          gpu: 8, cpu: 0, memory: 0
        },
        free: {
          gpu: 1, cpu: 0, memory: 0
        }
      } as any
    }), 'device-plugin'))
      .toEqual({
        available: 1, gpuOnly: false, limitedBy: 'gpu'
      });
  });

  it('is limited by CPU when that runs out first', () => {
    expect(workersSchedulableNow(FORM, facts({ gpuNodes: [node({ cpuFree: 2.5 })] }), 'device-plugin').limitedBy).toBe('cpu');
    expect(workersSchedulableNow(FORM, facts({ gpuNodes: [node({ cpuFree: 2.5 })] }), 'device-plugin').available).toBe(0);
  });

  it('counts DRA devices not yet claimed', () => {
    expect(workersSchedulableNow(FORM, facts({
      gpuNodes: [node()], draDevices: 4, draAllocated: 1
    }), 'dra').available).toBe(2);
  });

  it('skips nodes under disk pressure', () => {
    expect(workersSchedulableNow(FORM, facts({ gpuNodes: [node({ diskPressure: true })] }), 'device-plugin').available).toBe(0);
  });

  it('falls back to GPUs only, as an upper bound, when pods cannot be read', () => {
    expect(workersSchedulableNow(FORM, facts({ podsReadable: false }), 'device-plugin')).toEqual({
      available: 8, gpuOnly: true, limitedBy: 'gpu'
    });
  });
});

describe('resource totals', () => {
  it('multiplies per-worker requests by the number of workers', () => {
    expect(resourceTotals(FORM).slice(0, 3)).toEqual([
      { label: 'GPUs', value: '4' }, { label: 'CPU', value: '16' }, { label: 'Memory', value: '64.0Gi' },
    ]);
  });
});
