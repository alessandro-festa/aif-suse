import { describe, expect, it } from 'vitest';
import { entitlementText, overviewProjects } from '../overview';

const project = (over: any) => ({
  id: 'team-a', displayName: 'Team A', rancherProjectId: 'local:p-1', rancherProjectName: 'Team A', namespaces: ['team-a'], queue: 'team-a', department: null, members: [], gpu: null, source: 'complete', ...over
});
const avail = (guaranteed: number, cap: number, allocated = 0) => ({ guaranteed, cap, allocated } as any);

describe('entitlementText', () => {
  it('words guarantees under a queueing backend', () => {
    expect(entitlementText(project({ gpu: avail(1, 1) }) as any, true)).toBe('1 GPU guaranteed');
    expect(entitlementText(project({ gpu: avail(1, Infinity) }) as any, true)).toBe('1 GPU guaranteed · can borrow');
    expect(entitlementText(project({ gpu: avail(0, 2) }) as any, true)).toBe('No guarantee · up to 2');
  });

  it('words a ResourceQuota as a limit', () => {
    expect(entitlementText(project({ gpu: avail(0, 2) }) as any, false)).toBe('Up to 2 GPU');
    expect(entitlementText(project({ gpu: null }) as any, false)).toBe('No limit');
  });
});

describe('overviewProjects', () => {
  const summary: any = {
    byQueue: {
      'team-a': {
        gpus: 0.42, memoryMiB: 5120, running: 1, queued: 0
      },
      'team-b': {
        gpus: 0, memoryMiB: 0, running: 0, queued: 2
      },
    },
  };

  it('takes use from the capacity summary, busiest first, and leaves out bare queues', () => {
    const rows = overviewProjects([
      project({ id: 'team-b', displayName: 'Team B', queue: 'team-b', gpu: avail(0, 1) }),
      project({ gpu: avail(1, 1) }),
      project({ id: 'stray', displayName: 'stray', queue: 'stray', source: 'queue-only' }),
    ] as any, summary, true);

    expect(rows.map((r) => r.name)).toEqual(['Team A', 'Team B']);
    expect(rows[0]).toMatchObject({ gpus: 0.42, memoryMiB: 5120, running: 1, entitlement: '1 GPU guaranteed' });
    expect(rows[1]).toMatchObject({ queued: 2 });
  });
});
