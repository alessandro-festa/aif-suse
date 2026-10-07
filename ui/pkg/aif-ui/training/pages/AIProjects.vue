<script lang="ts">
// AI projects: a team's AI work across clusters. Administrators create a project and choose the
// clusters it spans (each with its namespace there); the operator puts it in place on every one of
// them. Owners manage who else is in it. See docs/design/ai-scheduling.md and the AIProject type.
import { defineComponent } from 'vue';
import Banner from '@components/Banner/Banner.vue';
import LabeledInput from '@components/Form/LabeledInput/LabeledInput.vue';
import LabeledSelect from '@shell/components/form/LabeledSelect.vue';
import AsyncButton from '@shell/components/AsyncButton.vue';
import { PRODUCT_NAME, PROJECTS_PAGE, TYPES } from '../config';
import { fetchProjects, LOCAL_CLUSTER, projectNamespace } from '../placement';
import { getAllClusters } from '../../services/rancher-apps';

const AIF_API = '/k8s/clusters/local/apis/ai-factory.suse.com/v1alpha1';
const NAME = /^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$/;
const ROLES = [{ label: 'Owner', value: 'owner' }, { label: 'Member', value: 'member' }, { label: 'Read-only', value: 'read-only' }];

type Subject = { kind: 'User' | 'Group'; name: string };
type Member = Subject & { role: string };

export default defineComponent({
  name:       'AIProjectsPage',
  components: {
    Banner, LabeledInput, LabeledSelect, AsyncButton
  },

  data() {
    return {
      projects:     [] as any[],
      clusters:     [] as { id: string; name: string }[],
      rancherProjects: [] as any[],
      canCreate:    false,
      error:        '',
      notice:       '',
      showCreate:   false,
      draft:        { name: '', displayName: '', owners: '', clusters: [{ clusterId: '', namespace: '', projectId: '' }] },
      // members being edited, by project name
      editing:      {} as Record<string, Member[]>,
      canEditMembers: {} as Record<string, boolean>,
      roles:        ROLES,
    };
  },

  async fetch() {
    await this.load();
  },

  computed: {
    clusterOptions(): { label: string; value: string }[] {
      return this.clusters.map((c) => ({ label: c.name, value: c.id }));
    },
    me(): string {
      const p = String(this.$store.getters['auth/principalId'] || '');

      return p.includes('://') ? p.split('://')[1] : p;
    },
    draftErrors(): string[] {
      const d = this.draft;
      const out: string[] = [];

      if (!NAME.test(d.name)) {
        out.push('Name: lowercase letters, digits and dashes, up to 42 characters.');
      }
      if (this.projects.some((p) => p.metadata.name === d.name)) {
        out.push(`A project named ${ d.name } already exists.`);
      }
      if (!d.clusters.some((c) => c.clusterId)) {
        out.push('Choose at least one cluster.');
      }
      if (d.clusters.some((c) => c.clusterId && !NAME.test(c.namespace))) {
        out.push('Each cluster needs a namespace name.');
      }
      if (!this.owners.length) {
        out.push('A project needs at least one owner.');
      }

      return out;
    },
    owners(): Subject[] {
      return this.draft.owners.split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => (s.includes('://') ? { kind: 'Group' as const, name: s } : { kind: 'User' as const, name: s }));
    },
  },

  methods: {
    async request(opts: any): Promise<any> {
      const res = await this.$store.dispatch('cluster/request', opts);

      return res?.data ?? res;
    },
    async canI(verb: string, resource: string, namespace = '', name = ''): Promise<boolean> {
      try {
        const res = await this.request({
          url:    '/k8s/clusters/local/apis/authorization.k8s.io/v1/selfsubjectaccessreviews',
          method: 'POST',
          data:   {
            apiVersion: 'authorization.k8s.io/v1',
            kind:       'SelfSubjectAccessReview',
            spec:       {
              resourceAttributes: {
                group: 'ai-factory.suse.com', resource, verb, namespace, name
              }
            },
          },
        });

        return !!res?.status?.allowed;
      } catch {
        return false;
      }
    },
    async load() {
      this.error = '';
      try {
        const [projects, clusters] = await Promise.all([fetchProjects(this.$store), getAllClusters(this.$store)]);

        this.projects = projects;
        this.clusters = clusters.filter((c: any) => c.id !== LOCAL_CLUSTER);
        this.canCreate = await this.canI('create', 'aiprojects');
        const edit: Record<string, boolean> = {};

        await Promise.all(projects.map(async(p: any) => {
          edit[p.metadata.name] = await this.canI('update', 'aiprojectmembers', projectNamespace(p.metadata.name), 'members');
        }));
        this.canEditMembers = edit;
        if (this.canCreate) {
          this.rancherProjects = await this.$store.dispatch('management/findAll', { type: TYPES.RANCHER_PROJECT }).catch(() => []);
        }
      } catch (e: any) {
        this.error = `Could not read AI projects: ${ e?.message || e }`;
      }
    },
    clusterName(id: string): string {
      return this.clusters.find((c) => c.id === id)?.name || id;
    },
    statusOf(p: any, clusterId: string): any {
      return (p.status?.clusters || []).find((c: any) => c.clusterId === clusterId) || null;
    },
    quotasRoute(clusterId: string): any {
      return { name: `c-cluster-${ PRODUCT_NAME }-${ PROJECTS_PAGE }`, params: { cluster: clusterId } };
    },
    adoptOptions(clusterId: string): { label: string; value: string }[] {
      return [
        { label: 'Create a new Rancher project', value: '' },
        ...this.rancherProjects
          .filter((p: any) => p.metadata?.namespace === clusterId && p.metadata?.labels?.['authz.management.cattle.io/system-project'] !== 'true')
          .map((p: any) => ({ label: `Use ${ p.spec?.displayName || p.metadata.name }`, value: p.metadata.name })),
      ];
    },
    openCreate() {
      this.showCreate = true;
      this.draft = {
        name: '', displayName: '', owners: this.me, clusters: [{ clusterId: '', namespace: '', projectId: '' }]
      };
    },
    addCluster() {
      this.draft.clusters.push({ clusterId: '', namespace: this.draft.name, projectId: '' });
    },
    async create(done: (ok: boolean) => void) {
      const d = this.draft;

      try {
        await this.request({
          url:    `${ AIF_API }/aiprojects`,
          method: 'POST',
          data:   {
            apiVersion: 'ai-factory.suse.com/v1alpha1',
            kind:       'AIProject',
            metadata:   { name: d.name },
            spec:       {
              displayName: d.displayName || d.name,
              owners:      this.owners,
              clusters:    d.clusters.filter((c) => c.clusterId).map((c) => ({ clusterId: c.clusterId, namespace: c.namespace, ...(c.projectId ? { projectId: c.projectId } : {}) })),
            },
          },
        });
        this.notice = `Project ${ d.displayName || d.name } created. AI Factory is putting it in place on its clusters.`;
        this.showCreate = false;
        done(true);
        await this.load();
      } catch (e: any) {
        this.error = `Could not create the project: ${ e?.message || e }`;
        done(false);
      }
    },
    async editMembers(p: any) {
      const m = await this.request({ url: `${ AIF_API }/namespaces/${ projectNamespace(p.metadata.name) }/aiprojectmembers/members` });

      this.editing = { ...this.editing, [p.metadata.name]: (m?.spec?.members || []).map((x: any) => ({ ...x })) };
    },
    addMember(name: string) {
      this.editing[name].push({ kind: 'User', name: '', role: 'member' });
    },
    async saveMembers(p: any, done: (ok: boolean) => void) {
      const name = p.metadata.name;
      const url = `${ AIF_API }/namespaces/${ projectNamespace(name) }/aiprojectmembers/members`;

      try {
        const m = await this.request({ url });

        m.spec = { members: this.editing[name].filter((x) => x.name.trim()).map((x) => ({ kind: x.kind, name: x.name.trim(), role: x.role })) };
        await this.request({ url, method: 'PUT', data: m });
        this.notice = `Members of ${ p.spec?.displayName || name } saved; their access follows on every cluster of the project.`;
        const editing = { ...this.editing };

        delete editing[name];
        this.editing = editing;
        done(true);
        await this.load();
      } catch (e: any) {
        this.error = `Could not save the members: ${ e?.message || e }`;
        done(false);
      }
    },
  },
});
</script>

