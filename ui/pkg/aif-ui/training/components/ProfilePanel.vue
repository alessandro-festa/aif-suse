<script lang="ts">
// The admin's side of a profile: shown on the Submit page in place of the Submit button. The form
// on the left is the profile's values; this panel says which of them users may change, the limits on
// those, and writes the result to a ConfigMap in the profile namespace.
import { defineComponent, PropType } from 'vue';
import jsyaml from 'js-yaml';
import LabeledInput from '@components/Form/LabeledInput/LabeledInput.vue';
import LabeledSelect from '@shell/components/form/LabeledSelect.vue';
import Checkbox from '@components/Form/Checkbox/Checkbox.vue';
import Banner from '@components/Banner/Banner.vue';
import AsyncButton from '@shell/components/AsyncButton.vue';
import { gpuShort } from '../gputypes';
import { Form } from '../preflight';
import {
  EDITABLE_FIELDS, EditableField, namespacedFixed, Profile, profileConfigMap, profileDocument, ProfileLimits,
  ProfileMeta, profileSaveErrors, PROFILE_NAMESPACE, registryPrefixOf
} from '../profiles';

// What the user sees for each field on the Deploy page
const FIELD_LABELS: Record<EditableField, string> = {
  image:             'Container image',
  tag:               'Image tag',
  command:           'Command (custom mode)',
  args:              'Arguments',
  script:            'Training script',
  configMap:         'Code ConfigMap',
  env:               'Environment variables',
  nodes:             'Workers',
  gpusPerNode:       'GPUs per worker',
  gpuProduct:        'GPU type',
  gpuShareMiB:       'GPU memory share',
  datasetPVC:        'Dataset PVC',
  checkpointPVC:     'Checkpoint PVC',
  secretName:        'Credentials Secret',
  runtimeLimitHours: 'Runtime limit',
  priorityClassName: 'Priority class',
};

const DEFAULT_EDITABLE: EditableField[] = ['image', 'tag', 'script', 'configMap', 'args', 'env', 'nodes', 'datasetPVC', 'checkpointPVC', 'runtimeLimitHours'];

