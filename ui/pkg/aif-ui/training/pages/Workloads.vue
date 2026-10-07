<script lang="ts">
// Workloads: every training run and inference endpoint in one table (runs.ts builds the rows).
// Training runs are gpu-train-job releases (trainingruns.ts); inference endpoints are the AI Factory
// AIWorkloads made from profiles. A row expands to its pods, logs and YAML (RunDetail).
import { defineComponent } from 'vue';
import jsyaml from 'js-yaml';
import Loading from '@shell/components/Loading.vue';
import Banner from '@components/Banner/Banner.vue';
import { saferDump } from '@shell/utils/create-yaml';
import { AIJOB_TYPE } from '../aijob';
import RunDetail from '../components/RunDetail.vue';
import VolumeFiles from '../components/VolumeFiles.vue';
import YamlViewer, { YamlDoc } from '../components/YamlViewer.vue';
import { PRODUCT_NAME, PROFILES_PAGE, SUBMIT_PAGE, TYPES } from '../config';
import { AIWORKLOAD_TYPE, BLUEPRINT_TYPE } from '../inference';
import { profilesFrom } from '../profiles';
import {
  ago, ALL_RUNS, filterRuns, inferenceToRuns, pageOf, Run, RunFilter, RunSortKey, RunState, sortRuns, trainingToRuns
} from '../runs';
import { CheckpointVolume, checkpointVolumes } from '../checkpoints';
import { trainingRuns } from '../trainingruns';

const STATES: RunState[] = ['Running', 'Deploying', 'Pending', 'Queued', 'Degraded', 'Suspended', 'Completed', 'Failed', 'Cancelled'];
const COLUMNS: { key: RunSortKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'type', label: 'Type' },
  { key: 'profile', label: 'Profile' },
  { key: 'project', label: 'Project' },
  { key: 'resources', label: 'Resources' },
  { key: 'state', label: 'State' },
  { key: 'created', label: 'Created' },
];

