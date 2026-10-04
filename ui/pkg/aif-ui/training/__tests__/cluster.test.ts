import { describe, it, expect } from 'vitest';
import { clusterLabel, loadClusterLabel } from '../cluster';

describe('clusterLabel', () => {
  it('names the management cluster as such', () => {
    expect(clusterLabel('local', 'local')).toBe('local (management cluster)');
    expect(clusterLabel('local')).toBe('local (management cluster)');
  });

  it('uses the display name of a downstream cluster', () => {
    expect(clusterLabel('c-m-abc12', 'rke2-prod')).toBe('rke2-prod');
    expect(clusterLabel('c-m-abc12', '  ')).toBe('c-m-abc12');
  });
});

describe('loadClusterLabel', () => {
  it('reads the display name from the management store', async () => {
    const store = { dispatch: async () => ({ nameDisplay: 'gpu-east' }) };

    expect(await loadClusterLabel(store, 'c-m-abc12')).toBe('gpu-east');
  });

  it('falls back to the ID when the cluster cannot be read', async () => {
    const store = { dispatch: async () => { throw new Error('forbidden') } };

    expect(await loadClusterLabel(store, 'local')).toBe('local (management cluster)');
  });
});
