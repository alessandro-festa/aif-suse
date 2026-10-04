<script lang="ts" setup>
// The Overview's Projects panel: who is entitled to GPUs and what they use now. Quota editing,
// members and namespaces stay on the Projects page.
import type { OverviewProject } from '../overview';

defineProps<{ projects: OverviewProject[] }>();

const used = (p: OverviewProject) => `${ Math.round(p.gpus * 100) / 100 } GPU used`;
const activity = (p: OverviewProject) => {
  const parts = [p.running ? `${ p.running } running` : '', p.queued ? `${ p.queued } queued` : ''].filter(Boolean);

  return parts.length ? parts.join(' · ') : 'No workloads';
};
</script>

<template>
  <div
    v-if="!projects.length"
    class="panel-empty"
  >
    <i class="icon icon-folder-open" />
    No projects yet.
  </div>
  <ul
    v-else
    class="projects-panel"
  >
    <li
      v-for="p in projects.slice(0, 5)"
      :key="p.id"
    >
      <div class="pp-name">
        {{ p.name }}
        <span class="pp-entitlement">{{ p.entitlement }}</span>
      </div>
      <div class="pp-use">
        <span>{{ used(p) }}</span>
        <span class="pp-activity">{{ activity(p) }}</span>
      </div>
    </li>
  </ul>
</template>

<style lang="scss" scoped>
.projects-panel {
  list-style: none;
  margin: 0;
  padding: 0;

  li {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);

    &:last-child { border-bottom: 0; }
  }
}
.pp-name { font-weight: 500; display: flex; flex-direction: column; }
.pp-entitlement, .pp-activity { color: var(--muted); font-size: 12px; font-weight: 400; }
.pp-use { display: flex; flex-direction: column; align-items: flex-end; text-align: right; }
.panel-empty { color: var(--muted); display: flex; gap: 8px; align-items: center; padding: 16px 0; }
</style>
