<script lang="ts" setup>
// The Overview's GPU Capacity panel: the hardware, GPU memory used (what shares are sized in, and
// the plainest measure across whole GPUs, shares and DRA capacity), then GPUs allocated, memory
// available and what is waiting. Fractional shares count at their size, so allocation is in GPUs and GPU memory.
import { computed } from 'vue';
import type { CapacitySummary } from '../capacity';
import { gib } from '../gpushare';

const props = defineProps<{ summary: CapacitySummary | null }>();

const s = computed(() => props.summary);
const hardware = computed(() => (s.value?.models || []).map((m) => (m.count > 1 ? `${ m.count } × ${ m.product }` : m.product)).join(', '));
const pct = computed(() => {
  const v = s.value;

  if (!v?.gpus) {
    return 0;
  }

  return Math.min(100, Math.round(v.memoryMiB ? (v.allocatedMiB / v.memoryMiB) * 100 : (v.allocatedGpus / v.gpus) * 100));
});
</script>

<template>
  <div
    v-if="!s || !s.gpus"
    class="panel-empty"
  >
    <i class="icon icon-info" />
    {{ s ? 'No GPUs in this cluster.' : 'GPU capacity is not available.' }}
  </div>
  <div
    v-else
    class="gpu-panel"
  >
    <div class="gp-hardware">
      {{ hardware }}
    </div>
    <div class="gp-headline">
      <strong v-if="s.memoryMiB">{{ gib(s.allocatedMiB) }} / {{ gib(s.memoryMiB) }} used</strong>
      <strong v-else>{{ s.allocatedGpus }} / {{ s.gpus }} GPU allocated</strong>
      <span>{{ pct }}%</span>
    </div>
    <div
      class="gp-bar"
      role="progressbar"
      :aria-valuenow="pct"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <div
        class="gp-fill"
        :style="{ width: `${ pct }%` }"
      />
    </div>
    <div class="gp-detail">
      <template v-if="s.memoryMiB">
        {{ s.allocatedGpus }} GPU allocated · {{ gib(Math.max(0, s.memoryMiB - s.allocatedMiB)) }} available ·
      </template>
      {{ s.queuedWorkloads }} waiting
    </div>
  </div>
</template>

<style lang="scss" scoped>
.gp-hardware { font-weight: 500; margin-bottom: 12px; }
.gp-headline { display: flex; justify-content: space-between; margin-bottom: 6px; }
.gp-bar { height: 8px; border-radius: 4px; background: var(--border); overflow: hidden; margin-bottom: 10px; }
// capacity is not health: a neutral fill, no success/warning colors
.gp-fill { height: 100%; background: var(--primary); }
.gp-detail { color: var(--muted); }
.panel-empty { color: var(--muted); display: flex; gap: 8px; align-items: center; padding: 16px 0; }
</style>