<template>
  <div class="aip">
    <header class="aip-header">
      <div>
        <h1>Projects</h1>
        <p class="text-muted">
          An AI project is a team's AI work across clusters: who is in it, and the clusters and namespaces its training runs on.
          Runs placed automatically go to the compute pool of the project that fits them best.
        </p>
      </div>
      <button
        v-if="canCreate"
        class="btn role-primary"
        @click="openCreate"
      >
        <i class="icon icon-plus mr-5" /> New project
      </button>
    </header>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <Banner
      v-if="notice"
      color="success"
      :label="notice"
    />

    <section
      v-if="showCreate"
      class="aip-card"
    >
      <h3>New project</h3>
      <div class="aip-row">
        <LabeledInput
          v-model:value="draft.name"
          label="Name"
          placeholder="vision"
        />
        <LabeledInput
          v-model:value="draft.displayName"
          label="Display name"
          placeholder="Vision team"
        />
      </div>
      <p class="text-muted">
        Clusters it runs on, and its namespace on each (created when missing):
      </p>
      <div
        v-for="(c, i) in draft.clusters"
        :key="i"
        class="aip-row"
      >
        <LabeledSelect
          v-model:value="c.clusterId"
          :options="clusterOptions"
          label="Cluster"
        />
        <LabeledInput
          v-model:value="c.namespace"
          label="Namespace"
          :placeholder="draft.name"
        />
        <LabeledSelect
          v-model:value="c.projectId"
          :options="adoptOptions(c.clusterId)"
          label="Rancher project"
        />
      </div>
      <button
        class="btn role-link"
        @click="addCluster"
      >
        + Add a cluster
      </button>
      <LabeledInput
        v-model:value="draft.owners"
        label="Owners"
        sub-label="Rancher user IDs (user-…) or group principals (github_team://…), comma separated"
      />
      <ul
        v-if="draftErrors.length"
        class="aip-errors"
      >
        <li
          v-for="e in draftErrors"
          :key="e"
        >
          {{ e }}
        </li>
      </ul>
      <div class="aip-actions">
        <button
          class="btn role-secondary"
          @click="showCreate = false"
        >
          Cancel
        </button>
        <AsyncButton
          mode="create"
          :disabled="draftErrors.length > 0"
          @click="create"
        />
      </div>
    </section>

    <p
      v-if="!projects.length && !showCreate"
      class="text-muted"
    >
      No AI project yet.<template v-if="canCreate">
        Create one to let a team run training on its clusters.
      </template><template v-else>
        An administrator creates them.
      </template>
    </p>

    <section
      v-for="p in projects"
      :key="p.metadata.name"
      class="aip-card"
    >
      <div class="aip-card-head">
        <div>
          <h3>{{ p.spec.displayName || p.metadata.name }}</h3>
          <span class="text-muted">{{ p.metadata.name }} · runs recorded in {{ p.status?.namespace || `aif-${ p.metadata.name }` }}</span>
        </div>
        <div>
          <span
            v-for="o in p.spec.owners"
            :key="o.name"
            class="pool-tag"
          >owner {{ o.name }}</span>
        </div>
      </div>
      <table class="aip-table">
        <thead>
          <tr>
            <th>Cluster</th><th>Namespace</th><th>Status</th><th />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in p.spec.clusters"
            :key="c.clusterId"
          >
            <td>{{ clusterName(c.clusterId) }}</td>
            <td>{{ c.namespace }}</td>
            <td>
              <span
                v-clean-tooltip="statusOf(p, c.clusterId)?.message || ''"
                :class="['pool-status', statusOf(p, c.clusterId)?.ready ? 'pool-status--success' : (statusOf(p, c.clusterId) ? 'pool-status--error' : 'pool-status--info')]"
              >{{ statusOf(p, c.clusterId)?.ready ? 'Ready' : (statusOf(p, c.clusterId) ? 'Not ready' : 'Setting up') }}</span>
              <div
                v-if="statusOf(p, c.clusterId) && !statusOf(p, c.clusterId).ready"
                class="text-muted aip-msg"
              >
                {{ statusOf(p, c.clusterId).message }}
              </div>
            </td>
            <td>
              <router-link :to="quotasRoute(c.clusterId)">
                Quotas
              </router-link>
            </td>
          </tr>
        </tbody>
      </table>

      <template v-if="canEditMembers[p.metadata.name]">
        <button
          v-if="!editing[p.metadata.name]"
          class="btn role-secondary btn-sm"
          @click="editMembers(p)"
        >
          Members
        </button>
        <div
          v-else
          class="aip-members"
        >
          <div
            v-for="(m, i) in editing[p.metadata.name]"
            :key="i"
            class="aip-row"
          >
            <LabeledSelect
              v-model:value="m.kind"
              :options="[{ label: 'User', value: 'User' }, { label: 'Group', value: 'Group' }]"
              label="Kind"
            />
            <LabeledInput
              v-model:value="m.name"
              label="User ID or group principal"
            />
            <LabeledSelect
              v-model:value="m.role"
              :options="roles"
              label="Role"
            />
            <button
              class="btn role-link"
              @click="editing[p.metadata.name].splice(i, 1)"
            >
              Remove
            </button>
          </div>
          <button
            class="btn role-link"
            @click="addMember(p.metadata.name)"
          >
            + Add a member
          </button>
          <div class="aip-actions">
            <AsyncButton
              mode="edit"
              @click="saveMembers(p, $event)"
            />
          </div>
        </div>
      </template>
    </section>
  </div>
</template>

<style lang="scss" scoped>
.aip { padding: 0 20px 20px; }
.aip-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 12px; }
.aip-card { border: 1px solid var(--border); border-radius: var(--border-radius); padding: 14px 16px; margin-bottom: 14px; }
.aip-card-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; h3 { margin: 0; } }
.aip-row { display: flex; gap: 12px; align-items: flex-end; margin-bottom: 8px; > * { flex: 1; } > .btn { flex: 0; } }
.aip-table { width: 100%; margin: 6px 0 10px; th, td { padding: 6px 8px; text-align: left; vertical-align: top; } }
.aip-msg { font-size: 12px; margin-top: 2px; }
.aip-errors { color: var(--error); margin: 8px 0; }
.aip-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
.aip-members { margin-top: 8px; }
.pool-tag { display: inline-block; margin: 0 4px 4px 0; padding: 1px 8px; border: 1px solid var(--border); border-radius: 10px; font-size: 12px; line-height: 18px; }
.pool-status {
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  &::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  &--success::before { background: var(--success); }
  &--error::before { background: var(--error); }
  &--info::before { background: var(--info); }
}
</style>
