<script>
import Loading from '@shell/components/Loading';
import { listRuntimes } from '../../services/scheduling/api';
import { runtimeRows } from '../../services/scheduling/model';

export default {
  name:       'RuntimesTab',
  components: { Loading },
  props:      { cluster: { type: String, required: true } },

  data() {
    return { loading: true, rows: [] };
  },

  async mounted() {
    this.rows = runtimeRows(await listRuntimes(this.$store, this.cluster));
    this.loading = false;
  },

  methods: {
    gpu(r) {
      if (r.kind === 'share') {
        return `${ Number(r.gpuMemoryMiB) / 1024 } GiB share of one GPU`;
      }
      if (r.kind === 'gpu') {
        return `whole GPUs, up to ${ r.maxGpusPerNode || '?' } per node`;
      }

      return 'CPU only';
    }
  }
};
</script>

<template>
  <div>
    <p class="muted">
      The compute profiles a notebook picks from (<span class="mono">client.list_runtimes()</span>). They
      come from the aif-training-runtimes chart; the admission policy holds every job to its runtime's limits.
    </p>
    <Loading v-if="loading" />
    <div
      v-else-if="!rows.length"
      class="empty"
    >
      No AI Factory runtimes on this cluster. See Readiness.
    </div>
    <table
      v-else
      class="grid"
    >
      <thead>
        <tr>
          <th>Runtime</th><th>Runs on</th><th>Nodes</th><th>Time limit</th><th>Image</th><th>Allowed registries</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in rows"
          :key="r.name"
        >
          <td>
            <div>{{ r.displayName }}</div>
            <div class="mono muted">
              {{ r.name }}
            </div>
            <div class="muted">
              {{ r.description }}
            </div>
          </td>
          <td>{{ gpu(r) }}</td>
          <td>up to {{ r.maxNodes }}</td>
          <td>{{ r.maxRuntimeHours ? `${ r.maxRuntimeHours } h` : 'none' }}</td>
          <td class="mono">
            {{ r.image }}
          </td>
          <td>
            <span
              v-for="g in r.registries"
              :key="g"
              class="tag mono"
            >{{ g }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style lang="scss" scoped>
@import './sched.scss';
</style>
