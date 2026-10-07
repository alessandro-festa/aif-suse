<script lang="ts">
import { defineComponent } from 'vue';
import ActionMenuShell from '@shell/components/ActionMenuShell.vue';
import Loading from '@shell/components/Loading.vue';
import StatusPill from '../components/StatusPill.vue';
import Banner from '@components/Banner/Banner.vue';
import jsyaml from 'js-yaml';
import { DEPLOY_PAGE, ENDPOINT_PAGE, INFERENCE_PROFILE_PAGE, PRODUCT_NAME, SUBMIT_PAGE } from '../config';
import { BlueprintSummary, findBlueprint, summarizeBlueprint } from '../inference';
import {
  filterOptions, filterProfiles, NO_FILTER, Profile, PROFILE_KEY, PROFILE_LABEL, PROFILE_NAMESPACE, ProfileFilter, profilesFrom,
  ProfileType
} from '../profiles';
import { localBlueprints, localProfileConfigMaps } from '../placement';

const TABS: { type: ProfileType; label: string; subtitle: string }[] = [
  {
    type: 'training', label: 'Training', subtitle: 'Standardised environments for training and fine-tuning models.'
  },
  {
    type: 'inference', label: 'Inference', subtitle: 'Standardised environments for deploying model inference endpoints.'
  },
];

