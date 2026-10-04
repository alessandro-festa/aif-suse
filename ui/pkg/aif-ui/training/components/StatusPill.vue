<script lang="ts" setup>
// A profile's release status. Beta is solid amber with dark text so it reads at a glance on any
// background; Ready is the same shape in green. One component, so every page says it the same way.
defineProps<{ status: string; size?: 'sm' | 'lg' }>();
</script>

<template>
  <span :class="['status-pill', status === 'beta' ? 'beta' : 'ready', size || 'sm']">
    {{ status === 'beta' ? 'Beta' : 'Ready' }}
  </span>
</template>

<style lang="scss" scoped>
.status-pill {
  display: inline-block;
  border-radius: 999px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
  vertical-align: middle;
  line-height: 1.4;
  border: 1px solid transparent;

  &.sm { font-size: 11px; padding: 1px 9px; }
  &.lg { font-size: 15px; padding: 3px 14px; }

  // fixed colors rather than theme tokens: the point is contrast, in light and dark themes alike
  &.beta { background: #f6c453; border-color: #e0a92e; color: #3b2a00; }
  &.ready { background: #2f9e5b; border-color: #26844b; color: #ffffff; }
}
</style>
