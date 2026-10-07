<script lang="ts">
/* eslint-disable vue/no-undef-properties -- form, facts, submit and the rest come from Submit via `extends`, which the rule does not follow */
// Deploy from a profile: the person deploying says what they want to run, the platform says how.
//
// Everything that decides whether a deployment can start -- the cluster facts, the pre-flight, the
// chart lookup, the Helm install -- is Submit's, inherited through `extends` so the two pages cannot
// drift. This page adds the profile on top: it fixes most of the form, lays out only the fields the
// profile opens (grouped by intent, escape hatches under Advanced), and shows the pre-flight as a
// Readiness panel (readiness.ts) instead of the admin-facing check list.
import StatusPill from '../components/StatusPill.vue';
import { defineComponent } from 'vue';
import jsyaml from 'js-yaml';
import Submit from './Submit.vue';
import ReadinessPanel from '../components/ReadinessPanel.vue';
import { PRODUCT_NAME, PROFILES_PAGE } from '../config';
import {
  chartValuesFor, Check, checksFor, Form, runPreflight, summarize
} from '../preflight';
import { availability } from '../quota';
import { usesQueueTree } from '../schedulers';
import {
  Profile, profileChecks, profilesFrom, resolveForm, resolvedSections
} from '../profiles';
import {
  Readiness, readiness, resourceTotals, WorkersNow, workersSchedulableNow
} from '../readiness';
import { CodeSource, codeCheck, codeFields, initialCodeSource } from '../code';
import { loadClusterLabel } from '../cluster';
import { localProfileConfigMaps } from '../placement';

// The code (script, ConfigMap, arguments) has a section of its own: a training run needs it every time.
const ADVANCED_FIELDS = ['env', 'secretName', 'runtimeLimitHours', 'priorityClassName'];

const LIMITED_BY: Record<string, string> = {
  gpu: 'free GPUs', cpu: 'free CPU on GPU nodes', memory: 'free memory on GPU nodes', disk: 'free node disk'
};