export default defineComponent({
  name: 'TrainingJobProfiles',
  // Set when the page is the Compute Profiles tab of Settings, which carries the title.
  props: { embedded: { type: Boolean, default: false } },

  components: { StatusPill, ActionMenuShell, Loading, Banner },

  data() {
    return {
      profiles:   [] as Profile[],
      error:      '' as string,
      // Publishing profiles is the platform admin's job; a user who cannot write them never sees
      // Create or Edit.
      canWrite:   false,
      filter:     { ...NO_FILTER } as ProfileFilter,
      // AI Factory blueprints, for what an inference profile deploys (model, GPUs, replicas)
      blueprints: [] as any[],
    };
  },

  async fetch() {
    try {
      // Profiles and Blueprints live on local, whatever cluster this page was opened on (a Deploy
      // into a pool moves the browser to the pool's cluster).
      const [cms, blueprints] = await Promise.all([localProfileConfigMaps(this.$store), localBlueprints(this.$store).catch(() => [])]);

      this.profiles = profilesFrom(cms, (s: string) => jsyaml.load(s));
      this.blueprints = blueprints;
    } catch (e: any) {
      this.error = `Could not list ConfigMaps: ${ e?.message || e }`;
    }
    this.canWrite = await this.canCreateProfiles();
  },

  computed: {
    profileNamespace: () => PROFILE_NAMESPACE,
    /** Managing profiles (the Compute Profiles tab of Settings) rather than choosing one to deploy. */
    managing(): boolean {
      return this.embedded && this.canWrite;
    },
    profileLabel:     () => PROFILE_LABEL,
    profileKey:       () => PROFILE_KEY,
    tabs:             () => TABS,

    // The tab is in the URL so a link can open Inference directly, and Back returns to the same tab.
    type(): ProfileType {
      return this.$route.query.type === 'inference' ? 'inference' : 'training';
    },

    tab(): { type: ProfileType; label: string; subtitle: string } {
      return TABS.find((t) => t.type === this.type) || TABS[0];
    },

    ofType(): Profile[] {
      return this.profiles.filter((p: Profile) => p.type === this.type);
    },

    visible(): Profile[] {
      return filterProfiles(this.profiles, this.type, this.filter);
    },

    frameworks(): string[] {
      return filterOptions(this.profiles, this.type, 'framework');
    },

    gpus(): string[] {
      return filterOptions(this.profiles, this.type, 'gpu');
    },

    filtered(): boolean {
      const f = this.filter as ProfileFilter;

      return !!(f.text || f.framework || f.gpu || f.status);
    },
  },

  watch: {
    // options differ per tab, so a framework picked on one tab would silently hide everything on the other
    type() {
      this.filter = { ...NO_FILTER };
    },
  },

  methods: {
    // Like the Blueprints tiles: the main action on the tile, the rest under its menu: the form editor
    // for its type, or the ConfigMap it is as YAML.
    tileActions(p: Profile): any[] {
      if (!this.canWrite) {
        return [];
      }

      return [
        ...(this.managing ? [] : [{ action: 'edit', label: 'Edit', enabled: true }]),
        { action: 'yaml', label: 'Edit YAML', enabled: true },
      ];
    },
    onTileAction(payload: { action: string }, p: Profile) {
      if (payload.action === 'edit') {
        this.$router.push(this.editRoute(p));
      } else if (payload.action === 'yaml') {
        this.$router.push({
          name:   'c-cluster-product-resource-namespace-id',
          params: {
            cluster: this.$route.params.cluster, product: 'explorer', resource: 'configmap', namespace: PROFILE_NAMESPACE, id: p.name
          },
          query: { mode: 'edit', as: 'yaml' },
        });
      }
    },
    refresh() {
      (this as any).$fetch(); // the shell's fetch mixin, not in the component's types
    },
    countOf(type: ProfileType): number {
      return this.profiles.filter((p: Profile) => p.type === type).length;
    },

    tabRoute(type: ProfileType) {
      return { query: { ...this.$route.query, type } };
    },

    clearFilter() {
      this.filter = { ...NO_FILTER };
    },

    async canCreateProfiles(): Promise<boolean> {
      try {
        const res = await this.$store.dispatch('cluster/request', {
          url:    `/k8s/clusters/${ encodeURIComponent(String(this.$route.params.cluster)) }/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`,
          method: 'POST',
          data:   {
            apiVersion: 'authorization.k8s.io/v1',
            kind:       'SelfSubjectAccessReview',
            spec:       {
              resourceAttributes: {
                verb: 'create', resource: 'configmaps', namespace: PROFILE_NAMESPACE
              }
            },
          },
        });

        return !!res?.status?.allowed;
      } catch (e) {
        return false;
      }
    },

    /** The form editor for a profile of either type. */
    editRoute(p: Profile) {
      return p.type === 'inference' ? this.inferenceRoute(p.name) : this.authorRoute(p.name);
    },
    inferenceRoute(name: string) {
      return {
        name:   `c-cluster-${ PRODUCT_NAME }-${ INFERENCE_PROFILE_PAGE }`,
        params: { cluster: this.$route.params.cluster },
        query:  name ? { profile: name } : {},
      };
    },
    authorRoute(name: string) {
      return {
        name:   `c-cluster-${ PRODUCT_NAME }-${ SUBMIT_PAGE }`,
        params: { cluster: this.$route.params.cluster },
        query:  { authorProfile: name },
      };
    },

    bp(p: Profile): BlueprintSummary | null {
      const obj = p.blueprint ? findBlueprint(this.blueprints, p.blueprint) : null;

      return p.blueprint && obj ? summarizeBlueprint(obj, p.blueprint) : null;
    },

    deployRoute(p: Profile) {
      return {
        name:   `c-cluster-${ PRODUCT_NAME }-${ p.type === 'inference' ? ENDPOINT_PAGE : DEPLOY_PAGE }`,
        params: { cluster: this.$route.params.cluster },
        query:  { profile: p.name },
      };
    },

    scale(p: Profile): string {
      if (p.type === 'inference') {
        const s = this.bp(p);

        return s ? `${ s.replicas } replica${ s.replicas === 1 ? '' : 's' } × ${ s.gpusPerReplica } GPU · runs until deleted` : `Blueprint ${ p.blueprint?.name || '?' } ${ p.blueprint?.version || '' } not found in this cluster`;
      }
      const n = p.limits.nodes;
      const workers = n ? (n.min === n.max ? `${ n.min } worker${ n.min === 1 ? '' : 's' }` : `${ n.min }–${ n.max } workers`) : `${ p.form.nodes } worker${ p.form.nodes === 1 ? '' : 's' }`;

      return p.form.gpusPerNode === 0 && !(p.form.gpuShareMiB > 0) ? `${ workers } · CPU only` : `${ workers } × ${ p.form.gpusPerNode } GPU`;
    },

    badges(p: Profile): string[] {
      if (p.type === 'inference') {
        const s = this.bp(p);

        return [p.framework, s?.model.split('/').pop() || '', p.gpu, s?.dra ? 'DRA' : '', s?.gateway ? 'LiteLLM gateway' : '', 'OpenAI API'].filter(Boolean);
      }

      return [
        p.framework,
        p.gpu,
        p.form.kind === 'pytorchjob' ? 'PyTorchJob' : '',
        p.form.scratchSize ? `scratch ${ p.form.scratchSize }` : '',
        p.form.gpuShareMiB > 0 ? `shared GPU ${ (p.form.gpuShareMiB / 1024).toFixed(1).replace(/\.0$/, '') } GiB` : '',
        p.limits.maxRuntimeHours ? `max ${ p.limits.maxRuntimeHours } h` : '',
      ].filter(Boolean);
    },
  },
});
</script>