export default defineComponent({
  name:       'TrainingJobWorkloads',
  // Set when the page is embedded as one tab of the AI Factory Workloads page: the tab is fixed
  // and the page's own title and tab strip are left out.
  props:      { fixedTab: { type: String, default: null } },
  components: {
    Loading, Banner, RunDetail, VolumeFiles, YamlViewer
  },

  data() {
    return {
      // the kept volume (namespace/name) whose files are open, in the list of volumes without a run
      browsingVolume: '' as string,
      raw: {
        jobs: [] as any[], pytorchJobs: [] as any[], kueueWorkloads: [] as any[], apps: [] as any[], pods: [] as any[], claimTemplates: [] as any[], aiWorkloads: [] as any[], blueprints: [] as any[], configMaps: [] as any[], pvcs: [] as any[], aiJobs: [] as any[]
      },
      error:  '' as string,
      // ?project=<namespace>&state=<state> preset the filters, so other pages can link to a view
      filter: {
        ...ALL_RUNS, project: String(this.$route.query.project || ''), state: String(this.$route.query.state || '')
      } as RunFilter,
      sortKey:  'created' as RunSortKey,
      sortDesc: true,
      page:     1,
      pageSize: 10,
      menuFor:  '' as string, // row key whose ⋯ menu is open
      open:     {} as Record<string, boolean>, // expanded rows, by key
      yaml:     {
        open: false, title: '', docs: [] as YamlDoc[], loading: false, error: ''
      },
      newOpen:    false,
      notice:     '' as string,
      now:        Date.now(),
      timer:      null as any,
      refreshing: false,
    };
  },

  async fetch() {
    await this.load();
  },

  mounted() {
    // Jobs and endpoints change state on their own; a forced re-list keeps the table honest.
    this.timer = setInterval(() => {
      this.now = Date.now();
      this.load();
    }, 20000);
    document.addEventListener('click', this.closeMenus);
  },

  beforeUnmount() {
    clearInterval(this.timer);
    document.removeEventListener('click', this.closeMenus);
  },

  computed: {
    columns: () => COLUMNS,
    states:  () => STATES,

    // The tab is in the URL (?tab=training|inference), so a link opens the same view.
    tab(): '' | 'training' | 'inference' {
      if (this.fixedTab) {
        return this.fixedTab as 'training' | 'inference';
      }
      const t = this.$route.query.tab;

      return t === 'training' || t === 'inference' ? t : '';
    },

    all(): Run[] {
      const r = this.raw;
      const profiles = profilesFrom(r.configMaps, (s: string) => jsyaml.load(s));
      const training = trainingToRuns(trainingRuns({
        jobs: r.jobs, pytorchJobs: r.pytorchJobs, kueueWorkloads: r.kueueWorkloads, apps: r.apps, pods: r.pods, aiJobs: r.aiJobs
      }), profiles, r.claimTemplates);

      return [...training, ...inferenceToRuns(r.aiWorkloads, r.blueprints, profiles, r.pods)];
    },

    /** Every run's kept checkpoint volume (<run>-checkpoints, made by the chart), with who still uses it. */
    checkpoints(): CheckpointVolume[] {
      return checkpointVolumes(this.raw.pvcs, this.raw.pods, this.raw.jobs);
    },
    /** Kept checkpoint volumes whose run is gone from the list (uninstalled or cleaned up). */
    orphanCheckpoints(): CheckpointVolume[] {
      // training outputs: not on the Inference tab
      if (this.tab === 'inference') {
        return [];
      }
      const runs = new Set(this.all.filter((r: Run) => r.type === 'training').map((r: Run) => `${ r.namespace }/${ r.name }`));

      return this.checkpoints.filter((k) => !runs.has(`${ k.namespace }/${ k.run }`) && (!this.filter.project || k.namespace === this.filter.project));
    },
    counts(): Record<string, number> {
      return {
        '':        this.all.length,
        training:  this.all.filter((x: Run) => x.type === 'training').length,
        inference: this.all.filter((x: Run) => x.type === 'inference').length,
      };
    },

    projects(): string[] {
      return [...new Set(this.all.map((r: Run) => r.namespace))].sort() as string[];
    },

    profileOptions(): { value: string; label: string }[] {
      const seen = new Map<string, string>();

      this.all.forEach((r: Run) => seen.set(r.profile || '(custom)', r.profile ? r.profileLabel : 'Custom (form)'));

      return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
    },

    shown(): Run[] {
      return sortRuns(filterRuns(this.all, { ...this.filter, type: this.tab }), this.sortKey, this.sortDesc);
    },

    paged(): { items: Run[]; page: number; pages: number; from: number; to: number } {
      return pageOf(this.shown, this.page, this.pageSize);
    },

    routes(): Record<string, any> {
      const params = { cluster: this.$route.params.cluster };

      return {
        submit:   { name: `c-cluster-${ PRODUCT_NAME }-${ SUBMIT_PAGE }`, params },
        training: {
          name: `c-cluster-${ PRODUCT_NAME }-${ PROFILES_PAGE }`, params
        },
        inference: {
          name: `c-cluster-${ PRODUCT_NAME }-${ PROFILES_PAGE }`, params, query: { type: 'inference' }
        },
      };
    },
  },

  watch: {
    // a filter change can leave the current page empty
    filter: {
      deep: true,
      handler() {
        this.page = 1;
      },
    },
    tab() {
      this.page = 1;
    },
  },

  methods: {
    async list(type: string): Promise<any[]> {
      if (!this.$store.getters['cluster/schemaFor'](type)) {
        return [];
      }
      try {
        return await this.$store.dispatch('cluster/findAll', { type, opt: { force: true } });
      } catch (e) {
        return [];
      }
    },

    async load() {
      if (this.refreshing) {
        return;
      }
      this.refreshing = true;
      try {
        const [jobs, pytorchJobs, kueueWorkloads, apps, pods, claimTemplates, aiWorkloads, blueprints, configMaps, pvcs, aiJobs] = await Promise.all([
          this.list(TYPES.JOB), this.list(TYPES.PYTORCH_JOB), this.list(TYPES.WORKLOAD), this.list(TYPES.APP), this.list(TYPES.POD),
          this.list(TYPES.RESOURCE_CLAIM_TEMPLATE), this.list(AIWORKLOAD_TYPE), this.list(BLUEPRINT_TYPE), this.list('configmap'),
          this.list(TYPES.PVC), this.list(AIJOB_TYPE),
        ]);

        this.raw = {
          jobs, pytorchJobs, kueueWorkloads, apps, pods, claimTemplates, aiWorkloads, blueprints, configMaps, pvcs, aiJobs
        };
      } catch (e: any) {
        this.error = `Could not list workloads: ${ e?.message || e }`;
      } finally {
        this.refreshing = false;
      }
    },

    tabRoute(t: string) {
      const query = { ...this.$route.query };

      if (t) {
        query.tab = t;
      } else {
        delete query.tab;
      }

      return { query };
    },

    sortBy(key: RunSortKey) {
      if (this.sortKey === key) {
        this.sortDesc = !this.sortDesc;
      } else {
        this.sortKey = key;
        this.sortDesc = key === 'created' || key === 'resources';
      }
    },

    ago(iso: string): string {
      return ago(iso, this.now);
    },

    stateClass(s: RunState): string {
      return ({
        Running: 'ok', Completed: 'done', Failed: 'bad', Degraded: 'warn', Queued: 'info', Pending: 'info', Deploying: 'info', Suspended: 'muted'
      } as Record<string, string>)[s] || 'muted';
    },

    toggleOpen(r: Run) {
      this.open = { ...this.open, [r.key]: !this.open[r.key] };
    },

    /**
     * The objects as the API server stores them (defaults, scheduler name and requests included), so
     * a training Job can be copied into Submit → YAML and re-applied. cleanForDownload strips
     * managedFields and the other bookkeeping that makes a manifest un-reappliable.
     */
    async fetchYaml(resource: any): Promise<string> {
      if (!resource?.hasLink?.('view')) {
        throw new Error('This resource does not expose a view link, so its YAML cannot be read.');
      }
      const res = await resource.followLink('view', { headers: { accept: 'application/yaml' } });

      return resource.cleanForDownload ? await resource.cleanForDownload(res.data) : res.data;
    },

    async showYaml(r: Run) {
      this.yaml = {
        open: true, title: `${ r.namespace }/${ r.name }`, docs: [], loading: true, error: ''
      };
      const docs: YamlDoc[] = [];

      try {
        const job = r.training?.job;
        const app = r.training?.app;

        if (job) {
          docs.push({
            label: job.kind || 'Job', yaml: await this.fetchYaml(job), filename: r.name, hint: 'The live object. Copy it into Submit → YAML → Kubernetes manifest to run a variant of this job.'
          });
        }
        if (app?.spec?.values) {
          docs.push({
            label: 'Helm values', yaml: saferDump(app.spec.values), filename: `${ r.name }-values`, hint: 'The values this run was installed with. Copy them into Submit → YAML → Helm values to rerun with tweaks.'
          });
        }
        if (r.inference?.workload) {
          docs.push({
            label: 'AIWorkload', yaml: await this.fetchYaml(r.inference.workload), filename: r.name, hint: 'The SUSE AI Factory workload. The operator renders its blueprint into Fleet HelmOps.'
          });
        }
        if (!docs.length) {
          this.yaml.error = 'Nothing to show: the Job has been cleaned up and the Helm release records no values.';
        }
        this.yaml.docs = docs;
      } catch (e: any) {
        this.yaml.error = e?.message || String(e);
      } finally {
        this.yaml.loading = false;
      }
    },

    toggleMenu(r: Run) {
      this.menuFor = this.menuFor === r.key ? '' : r.key;
    },

    closeMenus() {
      this.menuFor = '';
      this.newOpen = false;
    },

    async copy(text: string) {
      try {
        await navigator.clipboard.writeText(text);
        this.notice = `Copied ${ text }`;
      } catch (e) {
        this.notice = text;
      }
      this.menuFor = '';
    },

    // Rancher's own confirmation dialog: Helm uninstall for a training release, delete for an
    // AIWorkload (the AI Factory operator then removes what its blueprint installed).
    checkpointOf(r: Run): CheckpointVolume | null {
      return r.type === 'training' ? this.checkpoints.find((k) => k.run === r.name && k.namespace === r.namespace) || null : null;
    },
    /** Rancher's own confirmation dialog, as for a run; the volume's data goes with it. */
    removeCheckpoint(k: CheckpointVolume) {
      if (!k.obj?.promptRemove) {
        return;
      }
      k.obj.promptRemove();
      const off = this.$store.watch((st: any) => st['action-menu']?.showPromptRemove, (shown: boolean) => {
        if (!shown) {
          off();
          setTimeout(() => this.load(), 1500);
        }
      });
    },
    remove(r: Run) {
      this.menuFor = '';
      if (!r.obj?.promptRemove) {
        return;
      }
      r.obj.promptRemove();
      const off = this.$store.watch((st: any) => st['action-menu']?.showPromptRemove, (shown: boolean) => {
        if (!shown) {
          off();
          setTimeout(() => this.load(), 1500);
        }
      });
    },
  },
});
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <div
    v-else
    :class="['tj-workloads', { embedded: fixedTab }]"
  >
    <!-- Laid out like Profiles, Apps and Blueprints: title, then one toolbar row of search, filters
         and actions. Embedded as the Workloads page's Training tab, the toolbar moves into that
         page's header, above its tabs. -->
    <header
      v-if="!fixedTab"
      class="fixed-header"
    >
      <h1>{{ t('trainingjobs.endpoints.title') }}</h1>
    </header>
    <Teleport
      defer
      to="#workloads-toolbar"
      :disabled="!fixedTab"
    >
      <div
        class="actions-container tj-toolbar"
        role="toolbar"
      >
        <div class="search-box">
          <input
            v-model="filter.text"
            type="search"
            class="input-sm"
            placeholder="Search runs"
            aria-label="Search runs"
          >
        </div>
        <select
          v-model="filter.project"
          class="sort-select form-control-sm"
          aria-label="Project"
        >
          <option value="">
            All projects
          </option>
          <option
            v-for="p in projects"
            :key="p"
            :value="p"
          >
            {{ p }}
          </option>
        </select>
        <select
          v-model="filter.profile"
          class="sort-select form-control-sm"
          aria-label="Profile"
        >
          <option value="">
            All profiles
          </option>
          <option
            v-for="p in profileOptions"
            :key="p.value"
            :value="p.value"
          >
            {{ p.label }}
          </option>
        </select>
        <select
          v-model="filter.state"
          class="sort-select form-control-sm"
          aria-label="State"
        >
          <option value="">
            All states
          </option>
          <option
            v-for="s in states"
            :key="s"
            :value="s"
          >
            {{ s }}
          </option>
        </select>
        <div
          class="tj-new ml-auto"
          @click.stop
        >
          <button
            class="btn role-primary"
            type="button"
            @click="newOpen = !newOpen"
          >
            <i class="icon icon-plus" /> New run <i class="icon icon-chevron-down" />
          </button>
          <ul
            v-if="newOpen"
            class="tj-menu tj-menu-right"
          >
            <li>
              <router-link :to="routes.training">
                Training run from a profile
              </router-link>
            </li>
            <li>
              <router-link :to="routes.inference">
                Inference endpoint from a profile
              </router-link>
            </li>
            <li>
              <router-link :to="routes.submit">
                Custom training job (full form)
              </router-link>
            </li>
          </ul>
        </div>
        <button
          class="btn role-secondary"
          type="button"
          :disabled="refreshing"
          @click="load()"
        >
          <i :class="['icon', refreshing ? 'icon-spinner icon-spin' : 'icon-refresh']" />
          Refresh
        </button>
      </div>
    </Teleport>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <Banner
      v-if="notice"
      color="info"
      :label="notice"
      :closable="true"
      @close="notice = ''"
    />

    <div
      v-if="!fixedTab"
      class="tj-tabs"
    >
      <router-link
        v-for="tb in [{ key: '', label: 'All' }, { key: 'training', label: 'Training' }, { key: 'inference', label: 'Inference' }]"
        :key="tb.key"
        :to="tabRoute(tb.key)"
        :class="['tj-tab', { active: tab === tb.key }]"
      >
        {{ tb.label }} ({{ counts[tb.key] }})
      </router-link>
    </div>


    <p
      v-if="!all.length"
      class="text-muted"
    >
      Nothing is running yet. Start a training run or an inference endpoint with New run.
    </p>
    <p
      v-else-if="!shown.length"
      class="text-muted"
    >
      No runs match the filters.
    </p>

    <table
      v-else
      class="tj-table"
    >
      <thead>
        <tr>
          <th
            v-for="c in columns"
            :key="c.key"
            :class="['tj-sortable', { sorted: sortKey === c.key }]"
            @click="sortBy(c.key)"
          >
            {{ c.label }}
            <i
              v-if="sortKey === c.key"
              :class="['icon', sortDesc ? 'icon-chevron-down' : 'icon-chevron-up']"
            />
          </th>
          <th class="tj-actions-col" />
        </tr>
      </thead>
      <tbody>
        <template
          v-for="r in paged.items"
          :key="r.key"
        >
          <tr :class="{ 'tj-open': open[r.key] }">
            <td>
              <a
                href="#"
                class="tj-name"
                :aria-expanded="!!open[r.key]"
                @click.prevent="toggleOpen(r)"
              ><i :class="['icon', open[r.key] ? 'icon-chevron-down' : 'icon-chevron-right', 'tj-chev']" />{{ r.name }}</a>
            </td>
            <td>{{ r.type === 'training' ? 'Training' : 'Endpoint' }}</td>
            <td>{{ r.profileLabel }}</td>
            <td>{{ r.namespace }}</td>
            <td>{{ r.resources }}</td>
            <td>
              <span :class="['tj-state', stateClass(r.state)]"><i class="tj-dot" />{{ r.state }}</span>
            </td>
            <td :title="r.created">
              {{ ago(r.created) }}
            </td>
            <td
              class="tj-actions-col"
              @click.stop
            >
              <button
                class="btn role-link btn-sm"
                aria-label="Actions"
                @click="toggleMenu(r)"
              >
                <i class="icon icon-actions" />
              </button>
              <ul
                v-if="menuFor === r.key"
                class="tj-menu tj-menu-right"
              >
                <li>
                  <a
                    href="#"
                    @click.prevent="toggleOpen(r); menuFor = ''"
                  >{{ open[r.key] ? 'Hide details' : 'Show details' }}</a>
                </li>
                <li v-if="r.url">
                  <a
                    href="#"
                    @click.prevent="copy(r.url)"
                  >Copy endpoint URL</a>
                </li>
                <li>
                  <a
                    href="#"
                    class="text-error"
                    @click.prevent="remove(r)"
                  >Delete</a>
                </li>
              </ul>
            </td>
          </tr>
          <tr
            v-if="open[r.key]"
            class="tj-detail-row"
          >
            <td :colspan="columns.length + 1">
              <RunDetail
                :run="r"
                :checkpoint="checkpointOf(r)"
                @yaml="showYaml"
                @remove="remove"
                @copy="copy"
                @remove-checkpoint="removeCheckpoint"
              />
            </td>
          </tr>
        </template>
      </tbody>
    </table>

    <div
      v-if="shown.length"
      class="tj-pager"
    >
      <span class="text-muted">{{ paged.from }}–{{ paged.to }} of {{ shown.length }} runs</span>
      <div class="tj-pages">
        <button
          class="btn role-secondary btn-sm"
          :disabled="paged.page <= 1"
          aria-label="Previous page"
          @click="page = paged.page - 1"
        >
          <i class="icon icon-chevron-left" />
        </button>
        <button
          v-for="n in paged.pages"
          :key="n"
          :class="['btn', 'btn-sm', n === paged.page ? 'role-primary' : 'role-secondary']"
          @click="page = n"
        >
          {{ n }}
        </button>
        <button
          class="btn role-secondary btn-sm"
          :disabled="paged.page >= paged.pages"
          aria-label="Next page"
          @click="page = paged.page + 1"
        >
          <i class="icon icon-chevron-right" />
        </button>
        <select
          v-model.number="pageSize"
          aria-label="Rows per page"
          @change="page = 1"
        >
          <option :value="10">
            10 / page
          </option>
          <option :value="25">
            25 / page
          </option>
          <option :value="50">
            50 / page
          </option>
        </select>
      </div>
    </div>

    <section
      v-if="orphanCheckpoints.length"
      class="tj-orphans"
    >
      <h3>Kept checkpoint volumes without a run</h3>
      <p class="text-muted">
        Outputs of runs that have been removed. They stay until deleted; deleting one deletes its data.
      </p>
      <table class="tj-table">
        <thead>
          <tr>
            <th>Volume</th><th>Run</th><th>Project</th><th>Size</th><th>Storage class</th><th>Created</th><th />
          </tr>
        </thead>
        <tbody>
          <template
            v-for="k in orphanCheckpoints"
            :key="k.namespace + '/' + k.name"
          >
            <tr>
              <td>{{ k.name }}</td>
              <td>{{ k.run }}</td>
              <td>{{ k.namespace }}</td>
              <td>{{ k.size }}</td>
              <td>{{ k.storageClass || '—' }}</td>
              <td>{{ k.created }}</td>
              <td class="tj-right">
                <button
                  class="btn role-tertiary btn-sm"
                  type="button"
                  :disabled="k.inUseBy.length > 0"
                  :aria-expanded="browsingVolume === k.namespace + '/' + k.name"
                  :title="k.inUseBy.length ? `In use by ${ k.inUseBy.join(', ') }` : 'List the files on the volume, and download them'"
                  @click="browsingVolume = browsingVolume === k.namespace + '/' + k.name ? '' : k.namespace + '/' + k.name"
                >
                  <i class="icon icon-folder" /> {{ browsingVolume === k.namespace + '/' + k.name ? 'Hide files' : 'Browse files' }}
                </button>
                <button
                  class="btn role-tertiary btn-sm"
                  :disabled="k.inUseBy.length > 0"
                  :title="k.inUseBy.length ? `In use by ${ k.inUseBy.join(', ') }` : 'Delete the volume and its data'"
                  @click="removeCheckpoint(k)"
                >
                  <i class="icon icon-delete" /> Delete
                </button>
              </td>
            </tr>
            <tr v-if="browsingVolume === k.namespace + '/' + k.name">
              <td colspan="7">
                <VolumeFiles :checkpoint="k" />
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </section>

    <YamlViewer
      v-if="yaml.open"
      :title="yaml.title"
      :docs="yaml.docs"
      :loading="yaml.loading"
      :error="yaml.error"
      @close="yaml.open = false"
    />
  </div>