export default defineComponent({
  name: 'ProfilePanel',

  components: {
    LabeledInput, LabeledSelect, Checkbox, Banner, AsyncButton
  },

  props: {
    form:           { type: Object as PropType<Form>, required: true },
    chartValues:    { type: Object, required: true },
    existing:       { type: Object as PropType<Profile | null>, default: null },
    canWrite:       { type: Boolean, default: false },
    // The wizard on the Submit page saves from its own footer (through a ref to save()), so it hides
    // this button and listens for `errors` to gate its own.
    showSave:       { type: Boolean, default: true },
    // Which part to show: the card (details), what users may change and the limits (guardrails), or
    // both. The wizard shows one per step from a single instance, so input survives moving between them.
    section:        { type: String as PropType<'all' | 'details' | 'guardrails'>, default: 'all' },
    // The cluster's GPU types (the Submit page's list), so GPU type can be picked on this step too.
    // The choice is the form's, so it goes back up as gpu-product rather than being kept here.
    gpuTypeOptions: { type: Array as PropType<{ label: string; value: string }[]>, default: () => [] },
  },

  emits: ['saved', 'errors', 'gpu-product', 'prefix'],

  data() {
    const p = this.existing as Profile | null;
    const f = this.form as Form;

    return {
      meta: {
        name:        p?.name || '',
        displayName: p?.displayName || '',
        description: p?.description || '',
        framework:   p?.framework || 'PyTorch',
        gpu:         p?.gpu || '',
        status:      p?.status || 'ready',
        purpose:     p?.purpose || 'training',
        namePrefix:  p?.namePrefix || '',
      } as ProfileMeta,
      editable:      (p ? [...p.editable] : [...DEFAULT_EDITABLE]) as EditableField[],
      nodesMin:      p?.limits.nodes?.min ?? 1,
      nodesMax:      p?.limits.nodes?.max ?? Math.max(4, f.nodes),
      gpusMin:       p?.limits.gpusPerNode?.min ?? 1,
      gpusMax:       p?.limits.gpusPerNode?.max ?? Math.max(1, f.gpusPerNode),
      registries:    (p ? p.limits.registries || [] : [registryPrefixOf(f.image)]).join(', '),
      maxRuntime:    p?.limits.maxRuntimeHours ?? 8,
      followProject: p ? !p.fixed.includes('scheduler') : true,
      error:         '' as string,
    };
  },

  computed: {
    fields(): { value: EditableField; label: string }[] {
      return EDITABLE_FIELDS.map((k) => ({ value: k, label: FIELD_LABELS[k] }));
    },

    limits(): ProfileLimits {
      // A fixed image needs no allowlist, and a hidden one could reject the profile's own image later.
      const regs = this.editable.includes('image') ? this.registries.split(',').map((s: string) => s.trim()).filter(Boolean) : [];

      return {
        nodes:           { min: Number(this.nodesMin) || 1, max: Number(this.nodesMax) || 1 },
        // only when users may change it: otherwise the profile's own GPUs per worker apply
        ...(this.editable.includes('gpusPerNode') ? { gpusPerNode: { min: Number(this.gpusMin) || 0, max: Number(this.gpusMax) || 0 } } : {}),
        registries:      regs,
        maxRuntimeHours: Number(this.maxRuntime) || 0,
      };
    },

    saveErrors(): string[] {
      return profileSaveErrors(this.meta, this.limits, this.form);
    },

    namespaced(): string[] {
      return namespacedFixed(this.form, this.editable).map((k) => `${ FIELD_LABELS[k as EditableField] || k } = ${ (this.form as any)[k] }`);
    },

    profileNamespace: () => PROFILE_NAMESPACE,

    /** The card label: the GPU type chosen on Configure. There is no free-text label any more. */
    gpuLabel(): string {
      return this.form.gpuProduct ? gpuShort(this.form.gpuProduct) : 'Any GPU';
    },

    /**
     * Everything that stops a save, split by the part of the panel it belongs to: the name (and not
     * being allowed to write profiles at all) is the card's; the limits are the guardrails'.
     */
    blockers(): { details: string[]; guardrails: string[] } {
      const name = this.saveErrors.filter((e: string) => /^Name/.test(e));

      return {
        details:    [...(this.canWrite ? [] : [`You cannot write ConfigMaps in ${ PROFILE_NAMESPACE }.`]), ...name],
        guardrails: this.saveErrors.filter((e: string) => !name.includes(e)),
      };
    },
  },

  watch: {
    'meta.namePrefix': {
      immediate: true,
      handler(v: string) {
        this.$emit('prefix', v || '');
      },
    },
    blockers: {
      immediate: true,
      deep:      true,
      handler(v: { details: string[]; guardrails: string[] }) {
        this.$emit('errors', v);
      },
    },
  },

  methods: {
    toggle(k: EditableField, on: boolean) {
      this.editable = on ? [...new Set([...this.editable, k])] : this.editable.filter((x: EditableField) => x !== k);
    },

    async save(done: (ok: boolean) => void) {
      this.error = '';
      if (this.saveErrors.length || !this.canWrite) {
        done(false);

        return;
      }
      try {
        const doc = profileDocument({ ...this.meta, gpu: this.gpuLabel === 'Any GPU' ? '' : this.gpuLabel }, this.chartValues, this.editable, this.limits, this.followProject);
        const body = profileConfigMap(this.meta, doc, (o: any) => jsyaml.dump(o, { lineWidth: -1 }));
        const id = `${ PROFILE_NAMESPACE }/${ this.meta.name }`;
        let cm = this.$store.getters['cluster/byId']('configmap', id);

        if (!cm) {
          // the store only holds what it has listed; ask the API before treating the name as free
          cm = await this.$store.dispatch('cluster/find', { type: 'configmap', id }).catch(() => null);
        }
        if (cm && !this.existing) {
          throw new Error(`A profile named ${ this.meta.name } already exists. Edit it from the Profiles page, or choose another name.`);
        }
        if (cm) {
          cm.data = body.data;
          cm.metadata.labels = { ...(cm.metadata.labels || {}), ...body.metadata.labels };
        } else {
          cm = await this.$store.dispatch('cluster/create', body);
        }
        await cm.save();
        done(true);
        this.$emit('saved', this.meta.name);
      } catch (e: any) {
        const msg = e?.message || e?._statusText || String(e);

        this.error = /namespaces?\b.*not found/i.test(msg) ? `Namespace ${ PROFILE_NAMESPACE } does not exist. Apply examples/training/profiles/00-namespace-rbac.yaml first.` : msg;
        done(false);
      }
    },
  },
});
</script>