<template>
  <main class="main-layout">
    <div class="outlet">
      <!-- Laid out like Apps and Blueprints: title, then one toolbar row of search, filters and actions. -->
      <header class="fixed-header">
        <h1 v-if="!embedded">
          {{ t('trainingjobs.profiles.title') }}
        </h1>
        <div
          class="actions-container"
          role="toolbar"
        >
          <div class="search-box">
            <input
              v-model="filter.text"
              type="search"
              placeholder="Search profiles"
              class="input-sm"
              aria-label="Search profiles"
            >
          </div>
          <select
            v-model="filter.framework"
            class="sort-select form-control-sm"
            aria-label="Framework"
          >
            <option value="">
              All frameworks
            </option>
            <option
              v-for="f in frameworks"
              :key="f"
              :value="f"
            >
              {{ f }}
            </option>
          </select>
          <select
            v-model="filter.gpu"
            class="sort-select form-control-sm"
            aria-label="GPU type"
          >
            <option value="">
              All GPU types
            </option>
            <option
              v-for="g in gpus"
              :key="g"
              :value="g"
            >
              {{ g }}
            </option>
          </select>
          <select
            v-model="filter.status"
            class="sort-select form-control-sm"
            aria-label="Status"
          >
            <option value="">
              All statuses
            </option>
            <option value="ready">
              Ready
            </option>
            <option value="beta">
              Beta
            </option>
          </select>
          <router-link
            v-if="canWrite"
            :to="type === 'inference' ? inferenceRoute('') : authorRoute('new')"
            class="btn role-primary ml-auto"
          >
            Create
          </router-link>
          <button
            :class="['btn role-secondary', { 'ml-auto': !canWrite }]"
            :disabled="$fetchState.pending"
            type="button"
            @click="refresh"
          >
            <i
              v-if="$fetchState.pending"
              class="icon icon-spinner icon-spin"
            />
            <i
              v-else
              class="icon icon-refresh"
            />
            Refresh
          </button>
        </div>
      </header>

      <Banner
        v-if="error"
        color="error"
        :label="error"
      />

      <nav
        class="profile-tabs"
        aria-label="Profile type"
      >
        <router-link
          v-for="tb in tabs"
          :key="tb.type"
          :to="tabRoute(tb.type)"
          :class="['profile-tab', { active: tb.type === type }]"
        >
          {{ tb.label }} <span class="tab-count">{{ countOf(tb.type) }}</span>
        </router-link>
      </nav>

      <div class="main-content">
        <Loading v-if="$fetchState.pending && !profiles.length" />
        <p
          v-if="ofType.length && !visible.length"
          class="text-muted"
        >
          No profiles match. <a
            href="#"
            @click.prevent="clearFilter"
          >Clear filters</a>
        </p>

        <div
          v-if="!$fetchState.pending && !ofType.length && type === 'inference'"
          class="empty-state-content"
        >
          <i class="icon icon-folder-open icon-4x text-muted" />
          <h3>No inference profiles yet</h3>
          <p class="text-muted">
            An inference profile deploys a SUSE AI Factory blueprint, such as SUSE Inference Endpoint, with
            the model, GPUs and limits the platform team has chosen. It is a ConfigMap in
            <code>{{ profileNamespace }}</code> labelled <code>{{ profileLabel }}=inference</code>.
          </p>
        </div>

        <div
          v-if="!$fetchState.pending && !ofType.length && type === 'training'"
          class="empty-state-content"
        >
          <i class="icon icon-folder-open icon-4x text-muted" />
          <h3>No training profiles yet</h3>
          <p class="text-muted">
            A profile is a ConfigMap in <code>{{ profileNamespace }}</code> labelled
            <code>{{ profileLabel }}=training</code>, with the profile in its <code>{{ profileKey }}</code> key.
            The samples, and the Role that lets every signed-in user read them, are in
            <code>examples/training/profiles/</code>.
          </p>
        </div>

        <div
          class="tiles-grid"
          role="grid"
        >
          <div
            v-for="p in visible"
            :key="p.name"
            class="app-tile"
          >
            <div class="tile-header">
              <div class="tile-info">
                <div class="tile-title-row">
                  <h3 class="tile-title">
                    {{ p.displayName }}
                  </h3>
                  <StatusPill :status="p.status" />
                </div>
                <div class="tile-meta">
                  <span class="tile-meta-item">{{ scale(p) }}</span>
                  <template
                    v-for="b in badges(p)"
                    :key="b"
                  >
                    <span class="tile-meta-sep">·</span>
                    <span class="tile-meta-item">{{ b }}</span>
                  </template>
                </div>
              </div>
            </div>

            <div class="tile-content">
              <p class="tile-description">
                {{ p.description || '—' }}
              </p>
              <Banner
                v-if="p.problems.length"
                color="warning"
                :label="p.problems.join(' · ')"
              />
              <details class="tile-contract">
                <summary class="text-muted">
                  What you set, what the profile sets
                </summary>
                <template v-if="p.type === 'inference'">
                  <p><b>You set:</b> project, endpoint name</p>
                  <p><b>Set by the profile:</b> blueprint {{ p.blueprint ? `${ p.blueprint.name } ${ p.blueprint.version }` : '?' }} — model, GPUs, replicas, model cache</p>
                </template>
                <template v-else>
                  <p><b>You set:</b> project, run name{{ p.editable.length ? ', ' + p.editable.join(', ') : '' }}</p>
                  <p><b>Fixed by the profile:</b> {{ p.fixed.filter(f => !p.editable.includes(f)).join(', ') || 'nothing beyond the chart defaults' }}</p>
                </template>
                <p v-if="p.limits.registries && p.limits.registries.length">
                  <b>Allowed image registries:</b> {{ p.limits.registries.join(', ') }}
                </p>
              </details>
            </div>

            <div class="tile-footer">
              <!-- In Settings profiles are managed, not deployed: Edit is the tile's action there. -->
              <router-link
                v-if="managing"
                :to="editRoute(p)"
                class="btn role-primary btn-sm"
              >
                Edit
              </router-link>
              <router-link
                v-else
                :to="deployRoute(p)"
                class="btn role-primary btn-sm"
              >
                Deploy
              </router-link>
              <div
                v-if="tileActions(p).length"
                class="tile-menu"
              >
                <ActionMenuShell
                  button-variant="tertiary"
                  button-aria-label="More options"
                  :custom-actions="tileActions(p)"
                  @action-invoked="onTileAction($event, p)"
                />
              </div>
            </div>
          </div>
          <div
            v-for="n in 5"
            :key="`filler-${ n }`"
            class="app-tile app-tile-filler"
          />
        </div>
      </div>
    </div>
  </main>
