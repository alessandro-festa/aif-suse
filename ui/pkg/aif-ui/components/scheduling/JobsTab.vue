<script>
import Loading from '@shell/components/Loading';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import {
  listTrainJobs, listJobPods, deleteTrainJob, suspendTrainJob, podLog
} from '../../services/scheduling/api';
import { jobRows } from '../../services/scheduling/model';

const DOT = {
  Complete: 'ok', Failed: 'bad', Running: 'run', Pending: 'warn', Suspended: ''
};

export default {
  name:       'JobsTab',
  components: { Loading, LabeledSelect },
  props:      { cluster: { type: String, required: true } },

  data() {
    return {
      loading: true, rows: [], ns: '', open: '', log: { pod: '', text: '' }, busy: '', error: '', timer: null, DOT
    };
  },

  async mounted() {
    await this.load();
    this.timer = setInterval(() => this.load(true), 10000);
  },

  beforeUnmount() {
    clearInterval(this.timer);
  },

  computed: {
    nsOptions() {
      return [{ label: 'All namespaces', value: '' }].concat([...new Set(this.rows.map((r) => r.namespace))].sort().map((n) => ({ label: n, value: n })));
    },
    shown() {
      return this.ns ? this.rows.filter((r) => r.namespace === this.ns) : this.rows;
    }
  },

  methods: {
    async load(quiet = false) {
      if (!quiet) {
        this.loading = true;
      }
      const [jobs, pods] = await Promise.all([listTrainJobs(this.$store, this.cluster), listJobPods(this.$store, this.cluster)]);

      this.rows = jobRows(jobs, pods);
      this.loading = false;
    },

    age(ts) {
      const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);

      return s < 3600 ? `${ Math.round(s / 60) }m` : s < 86400 ? `${ Math.round(s / 3600) }h` : `${ Math.round(s / 86400) }d`;
    },

    key(r) {
      return `${ r.namespace }/${ r.name }`;
    },

    toggle(r) {
      this.open = this.open === this.key(r) ? '' : this.key(r);
      this.log = { pod: '', text: '' };
    },

    async showLog(r, p) {
      this.log = { pod: p.name, text: 'loading…' };
      this.log = { pod: p.name, text: await podLog(this.$store, this.cluster, r.namespace, p.name) };
    },

    async act(r, fn) {
      this.busy = this.key(r);
      this.error = '';
      try {
        await fn();
        await this.load(true);
      } catch (e) {
        this.error = e.message || String(e);
      }
      this.busy = '';
    },

    remove(r) {
      if (!window.confirm(`Delete TrainJob ${ r.namespace }/${ r.name }? Its outputs volume is kept.`)) {
        return;
      }

      return this.act(r, () => deleteTrainJob(this.$store, this.cluster, r.namespace, r.name));
    },

    suspend(r, on) {
      return this.act(r, () => suspendTrainJob(this.$store, this.cluster, r.namespace, r.name, on));
    }
  }
};
</script>

<template>
  <div>
    <div class="toolbar">
      <LabeledSelect
        v-model:value="ns"
        class="pick"
        label="Namespace"
        :options="nsOptions"
      />
      <span class="grow" />
      <button
        class="btn role-secondary"
        @click="load()"
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
    <div
      v-else-if="!shown.length"
      class="empty"
    >
      No training runs yet. They appear here when a notebook submits one.
    </div>
    <table
      v-else
      class="grid"
    >
      <thead>
        <tr>
          <th>Run</th><th>Namespace</th><th>Runtime</th><th>Queue</th><th>State</th><th>Age</th><th />
        </tr>
      </thead>
      <tbody>
        <template
          v-for="r in shown"
          :key="key(r)"
        >
          <tr>
            <td>
              <a
                href="#"
                @click.prevent="toggle(r)"
              >{{ r.name }}</a>
            </td>
            <td>{{ r.namespace }}</td>
            <td><span class="tag">{{ r.runtime }}</span></td>
            <td><span class="tag">{{ r.queue || '—' }}</span></td>
            <td>
              <span
                class="dot"
                :class="DOT[r.phase]"
              />{{ r.phase }}
              <div
                v-if="r.message"
                class="muted"
              >
                {{ r.message }}
              </div>
            </td>
            <td class="muted">
              {{ age(r.created) }}
            </td>
            <td class="actions">
              <button
                v-if="r.phase === 'Pending' || r.phase === 'Running'"
                class="btn btn-sm role-secondary"
                :disabled="busy === key(r)"
                @click="suspend(r, true)"
              >
                Suspend
              </button>
              <button
                v-if="r.phase === 'Suspended'"
                class="btn btn-sm role-secondary"
                :disabled="busy === key(r)"
                @click="suspend(r, false)"
              >
                Resume
              </button>
              <button
                class="btn btn-sm role-secondary"
                :disabled="busy === key(r)"
                @click="remove(r)"
              >
                Delete
              </button>
            </td>
          </tr>
          <tr
            v-if="open === key(r)"
            class="sub"
          >
            <td colspan="7">
              <div
                v-if="!r.pods.length"
                class="muted"
              >
                No pods (finished runs keep theirs until the TrainJob is deleted).
              </div>
              <div
                v-for="p in r.pods"
                :key="p.name"
              >
                <span class="mono">{{ p.name }}</span>
                <span class="tag">{{ p.phase }}</span>
                <span class="tag">{{ p.scheduler }}</span>
                <span
                  v-if="p.node"
                  class="tag"
                >{{ p.node }}</span>
                <a
                  href="#"
                  @click.prevent="showLog(r, p)"
                >log</a>
              </div>
              <pre
                v-if="log.pod"
                class="log"
              >{{ log.text }}</pre>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

<style lang="scss" scoped>
@import './sched.scss';
.pick { width: 260px; flex: none; }
</style>