export default defineComponent({
  name:       'TrainingJobDeploy',
  extends:    Submit,
  components: { StatusPill, ReadinessPanel },

  data() {
    return {
      profile:        null as Profile | null,
      profilesLoaded: false,
      drawer:         '' as '' | 'resolved' | 'profile',
      codeSource:     'script' as CodeSource,
      clusterName:    '',
    };
  },

  async fetch() {
    loadClusterLabel(this.$store, String(this.$route.params.cluster || 'local')).then((l: string) => {
      this.clusterName = l;
    });
    // Profiles live on local, whatever cluster the chosen pool moved this page to.
    const [cms] = await Promise.all([localProfileConfigMaps(this.$store).catch(() => []), this.loadPools()]);
    const profiles = profilesFrom(cms, (s: string) => jsyaml.load(s));

    this.profile = profiles.find((p) => p.name === this.$route.query.profile) || null;
    this.profilesLoaded = true;
    if (this.profile) {
      this.form = resolveForm(this.profile, {});
      this.codeSource = initialCodeSource(this.form);
    }
    await this.loadFacts();
    // Suggest a name that already satisfies the profile's prefix; the user can change the rest.
    const prefix = this.profile?.namePrefix;

    if (prefix && !this.form.releaseName.startsWith(`${ prefix }-`)) {
      this.form.releaseName = `${ prefix }-${ Math.random().toString(36).slice(2, 7) }`;
    }
  },

  watch: {
    codeSource(src: CodeSource) {
      Object.assign(this.form, codeFields(src, this.form));
    },
  },

  computed: {
    checks(): Check[] {
      // a deploy into a queueing project waits for room rather than failing on it
      const cluster = checksFor(runPreflight(this.form, this.facts), { profile: false, scheduler: this.form.scheduler });

      const code = this.hasCode ? [codeCheck(this.codeSource, this.form)] : [];

      return this.profile ? [...profileChecks(this.profile, this.form), ...code, ...cluster] : [...code, ...cluster];
    },
    /** Whether the user supplies the run's code: the profile opens the script or a code ConfigMap. */
    hasCode(): boolean {
      return !!(this.can.script || this.can.configMap);
    },
    codeOptions(): { label: string; value: CodeSource }[] {
      return [
        ...(this.can.script ? [{ label: 'Inline script', value: 'script' as CodeSource }] : []),
        ...(this.can.configMap ? [{ label: 'ConfigMap in the project', value: 'configMap' as CodeSource }] : []),
        { label: 'Built-in demo (all-reduce check)', value: 'demo' as CodeSource },
      ];
    },

    summary(): { fails: number; warns: number; ok: boolean } {
      // A missing profile is a blocking problem of its own; the cluster checks alone could pass.
      const s = summarize(this.checks);

      return this.profile ? s : { ...s, ok: false };
    },

    ready(): Readiness {
      return readiness(this.checks, this.form);
    },

    // the chart labels the Job with it, so the Workloads page finds the profile however it was installed
    chartValues(): any {
      return { ...chartValuesFor(this.form, this.facts.podsReadable), profile: this.profile?.name || '' };
    },

    checkpointPlan(): string {
      const f = this.form;

      if (f.checkpointMode === 'create') {
        return `a new ${ f.checkpointSize } volume from ${ f.checkpointStorageClass || 'the default storage class' } for this run, ${ f.checkpointKeep ? 'kept afterwards' : 'deleted with the run' } (/mnt/checkpoints)`;
      }

      return f.checkpointPVC ? `${ f.checkpointPVC }, read-write at /mnt/checkpoints` : 'none';
    },
    scratchPlan(): string {
      const f = this.form;

      if (!f.scratchSize) {
        return 'none (the container\'s own disk)';
      }

      return f.scratchMedium === 'node' ? `${ f.scratchSize } on the node's disk per pod, deleted with it` : `${ f.scratchSize } volume from ${ f.scratchStorageClass || 'the default storage class' } per pod, deleted with it`;
    },
    /** Checkpoints for the user to pick: what the profile creates, none, or an existing PVC. */
    checkpointChoices(): { label: string; value: string }[] {
      const created = this.profile?.form?.checkpointMode === 'create' ? [{ label: `New volume for this run (${ this.profile.form.checkpointSize })`, value: '__create__' }] : [];

      return [...created, { label: 'None', value: '' }, ...this.checkpointVolumeOptions];
    },
    checkpointChoice: {
      get(): string {
        return this.form.checkpointMode === 'create' ? '__create__' : this.form.checkpointPVC;
      },
      set(v: string) {
        if (v === '__create__') {
          this.form.checkpointMode = 'create';
          this.form.checkpointPVC = '';
        } else {
          this.form.checkpointMode = v ? 'existing' : 'none';
          this.form.checkpointPVC = v;
        }
      },
    },

    can(): Record<string, boolean> {
      const open = new Set<string>(this.profile?.editable || []);

      return Object.fromEntries([
        'image', 'tag', 'command', 'args', 'script', 'configMap', 'env', 'nodes', 'gpusPerNode', 'gpuProduct', 'gpuShareMiB',
        'datasetPVC', 'checkpointPVC', 'secretName', 'runtimeLimitHours', 'priorityClassName',
      ].map((k) => [k, open.has(k)]));
    },

    hasAdvanced(): boolean {
      return ADVANCED_FIELDS.some((k) => this.can[k]);
    },

    nodeRange(): { min: number; max: number } {
      return this.profile?.limits.nodes || { min: 1, max: Math.max(1, this.form.nodes) };
    },

    /** The one-line description of what the profile provides, for the summary card. */
    profileFacts(): string[] {
      const p = this.profile as Profile | null;

      if (!p) {
        return [];
      }
      const n = this.nodeRange;

      return [
        [p.framework, p.form.tag].filter(Boolean).join(' '),
        p.gpu,
        n.min === n.max ? `${ n.min } worker${ n.min === 1 ? '' : 's' }` : `${ n.min }–${ n.max } workers`,
        `${ p.form.gpusPerNode } GPU per worker`,
        p.form.mode === 'torchrun' ? 'torchrun' : p.form.mode,
        p.limits.maxRuntimeHours ? `${ p.limits.maxRuntimeHours } h max` : '',
      ].filter(Boolean);
    },

    now(): WorkersNow {
      return workersSchedulableNow(this.form, this.facts, this.resolvedGpuMode as any);
    },

    /** GPUs the project's queue can still take, when the scheduler is one whose quota we can read. */
    quotaGpus(): number | null {
      if (!usesQueueTree(this.form.scheduler) || !this.form.queue || !this.facts.queueIndex?.[this.form.queue]) {
        return null;
      }
      const a = availability(this.form.queue, this.facts.queueIndex, this.facts.capacity, 'gpu');

      return Number.isFinite(a.freeUpToCap) ? a.freeUpToCap : null;
    },

    nowText(): string {
      if (this.now.available === null) {
        return 'unknown';
      }

      return this.now.gpuOnly ? `up to ${ this.now.available } (by free GPUs; CPU and memory not visible to you)` : `${ this.now.available } (limited by ${ LIMITED_BY[this.now.limitedBy] || '—' })`;
    },

    tooManyNow(): boolean {
      return this.now.available !== null && !this.now.gpuOnly && this.form.nodes > this.now.available;
    },

    sections(): { title: string; rows: { label: string; value: string }[] }[] {
      return resolvedSections(this.form, this.resolvedGpuMode);
    },

    totals(): { label: string; value: string }[] {
      return resourceTotals(this.form);
    },

    profilesRoute(): any {
      return { name: `c-cluster-${ PRODUCT_NAME }-${ PROFILES_PAGE }`, params: { cluster: this.$route.params.cluster } };
    },
  },

  methods: {
    /**
     * Submit's loadFacts picks a scheduler when the form has none. That is right for the open form
     * and wrong for a profile that fixes it, so the fixed fields are put back afterwards.
     */
    async loadFacts() {
      await (Submit as any).methods.loadFacts.call(this);
      if (this.profile) {
        const fixed = this.profile.fixed.filter((k: keyof Form) => !(this.profile as Profile).editable.includes(k as any));

        fixed.forEach((k: keyof Form) => {
          (this.form as any)[k] = (this.profile as Profile).form[k];
        });
      }
    },
  },
});
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <div
    v-else
    class="tj-deploy"
  >
    <p class="tj-crumbs text-muted">
      <router-link :to="profilesRoute">
        Catalog
      </router-link>
      <span v-if="profile"> › {{ profile.displayName }} › Deploy</span>
    </p>

    <Banner
      v-if="profilesLoaded && !profile"
      color="error"
      :label="`No profile named ${ $route.query.profile || '(none)' } in this cluster. Pick one from the Catalog.`"
    />

    <template v-if="profile">
      <h1 class="tj-title">
        Deploy {{ profile.displayName }}
        <StatusPill
          v-if="profile.status === 'beta'"
          status="beta"
          size="lg"
        />
      </h1>

      <!-- The profile is the thing being consumed; say what it provides before asking for anything. -->
      <section class="tj-profile-card">
        <div class="tj-profile-head">
          <div>
            <span class="tj-profile-name">{{ profile.displayName }}</span>
            <span class="text-muted"> · Training profile</span>
          </div>
          <StatusPill :status="profile.status" />
        </div>
        <div class="tj-profile-facts">
          {{ profileFacts.join(' · ') }}
        </div>
        <div
          v-if="profile.description"
          class="text-muted"
        >
          {{ profile.description }}
        </div>
        <a
          href="#"
          class="tj-link"
          @click.prevent="drawer = 'profile'"
        >View profile →</a>
      </section>

      <div
        v-if="pools.length"
        class="tj-pool"
      >
        <LabeledSelect
          :value="poolName"
          :options="poolOptions"
          label="Compute pool"
          placeholder="Choose where this runs"
          @update:value="choosePool"
        />
      </div>

      <Banner
        v-if="error"
        color="error"
        :label="error"
      />
      <Banner
        v-if="submitted"
        color="success"
        :label="`Deployed job ${form.releaseName}. Redirecting to Training Jobs…`"
      />

      <div class="tj-grid">
        <!-- ============ intent ============ -->
        <section class="tj-form">
          <div class="tj-section">
            <h3>Basics</h3>
            <div class="row mb-10">
              <div class="col span-6">
                <LabeledInput
                  :value="clusterName"
                  label="Cluster"
                  mode="view"
                  tooltip="The cluster the run is installed on, and whose GPUs, quotas and queues the checks below read."
                />
              </div>
            </div>
            <div class="row">
              <div class="col span-6">
                <LabeledSelect
                  v-model:value="form.namespace"
                  label="Project"
                  tooltip="The project namespace. The deployment uses its GPU quota and queue."
                  :options="namespaceOptions"
                  :searchable="true"
                />
              </div>
              <div class="col span-6">
                <LabeledInput
                  v-model:value="form.releaseName"
                  label="Deployment name"
                  :tooltip="profile.namePrefix ? `Starts with ${ profile.namePrefix }-. Lowercase letters, numbers and hyphens.` : 'Lowercase letters, numbers and hyphens.'"
                />
              </div>
            </div>
          </div>

          <div
            v-if="can.image || can.tag || can.command"
            class="tj-section"
          >
            <h3>Workload</h3>
            <div
              v-if="can.image || can.tag"
              class="row"
            >
              <div
                v-if="can.image"
                class="col span-8"
              >
                <LabeledInput
                  v-model:value="form.image"
                  label="Image"
                />
              </div>
              <div
                v-if="can.tag"
                class="col span-4"
              >
                <LabeledInput
                  v-model:value="form.tag"
                  label="Tag"
                />
              </div>
            </div>
            <div
              v-if="can.command"
              class="row"
            >
              <div class="col span-12">
                <LabeledInput
                  v-model:value="form.command"
                  label="Command"
                  placeholder="python /mnt/config/train.py"
                />
              </div>
            </div>
          </div>

          <div
            v-if="hasCode"
            class="tj-section"
          >
            <h3>Code</h3>
            <RadioGroup
              v-model:value="codeSource"
              name="code-source"
              :options="codeOptions"
              :row="true"
            />
            <div
              v-if="codeSource === 'script'"
              class="row mt-10"
            >
              <div class="col span-12">
                <LabeledInput
                  v-model:value="form.script"
                  type="multiline"
                  label="Training script (train.py)"
                  placeholder="import torch&#10;…"
                  :min-height="220"
                  required
                />
              </div>
            </div>
            <div
              v-else-if="codeSource === 'configMap'"
              class="row mt-10"
            >
              <div class="col span-6">
                <LabeledSelect
                  v-model:value="form.configMap"
                  label="Code ConfigMap, mounted at /mnt/config"
                  tooltip="torchrun runs its train.py key."
                  :options="facts.configMaps"
                  :searchable="true"
                  required
                />
              </div>
            </div>
            <p
              v-else
              class="text-muted mt-10"
            >
              Runs the chart's built-in check: an all-reduce across the workers' GPUs, then exits. For
              checking a profile, quota and scheduling, not for training.
            </p>
            <div
              v-if="can.args && codeSource !== 'demo'"
              class="row mt-10"
            >
              <div class="col span-12">
                <LabeledInput
                  v-model:value="form.args"
                  label="Arguments"
                  placeholder="--epochs 10 --lr 2e-5"
                />
              </div>
            </div>
          </div>

          <div
            v-if="can.nodes || can.gpusPerNode || can.gpuProduct || can.gpuShareMiB"
            class="tj-section"
          >
            <h3>Scale</h3>
            <div class="row">
              <div
                v-if="can.nodes"
                class="col span-4"
              >
                <!-- Out-of-range values are left for the profile check to report, not clamped: a number
                     that silently changes under the cursor reads as a broken field. -->
                <LabeledInput
                  v-model:value.number="form.nodes"
                  type="number"
                  :label="nodeRange.min === nodeRange.max ? 'Workers' : `Workers (${ nodeRange.min }–${ nodeRange.max })`"
                  :disabled="nodeRange.min === nodeRange.max"
                />
              </div>
              <div
                v-if="can.gpusPerNode"
                class="col span-4"
              >
                <LabeledInput
                  v-model:value.number="form.gpusPerNode"
                  type="number"
                  :label="profile && profile.limits.gpusPerNode ? `GPUs per worker (${ profile.limits.gpusPerNode.min }–${ profile.limits.gpusPerNode.max })` : 'GPUs per worker'"
                />
              </div>
              <div
                v-if="can.gpuShareMiB && form.gpuShareMiB > 0"
                class="col span-4"
              >
                <LabeledInput
                  v-model:value.number="gpuShareGiB"
                  type="number"
                  label="GPU memory per worker (GiB)"
                  tooltip="On the project's shared GPU. Enforced by MPS."
                />
              </div>
              <div
                v-if="can.gpuProduct"
                class="col span-4"
              >
                <LabeledSelect
                  v-model:value="form.gpuProduct"
                  label="GPU type"
                  :options="gpuTypeOptions"
                />
              </div>
            </div>
            <p class="tj-scale-line">
              {{ form.nodes }} worker{{ form.nodes === 1 ? '' : 's' }} · {{ form.nodes * form.gpusPerNode }} × {{ profile.gpu || 'GPU' }}
            </p>
            <!-- The profile's limit and the cluster's state are different facts; show both. -->
            <table class="tj-kv">
              <tr>
                <th>Profile allows</th>
                <td>{{ nodeRange.min === nodeRange.max ? nodeRange.max : `${ nodeRange.min }–${ nodeRange.max }` }} workers</td>
              </tr>
              <tr>
                <th>Can start now</th>
                <td>{{ nowText }}</td>
              </tr>
              <tr v-if="quotaGpus !== null">
                <th>Project quota free</th>
                <td>{{ quotaGpus }} GPU</td>
              </tr>
            </table>
            <Banner
              v-if="tooManyNow"
              color="warning"
              :label="`Only ${ now.available } worker(s) can start now. The rest wait until capacity frees up.`"
            />
          </div>

          <div class="tj-section">
            <h3>Data</h3>
            <!-- What the profile provides for each lifecycle, and the choices it leaves open. -->
            <ul class="tj-storage-plan">
              <li><b>Dataset:</b> {{ form.datasetPVC ? `${ form.datasetPVC }, read-only at /mnt/dataset` : 'none' }}</li>
              <li><b>Checkpoints:</b> {{ checkpointPlan }}</li>
              <li><b>Scratch:</b> {{ scratchPlan }}</li>
            </ul>
            <div
              v-if="can.datasetPVC || can.checkpointPVC"
              class="row"
            >
              <div
                v-if="can.datasetPVC"
                class="col span-6"
              >
                <LabeledSelect
                  v-model:value="form.datasetPVC"
                  label="Dataset"
                  tooltip="A volume in the project, mounted read-only at /mnt/dataset ($DATASET_DIR)."
                  :options="pvcOptions"
                  :searchable="true"
                />
              </div>
              <div
                v-if="can.checkpointPVC"
                class="col span-6"
              >
                <LabeledSelect
                  v-model:value="checkpointChoice"
                  label="Checkpoints"
                  tooltip="A new volume for this run (as the profile sets it up) or an existing one in the project, mounted read-write at /mnt/checkpoints ($CHECKPOINT_DIR)."
                  :options="checkpointChoices"
                  :searchable="true"
                />
              </div>
            </div>
          </div>

          <!-- Escape hatches. Most deployments from a profile should never need to open this. -->
          <details
            v-if="hasAdvanced"
            class="tj-section tj-advanced"
          >
            <summary>Advanced configuration</summary>
            <div
              v-if="can.runtimeLimitHours || can.priorityClassName"
              class="row"
            >
              <div
                v-if="can.runtimeLimitHours"
                class="col span-6"
              >
                <LabeledInput
                  v-model:value.number="form.runtimeLimitHours"
                  type="number"
                  :label="profile.limits.maxRuntimeHours ? `Runtime limit (hours, at most ${ profile.limits.maxRuntimeHours })` : 'Runtime limit (hours, 0 = none)'"
                  tooltip="Kubernetes stops the deployment when this runs out."
                />
              </div>
              <div
                v-if="can.priorityClassName"
                class="col span-6"
              >
                <LabeledInput
                  v-model:value="form.priorityClassName"
                  label="Priority class"
                />
              </div>
            </div>
            <div
              v-if="can.secretName"
              class="row"
            >
              <div
                v-if="can.secretName"
                class="col span-6"
              >
                <LabeledSelect
                  v-model:value="form.secretName"
                  label="Credentials Secret"
                  :options="secretOptions"
                  :searchable="true"
                />
              </div>
            </div>
            <div
              v-if="can.env"
              class="row"
            >
              <div class="col span-12">
                <KeyValue
                  v-model:value="form.env"
                  :as-map="true"
                  mode="edit"
                  title="Environment variables"
                  :read-allowed="false"
                />
              </div>
            </div>
          </details>

          <div class="tj-form-foot">
            <a
              href="#"
              class="tj-link"
              @click.prevent="drawer = 'resolved'"
            >View resolved configuration →</a>
            <div class="tj-form-actions">
              <router-link
                :to="profilesRoute"
                class="btn role-secondary"
              >
                Cancel
              </router-link>
              <AsyncButton
                mode="create"
                :disabled="submitDisabled"
                action-label="Deploy"
                waiting-label="Deploying…"
                success-label="Deployed"
                @click="submit"
              />
            </div>
          </div>
        </section>

        <!-- ============ what the platform resolved, and whether it can run ============ -->
        <aside class="tj-side">
          <ReadinessPanel
            :ready="ready"
            :checks="checks"
            @recheck="loadFacts()"
          />

          <div class="tj-panel">
            <h2>Resource summary</h2>
            <table class="tj-kv">
              <tr
                v-for="r in totals"
                :key="r.label"
              >
                <th>{{ r.label }}</th>
                <td>{{ r.value }}</td>
              </tr>
            </table>
            <p class="text-muted tj-sub">
              For the whole deployment, {{ form.nodes }} worker{{ form.nodes === 1 ? '' : 's' }}.
            </p>
          </div>
        </aside>
      </div>

      <!-- ============ drawer: platform detail, on demand ============ -->
      <div
        v-if="drawer"
        class="tj-backdrop"
        @click="drawer = ''"
      />
      <aside
        v-if="drawer"
        class="tj-drawer"
      >
        <div class="tj-panel-head">
          <h2>{{ drawer === 'resolved' ? 'Resolved configuration' : profile.displayName }}</h2>
          <button
            class="btn role-tertiary btn-sm"
            aria-label="Close"
            @click="drawer = ''"
          >
            <i class="icon icon-close" />
          </button>
        </div>

        <template v-if="drawer === 'resolved'">
          <p class="text-muted tj-sub">
            What the profile and this cluster decided. Read-only.
          </p>
          <div
            v-for="s in sections"
            :key="s.title"
            class="tj-drawer-section"
          >
            <h4>{{ s.title }}</h4>
            <table class="tj-kv">
              <tr
                v-for="r in s.rows"
                :key="r.label"
              >
                <th>{{ r.label }}</th>
                <td>{{ r.value }}</td>
              </tr>
            </table>
          </div>
          <details class="tj-values">
            <summary>View YAML (Helm values)</summary>
            <pre>{{ JSON.stringify(effectiveValues, null, 2) }}</pre>
          </details>
        </template>

        <template v-else>
          <p class="text-muted tj-sub">
            {{ profile.description }}
          </p>
          <div class="tj-drawer-section">
            <h4>You set</h4>
            <p>Project, deployment name{{ profile.editable.length ? ', ' + profile.editable.join(', ') : '' }}</p>
          </div>
          <div class="tj-drawer-section">
            <h4>Set by the profile</h4>
            <p>{{ profile.fixed.filter(f => !profile.editable.includes(f)).join(', ') || 'nothing beyond the chart defaults' }}</p>
          </div>
          <div class="tj-drawer-section">
            <h4>Limits</h4>
            <table class="tj-kv">
              <tr>
                <th>Workers</th>
                <td>{{ nodeRange.min }}–{{ nodeRange.max }}</td>
              </tr>
              <tr>
                <th>Max runtime</th>
                <td>{{ profile.limits.maxRuntimeHours ? `${ profile.limits.maxRuntimeHours } h` : 'none' }}</td>
              </tr>
              <tr>
                <th>Image registries</th>
                <td>{{ (profile.limits.registries || []).join(', ') || 'any registry' }}</td>
              </tr>
            </table>
          </div>
        </template>
      </aside>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.tj-storage-plan { margin: 0 0 10px 18px; li { margin: 2px 0; } }