</template>

<style lang="scss" scoped>
// The same header, toolbar and tiles as the Apps and Blueprints pages.
.fixed-header {
  margin-bottom: 20px;
  .actions-container {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
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
}
.profile-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 20px;
}
.profile-tab {
  padding: 8px 16px;
  border-bottom: 2px solid transparent;
  color: var(--body-text);
  text-decoration: none;

  &.active { border-bottom-color: var(--primary); color: var(--primary); }
}
.tab-count { font-size: 11px; padding: 0 6px; border-radius: 8px; background: var(--border); color: var(--body-text); margin-left: 4px; }
.tiles-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 20px;
}
.app-tile {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 20px;
  gap: 12px;
  min-height: 200px;
  background: transparent;
  transition: border-color 0.2s ease, background 0.2s ease;
  &:hover { border-color: var(--primary); }
  .tile-header { display: flex; align-items: flex-start; }
  .tile-info { flex: 1; }
  .tile-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .tile-title { margin: 0; font-size: 14px; font-weight: 600; }
  .tile-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
    margin-top: 4px;
  }
  .tile-meta-sep { opacity: 0.5; }
  .tile-content { flex: 1; display: flex; flex-direction: column; gap: 8px; }
  .tile-description {
    margin: 0;
    font-size: 14px;
    color: var(--body-text);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
  }
  .tile-contract { font-size: 12px; p { margin: 4px 0; } }
  .tile-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .tile-menu { margin-left: auto; }
}
.app-tile-filler { visibility: hidden; }
.empty-state-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 60px 20px;
  max-width: 760px;
  margin: 0 auto;
  .icon-4x { font-size: 64px; opacity: 0.5; margin-bottom: 20px; }
}
</style>
