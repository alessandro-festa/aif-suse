<script>
import Loading from '@shell/components/Loading';
import { readiness, fixReadiness } from '../../services/scheduling/api';

export default {
  name:       'ReadinessTab',
  components: { Loading },
  props:      { cluster: { type: String, required: true } },

  data() {
    return {
      loading: true, checks: [], busy: '', error: ''
    };
  },

  mounted() {
    this.load();
  },

  computed: {
    allOk() {
      return this.checks.length && this.checks.every((c) => c.ok);
    }
  },

  methods: {
    async load() {
      this.loading = true;
      this.error = '';
      try {
        this.checks = await readiness(this.$store, this.cluster);
      } catch (e) {
        this.error = e.message || String(e);
      }
      this.loading = false;
    },

    async fix(c) {
      this.busy = c.key;
      this.error = '';
      try {
        await fixReadiness(this.$store, this.cluster, c.fix.action);
        await this.load();
      } catch (e) {
        this.error = e.message || String(e);
      }
      this.busy = '';
    }
  }
};
</script>

<template>
  <div>
    <div class="toolbar">
      <span v-if="!loading">
        <span
          class="dot"
          :class="allOk ? 'ok' : 'warn'"
        />{{ allOk ? 'This cluster is ready for training runs.' : 'Some pieces are missing on this cluster.' }}
      </span>
      <span class="grow" />
      <button
        class="btn role-secondary"
        @click="load"
      >
        Refresh
      </button>
    </div>
    <p
      v-if="error"
      class="err"
    >
      {{ error }}
    </p>
    <Loading v-if="loading" />
    <table
      v-else
      class="grid"
    >
      <thead>
        <tr>
          <th>Component</th><th>State</th><th />
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="c in checks"
          :key="c.key"
        >
          <td>
            <span
              class="dot"
              :class="c.ok ? 'ok' : 'bad'"
            />{{ c.label }}
          </td>
          <td :class="{ muted: c.ok }">
            {{ c.detail }}
          </td>
          <td class="actions">
            <template v-if="!c.ok && c.fix">
              <button
                v-if="c.fix.action"
                class="btn btn-sm role-primary"
                :disabled="busy === c.key"
                @click="fix(c)"
              >
                {{ c.fix.text }}
              </button>
              <span
                v-else
                class="mono"
              >{{ c.fix.text }}</span>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style lang="scss" scoped>
@import './sched.scss';
</style>
