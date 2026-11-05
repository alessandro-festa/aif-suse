<script>
import Loading from '@shell/components/Loading';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import {
  listProjects, listNamespaces, listQueues, listUsers, listMembers, grantTrainer, revokeMember,
  setNamespaceTraining, hasNotebookAccess, enableNotebookAccess
} from '../../services/scheduling/api';
import { namespaceRows, TRAINER_ROLE, NOTEBOOK_SA } from '../../services/scheduling/model';

export default {
  name:       'ProjectsTab',
  components: { Loading, LabeledSelect },
  props:      { cluster: { type: String, required: true } },

  data() {
    return {
      loading:   true,
      projects:  [],
      projectId: '',
      allNs:     [],
      queues:    [],
      users:     [],
      members:   [],
      notebook:  {},
      pickQueue: {},
      newUser:   '',
      busy:      '',
      error:     '',
      NOTEBOOK_SA,
    };
  },

  async mounted() {
    await this.load();
  },

  computed: {
    project() {
      return this.projects.find((p) => p.id === this.projectId);
    },
    projectOptions() {
      return this.projects.filter((p) => p.name !== 'System').map((p) => ({ label: p.name, value: p.id }));
    },
    queueOptions() {
      return this.queues.map((q) => ({ label: q, value: q }));
    },
    rows() {
      return namespaceRows(this.allNs, this.queues).filter((r) => r.projectId === this.projectId);
    },
    trainers() {
      return this.members.filter((m) => m.role === TRAINER_ROLE);
    },
    others() {
      return this.members.filter((m) => m.role !== TRAINER_ROLE);
    },
    userOptions() {
      const have = this.trainers.map((m) => m.userId);

      return this.users.filter((u) => !have.includes(u.id)).map((u) => ({ label: u.label, value: u.id }));
    }
  },

  watch: {
    projectId() {
      this.loadProject();
    }
  },

  methods: {
    async load() {
      this.loading = true;
      const [projects, ns, queues, users] = await Promise.all([
        listProjects(this.$store, this.cluster),
        listNamespaces(this.$store, this.cluster),
        listQueues(this.$store, this.cluster),
        listUsers(this.$store),
      ]);

      this.projects = projects;
      this.allNs = ns;
      this.queues = queues.map((q) => q.metadata.name).filter((n) => !queues.some((c) => c.spec?.parentQueue === n));
      this.users = users;
      if (!this.projectId || !projects.some((p) => p.id === this.projectId)) {
        this.projectId = (projects.find((p) => p.name !== 'System' && p.name !== 'Default') || projects[0])?.id || '';
      } else {
        await this.loadProject();
      }
      this.loading = false;
    },

    async loadProject() {
      if (!this.project) {
        return;
      }
      this.members = await listMembers(this.$store, this.cluster, this.project, this.users);
      const nb = {};

      await Promise.all(this.rows.map(async(r) => {
        nb[r.name] = await hasNotebookAccess(this.$store, this.cluster, r.name);
      }));
      this.notebook = nb;
      this.pickQueue = Object.fromEntries(this.rows.map((r) => [r.name, r.queue || this.queues[0] || '']));
    },

    async run(key, fn) {
      this.busy = key;
      this.error = '';
      try {
        await fn();
        this.allNs = await listNamespaces(this.$store, this.cluster);
        await this.loadProject();
      } catch (e) {
        this.error = e.message || String(e);
      }
      this.busy = '';
    },

    enable(r) {
      return this.run(r.name, () => setNamespaceTraining(this.$store, this.cluster, r.name, this.pickQueue[r.name]));
    },
    disable(r) {
      return this.run(r.name, () => setNamespaceTraining(this.$store, this.cluster, r.name, null));
    },
    notebookOn(r) {
      return this.run(`nb-${ r.name }`, () => enableNotebookAccess(this.$store, this.cluster, r.name));
    },
    grant() {
      const u = this.newUser;

      this.newUser = '';

      return this.run('grant', () => grantTrainer(this.$store, this.cluster, this.project, u));
    },
    revoke(m) {
      return this.run(m.id, () => revokeMember(this.$store, m));
    }
  }
};
</script>

