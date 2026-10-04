<script lang="ts">
// The Readiness panel of the Deploy pages (training and inference): a verdict, a roll-up by
// category, blocking items and recommendations in terms of the deployment with the pre-flight's own
// text under Details, counts, and the full check list on demand. readiness.ts decides the content.
import { defineComponent, PropType } from 'vue';
import { Check } from '../preflight';
import { Readiness } from '../readiness';

export default defineComponent({
  name:  'ReadinessPanel',
  props: {
    ready:  { type: Object as PropType<Readiness>, required: true },
    checks: { type: Array as PropType<Check[]>, required: true },
  },
  emits: ['recheck'],

  data() {
    return { showAll: false };
  },

  methods: {
    groupIcon(sev: string): string {
      return { fail: 'icon-x text-error', warn: 'icon-warning text-warning' }[sev] || 'icon-checkmark text-success';
    },

    groupWord(sev: string): string {
      return { fail: 'Blocked', warn: 'Attention' }[sev] || 'OK';
    },

    severityIcon(s: string): string {
      return {
        pass: 'icon-checkmark text-success', fail: 'icon-x text-error', warn: 'icon-warning text-warning', info: 'icon-info text-info'
      }[s] || 'icon-info';
    },
  },
});
</script>

<template>
  <div class="tj-panel">
    <div class="tj-panel-head">
      <h2>Readiness</h2>
      <button
        class="btn role-tertiary btn-sm"
        @click="$emit('recheck')"
      >
        <i class="icon icon-refresh" /> Re-check
      </button>
    </div>
    <p :class="['tj-verdict', ready.ready ? 'ok' : 'blocked']">
      <i :class="['icon', ready.ready ? 'icon-checkmark text-success' : 'icon-x text-error']" />
      {{ ready.ready ? 'Ready to deploy' : 'Not ready to deploy' }}
    </p>
    <p
      v-if="!ready.ready"
      class="text-muted tj-sub"
    >
      {{ ready.counts.blocked }} issue{{ ready.counts.blocked === 1 ? '' : 's' }} need{{ ready.counts.blocked === 1 ? 's' : '' }} attention
    </p>

    <ul class="tj-groups">
      <li
        v-for="g in ready.groups"
        :key="g.key"
      >
        <i :class="['icon', groupIcon(g.severity)]" />
        <span class="tj-group-label">{{ g.label }}</span>
        <span :class="['tj-group-word', g.severity]">{{ groupWord(g.severity) }}</span>
      </li>
    </ul>

    <template
      v-for="section in [{ key: 'b', title: 'Needs attention', items: ready.blocking, icon: 'icon-x text-error' }, { key: 'r', title: 'Recommendations', items: ready.recommendations, icon: 'icon-warning text-warning' }]"
      :key="section.key"
    >
      <template v-if="section.items.length">
        <h4>{{ section.title }}</h4>
        <div
          v-for="i in section.items"
          :key="section.key + i.id + i.title"
          class="tj-item"
        >
          <div class="tj-item-title">
            <i :class="['icon', section.icon]" /> {{ i.title }}
          </div>
          <div
            v-if="i.hint"
            class="tj-item-hint"
          >
            {{ i.hint }}
          </div>
          <details
            v-if="i.detail"
            class="tj-item-detail"
          >
            <summary>Details</summary>
            {{ i.detail }}
          </details>
        </div>
      </template>
    </template>

    <p class="text-muted tj-counts">
      {{ ready.counts.total }} checks · {{ ready.counts.passed }} passed · {{ ready.counts.blocked }} blocked · {{ ready.counts.warnings }} warning{{ ready.counts.warnings === 1 ? '' : 's' }}
    </p>
    <a
      href="#"
      class="tj-link"
      @click.prevent="showAll = !showAll"
    >{{ showAll ? 'Hide checks' : 'View all checks →' }}</a>
    <ul
      v-if="showAll"
      class="tj-checks"
    >
      <li
        v-for="c in checks"
        :key="c.id + c.severity + c.title"
        class="tj-check"
      >
        <i :class="['icon', severityIcon(c.severity)]" />
        <div>
          <div class="tj-check-title">
            {{ c.title }}
          </div>
          <div
            v-if="c.detail"
            class="text-muted tj-check-detail"
          >
            {{ c.detail }}
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>

<style lang="scss" scoped>
.tj-panel { border: 1px solid var(--border); border-radius: var(--border-radius); padding: 12px 16px; background: var(--body-bg); overflow-wrap: anywhere;
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 4px 0 8px; }
  h4 { font-size: 13px; margin: 14px 0 6px; } }
.tj-panel-head { display: flex; justify-content: space-between; align-items: center; }
.tj-verdict { font-size: 16px; font-weight: 600; margin: 0; }
.tj-sub { font-size: 12px; margin: 2px 0 0; }
.tj-link { font-size: 13px; }
.tj-groups { list-style: none; padding: 0; margin: 10px 0 0; li { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 13px; } }
.tj-group-label { flex: 1; }
.tj-group-word { font-size: 12px; color: var(--muted); &.fail { color: var(--error); } &.warn { color: var(--warning); } }
.tj-item { padding: 6px 0; border-bottom: 1px solid var(--border); &:last-of-type { border-bottom: none; } }
.tj-item-title { font-weight: 600; font-size: 13px; }
.tj-item-hint { font-size: 12px; margin: 2px 0 0 22px; }
.tj-item-detail { font-size: 11px; color: var(--muted); margin: 2px 0 0 22px; summary { cursor: pointer; } }
.tj-counts { font-size: 12px; margin: 12px 0 4px; }
.tj-checks { list-style: none; margin: 8px 0 0; padding: 0; }
.tj-check { display: flex; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 12px; .icon { margin-top: 2px; } }
.tj-check > div { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.tj-check-title { font-weight: 600; }
</style>