.tj-deploy { padding: 0 20px 20px; }
.tj-crumbs { margin: 10px 0 4px; }
.tj-title { margin: 0 0 12px; }
.tj-link { font-size: 13px; }

.tj-pool { max-width: 520px; margin-bottom: 16px; }
.tj-profile-card { border: 1px solid var(--border); border-left: 4px solid var(--primary); border-radius: var(--border-radius); padding: 12px 16px; margin-bottom: 16px; display: flex; flex-direction: column; gap: 4px; }
.tj-profile-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.tj-profile-name { font-size: 16px; font-weight: 600; }
.tj-profile-facts { font-size: 13px; }

// 2/3 intent, 1/3 what the platform resolved
.tj-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr); gap: 24px; align-items: start; }
@media (max-width: 1100px) { .tj-grid { grid-template-columns: 1fr; } }
// Grid items default to min-width: auto, so one line of text that will not wrap widens the whole
// page past the viewport. Let the columns be what the grid says and make the text wrap.
.tj-grid > * { min-width: 0; }

.tj-section { border-top: 1px solid var(--border); padding: 12px 0 4px; h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 0 0 10px; } }
.tj-section:first-child { border-top: none; padding-top: 0; }
.tj-form .row { margin-bottom: 12px; }
.tj-scale-line { margin: 0 0 6px; font-weight: 600; }
.tj-advanced { summary { cursor: pointer; font-weight: 600; margin-bottom: 10px; } }
.tj-form-foot { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 12px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.tj-form-actions { display: flex; gap: 8px; }

.tj-kv { font-size: 13px; th { text-align: left; font-weight: normal; color: var(--muted); padding: 2px 16px 2px 0; white-space: nowrap; vertical-align: top; } td { padding: 2px 0; } }

.tj-side { display: flex; flex-direction: column; gap: 16px; position: sticky; top: 10px; }
.tj-panel { border: 1px solid var(--border); border-radius: var(--border-radius); padding: 12px 16px; background: var(--body-bg); overflow-wrap: anywhere;
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 4px 0 8px; }
  h4 { font-size: 13px; margin: 14px 0 6px; } }
.tj-panel-head { display: flex; justify-content: space-between; align-items: center; }
.tj-sub { font-size: 12px; margin: 2px 0 0; }

.tj-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.25); z-index: 40; }
.tj-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(480px, 100vw); background: var(--body-bg); border-left: 1px solid var(--border); z-index: 41; padding: 16px 20px; overflow-y: auto;
  h2 { font-size: 16px; margin: 0; } h4 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 14px 0 6px; } p { margin: 0; } }
.tj-drawer-section { margin-bottom: 4px; }
.tj-values { margin-top: 16px; summary { cursor: pointer; } pre { font-size: 11px; overflow: auto; } }
</style>