<template>
  <div>
    <Loading v-if="loading" />
    <template v-else>
      <div class="toolbar">
        <LabeledSelect
          v-model:value="projectId"
          class="pick"
          label="Rancher project"
          :options="projectOptions"
        />
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

      <h3>Namespaces</h3>
      <p class="muted">
        A namespace can train once it is managed by AI Factory and has a queue. The admission policy
        then holds every TrainJob there to the queue and the runtimes' limits. Notebook access lets a
        notebook in the namespace submit as the <span class="mono">{{ NOTEBOOK_SA }}</span> service account.
      </p>
      <div
        v-if="!rows.length"
        class="empty"
      >
        This project has no namespaces on this cluster.
      </div>
      <table
        v-else
        class="grid"
      >
        <thead>
          <tr>
            <th>Namespace</th><th>Training</th><th>Queue</th><th>Notebook access</th><th />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in rows"
            :key="r.name"
          >
            <td>{{ r.name }}</td>
            <td>
              <span
                class="dot"
                :class="r.ready ? 'ok' : (r.problem ? 'warn' : '')"
              />{{ r.ready ? 'enabled' : (r.problem || 'off') }}
            </td>
            <td style="min-width: 200px">
              <LabeledSelect
                v-model:value="pickQueue[r.name]"
                label="Queue"
                :options="queueOptions"
                :compact="true"
              />
            </td>
            <td>
              <span v-if="notebook[r.name]"><span class="dot ok" />enabled</span>
              <button
                v-else
                class="btn btn-sm role-secondary"
                :disabled="busy === `nb-${ r.name }`"
                @click="notebookOn(r)"
              >
                Enable
              </button>
            </td>
            <td class="actions">
              <button
                class="btn btn-sm role-primary"
                :disabled="busy === r.name || !pickQueue[r.name] || (r.ready && r.queue === pickQueue[r.name])"
                @click="enable(r)"
              >
                {{ r.managed ? 'Set queue' : 'Enable training' }}
              </button>
              <button
                v-if="r.managed || r.queue"
                class="btn btn-sm role-secondary"
                :disabled="busy === r.name"
                @click="disable(r)"
              >
                Disable
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <h3 class="mt-20">
        AI Trainers
      </h3>
      <p class="muted">
        Members with the AI Trainer role may submit, follow and delete TrainJobs in every namespace of
        the project. (Rancher's own member editor does not list this role, so it is granted here.)
      </p>
      <div class="toolbar">
        <LabeledSelect
          v-model:value="newUser"
          class="pick"
          label="User"
          :options="userOptions"
        />
        <button
          class="btn role-primary"
          :disabled="!newUser || busy === 'grant'"
          @click="grant"
        >
          Grant AI Trainer
        </button>
      </div>
      <table class="grid">
        <thead>
          <tr>
            <th>User</th><th>Role</th><th />
          </tr>
        </thead>
        <tbody>
          <tr v-if="!trainers.length">
            <td
              colspan="3"
              class="muted"
            >
              Nobody can train in this project yet.
            </td>
          </tr>
          <tr
            v-for="m in trainers"
            :key="m.id"
          >
            <td>{{ m.user }}</td>
            <td><span class="tag">AI Trainer</span></td>
            <td class="actions">
              <button
                class="btn btn-sm role-secondary"
                :disabled="busy === m.id"
                @click="revoke(m)"
              >
                Revoke
              </button>
            </td>
          </tr>
          <tr
            v-for="m in others"
            :key="m.id"
          >
            <td class="muted">
              {{ m.user }}
            </td>
            <td><span class="tag">{{ m.role }}</span></td>
            <td />
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>

<style lang="scss" scoped>
@import './sched.scss';
.pick { width: 320px; flex: none; }
</style>