<template>
  <div class="tj-profile-panel">
    <template v-if="section !== 'guardrails'">
      <h2>{{ existing ? `Profile ${ existing.name }` : 'New profile' }}</h2>
      <Banner
        v-if="!canWrite"
        color="warning"
        :label="`You cannot write ConfigMaps in ${ profileNamespace }, so this profile cannot be saved. Publishing profiles is for platform admins.`"
      />

      <div class="row">
        <div class="col span-6">
          <LabeledInput
            v-model:value="meta.name"
            label="Name"
            tooltip="Lowercase letters, numbers and hyphens. The ConfigMap name, and what each run is annotated with."
            :disabled="!!existing"
          />
        </div>
        <div class="col span-6">
          <LabeledInput
            v-model:value="meta.displayName"
            label="Display name"
          />
        </div>
      </div>
      <div class="row">
        <div class="col span-8">
          <LabeledInput
            v-model:value="meta.description"
            label="Description"
          />
        </div>
        <div class="col span-4">
          <LabeledInput
            v-model:value="meta.namePrefix"
            label="Run name prefix (optional)"
            :tooltip="`Runs are named ${ meta.namePrefix || '<prefix>' }-<anything>; the user picks the rest when they deploy. Empty = any name.`"
            placeholder="e.g. team-lora"
          />
        </div>
      </div>
      <div class="row">
        <div class="col span-4">
          <LabeledInput
            v-model:value="meta.framework"
            label="Framework"
          />
        </div>
        <div class="col span-4">
          <LabeledSelect
            :value="form.gpuProduct"
            label="GPU type"
            tooltip="The GPU model runs must get. Enforced: a DRA device selector, or a node selector on GPU Feature Discovery's nvidia.com/gpu.product label. Same setting as Configure → GPU & resources."
            :options="gpuTypeOptions.length ? gpuTypeOptions : [{ label: 'Any GPU', value: '' }]"
            @update:value="$emit('gpu-product', $event)"
          />
        </div>
        <div class="col span-4">
          <LabeledSelect
            v-model:value="meta.status"
            label="Status"
            :options="[{ label: 'Ready', value: 'ready' }, { label: 'Beta', value: 'beta' }]"
          />
        </div>
        <div class="col span-4">
          <LabeledSelect
            v-model:value="meta.purpose"
            label="Purpose"
            tooltip="Training runs the user's code. A test or benchmark checks the environment and reports results; the Catalog lists them under Validate your environment."
            :options="[{ label: 'Training', value: 'training' }, { label: 'Test', value: 'test' }, { label: 'Benchmark', value: 'benchmark' }]"
          />
        </div>
      </div>

      <Banner
        v-for="e in blockers.details.filter(x => !x.startsWith('You cannot'))"
        :key="e"
        color="error"
        :label="e"
      />
    </template>

    <template v-if="section !== 'details'">
      <h2 v-if="section === 'guardrails'">
        Guardrails
      </h2>
      <h3>Users may change</h3>
      <p class="text-muted tj-hint">
        Everything else is fixed at what the form says now. Project namespace and run name are always the user's.
      </p>
      <div class="tj-fields">
        <Checkbox
          v-for="f in fields"
          :key="f.value"
          :value="editable.includes(f.value)"
          :label="f.label"
          @update:value="toggle(f.value, $event)"
        />
      </div>

      <h3>Limits</h3>
      <div class="row">
        <div class="col span-4">
          <LabeledInput
            v-model:value.number="nodesMin"
            type="number"
            label="Workers, min"
          />
        </div>
        <div class="col span-4">
          <LabeledInput
            v-model:value.number="nodesMax"
            type="number"
            label="Workers, max"
          />
        </div>
        <template v-if="editable.includes('gpusPerNode')">
          <div class="col span-4">
            <LabeledInput
              v-model:value.number="gpusMin"
              type="number"
              label="GPUs per worker, min"
            />
          </div>
          <div class="col span-4">
            <LabeledInput
              v-model:value.number="gpusMax"
              type="number"
              label="GPUs per worker, max"
            />
          </div>
        </template>
        <div class="col span-4">
          <LabeledInput
            v-model:value.number="maxRuntime"
            type="number"
            label="Max runtime (h)"
            tooltip="0 = no limit."
          />
        </div>
      </div>
      <!-- Only meaningful when users may change the image: a fixed image is the profile's own choice. -->
      <div
        v-if="editable.includes('image')"
        class="row"
      >
        <div class="col span-12">
          <LabeledInput
            v-model:value="registries"
            label="Allowed image registries"
            placeholder="e.g. nvcr.io/nvidia/, registry.suse.com/"
            tooltip="Comma separated. The image a user enters must start with one of these (Docker Hub short names count as docker.io/...). Empty = any registry. Checked before deploy, not enforced in the cluster."
          />
        </div>
      </div>
      <Checkbox
        v-model:value="followProject"
        label="Scheduler and queue follow the user's project"
        tooltip="Leave on unless every run must use one scheduler. Off fixes the scheduler and queue shown in the form for all users."
      />

      <Banner
        v-if="namespaced.length"
        color="warning"
        :label="`Fixed to a value that exists only in ${ form.namespace || 'this namespace' }: ${ namespaced.join(', ') }. Users in other projects will not have it; open the field or clear it.`"
      />
      <Banner
        v-for="e in blockers.guardrails"
        :key="e"
        color="error"
        :label="e"
      />
    </template>
    <Banner
      v-if="error"
      color="error"
      :label="error"
    />

    <div
      v-if="showSave"
      class="tj-panel-actions"
    >
      <AsyncButton
        mode="edit"
        :disabled="!canWrite || saveErrors.length > 0"
        action-label="Save profile"
        waiting-label="Saving…"
        success-label="Saved"
        @click="save"
      />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.tj-profile-panel { border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 12px;
  h2 { font-size: 16px; margin: 6px 0 10px; } h3 { font-size: 14px; margin: 12px 0 6px; } .row { margin-bottom: 10px; } }
.tj-hint { font-size: 12px; margin: 0 0 6px; }
.tj-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; }
.tj-panel-actions { display: flex; justify-content: flex-end; margin-top: 10px; }
</style>
