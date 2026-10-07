<script lang="ts">
// Create or edit an inference profile: the blueprint and version it deploys, how it is shown on the
// Profiles page, and the Secrets a project must have before deploying it. Saved as the profile's
// ConfigMap in the profile namespace, the same object the Profiles and Deploy pages read.
import { defineComponent } from 'vue';
import jsyaml from 'js-yaml';
import Loading from '@shell/components/Loading.vue';
import Banner from '@components/Banner/Banner.vue';
import LabeledInput from '@components/Form/LabeledInput/LabeledInput.vue';
import LabeledSelect from '@shell/components/form/LabeledSelect.vue';
import AsyncButton from '@shell/components/AsyncButton.vue';
import StatusPill from '../components/StatusPill.vue';
import { PRODUCT_NAME, PROFILES_PAGE } from '../config';
import {
  InferenceProfileDraft, PROFILE_NAMESPACE, inferenceDraftFrom, inferenceProfileDocument, inferenceProfileErrors,
  profileConfigMap, profilesFrom
} from '../profiles';
import {
  BLUEPRINT_NAME_LABEL, BLUEPRINT_VERSION_LABEL, BlueprintSummary, findBlueprint, summarizeBlueprint
} from '../inference';
import { gib } from '../gpushare';
import { localBlueprints } from '../placement';

const emptyDraft = (): InferenceProfileDraft => ({
  meta: {
    name: '', displayName: '', description: '', framework: '', gpu: '', status: 'beta'
  },
  blueprint:       { name: '', version: '' },
  requiredSecrets: [],
});

