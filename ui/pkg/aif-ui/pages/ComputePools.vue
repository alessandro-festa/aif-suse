<script>
import Banner from '@components/Banner/Banner.vue';
import { Checkbox } from '@components/Form/Checkbox';
import AsyncButton from '@shell/components/AsyncButton.vue';
import LabeledSelect from '@shell/components/form/LabeledSelect.vue';
import {
  addonsFor, canInstallAddons, installAddon, listAddonInstalls, uninstallAddon
} from '../services/addons';
import {
  canEditPools, listComputePools, reclaimDraft, reclaimErrors, reclaimSpec, reclaimText, savePoolReclaim
} from '../services/compute-pools';

// How often the page reads the pools again: the operator refreshes them every minute.
const REFRESH_MS = 30000;
import { MANAGEMENT_CLUSTER, PRODUCT } from '../config/suseai';

export default {
  name: 'ComputePoolsPage',

  components: {
    Banner, Checkbox, AsyncButton, LabeledSelect
  },

  data() {
    return {
      pools: [], undiscovered: [], installed: true, loading: true, error: '', canEdit: false,
      // the pool whose idle reclaim is being edited, and the edit
      editing: '', draft: null, saveError: '',
      // pools whose consumers are shown
      open: {},
      // cluster add-ons: what is installed (Fleet HelmOps), and the install panel
      installs: [], canInstall: false, adding: false, addCluster: '', addKey: '', addError: '',
      timer: null
    };
  },

  async fetch() {
    try {
      const [{ installed, rows, undiscovered }, canEdit, installs, canInstall] = await Promise.all([
        listComputePools(this.$store),
        canEditPools(this.$store),
        listAddonInstalls(this.$store),
        canInstallAddons(this.$store),
      ]);

      this.installs = installs;
      this.canInstall = canInstall;

      this.installed = installed;
      this.pools = rows;
      this.undiscovered = undiscovered;
      this.canEdit = canEdit;
      this.error = '';
    } catch (e) {
      this.error = e?.message || String(e);
    } finally {
      this.loading = false;
    }
  },

  mounted() {
    this.timer = setInterval(() => {
      if (!this.editing) {
        this.$fetch();
      }
    }, REFRESH_MS);
  },

  beforeUnmount() {
    clearInterval(this.timer);
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
    clusterOptions() {
      const seen = new Map();

      this.pools.forEach((p) => seen.set(p.clusterId, p.clusterName || p.clusterId));

      return [...seen].map(([value, label]) => ({ label, value }));
    },
    addonOptions() {
      return this.addCluster ? addonsFor(this.addCluster, this.pools, this.installs).map((a) => ({ label: `${ a.display } ${ a.version }`, value: a.key })) : [];
    },
    addAddon() {
      return addonsFor(this.addCluster, this.pools, this.installs).find((a) => a.key === this.addKey) || null;
    },
  },

  methods: {
    reclaimText,
    clusterLabel(id) {
      return this.clusterOptions.find((c) => c.value === id)?.label || id;
    },
    async install(done) {
      this.addError = '';
      try {
        await installAddon(this.$store, this.addAddon, this.addCluster);
        done(true);
        this.adding = false;
        this.addKey = '';
        await this.$fetch();
      } catch (e) {
        this.addError = e?.message || e?._statusText || String(e);
        done(false);
      }
    },
    uninstall(i) {
      this.$store.dispatch('management/promptModal', {
        component:      'GenericPrompt',
        componentProps: {
          title:       `Uninstall ${ i.addon.display } from ${ this.clusterLabel(i.clusterId) }?`,
          body:        `Fleet removes its release from the cluster. Runs that use it (${ i.addon.kind === 'sharing' ? 'its GPU shares' : i.addon.kind === 'scheduler' ? 'its queues' : 'its training jobs' }) stop working there.`,
          applyMode:   'delete',
          actionColor: 'bg-error',
          applyAction: async() => {
            await uninstallAddon(this.$store, i.addon, i.clusterId);
            await this.$fetch();
          },
        },
      });
    },
    toggle(p) {
      this.open = { ...this.open, [p.name]: !this.open[p.name] };
    },
    consumerLabel(c) {
      if (c.kind === 'rest') {
        return 'Everything else';
      }

      if (c.kind === 'run' || c.name) {
        return c.name;
      }

      return this.t('suseai.pages.computePools.consumers.otherPods');
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
      if (Object.keys(this.draftErrors).length) {
        done(false);

        return;
      }
      try {
        await savePoolReclaim(this.$store, this.editing, reclaimSpec(this.draft));
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
          <td>
            <a
              href="#"
              class="pool-toggle"
              :title="t('suseai.pages.computePools.consumers.toggle')"
              @click.prevent="toggle(p)"
            ><i :class="['icon', open[p.name] ? 'icon-chevron-down' : 'icon-chevron-right']" /> {{ p.displayName }}</a>
          </td>
          <td>
            <span :class="['pool-tag', { 'pool-tag--gpu': p.kind === 'gpu' }]">{{ p.kind === 'gpu' ? 'GPU' : 'CPU' }}</span>
          </td>
          <td>{{ p.nodes }}</td>
          <td>
            {{ p.cpu }}
            <div class="text-muted">
              <template v-if="p.used">
                {{ p.used.cpu }} {{ t('suseai.pages.computePools.inUse') }} ·
              </template>{{ p.free.cpu }} {{ t('suseai.pages.computePools.free') }}
            </div>
          </td>
          <td>
            {{ p.memory }}
            <div class="text-muted">
              <template v-if="p.used">
                {{ p.used.memory }} {{ t('suseai.pages.computePools.inUse') }} ·
              </template>{{ p.free.memory }} {{ t('suseai.pages.computePools.free') }}
            </div>
          </td>
          <td>
            <template v-if="p.kind === 'gpu'">
              {{ p.gpusRequested }} / {{ p.gpus }}
              <div class="text-muted">
                {{ p.free.gpus }} {{ t('suseai.pages.computePools.free') }}
              </div>
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
              v-clean-tooltip="t('suseai.pages.computePools.builtin.schedulerTip')"
              class="pool-tag pool-tag--builtin"
            >{{ t('suseai.pages.computePools.builtin.scheduler') }}</span>
          </td>
          <td>
            <span
              v-for="l in stackLabels(p.sharing, sharingLabels)"
              :key="l"
              class="pool-tag"
            >{{ l }}</span>
            <span
              v-if="!p.sharing.length && p.kind === 'gpu'"
              class="pool-tag pool-tag--builtin"
            >{{ t('suseai.pages.computePools.builtin.sharing') }}</span>
            <span
              v-else-if="!p.sharing.length"
              class="text-muted"
            >—</span>
          </td>
          <td>
            <span
              v-clean-tooltip="t('suseai.pages.computePools.builtin.trainingTip')"
              class="pool-tag pool-tag--builtin"
            >{{ t('suseai.pages.computePools.builtin.training') }}</span>
            <span
              v-for="l in stackLabels(p.training, trainingLabels)"
              :key="l"
              class="pool-tag"
            >{{ l }}</span>
          </td>
          <td>
            <span :class="{ 'text-muted': !p.reclaim }">{{ reclaimText(p.reclaim) }}</span>
            <a
              v-if="canEdit && editing !== p.name"
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
          v-if="open[p.name]"
          class="pool-consumers"
        >
          <td colspan="11">
            <p
              v-if="!p.consumers.length"
              class="text-muted"
            >
              {{ t('suseai.pages.computePools.consumers.none') }}
            </p>
            <table v-else>
              <thead>
                <tr>
                  <th>{{ t('suseai.pages.computePools.consumers.what') }}</th>
                  <th>{{ t('suseai.pages.computePools.consumers.namespace') }}</th>
                  <th>{{ t('suseai.pages.computePools.consumers.project') }}</th>
                  <th>{{ t('suseai.pages.computePools.consumers.pods') }}</th>
                  <th>{{ t('suseai.pages.computePools.consumers.cpu') }}</th>
                  <th>{{ t('suseai.pages.computePools.consumers.memory') }}</th>
                  <th v-if="p.kind === 'gpu'">
                    GPUs
                  </th>
                  <th>{{ t('suseai.pages.computePools.consumers.activity') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="c in p.consumers"
                  :key="`${ c.kind }/${ c.namespace }/${ c.name }`"
                >
                  <td>
                    <span
                      v-if="c.kind === 'run'"
                      class="pool-tag"
                    >{{ t('suseai.pages.computePools.consumers.run') }}</span>
                    {{ consumerLabel(c) }}
                    <span
                      v-if="c.phase"
                      class="text-muted"
                    > · {{ c.phase }}</span>
                  </td>
                  <td>{{ c.namespace || '—' }}</td>
                  <td>{{ c.project || '—' }}</td>
                  <td>{{ c.pods }}</td>
                  <td>
                    {{ c.cpu }}<span
                      v-if="c.usedCpu"
                      class="text-muted"
                    > · {{ c.usedCpu }} {{ t('suseai.pages.computePools.inUse') }}</span>
                  </td>
                  <td>
                    {{ c.memory }}<span
                      v-if="c.usedMemory"
                      class="text-muted"
                    > · {{ c.usedMemory }} {{ t('suseai.pages.computePools.inUse') }}</span>
                  </td>
                  <td v-if="p.kind === 'gpu'">
                    {{ c.gpus }}
                  </td>
                  <td class="text-muted">
                    {{ c.activity || '—' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
        <tr
          v-if="editing === p.name && draft"
          class="pool-editor"
        >
          <td colspan="11">
            <div class="pool-editor-line">
              <Checkbox
                v-model:value="draft.enabled"
                :label="t('suseai.pages.computePools.reclaim.enabled')"
              />
              <template v-if="draft.enabled">
                <label
                  v-clean-tooltip="t('suseai.pages.computePools.reclaim.durationHint')"
                  :class="['pool-field', { 'pool-field--error': draftErrors.idleTimeout }]"
                >{{ t('suseai.pages.computePools.reclaim.idleTimeout') }}
                  <input
                    v-model="draft.idleTimeout"
                    type="text"
                    placeholder="2h"
                  >
                </label>
                <label
                  v-clean-tooltip="t('suseai.pages.computePools.reclaim.thresholdHint')"
                  :class="['pool-field', { 'pool-field--error': draftErrors.idleThreshold }]"
                >{{ t('suseai.pages.computePools.reclaim.idleThreshold') }}
                  <input
                    v-model.number="draft.idleThreshold"
                    type="number"
                    min="1"
                    max="100"
                  >
                </label>
                <label
                  v-clean-tooltip="t('suseai.pages.computePools.reclaim.maxHint')"
                  :class="['pool-field', { 'pool-field--error': draftErrors.maxIdleTimeout }]"
                >{{ t('suseai.pages.computePools.reclaim.maxIdleTimeout') }}
                  <input
                    v-model="draft.maxIdleTimeout"
                    type="text"
                    :placeholder="draft.idleTimeout"
                  >
                </label>
                <Checkbox
                  v-model:value="draft.onlyWhenContended"
                  :label="t('suseai.pages.computePools.reclaim.onlyWhenContended')"
                />
              </template>
              <span class="pool-editor-actions">
                <button
                  class="btn btn-sm role-secondary"
                  @click="cancelEdit"
                >
                  {{ t('suseai.pages.computePools.reclaim.cancel') }}
                </button>
                <AsyncButton
                  mode="edit"
                  size="sm"
                  :disabled="Object.keys(draftErrors).length > 0"
                  @click="save"
                />
              </span>
            </div>
            <p
              v-if="Object.keys(draftErrors).length"
              class="pool-editor-error"
            >
              {{ Object.values(draftErrors).join(' · ') }}
            </p>
            <p
              v-else
              class="text-muted pool-editor-help"
            >
              {{ t('suseai.pages.computePools.reclaim.help') }}
            </p>
            <Banner
              v-if="saveError"
              color="error"
              :label="saveError"
            />
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

    <section
      v-if="installed && (canInstall || installs.length)"
      class="pool-addons"
    >
      <header>
        <h3>{{ t('suseai.pages.computePools.addons.title') }}</h3>
        <button
          v-if="canInstall && !adding"
          class="btn btn-sm role-secondary"
          @click="adding = true"
        >
          {{ t('suseai.pages.computePools.addons.install') }}
        </button>
      </header>
      <p class="text-muted">
        {{ t('suseai.pages.computePools.addons.description') }}
      </p>

      <div
        v-if="adding"
        class="pool-addon-form"
      >
        <div class="pool-addon-fields">
          <LabeledSelect
            v-model:value="addCluster"
            :options="clusterOptions"
            :label="t('suseai.pages.computePools.addons.cluster')"
            @update:value="addKey = ''"
          />
          <LabeledSelect
            v-model:value="addKey"
            :options="addonOptions"
            :disabled="!addCluster"
            :label="t('suseai.pages.computePools.addons.addon')"
            :placeholder="addCluster && !addonOptions.length ? t('suseai.pages.computePools.addons.nothingLeft') : ''"
          />
        </div>
        <p
          v-if="addAddon"
          class="pool-addon-notes"
        >
          <span class="pool-tag">{{ addAddon.chart }} {{ addAddon.version }} → {{ addAddon.namespace }}</span>
          {{ addAddon.notes }}
        </p>
        <Banner
          v-if="addError"
          color="error"
          :label="addError"
        />
        <div class="pool-editor-actions">
          <button
            class="btn btn-sm role-secondary"
            @click="adding = false; addError = ''"
          >
            {{ t('suseai.pages.computePools.reclaim.cancel') }}
          </button>
          <AsyncButton
            mode="create"
            size="sm"
            :action-label="t('suseai.pages.computePools.addons.installAction')"
            :disabled="!addAddon"
            @click="install"
          />
        </div>
      </div>

      <table
        v-if="installs.length"
        class="pool-addon-list"
      >
        <tr
          v-for="i in installs"
          :key="`${ i.clusterId }/${ i.addon.key }`"
        >
          <td>{{ clusterLabel(i.clusterId) }}</td>
          <td>{{ i.addon.display }} <span class="text-muted">{{ i.addon.version }}</span></td>
          <td>
            <span
              v-clean-tooltip="i.message"
              :class="['pool-status', `pool-status--${ i.ready ? 'success' : (/err/i.test(i.state) ? 'error' : 'info') }`]"
            >{{ i.state }}</span>
          </td>
          <td>
            <a
              v-if="canInstall"
              href="#"
              @click.prevent="uninstall(i)"
            >{{ t('suseai.pages.computePools.addons.uninstall') }}</a>
          </td>
        </tr>
      </table>
    </section>
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

  // what every cluster has without an add-on
  &--builtin {
    border-style: dashed;
    color: var(--muted);
  }
}

.pool-edit { margin-left: 8px; white-space: nowrap; }
.pool-toggle { white-space: nowrap; }
.pool-addons { margin-top: 24px; border-top: 1px solid var(--border); padding-top: 12px;
  header { display: flex; align-items: center; gap: 12px; h3 { margin: 0; } }
}
.pool-addon-form { border: 1px solid var(--border); border-radius: var(--border-radius); padding: 12px; margin: 8px 0 12px; max-width: 760px; }
.pool-addon-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.pool-addon-notes { margin: 10px 0 0; font-size: 13px; }
.pool-addon-list { td { padding: 6px 16px 6px 0; } }
.pool-consumers td { background: var(--body-bg); border-top: 1px solid var(--border); }
.pool-consumers table { width: 100%; th, td { padding: 4px 10px 4px 0; text-align: left; font-size: 13px; background: none; border: none; } }

.pool-editor td { background: var(--body-bg); border-top: 1px solid var(--border); }
.pool-editor-line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; }
.pool-field { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; color: var(--muted);
  input { width: 72px; height: 30px; padding: 0 8px; }
  &--error input { border-color: var(--error); }
}
.pool-editor-actions { display: inline-flex; gap: 8px; margin-left: auto; }
.pool-editor-help, .pool-editor-error { margin: 8px 0 0; font-size: 12px; }
.pool-editor-error { color: var(--error); }

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