</template>

<style lang="scss" scoped>
.tj-orphans { margin-top: 28px; h3 { margin-bottom: 4px; } }

.tj-workloads { padding: 12px 20px 20px; &.embedded { padding: 0; } }
.tj-new { position: relative; }
.tj-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 14px; }
.tj-tab { padding: 8px 16px; border-bottom: 2px solid transparent; color: var(--body-text); text-decoration: none;
  &.active { border-bottom-color: var(--primary); color: var(--primary); font-weight: 600; } }
.tj-table { width: 100%; border-collapse: collapse;
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  th { font-weight: 600; font-size: 13px; white-space: nowrap; } }
.tj-sortable { cursor: pointer; user-select: none; &.sorted { color: var(--primary); } .icon { font-size: 10px; } }
.tj-name { font-weight: 600; }
.tj-chev { font-size: 10px; margin-right: 6px; color: var(--muted); }
.tj-open td { border-bottom: none; }
.tj-detail-row > td { padding: 0 0 10px; }
.tj-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 2px 10px; border-radius: 10px; background: var(--border);
  &.ok { background: var(--success-banner-bg); color: var(--success); }
  &.done { background: var(--success-banner-bg); color: var(--success); opacity: 0.8; }
  &.bad { background: var(--error-banner-bg); color: var(--error); }
  &.warn { background: var(--warning-banner-bg); color: var(--warning); }
  &.info { background: var(--info-banner-bg); color: var(--info); }
  &.muted { color: var(--muted); } }