export default defineComponent({
  name:       'InferenceProfile',
  components: {
    Loading, Banner, LabeledInput, LabeledSelect, AsyncButton, StatusPill
  },

  data() {
    return {
      draft:      emptyDraft(),
      existing:   false,
      blueprints: [] as any[],
      canWrite:   false,
      error:      '',
      notFound:   '',
    };
  },

  async fetch() {
    const name = String(this.$route.query.profile || '');

    this.blueprints = await localBlueprints(this.$store).catch(() => []);
    if (name) {
      const cms = await this.$store.dispatch('cluster/findAll', { type: 'configmap', opt: { force: true } }).catch(() => []);
      const p = profilesFrom(cms, (s: string) => jsyaml.load(s)).find((x) => x.name === name && x.type === 'inference');

      if (p) {
        this.draft = inferenceDraftFrom(p);
        this.existing = true;
      } else {
        this.notFound = `No inference profile named ${ name }.`;
      }
    }
    this.canWrite = await this.canWriteProfiles();
  },

  computed: {
    title(): string {
      return this.existing ? `Edit inference profile ${ this.draft.meta.displayName || this.draft.meta.name }` : 'Create an inference profile';
    },
    /** Blueprint families in the cluster, by the operator's name label. */
    families(): { value: string; label: string }[] {
      const by: Record<string, string> = {};

      for (const b of this.blueprints) {
        const n = b?.metadata?.labels?.[BLUEPRINT_NAME_LABEL];

        if (n && !by[n]) {
          by[n] = String(b?.spec?.displayName || n);
        }
      }

      return Object.entries(by).map(([value, label]) => ({ value, label: `${ label } (${ value })` })).sort((a, b) => a.label.localeCompare(b.label));
    },
    versions(): string[] {
      return this.blueprints
        .filter((b: any) => b?.metadata?.labels?.[BLUEPRINT_NAME_LABEL] === this.draft.blueprint.name)
        .map((b: any) => String(b?.metadata?.labels?.[BLUEPRINT_VERSION_LABEL] || b?.spec?.version || ''))
        .filter(Boolean)
        .sort((a: string, b: string) => b.localeCompare(a, undefined, { numeric: true }));
    },
    summary(): BlueprintSummary | null {
      const ref = this.draft.blueprint;
      const bp = ref.name && ref.version ? findBlueprint(this.blueprints, ref) : null;

      return bp ? summarizeBlueprint(bp, ref) : null;
    },
    gpuText(): string {
      const s = this.summary;

      if (!s) {
        return '';
      }
      if (s.kaiMemoryMiB) {
        return `${ gib(s.kaiMemoryMiB) } of a GPU per replica (KAI share)`;
      }
      if (s.mpsLimitMiB) {
        return `${ gib(s.mpsLimitMiB) } of a shared GPU per replica (MPS)`;
      }

      return `${ s.gpusPerReplica || 0 } GPU per replica${ s.dra ? ' (DRA)' : '' }`;
    },
    errors(): string[] {
      return inferenceProfileErrors(this.draft);
    },
    profilesRoute(): any {
      return { name: `c-cluster-${ PRODUCT_NAME }-${ PROFILES_PAGE }`, params: { cluster: this.$route.params.cluster }, query: { type: 'inference' } };
    },
  },

  watch: {
    // a new blueprint starts at its newest version
    'draft.blueprint.name'(n: string, old: string) {
      if (n !== old && !this.versions.includes(this.draft.blueprint.version)) {
        this.draft.blueprint.version = this.versions[0] || '';
      }
    },
  },

  methods: {
    gib,
    addSecret() {
      this.draft.requiredSecrets.push({ name: '', hint: '' });
    },
    removeSecret(i: number) {
      this.draft.requiredSecrets.splice(i, 1);
    },
    async canWriteProfiles(): Promise<boolean> {
      try {
        const res = await this.$store.dispatch('cluster/request', {
          url:    `/k8s/clusters/${ encodeURIComponent(String(this.$route.params.cluster)) }/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`,
          method: 'POST',
          data:   {
            apiVersion: 'authorization.k8s.io/v1',
            kind:       'SelfSubjectAccessReview',
            spec:       { resourceAttributes: { verb: this.existing ? 'update' : 'create', resource: 'configmaps', namespace: PROFILE_NAMESPACE } },
          },
        });

        return !!res?.status?.allowed;
      } catch (e) {
        return false;
      }
    },
    async save(done: (ok: boolean) => void) {
      this.error = '';
      if (this.errors.length || !this.canWrite) {
        done(false);

        return;
      }
      try {
        const body = profileConfigMap(this.draft.meta, inferenceProfileDocument(this.draft), (o: any) => jsyaml.dump(o, { lineWidth: -1 }), 'inference');
        const id = `${ PROFILE_NAMESPACE }/${ this.draft.meta.name }`;
        let cm = this.$store.getters['cluster/byId']('configmap', id) || await this.$store.dispatch('cluster/find', { type: 'configmap', id }).catch(() => null);

        if (cm && !this.existing) {
          throw new Error(`A profile named ${ this.draft.meta.name } already exists. Choose another name.`);
        }
        if (cm) {
          cm.data = body.data;
          cm.metadata.labels = { ...(cm.metadata.labels || {}), ...body.metadata.labels };
        } else {
          cm = await this.$store.dispatch('cluster/create', body);
        }
        await cm.save();
        done(true);
        this.$router.push(this.profilesRoute);
      } catch (e: any) {
        this.error = e?.message || e?._statusText || String(e);
        done(false);
      }
    },
  },
});
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <main
    v-else
    class="inference-profile"
  >
    <nav class="ip-crumbs">
      <router-link :to="profilesRoute">
        Profiles
      </router-link> › Inference
    </nav>
    <h1>
      {{ title }}
      <StatusPill
        v-if="draft.meta.status === 'beta'"
        status="beta"
        size="lg"
      />
    </h1>
    <p class="text-muted">
      An inference profile deploys a blueprint, with the model, GPUs and limits it sets, into the project the
      user picks. Users choose a project and an endpoint name; everything else comes from here.
    </p>

    <Banner
      v-if="notFound"
      color="error"
      :label="notFound"
    />
    <Banner
      v-if="!canWrite"
      color="warning"
      :label="`You cannot write ConfigMaps in ai-profiles, so this profile cannot be saved. Publishing profiles is for platform admins.`"
    />
    <Banner
      v-if="error"
      color="error"
      :label="error"
    />

    <section class="ip-section">
      <h2>Profile</h2>
      <div class="ip-grid">
        <LabeledInput
          v-model:value="draft.meta.name"
          label="Name"
          :disabled="existing"
          tooltip="The ConfigMap name: lowercase letters, numbers and hyphens. Cannot be changed later."
          required
        />
        <LabeledInput
          v-model:value="draft.meta.displayName"
          label="Display name"
          required
        />
        <LabeledInput
          v-model:value="draft.meta.description"
          class="ip-wide"
          label="Description"
          placeholder="What it serves, and on what"
        />
        <LabeledInput
          v-model:value="draft.meta.framework"
          label="Framework"
          placeholder="e.g. vLLM + LiteLLM"
        />
        <LabeledInput
          v-model:value="draft.meta.gpu"
          label="GPU label"
          placeholder="e.g. A2000"
          tooltip="Shown on the profile tile and used by the GPU type filter"
        />
        <LabeledSelect
          v-model:value="draft.meta.status"
          label="Status"
          :options="[{ label: 'Ready', value: 'ready' }, { label: 'Beta', value: 'beta' }]"
        />
      </div>
    </section>

    <section class="ip-section">
      <h2>Blueprint</h2>
      <Banner
        v-if="!families.length"
        color="info"
        label="No Blueprints in this cluster. Create or install one on the Blueprints page first."
      />
      <div class="ip-grid">
        <LabeledSelect
          v-model:value="draft.blueprint.name"
          label="Blueprint"
          :options="families"
          required
        />
        <LabeledSelect
          v-model:value="draft.blueprint.version"
          label="Version"
          :options="versions"
          :disabled="!draft.blueprint.name"
          required
        />
      </div>
      <dl
        v-if="summary"
        class="ip-summary"
      >
        <div>
          <dt>Serves</dt>
          <dd>{{ summary.model || 'No vLLM model found: the deploy page cannot size this blueprint' }}</dd>
        </div>
        <div v-if="summary.model">
          <dt>GPU</dt>
          <dd>{{ gpuText }} · {{ summary.replicas }} replica{{ summary.replicas === 1 ? '' : 's' }}</dd>
        </div>
        <div>
          <dt>Components</dt>
          <dd>{{ summary.components.join(', ') || '—' }}</dd>
        </div>
        <div>
          <dt>Gateway</dt>
          <dd>{{ summary.gateway ? `LiteLLM (${ summary.gateway.release })` : 'None: the endpoint is the vLLM router' }}</dd>
        </div>
      </dl>
    </section>

    <section class="ip-section">
      <h2>Prerequisites</h2>
      <p class="text-muted">
        Secrets a project must have before this profile can be deployed into it. The deploy page checks for each
        one and shows the hint when it is missing.
      </p>
      <div
        v-for="(s, i) in draft.requiredSecrets"
        :key="i"
        class="ip-secret"
      >
        <LabeledInput
          v-model:value="s.name"
          label="Secret name"
        />
        <LabeledInput
          v-model:value="s.hint"
          class="ip-hint"
          label="How to create it"
          placeholder="kubectl -n <project-namespace> create secret generic …"
        />
        <button
          type="button"
          class="btn role-link"
          @click="removeSecret(i)"
        >
          Remove
        </button>
      </div>
      <button
        type="button"
        class="btn role-tertiary btn-sm"
        @click="addSecret"
      >
        <i class="icon icon-plus mr-5" /> Add required secret
      </button>
    </section>

    <Banner
      v-if="errors.length && (draft.meta.name || draft.blueprint.name)"
      color="warning"
    >
      <ul class="ip-errors">
        <li
          v-for="e in errors"
          :key="e"
        >
          {{ e }}
        </li>
      </ul>
    </Banner>

    <footer class="ip-footer">
      <router-link
        :to="profilesRoute"
        class="btn role-secondary"
      >
        Cancel
      </router-link>
      <AsyncButton
        mode="edit"
        :action-label="existing ? 'Save' : 'Create'"
        :disabled="!canWrite || errors.length > 0"
        @click="save"
      />
    </footer>
  </main>
</template>

<style lang="scss" scoped>
.inference-profile { max-width: 1100px; }
.ip-crumbs { margin-bottom: 6px; }
.ip-section { margin-top: 24px; h2 { font-size: 16px; margin-bottom: 12px; } }
.ip-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px 16px; }
.ip-wide { grid-column: 1 / -1; }
.ip-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 8px 24px;
  margin: 16px 0 0;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: var(--border-radius);

  dt { color: var(--muted); font-size: 12px; }
  dd { margin: 0; overflow-wrap: anywhere; }
}
.ip-secret { display: flex; gap: 12px; align-items: center; margin-bottom: 10px; .ip-hint { flex: 1; } }
.ip-errors { margin: 0; padding-left: 18px; }
.ip-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border); }
</style>
