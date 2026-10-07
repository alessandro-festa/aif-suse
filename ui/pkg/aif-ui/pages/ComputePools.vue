<script>
import Banner from '@components/Banner/Banner.vue';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Checkbox } from '@components/Form/Checkbox';
import AsyncButton from '@shell/components/AsyncButton.vue';
import {
  listComputePools, reclaimDraft, reclaimErrors, reclaimSpec, reclaimText
} from '../services/compute-pools';
import { MANAGEMENT_CLUSTER, PRODUCT } from '../config/suseai';

export default {
  name: 'ComputePoolsPage',

  components: {
    Banner, LabeledInput, Checkbox, AsyncButton
  },

  data() {
    return {
      pools: [], objects: {}, undiscovered: [], installed: true, loading: true, error: '',
      // the pool whose idle reclaim is being edited, and the edit
      editing: '', draft: null, saveError: ''
    };
  },

  async fetch() {
    try {
      const {
        installed, rows, objects, undiscovered
      } = await listComputePools(this.$store);

      this.installed = installed;
      this.pools = rows;
      this.objects = objects;
      this.undiscovered = undiscovered;
    } catch (e) {
      this.error = e?.message || String(e);
    } finally {
      this.loading = false;
    }
  },

  computed: {
    schedulerLabels: () => ({
      kai: 'KAI Scheduler', runai: 'Run:ai', kueue: 'Kueue', volcano: 'Volcano'
    }),
    sharingLabels:  () => ({ 'kai-fraction': 'KAI fractions', hami: 'HAMi' }),
    trainingLabels: () => ({ 'training-operator': 'Kubeflow Training Operator', 'trainer-v2': 'Kubeflow Trainer v2' }),
    /** Downstream clusters the operator cannot read because Settings has no Rancher token. */
    needsToken() {
      return this.pools.some((p) => p.reason === 'NoRancherToken') || this.undiscovered.length > 0;
    },
    settingsRoute: () => ({ name: `c-cluster-${ PRODUCT }-settings`, params: { cluster: MANAGEMENT_CLUSTER } }),
    draftErrors() {
      return this.draft ? reclaimErrors(this.draft) : {};
    },
  },

  methods: {
    reclaimText,
    canEdit(p) {
      return !!this.objects[p.name]?.canUpdate;
    },
    edit(p) {
      this.editing = p.name;
      this.draft = reclaimDraft(p.reclaim);
      this.saveError = '';
    },
    cancelEdit() {
      this.editing = '';
      this.draft = null;
    },
    async save(done) {
      const obj = this.objects[this.editing];

      if (!obj || Object.keys(this.draftErrors).length) {
        done(false);

        return;
      }
      try {
        const spec = reclaimSpec(this.draft);

        if (spec) {
          obj.spec.reclaim = spec;
        } else {
          delete obj.spec.reclaim;
        }
        await obj.save();
        done(true);
        this.cancelEdit();
        await this.$fetch();
      } catch (e) {
        this.saveError = e?.message || e?._statusText || String(e);
        done(false);
      }
    },
    stackLabels(keys, labels) {
      return keys.map((k) => labels[k] || k);
    },
    statusOf(p) {
      if (p.connected === null) {
        return { label: 'Discovering', tone: 'info' };
      }
      if (!p.connected) {
        return { label: p.reason === 'NoRancherToken' ? 'No Rancher token' : 'Unreachable', tone: 'error' };
      }

      return p.disabled ? { label: 'Disabled', tone: 'muted' } : { label: 'Active', tone: 'success' };
    },
  },
};
</script>