.tj-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; display: inline-block; }
.tj-actions-col { width: 48px; text-align: right; position: relative; }
.tj-menu { position: absolute; z-index: 20; list-style: none; margin: 4px 0 0; padding: 4px 0; min-width: 220px; background: var(--dropdown-bg, var(--body-bg)); border: 1px solid var(--border); border-radius: var(--border-radius); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12); text-align: left;
  li a { display: block; padding: 6px 14px; white-space: nowrap; }
  li a:hover { background: var(--dropdown-hover-bg, var(--border)); text-decoration: none; } }
.tj-menu-right { right: 0; }
.tj-pager { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; flex-wrap: wrap; gap: 10px; }
.tj-pages { display: flex; gap: 6px; align-items: center; select { width: auto; height: 32px; padding: 0 8px; } }
.tj-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 20px;
  .search-box .input-sm {
    width: 200px;
    height: 32px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: var(--border-radius);
    background: var(--input-bg);
    color: var(--body-text);
    font-size: 14px;
  }
  .sort-select {
    height: 30px;
    padding: 0 6px 0 8px;
    border: 1px solid var(--border);
    border-radius: var(--border-radius);
    background: var(--input-bg);
    color: var(--body-text);
    font-size: 13px;
    width: auto;
  }
  .ml-auto { margin-left: auto; }
}
</style>
