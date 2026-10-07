<script>
import { listComputePools } from '../services/compute-pools';

export default {
  name: 'ComputePoolsPage',

  data() {
    return { pools: [], loading: true };
  },

  async fetch() {
    try {
      this.pools = await listComputePools(this.$store);
    } finally {
      this.loading = false;
    }
  },

  methods: {
    stackLabel(keys, labels) {
      return keys.length ? keys.map((k) => labels[k] || k).join(', ') : '—';
    },
  },

  computed: {
    schedulerLabels: () => ({
      kai: 'KAI Scheduler', runai: 'Run:ai', kueue: 'Kueue', volcano: 'Volcano'
    }),
    sharingLabels: () => ({ hami: 'HAMi' }),
    trainingLabels: () => ({ 'training-operator': 'Kubeflow Training Operator', 'trainer-v2': 'Kubeflow Trainer v2' }),
  },
};
</script>

<template>
  <div>
    <header class="page-header">
      <h1>{{ t('suseai.pages.computePools.title') }}</h1>
    </header>
    <p class="text-muted mb-10">
      {{ t('suseai.pages.computePools.description') }}
    </p>

    <div
      v-if="loading"
      class="text-muted"
    >
      {{ t('suseai.pages.computePools.loading') }}
    </div>
    <div
      v-else-if="!pools.length"
      class="text-muted"
    >
      {{ t('suseai.pages.computePools.empty') }}
    </div>
    <table
      v-else
      class="sortable-table pools-table"
    >
      <thead>
        <tr>
          <th>{{ t('suseai.pages.computePools.cols.cluster') }}</th>
          <th>{{ t('suseai.pages.computePools.cols.kind') }}</th>
          <th>{{ t('suseai.pages.computePools.cols.nodes') }}</th>
          <th>{{ t('suseai.pages.computePools.cols.cpu') }}</th>
          <th>{{ t('suseai.pages.computePools.cols.memory') }}</th>
          <th>{{ t('suseai.pages.computePools.cols.gpuMemory') }}</th>
          <th>{{ t('suseai.pages.computePools.cols.schedulers') }}</th>
          <th>{{ t('suseai.pages.computePools.cols.sharing') }}</th>
          <th>{{ t('suseai.pages.computePools.cols.training') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="p in pools"
          :key="p.clusterId"
          :class="{ 'text-muted': p.status !== 'ready' }"
        >
          <td>{{ p.name }}</td>
          <td>
            <span :class="['badge-state', p.kind === 'gpu' ? 'bg-success' : 'bg-info']">
              {{ p.kind === 'gpu' ? 'GPU' : 'CPU only' }}
            </span>
          </td>
          <td>{{ p.nodeCount }}</td>
          <td>{{ p.cpu }}</td>
          <td>{{ Math.round(p.memoryGB) }} GB</td>
          <td>{{ p.gpuMemGB ? `${ Math.round(p.gpuMemGB) } GB` : '—' }}</td>
          <td>{{ stackLabel(p.schedulers, schedulerLabels) }}</td>
          <td>{{ stackLabel(p.sharing, sharingLabels) }}</td>
          <td>{{ stackLabel(p.training, trainingLabels) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style lang="scss" scoped>
.pools-table {
  width: 100%;

  th, td { padding: 8px 10px; text-align: left; }
}
</style>
