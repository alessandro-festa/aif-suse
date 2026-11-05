<script>
import Loading from '@shell/components/Loading';
import { LabeledInput } from '@components/Form/LabeledInput';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import {
  listQueues, listNamespaces, saveQueue, deleteQueue
} from '../../services/scheduling/api';
import { queueRows, validateQueue } from '../../services/scheduling/model';

const blank = () => ({
  name: '', parent: '', gpuQuota: 0, gpuLimit: -1, cpuQuota: -1, memoryQuota: -1
});

export default {
  name:       'QueuesTab',
  components: { Loading, LabeledInput, LabeledSelect },
  props:      { cluster: { type: String, required: true } },

  data() {
    return {
      loading: true, raw: [], rows: [], form: null, editing: null, errors: [], error: '', busy: false
    };
  },

  mounted() {
    this.load();
  },

  computed: {
    parentOptions() {
      return [{ label: '(none: a top-level queue)', value: '' }]
        .concat(this.rows.filter((r) => r.name !== this.form?.name).map((r) => ({ label: r.name, value: r.name })));
    }
  },

  methods: {
    async load() {
      this.loading = true;
      const [queues, namespaces] = await Promise.all([listQueues(this.$store, this.cluster), listNamespaces(this.$store, this.cluster)]);

      this.raw = queues;
      this.rows = queueRows(queues, namespaces);
      this.loading = false;
    },

    fmt(v, unit = '') {
      return v === -1 ? 'unlimited' : `${ v }${ unit }`;
    },

    add() {
      this.form = blank();
      this.form.parent = this.rows.find((r) => !r.parent && r.name !== 'default-parent-queue')?.name || '';
      this.editing = null;
      this.errors = [];
    },

    edit(r) {
      this.form = {
        name: r.name, parent: r.parent, gpuQuota: r.gpuQuota, gpuLimit: r.gpuLimit, cpuQuota: r.cpuQuota, memoryQuota: r.memoryQuota
      };
      this.editing = this.raw.find((q) => q.metadata.name === r.name);
      this.errors = [];
    },

    async save() {
      const f = {
        ...this.form,
        gpuQuota:    Number(this.form.gpuQuota),
        gpuLimit:    Number(this.form.gpuLimit),
        cpuQuota:    Number(this.form.cpuQuota),
        memoryQuota: Number(this.form.memoryQuota),
      };

      this.errors = validateQueue(f, this.rows.map((r) => r.name), !!this.editing);
      if (this.errors.length) {
        return;
      }
      this.busy = true;
      try {
        await saveQueue(this.$store, this.cluster, f, this.editing);
        this.form = null;
        await this.load();
      } catch (e) {
        this.errors = [e.message];
      }
      this.busy = false;
    },

    async remove(r) {
      if (r.namespaces.length || r.children.length) {
        this.error = `${ r.name } is still used by ${ [...r.namespaces, ...r.children].join(', ') }`;

        return;
      }
      if (!window.confirm(`Delete queue ${ r.name }?`)) {
        return;
      }
      this.error = '';
      try {
        await deleteQueue(this.$store, this.cluster, r.name);
        await this.load();
      } catch (e) {
        this.error = e.message;
      }
    }
  }
};
</script>

<template>
  <div>
    <div class="toolbar">
      <span class="muted">KAI queues hold each project's GPU quota. A namespace runs its TrainJobs in the queue on its <span class="mono">kai.scheduler/queue</span> label.</span>
      <span class="grow" />
      <button
        class="btn role-secondary"
        @click="load"
      >
        Refresh
      </button>
      <button
        class="btn role-primary"
        @click="add"
      >
        Add queue
      </button>
    </div>

    <div
      v-if="form"
      class="form"
    >
      <h3>{{ editing ? `Edit ${ form.name }` : 'New queue' }}</h3>
      <div class="row">
        <LabeledInput
          v-model:value="form.name"
          label="Name"
          :disabled="!!editing"
        />
        <LabeledSelect
          v-model:value="form.parent"
          label="Parent queue"
          :options="parentOptions"
        />
      </div>
      <div class="row">
        <LabeledInput
          v-model:value="form.gpuQuota"
          label="GPU quota (guaranteed GPUs)"
          type="number"
        />
        <LabeledInput
          v-model:value="form.gpuLimit"
          label="GPU limit (-1 = unlimited)"
          type="number"
        />
        <LabeledInput
          v-model:value="form.cpuQuota"
          label="CPU quota, millicores (-1 = unlimited)"
          type="number"
        />
        <LabeledInput
          v-model:value="form.memoryQuota"
          label="Memory quota, MB (-1 = unlimited)"
          type="number"
        />
      </div>
      <p
        v-for="e in errors"
        :key="e"
        class="err"
      >
        {{ e }}
      </p>
      <button
        class="btn role-primary"
        :disabled="busy"
        @click="save"
      >
        Save
      </button>
      <button
        class="btn role-secondary ml-10"
        @click="form = null"
      >
        Cancel
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
      v-else-if="!rows.length"
      class="empty"
    >
      No KAI queues on this cluster. Is KAI installed? See Readiness.
    </div>
    <table
      v-else
      class="grid"
    >
      <thead>
        <tr>
          <th>Queue</th><th>Parent</th><th>GPU quota</th><th>GPU limit</th><th>GPUs in use</th><th>CPU / memory quota</th><th>Namespaces</th><th />
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in rows"
          :key="r.name"
        >
          <td :style="{ paddingLeft: r.parent ? '28px' : '10px' }">
            {{ r.name }}
          </td>
          <td class="muted">
            {{ r.parent || '—' }}
          </td>
          <td>{{ fmt(r.gpuQuota) }}</td>
          <td>{{ fmt(r.gpuLimit) }}</td>
          <td>{{ r.allocatedGpu }}</td>
          <td class="muted">
            {{ fmt(r.cpuQuota, 'm') }} / {{ fmt(r.memoryQuota, ' MB') }}
          </td>
          <td>
            <span
              v-for="n in r.namespaces"
              :key="n"
              class="tag"
            >{{ n }}</span>
          </td>
          <td class="actions">
            <button
              class="btn btn-sm role-secondary"
              @click="edit(r)"
            >
              Edit
            </button>
            <button
              class="btn btn-sm role-secondary"
              @click="remove(r)"
            >
              Delete
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style lang="scss" scoped>
@import './sched.scss';
</style>
