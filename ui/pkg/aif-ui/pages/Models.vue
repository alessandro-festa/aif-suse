<template>
  <main class="main-layout">
    <div class="outlet">
      <!-- Header -->
      <header class="fixed-header">
        <h1>{{ t('suseai.models.title', 'Models') }}</h1>
        <p class="page-subtitle">
          {{ t('suseai.models.subtitle', 'Browse validated vLLM inference recipes and deploy them with the SUSE Application Collection vLLM engine.') }}
        </p>

        <!-- Toolbar with filters and actions -->
        <div class="actions-container" role="toolbar" aria-label="Model filters and actions">
          <div class="search-box">
            <label for="model-search-input" class="filter-label">Search</label>
            <input
              id="model-search-input"
              v-model="search"
              type="search"
              :placeholder="t('suseai.models.search', 'Search models')"
              class="input-sm"
              aria-label="Search models"
            />
          </div>

          <div class="filter-group">
            <label for="vendor-filter" class="filter-label">GPU vendor</label>
            <select id="vendor-filter" v-model="selectedVendor" class="form-control" aria-label="Filter by GPU vendor">
              <option v-for="opt in vendorOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </div>

          <div class="filter-group">
            <label for="family-filter" class="filter-label">GPU family</label>
            <select id="family-filter" v-model="selectedFamily" class="form-control" aria-label="Filter by GPU family">
              <option value="">{{ t('suseai.models.allFamilies', 'All GPU families') }}</option>
              <option v-for="f in familyOptions" :key="f" :value="f">{{ f }}</option>
            </select>
          </div>

          <div class="filter-group">
            <label for="size-filter" class="filter-label">Size</label>
            <select id="size-filter" v-model="selectedSize" class="form-control" aria-label="Filter by size">
              <option value="">{{ t('suseai.models.allSizes', 'All sizes') }}</option>
              <option v-for="s in SIZE_OPTIONS" :key="s.value" :value="s.value">{{ s.label }}</option>
            </select>
          </div>

          <div class="filter-group">
            <label for="validation-filter" class="filter-label">Validation</label>
            <select id="validation-filter" v-model="selectedValidation" class="form-control" aria-label="Filter by validation">
              <option value="all">{{ t('suseai.models.allValidation', 'All') }}</option>
              <option value="validated">{{ t('suseai.models.validated', 'Validated') }}</option>
              <option value="unvalidated">{{ t('suseai.models.unvalidated', 'Not validated') }}</option>
            </select>
          </div>

          <div class="filter-group">
            <label for="arch-filter" class="filter-label">Architecture</label>
            <select id="arch-filter" v-model="selectedArch" class="form-control" aria-label="Filter by architecture">
              <option value="">{{ t('suseai.models.allArch', 'All architectures') }}</option>
              <option value="dense">Dense</option>
              <option value="moe">MoE</option>
            </select>
          </div>

          <div class="filter-group">
            <label for="precision-filter" class="filter-label">Precision</label>
            <select id="precision-filter" v-model="selectedPrecision" class="form-control" aria-label="Filter by precision">
              <option value="">{{ t('suseai.models.allPrecision', 'All precisions') }}</option>
              <option v-for="p in precisionOptions" :key="p" :value="p">{{ p.toUpperCase() }}</option>
            </select>
          </div>

          <div class="view-controls" role="group" aria-label="View mode selection">
            <button
              :class="['btn', 'btn-sm', viewMode === 'tiles' ? 'role-primary' : 'role-secondary']"
              @click="viewMode = 'tiles'"
              :title="t('suseai.models.tileView', 'Tile View')"
              :aria-pressed="viewMode === 'tiles'"
              type="button"
            >
              <i class="icon icon-th view-icon-grid" aria-hidden="true" />
            </button>
            <button
              :class="['btn', 'btn-sm', viewMode === 'list' ? 'role-primary' : 'role-secondary']"
              @click="viewMode = 'list'"
              :title="t('suseai.models.listView', 'List View')"
              :aria-pressed="viewMode === 'list'"
              type="button"
            >
              <i class="icon icon-th-list view-icon-list" aria-hidden="true" />
            </button>
          </div>

          <button class="btn role-primary" @click="refresh" :disabled="loading" type="button" aria-label="Refresh models">
            <i v-if="loading" class="icon icon-spinner icon-spin" aria-hidden="true" />
            <i v-else class="icon icon-refresh" aria-hidden="true" />
            {{ t('suseai.models.refresh', 'Refresh') }}
          </button>
        </div>
      </header>

      <!-- Error state -->
      <div v-if="error" class="banner bg-error"><span>{{ error }}</span></div>

      <div class="main-content">
        <div class="results-summary" aria-live="polite">
          <div v-if="filteredModels.length" class="results-text">
            Showing {{ filteredModels.length }} of {{ items.length }} models
          </div>
        </div>

        <!-- Tiles view -->
        <div v-if="viewMode === 'tiles'" class="tiles-grid" role="grid" aria-label="Models grid">
          <div
            v-for="model in filteredModels"
            :key="model.id"
            class="app-tile clickable-tile"
            role="button"
            tabindex="0"
            :aria-label="`View ${ model.title }`"
            @click="openDetail(model)"
            @keydown.enter="openDetail(model)"
            @keydown.space.prevent="openDetail(model)"
          >
            <div class="tile-header">
              <img
                v-if="model.logoUrl && !failedLogos[model.id]"
                :src="model.logoUrl"
                alt=""
                class="tile-logo model-logo"
                @error="onLogoError(model)"
              />
              <div v-else class="tile-logo provider-avatar" :style="{ background: providerColor(model.provider) }" :aria-hidden="true">
                {{ providerInitial(model) }}
              </div>
              <div class="tile-info">
                <div class="tile-title-row">
                  <h3 class="tile-title">{{ model.title }}</h3>
                </div>
                <div class="tile-meta">
                  <span class="tile-meta-item">{{ model.provider }}</span>
                  <span class="tile-meta-item">{{ model.id }}</span>
                </div>
              </div>
              <div class="tile-actions">
                <a v-if="model.recipeUrl" :href="model.recipeUrl" target="_blank" rel="noopener noreferrer" class="action-link" title="Open on recipes.vllm.ai" @click.stop>
                  <i class="icon icon-external-link" />
                </a>
              </div>
            </div>

            <div class="tile-content">
              <div class="chip-row badge-row">
                <span v-if="model.communityValidated" class="badge badge-validated">
                  <i class="icon icon-checkmark" aria-hidden="true" /> {{ t('suseai.models.communityValidated', 'Community validated') }}
                </span>
                <span v-if="model.free" class="badge badge-free">{{ t('suseai.models.free', 'Free') }}</span>
              </div>
              <div class="chip-row">
                <span class="chip chip-arch">{{ model.architecture === 'moe' ? 'MoE' : 'Dense' }}</span>
                <span class="chip">{{ paramLabel(model) }}</span>
                <span class="chip">{{ contextLabel(model.contextLength) }}</span>
                <span v-for="p in model.precisions" :key="p" class="chip chip-precision">{{ p.toUpperCase() }}</span>
              </div>
              <div class="chip-row gpu-row">
                <span v-if="(model.verifiedFamilies || []).length" class="verified-tag">
                  <i class="icon icon-checkmark" aria-hidden="true" /> {{ t('suseai.models.vllmVerified', 'Verified by vLLM community') }}
                </span>
                <span v-else class="unverified-tag">{{ t('suseai.models.notValidated', 'Not validated') }}</span>
                <span
                  v-for="f in model.gpuFamilies"
                  :key="f"
                  :class="['chip', isVerified(model, f) ? 'chip-verified' : 'chip-gpu']"
                >{{ f }}</span>
              </div>
              <p class="tile-description">{{ model.description || '—' }}</p>
            </div>

            <div class="tile-footer">
              <button class="btn btn-sm role-primary" type="button" @click.stop="openDetail(model)">
                {{ t('suseai.models.viewDetails', 'View details & deploy') }}
              </button>
            </div>
          </div>
          <div v-for="n in 5" :key="`filler-${n}`" class="app-tile app-tile-filler"></div>
        </div>

        <!-- List view -->
        <div v-else class="list-view">
          <table class="table">
            <thead>
              <tr>
                <th>{{ t('suseai.models.name', 'Model') }}</th>
                <th>{{ t('suseai.models.arch', 'Arch') }}</th>
                <th>{{ t('suseai.models.params', 'Params') }}</th>
                <th>{{ t('suseai.models.context', 'Context') }}</th>
                <th>{{ t('suseai.models.precision', 'Precision') }}</th>
                <th>{{ t('suseai.models.gpu', 'GPU families') }}</th>
                <th class="text-right">{{ t('suseai.models.actions', 'Actions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="model in filteredModels"
                :key="model.id"
                class="main-row clickable-row"
                role="button"
                tabindex="0"
                @click="openDetail(model)"
                @keydown.enter="openDetail(model)"
                @keydown.space.prevent="openDetail(model)"
              >
                <td class="col-name">
                  <div class="name-cell">
                    <img
                      v-if="model.logoUrl && !failedLogos[model.id]"
                      :src="model.logoUrl"
                      alt=""
                      class="table-logo model-logo"
                      @error="onLogoError(model)"
                    />
                    <div v-else class="table-logo provider-avatar" :style="{ background: providerColor(model.provider) }">
                      {{ providerInitial(model) }}
                    </div>
                    <div class="name-info">
                      <div class="app-name">{{ model.title }}</div>
                      <div class="app-meta">
                        <span class="list-pkg">{{ model.provider }}</span>
                        <span v-if="model.communityValidated" class="badge badge-validated badge-sm"><i class="icon icon-checkmark" aria-hidden="true" /> {{ t('suseai.models.communityValidated', 'Community validated') }}</span>
                        <span v-if="model.free" class="badge badge-free badge-sm">{{ t('suseai.models.free', 'Free') }}</span>
                      </div>
                    </div>
                  </div>
                </td>
                <td>{{ model.architecture === 'moe' ? 'MoE' : 'Dense' }}</td>
                <td>{{ paramLabel(model) }}</td>
                <td>{{ contextLabel(model.contextLength) }}</td>
                <td>{{ model.precisions.map(p => p.toUpperCase()).join(', ') }}</td>
                <td>{{ model.gpuFamilies.join(', ') }}</td>
                <td class="col-actions text-right">
                  <a v-if="model.recipeUrl" :href="model.recipeUrl" target="_blank" rel="noopener noreferrer" class="action-link" title="View recipe">
                    <i class="icon icon-external-link" />
                  </a>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Empty state: no results after filtering -->
        <div v-if="!loading && !filteredModels.length && items.length > 0 && !error" class="empty-state-content">
          <i class="icon icon-folder-open icon-4x text-muted" />
          <h3>{{ t('suseai.models.noModels', 'No models found') }}</h3>
          <p class="text-muted">{{ t('suseai.models.noModelsDesc', 'Try adjusting your search or filters.') }}</p>
        </div>
      </div>
    </div>
  </main>
</template>

<script lang="ts">
import { defineComponent, computed, getCurrentInstance, onMounted, ref } from 'vue';
import { useT } from '../composables/useT';
import type { GpuVendor, ModelCatalogEntry } from '../types/model-catalog';
import { fetchModelsCatalog } from '../services/models-catalog';

// Stable-ish brand colors for the initial-avatar fallback when no logo loads.
const PROVIDER_COLORS: Record<string, string> = {
  'Qwen':       '#615ced',
  'Meta':       '#0668e1',
  'Google':     '#4285f4',
  'Mistral AI': '#fa520f',
  'DeepSeek':   '#4d6bfe',
  'NVIDIA':     '#76b900',
  'Microsoft':  '#0078d4',
  'AMD':        '#ed1c24',
  'DeepSeek AI':'#4d6bfe',
};

const SIZE_OPTIONS = [
  { value: 'small',  label: 'Small (≤ 8B)' },
  { value: 'medium', label: 'Medium (8–34B)' },
  { value: 'large',  label: 'Large (35–100B)' },
  { value: 'xlarge', label: 'X-Large (> 100B)' },
];

const VENDOR_LABELS: Record<string, string> = {
  nvidia: 'NVIDIA',
  amd:    'AMD',
  tpu:    'TPU',
  cpu:    'CPU',
};

export default defineComponent({
  name: 'SuseAIModels',

  setup() {
    const vm = getCurrentInstance();
    const $router = (vm as any)?.proxy?.$router;
    const route = (vm as any)?.proxy?.$route;
    const currentClusterId = (route?.params?.cluster as string) || 'local';

    const loading = ref(true);
    const error = ref<string | null>(null);
    const items = ref<ModelCatalogEntry[]>([]);
    const failedLogos = ref<Record<string, boolean>>({});

    const search = ref('');
    // Decision D3: default to NVIDIA GPU family only for now.
    const selectedVendor = ref<GpuVendor>('nvidia');
    const selectedFamily = ref('');
    const selectedSize = ref('');
    const selectedArch = ref('');
    const selectedPrecision = ref('');
    const selectedValidation = ref('all'); // all | validated | unvalidated
    const viewMode = ref('tiles');

    // Vendor options are data-driven; NVIDIA first, others as present.
    const vendorOptions = computed(() => {
      const present = new Set<string>();
      for (const m of items.value) present.add(m.gpuVendor);
      const order = ['nvidia', 'amd', 'tpu', 'cpu'].filter(v => present.has(v));
      return order.map(v => ({ value: v, label: VENDOR_LABELS[v] || v.toUpperCase() }));
    });

    // GPU family options within the selected vendor.
    const familyOptions = computed(() => {
      const set = new Set<string>();
      for (const m of items.value) {
        if (m.gpuVendor !== selectedVendor.value) continue;
        for (const f of m.gpuFamilies) set.add(f);
      }
      return Array.from(set).sort();
    });

    // Precision options within the selected vendor.
    const precisionOptions = computed(() => {
      const set = new Set<string>();
      for (const m of items.value) {
        if (m.gpuVendor !== selectedVendor.value) continue;
        for (const p of m.precisions) set.add(p);
      }
      return Array.from(set).sort();
    });

    const filteredModels = computed(() => {
      let arr = items.value.slice();
      arr = arr.filter(m => m.gpuVendor === selectedVendor.value);
      if (selectedFamily.value) arr = arr.filter(m => m.gpuFamilies.includes(selectedFamily.value));
      if (selectedSize.value) arr = arr.filter(m => m.sizeBucket === selectedSize.value);
      if (selectedArch.value) arr = arr.filter(m => m.architecture === selectedArch.value);
      if (selectedPrecision.value) arr = arr.filter(m => m.precisions.includes(selectedPrecision.value));
      if (selectedValidation.value === 'validated') arr = arr.filter(m => (m.verifiedFamilies || []).length > 0);
      else if (selectedValidation.value === 'unvalidated') arr = arr.filter(m => (m.verifiedFamilies || []).length === 0);
      if (search.value) {
        const q = search.value.toLowerCase();
        arr = arr.filter(m =>
          m.title.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q) ||
          m.description?.toLowerCase().includes(q)
        );
      }
      return arr;
    });

    const paramLabel = (m: ModelCatalogEntry): string =>
      m.activeParameters ? `${m.parameterCount} · ${m.activeParameters} active` : m.parameterCount;

    const contextLabel = (ctx: number): string => {
      if (ctx >= 1000) return `${Math.round(ctx / 1024)}K ctx`;
      return `${ctx} ctx`;
    };

    const providerInitial = (m: ModelCatalogEntry): string =>
      (m.provider || m.title || '?').trim().charAt(0).toUpperCase();

    const providerColor = (provider: string): string => PROVIDER_COLORS[provider] || 'var(--primary)';

    const isVerified = (m: ModelCatalogEntry, family: string): boolean =>
      (m.verifiedFamilies || []).includes(family);

    const onLogoError = (m: ModelCatalogEntry) => {
      failedLogos.value = { ...failedLogos.value, [m.id]: true };
    };

    const openDetail = (m: ModelCatalogEntry) => {
      $router?.push({
        name:   'c-cluster-suseai-model-detail',
        params: { cluster: currentClusterId },
        query:  { id: m.id },
      }).catch((err: any) => {
        if (err?.name !== 'NavigationDuplicated') console.warn('Navigation failed:', err);
      });
    };

    const loadModels = async () => {
      items.value = await fetchModelsCatalog();
    };

    const refresh = async () => {
      loading.value = true;
      error.value = null;
      try {
        await loadModels();
      } catch (err) {
        console.error('Failed to load models:', err);
        error.value = 'Failed to load models';
      } finally {
        loading.value = false;
      }
    };

    onMounted(() => { refresh(); });

    const t = useT();

    return {
      loading, error, items, failedLogos,
      search, selectedVendor, selectedFamily, selectedSize, selectedArch, selectedPrecision, selectedValidation, viewMode,
      vendorOptions, familyOptions, precisionOptions, filteredModels,
      SIZE_OPTIONS,
      paramLabel, contextLabel, providerInitial, providerColor, isVerified, onLogoError, openDetail, refresh, t,
    };
  }
});
</script>

<style lang="scss" scoped>
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.fixed-header {
  margin-bottom: 24px;

  h1 { margin: 0; }

  .page-subtitle {
    margin: 6px 0 18px;
    color: var(--muted);
    font-size: 14px;
    max-width: 780px;
  }

  .actions-container {
    display: flex;
    align-items: flex-end;
    gap: 12px;
    flex-wrap: wrap;
    min-height: 40px;

    .filter-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--muted);
      margin-bottom: 4px;
    }

    .search-box, .filter-group { display: flex; flex-direction: column; }

    .search-box .input-sm {
      width: 200px;
      height: 32px;
      padding: 0 12px;
      border: 1px solid var(--border);
      border-radius: var(--border-radius);
      background: var(--input-bg);
      color: var(--body-text);
      font-size: 14px;

      &::placeholder { color: var(--muted); }
      &:focus { outline: none; border-color: var(--outline); box-shadow: 0 0 0 2px var(--primary-keyboard-focus); }
    }

    .filter-group .form-control {
      min-width: 150px;
      width: auto;
      height: 32px;
      padding: 0 12px;
      border: 1px solid var(--border);
      border-radius: var(--border-radius);
      background: var(--input-bg);
      color: var(--body-text);
      font-size: 14px;
      appearance: none;
      background-image: url("data:image/svg+xml;charset=US-ASCII,<svg xmlns='http://www.w3.org/2000/svg' width='4' height='5'><path fill='%23666' d='m0 1 2 2 2-2z'/></svg>");
      background-repeat: no-repeat;
      background-position: right 8px center;
      background-size: 12px;

      &:focus { outline: none; border-color: var(--outline); box-shadow: 0 0 0 2px var(--primary-keyboard-focus); }
    }

    .view-controls {
      display: flex;
      border: 1px solid var(--border);
      border-radius: var(--border-radius);
      overflow: hidden;
      background: var(--input-bg);
      margin-left: auto;

      .btn {
        border: none;
        background: transparent;
        padding: 6px 10px;
        min-width: 32px;
        height: 32px;
        color: var(--muted);

        &.role-primary { background: var(--primary); color: var(--primary-text); }
        &.role-secondary:hover { background: var(--hover-bg); color: var(--body-text); }
        &:not(:last-child) { border-right: 1px solid var(--border); }
      }
    }
  }
}