<template>
  <div>
    <header class="page-header">
      <h1>{{ t('suseai.pages.computePools.title') }}</h1>
    </header>
    <p class="text-muted mb-10">
      {{ t('suseai.pages.computePools.description') }}
    </p>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <Banner
      v-if="!installed"
      color="warning"
      :label="t('suseai.pages.computePools.notInstalled')"
    />
    <Banner
      v-if="needsToken"
      color="warning"
    >
      {{ t('suseai.pages.computePools.needsToken') }}
      <router-link :to="settingsRoute">
        {{ t('suseai.pages.computePools.openSettings') }}
      </router-link>
    </Banner>

    <div
      v-if="loading"
      class="text-muted"
    >
      {{ t('suseai.pages.computePools.loading') }}
    </div>
    <div
      v-else-if="installed && !pools.length && !undiscovered.length"
      class="text-muted"
    >
      {{ t('suseai.pages.computePools.empty') }}
    </div>
    <table
      v-else-if="pools.length || undiscovered.length"
      class="sortable-table pools-table"
    >
      <thead>
        <tr>
          <th>{{ t('suseai.pages.computePools.cols.pool') }}</th>
          <th>{{ t('suseai.pages.computePools.cols.kind') }}</th>
          <th>{{ t('suseai.pages.computePools.cols.nodes') }}</th>
          <th>{{ t('suseai.pages.computePools.cols.cpu') }}</th>
          <th>{{ t('suseai.pages.computePools.cols.memory') }}</th>
          <th>{{ t('suseai.pages.computePools.cols.gpus') }}</th>
          <th>{{ t('suseai.pages.computePools.cols.schedulers') }}</th>
          <th>{{ t('suseai.pages.computePools.cols.sharing') }}</th>
          <th>{{ t('suseai.pages.computePools.cols.training') }}</th>
          <th>{{ t('suseai.pages.computePools.cols.reclaim') }}</th>
          <th>{{ t('suseai.pages.computePools.cols.status') }}</th>
        </tr>
      </thead>
      <tbody>
        <template
          v-for="p in pools"
          :key="p.name"
        >
        <tr :class="{ 'text-muted': p.disabled || p.connected === false }">
          <td>{{ p.displayName }}</td>
          <td>
            <span :class="['pool-tag', { 'pool-tag--gpu': p.kind === 'gpu' }]">{{ p.kind === 'gpu' ? 'GPU' : 'CPU' }}</span>
          </td>
          <td>{{ p.nodes }}</td>
          <td>{{ p.cpu }}</td>
          <td>{{ p.memory }}</td>
          <td>
            <template v-if="p.kind === 'gpu'">
              {{ p.gpusRequested }} / {{ p.gpus }}
              <div
                v-if="p.gpuModels.length"
                class="text-muted"
              >
                {{ p.gpuModels.join(', ') }}<template v-if="p.gpuMemoryMiB">
                  · {{ Math.round(p.gpuMemoryMiB / 1024) }} GB
                </template>
              </div>
            </template>
            <template v-else>
              —
            </template>
          </td>
          <td>
            <span
              v-for="l in stackLabels(p.schedulers, schedulerLabels)"
              :key="l"
              class="pool-tag"
            >{{ l }}</span>
            <span
              v-if="!p.schedulers.length"
              class="text-muted"
            >—</span>
          </td>
          <td>
            <span
              v-for="l in stackLabels(p.sharing, sharingLabels)"
              :key="l"
              class="pool-tag"
            >{{ l }}</span>
            <span
              v-if="!p.sharing.length"
              class="text-muted"
            >—</span>
          </td>
          <td>
            <span
              v-for="l in stackLabels(p.training, trainingLabels)"
              :key="l"
              class="pool-tag"
            >{{ l }}</span>
            <span
              v-if="!p.training.length"
              class="text-muted"
            >—</span>
          </td>
          <td>
            <span :class="{ 'text-muted': !p.reclaim }">{{ reclaimText(p.reclaim) }}</span>
            <a
              v-if="canEdit(p) && editing !== p.name"
              href="#"
              class="pool-edit"
              @click.prevent="edit(p)"
            >{{ t('suseai.pages.computePools.reclaim.edit') }}</a>
          </td>
          <td>
            <span
              v-clean-tooltip="p.message"
              :class="['pool-status', `pool-status--${ statusOf(p).tone }`]"
            >{{ statusOf(p).label }}</span>
          </td>
        </tr>
        <tr
          v-if="editing === p.name && draft"
          class="pool-editor"
        >
          <td colspan="11">
            <p class="text-muted">
              {{ t('suseai.pages.computePools.reclaim.help') }}
            </p>
            <Checkbox
              v-model:value="draft.enabled"
              :label="t('suseai.pages.computePools.reclaim.enabled')"
            />
            <div
              v-if="draft.enabled"
              class="pool-editor-fields"
            >
              <LabeledInput
                v-model:value="draft.idleTimeout"
                :label="t('suseai.pages.computePools.reclaim.idleTimeout')"
                :sub-label="draftErrors.idleTimeout || t('suseai.pages.computePools.reclaim.durationHint')"
                :status="draftErrors.idleTimeout ? 'error' : null"
              />
              <LabeledInput
                v-model:value="draft.idleThreshold"
                type="number"
                :label="t('suseai.pages.computePools.reclaim.idleThreshold')"
                :sub-label="draftErrors.idleThreshold || t('suseai.pages.computePools.reclaim.thresholdHint')"
                :status="draftErrors.idleThreshold ? 'error' : null"
              />
              <LabeledInput
                v-model:value="draft.maxIdleTimeout"
                :label="t('suseai.pages.computePools.reclaim.maxIdleTimeout')"
                :sub-label="draftErrors.maxIdleTimeout || t('suseai.pages.computePools.reclaim.maxHint')"
                :status="draftErrors.maxIdleTimeout ? 'error' : null"
              />
              <Checkbox
                v-model:value="draft.onlyWhenContended"
                :label="t('suseai.pages.computePools.reclaim.onlyWhenContended')"
              />
            </div>
            <Banner
              v-if="saveError"
              color="error"
              :label="saveError"
            />
            <div class="pool-editor-actions">
              <button
                class="btn role-secondary"
                @click="cancelEdit"
              >
                {{ t('suseai.pages.computePools.reclaim.cancel') }}
              </button>
              <AsyncButton
                mode="edit"
                :disabled="Object.keys(draftErrors).length > 0"
                @click="save"
              />
            </div>
          </td>
        </tr>
        </template>
        <tr
          v-for="c in undiscovered"
          :key="`undiscovered-${ c.id }`"
          class="text-muted"
        >
          <td>{{ c.name }}</td>
          <td colspan="9">
            {{ t('suseai.pages.computePools.undiscovered') }}
          </td>
          <td>
            <span class="pool-status pool-status--error">{{ t('suseai.pages.computePools.notDiscovered') }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style lang="scss" scoped>
.pools-table {
  width: 100%;

  th, td { padding: 8px 10px; text-align: left; vertical-align: top; }
}

// Quiet tags: an outline, no fill. GPU gets the accent colour so the two kinds read apart at a glance.
.pool-tag {
  display: inline-block;
  margin: 0 4px 4px 0;
  padding: 1px 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;

  &--gpu {
    border-color: var(--primary);
    color: var(--primary);
  }
}

.pool-edit { margin-left: 8px; white-space: nowrap; }

.pool-editor td { background: var(--body-bg); border-top: 1px solid var(--border); }
.pool-editor-fields { display: grid; grid-template-columns: repeat(3, minmax(160px, 240px)); gap: 12px; margin: 12px 0; align-items: start; }
.pool-editor-actions { display: flex; gap: 8px; margin-top: 12px; }

// Status: a coloured dot and plain text.
.pool-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;

  &::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }

  &--success::before { background: var(--success); }
  &--error::before { background: var(--error); }
  &--info::before { background: var(--info); }
}
</style>