.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}

.results-summary { padding: 8px 0 16px; color: var(--muted); font-size: 14px; font-weight: 500; }

.banner {
  margin-bottom: 20px; padding: 12px 16px; border-radius: 4px;
  &.bg-error { background-color: var(--error-banner-bg); border: 1px solid var(--error); color: var(--error); }
}

.tiles-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 20px;
  align-items: stretch;

  @media (max-width: 768px) { grid-template-columns: 1fr; }
}

.app-tile {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: transparent;
  padding: 20px;
  gap: 16px;
  min-height: 240px;
  transition: border-color 0.2s ease;

  &:hover { border-color: var(--primary); }

  .tile-header {
    display: flex;
    align-items: flex-start;
    gap: 16px;

    .tile-logo {
      width: 52px;
      height: 52px;
      border-radius: 12px;
      flex-shrink: 0;
      box-shadow: 0 2px 4px rgba(15, 23, 42, 0.08);
    }

    .provider-avatar {
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--primary);
      color: var(--primary-text);
      font-size: 22px;
      font-weight: 700;
    }

    .tile-info { flex: 1; min-width: 0; }
  }

  .tile-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .tile-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.4; color: var(--body-text); }

  .tile-meta {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    margin-top: 6px; color: var(--muted); font-size: 12px;
  }
  .tile-meta-item { display: inline-flex; align-items: center; font-weight: 500; }
  .tile-meta-item + .tile-meta-item {
    position: relative; padding-left: 12px;
    &::before { content: '•'; position: absolute; left: 2px; color: var(--muted); }
  }

  .tile-content { flex: 1; display: flex; flex-direction: column; gap: 10px; }

  .chip-row { display: flex; flex-wrap: wrap; gap: 6px; }

  .tile-description {
    margin: 4px 0 0;
    color: var(--body-text);
    line-height: 1.5;
    font-size: 14px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .tile-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-top: 4px;
  }
}

.chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.6;
  background: var(--accent-btn);
  color: var(--body-text);
  border: 1px solid var(--border);
}
.chip-arch { background: var(--primary); color: var(--primary-text); border-color: var(--primary); }
.chip-precision { background: transparent; color: var(--muted); }
.chip-gpu { background: transparent; color: var(--body-text); border-style: dashed; }

.verified-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 700;
  color: #4a7a00;
  .icon { font-size: 11px; }
}
body.theme-dark .verified-tag { color: #9bd649; }

.unverified-tag {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
}

.chip-verified {
  background: rgba(118, 185, 0, 0.14);
  color: #4a7a00;
  border: 1px solid rgba(118, 185, 0, 0.5);
}
body.theme-dark .chip-verified { color: #9bd649; }

.badge-row { margin-bottom: 2px; }

.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.6;
  letter-spacing: 0.02em;

  .icon { font-size: 11px; }
  &.badge-sm { padding: 1px 6px; font-size: 10px; }
}
.badge-validated {
  background: rgba(118, 185, 0, 0.14);
  color: #4a7a00;
  border: 1px solid rgba(118, 185, 0, 0.5);
}
body.theme-dark .badge-validated { color: #9bd649; }
.badge-free {
  background: rgba(0, 120, 212, 0.12);
  color: #0a63b0;
  border: 1px solid rgba(0, 120, 212, 0.45);
}
body.theme-dark .badge-free { color: #5fb0f0; }

// Real brand logos sit on a white plate so dark monochrome icons stay visible.
.model-logo {
  object-fit: contain;
  background: #ffffff;
  border: 1px solid var(--border, #e5e7eb);
  padding: 8px;
}

.clickable-tile {
  cursor: pointer;
  &:focus { outline: 2px solid var(--primary); outline-offset: 2px; }
}
.clickable-row {
  cursor: pointer;
  &:focus { outline: 2px solid var(--primary); outline-offset: -2px; }
}

.tile-actions {
  display: flex;
  gap: 12px;
  .action-link {
    color: var(--muted);
    font-size: 16px;
    &:hover { color: var(--primary); text-decoration: none; }
  }
}

// List view
.list-view {
  .table {
    width: 100%;
    border-collapse: collapse;
    background: var(--body-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;

    th {
      background: var(--sortable-table-header-bg);
      color: var(--body-text);
      padding: 12px;
      text-align: left;
      font-weight: 600;
      font-size: 13px;
      border-bottom: 1px solid var(--border);
      &.text-right { text-align: right; }
    }
    td {
      padding: 12px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
      font-size: 13px;
      &.text-right { text-align: right; }
    }
    tr:last-child td { border-bottom: none; }
    .main-row:hover { background: var(--sortable-table-accent-bg); }
  }

  .name-cell {
    display: flex; align-items: center; gap: 12px;
    .table-logo {
      width: 32px; height: 32px; border-radius: 6px; flex-shrink: 0;
      font-size: 14px;
    }
    .name-info {
      .app-name { font-weight: 600; color: var(--body-text); margin-bottom: 2px; }
      .app-meta .list-pkg { font-weight: 500; font-size: 12px; color: var(--muted); }
    }
  }
  .action-link { color: var(--muted); font-size: 16px; &:hover { color: var(--primary); } }
}

// Buttons
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 14px;
  height: 32px;
  border-radius: 6px;
  font-weight: 500;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  border: 1px solid;
  text-decoration: none;

  &.btn-sm { height: 28px; padding: 0 12px; font-size: 12px; }

  &.role-primary {
    background: var(--primary); border-color: var(--primary); color: var(--primary-text);
    &:hover { filter: brightness(0.9); }
    &:disabled { background: var(--disabled-bg); border-color: var(--disabled-bg); cursor: not-allowed; opacity: 0.6; }
  }
  &.role-secondary {
    background: var(--body-bg); border-color: var(--border); color: var(--body-text);
    &:hover { background: var(--hover-bg); border-color: var(--muted); text-decoration: none; }
  }

  .icon { font-size: 14px; &.icon-spinner { animation: spin 1s linear infinite; } }
}

.empty-state-content {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; padding: 60px 20px; max-width: 400px; margin: 0 auto;
  .icon-4x { font-size: 64px; margin-bottom: 20px; opacity: 0.5; }
  h3 { margin: 0 0 12px 0; color: var(--body-text); font-size: 20px; font-weight: 600; }
  p { margin: 0; color: var(--muted); line-height: 1.5; }
}

.app-tile-filler { visibility: hidden; min-height: 0; padding: 0; border: none; }

.view-icon-grid:before { content: "⊞"; font-size: 18px; font-weight: bold; }
.view-icon-list:before { content: "☰"; font-size: 18px; font-weight: bold; }
.icon.view-icon-grid, .icon.view-icon-list {
  font-family: inherit; display: flex; align-items: center; justify-content: center; width: 20px; height: 20px;
}
</style>
