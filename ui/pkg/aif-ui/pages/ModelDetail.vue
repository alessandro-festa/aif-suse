<template>
  <main class="main-layout">
    <div class="outlet">
      <a class="back-link" role="button" tabindex="0" @click="goBack" @keydown.enter="goBack">
        <i class="icon icon-chevron-left" /> {{ t('suseai.models.backToModels', 'Back to Models') }}
      </a>

      <div v-if="loading" class="loading-state">
        <i class="icon icon-spinner icon-spin" /> {{ t('suseai.models.loading', 'Loading model…') }}
      </div>

      <div v-else-if="!model" class="banner bg-error">
        {{ t('suseai.models.notFound', 'Model not found.') }}
      </div>

      <template v-else>
        <!-- Header -->
        <header class="detail-header">
          <img
            v-if="model.logoUrl && !logoFailed"
            :src="model.logoUrl"
            alt=""
            class="detail-logo model-logo"
            @error="logoFailed = true"
          />
          <div v-else class="detail-logo provider-avatar" :style="{ background: providerColor(model.provider) }">
            {{ providerInitial(model) }}
          </div>
          <div class="detail-heading">
            <h1>{{ model.title }}</h1>
            <div class="detail-sub">
              <span>{{ model.provider }}</span>
              <span class="mono">{{ model.id }}</span>
            </div>
            <div class="badge-row">
              <span v-if="model.communityValidated" class="badge badge-validated">
                <i class="icon icon-checkmark" aria-hidden="true" /> {{ t('suseai.models.communityValidated', 'Community validated') }}
              </span>
              <span v-if="model.free" class="badge badge-free">{{ t('suseai.models.free', 'Free') }}</span>
            </div>
          </div>
          <a v-if="model.recipeUrl" :href="model.recipeUrl" target="_blank" rel="noopener noreferrer" class="btn btn-sm role-secondary">
            {{ t('suseai.models.viewRecipe', 'View recipe') }} <i class="icon icon-external-link" />
          </a>
        </header>

        <!-- Overview -->
        <section class="card">
          <p class="description">{{ model.description || '—' }}</p>
          <div class="spec-grid">
            <div class="spec"><span class="spec-label">Architecture</span><span>{{ model.architecture === 'moe' ? 'Mixture of Experts' : 'Dense' }}</span></div>
            <div class="spec"><span class="spec-label">Parameters</span><span>{{ paramLabel(model) }}</span></div>
            <div class="spec"><span class="spec-label">Context length</span><span>{{ model.contextLength.toLocaleString() }} tokens</span></div>
            <div class="spec"><span class="spec-label">Precisions</span><span>{{ model.precisions.map(p => p.toUpperCase()).join(', ') }}</span></div>
            <div class="spec"><span class="spec-label">GPU families</span><span>{{ model.gpuFamilies.join(', ') }}</span></div>
            <div class="spec"><span class="spec-label">Tasks</span><span>{{ model.tasks.join(', ') }}</span></div>
            <div v-if="model.minVllmVersion" class="spec"><span class="spec-label">Min vLLM</span><span>{{ model.minVllmVersion }}</span></div>
            <div class="spec"><span class="spec-label">Engine</span><span>SUSE Application Collection vLLM</span></div>
          </div>

          <div class="verified-configs">
            <span class="spec-label">Verified configurations (vLLM community)</span>
            <div v-if="configsLoading" class="loading-state"><i class="icon icon-spinner icon-spin" aria-hidden="true" /> Loading…</div>
            <div v-else-if="verifiedConfigs.length" class="config-chips">
              <span v-for="c in verifiedConfigs" :key="c.hardware + '-' + c.gpuCount" class="chip chip-verified">
                <i class="icon icon-checkmark" aria-hidden="true" /> {{ c.gpuCount }}×{{ c.vramPerGpuGB }}GB {{ c.hardware }}
              </span>
            </div>
            <span v-else class="field-hint">
              Not validated by the vLLM community on any GPU. Supported (a recipe exists) on: {{ model.gpuFamilies.join(', ') }}.
            </span>
          </div>
        </section>

        <!-- Deploy wizard -->
        <section class="card wizard">
          <h2>{{ t('suseai.models.deployTitle', 'Deploy this model') }}</h2>

          <!-- Step indicator -->
          <ol class="steps">
            <li
              v-for="(s, i) in WIZARD_STEPS"
              :key="s"
              :class="['step', { active: i === currentStep, done: i < currentStep, upcoming: i > currentStep }]"
            >
              <span class="step-num">{{ i + 1 }}</span> {{ s }}
            </li>
          </ol>

          <!-- Step 0 · Cluster -->
          <div v-show="currentStep === 0">
            <h3 class="step-heading">{{ t('suseai.models.step1', 'Step 1 · Select a target cluster') }}</h3>
            <p class="step-hint">
              <template v-if="(model.verifiedFamilies || []).length">
                Verified on: <strong>{{ (model.verifiedFamilies || []).join(', ') }}</strong> — clusters with these GPUs are marked validated.
              </template>
              <template v-else>
                {{ t('suseai.models.step1HintNone', 'This model has no community-verified GPUs; supported clusters are marked deployable.') }}
              </template>
            </p>

            <div v-if="nodeDiskEstimate" class="banner bg-info node-disk-note">
              <i class="icon icon-info" aria-hidden="true" />
              <span>
                Each target node needs roughly <strong>{{ nodeDiskEstimate }} GB free disk</strong>
                (≈{{ imageFootprintGi }} GB vLLM image + {{ recommendedStorage }} GiB weights). Deploys fail with
                “no space left on device” if a node is short.
              </span>
            </div>

            <div v-if="clustersLoading" class="loading-state">
              <i class="icon icon-spinner icon-spin" /> {{ t('suseai.models.detectingGpus', 'Detecting cluster GPUs…') }}
            </div>
            <div v-else-if="clusterError" class="banner bg-error">{{ clusterError }}</div>
            <div v-else class="cluster-list">
              <label
                v-for="c in clusters"
                :key="c.id"
                :class="['cluster-row', `verdict-${ c.verdict.level }`, { selected: selectedCluster === c.id }]"
              >
                <input type="radio" name="cluster" :value="c.id" v-model="selectedCluster" />
                <div class="cluster-main">
                  <div class="cluster-name">{{ c.name }}</div>
                  <div class="cluster-gpu">
                    <template v-if="c.gpu.hasGpu">
                      GPU: {{ c.gpu.families.length ? c.gpu.families.join(', ') : c.gpu.products.join(', ') }}
                      <span v-if="c.gpu.totalGpuCount"> · {{ c.gpu.totalGpuCount }} GPU(s)</span>
                      <span v-if="c.gpu.totalVramGB"> · {{ c.gpu.totalVramGB }} GB</span>
                    </template>
                    <template v-else>{{ t('suseai.models.noGpu', 'No NVIDIA GPU detected') }}</template>
                  </div>
                </div>
                <span :class="['verdict-badge', `verdict-${ c.verdict.level }`]">
                  <i :class="['icon', verdictIcon(c.verdict.level)]" aria-hidden="true" />
                  {{ verdictLabel(c.verdict.level) }}
                </span>
              </label>
              <div v-if="!clusters.length" class="empty-inline">{{ t('suseai.models.noClusters', 'No ready clusters found.') }}</div>
            </div>

            <div v-if="selectedVerdict" :class="['banner', bannerClass(selectedVerdict.level)]">
              <i :class="['icon', verdictIcon(selectedVerdict.level)]" aria-hidden="true" />
              <span>{{ selectedVerdict.message }}</span>
            </div>
          </div>

          <!-- Step 1 · Hardware -->
          <div v-show="currentStep === 1">
            <h3 class="step-heading">{{ t('suseai.models.step2', 'Step 2 · Configure hardware') }}</h3>
            <p class="step-hint">
              Validated against <strong>{{ model.title }}</strong> — precision {{ model.precisions.map(p => p.toUpperCase()).join(' / ') }}, up to {{ model.contextLength.toLocaleString() }} tokens.
            </p>
            <div class="form-grid">
              <label class="field">
                <span class="field-label">Precision</span>
                <select v-model="selections.precision" class="form-control">
                  <option v-for="p in model.precisions" :key="p" :value="p">{{ p.toUpperCase() }}</option>
                </select>
              </label>
              <label class="field">
                <span class="field-label">GPUs per replica</span>
                <input type="number" min="1" v-model.number="selections.gpuCount" class="form-control" />
              </label>
              <label class="field">
                <span class="field-label">Tensor-parallel size</span>
                <input type="number" min="1" v-model.number="selections.tensorParallelSize" class="form-control" />
              </label>
              <label class="field">
                <span class="field-label">Max model length</span>
                <input type="number" min="1" :max="model.contextLength" v-model.number="selections.maxModelLen" class="form-control" />
                <span class="field-hint">Native: {{ model.contextLength.toLocaleString() }} tokens</span>
              </label>
              <label class="field">
                <span class="field-label">GPU memory utilization</span>
                <input type="number" min="0.1" max="1" step="0.05" v-model.number="selections.gpuMemoryUtilization" class="form-control" />
              </label>
              <label class="field">
                <span class="field-label">Replicas</span>
                <input type="number" min="1" v-model.number="selections.replicas" class="form-control" />
              </label>
              <label class="field">
                <span class="field-label">Min CPU request (cores)</span>
                <input type="number" min="1" v-model.number="selections.requestCPU" class="form-control" />
                <span v-if="recommended.cpu" class="field-hint">Recommended for this model size: {{ recommended.cpu }}</span>
              </label>
              <label class="field">
                <span class="field-label">Min Memory request</span>
                <input type="text" v-model="selections.requestMemory" class="form-control" placeholder="16Gi" />
                <span v-if="recommended.memoryGi" class="field-hint">Recommended for this model size: {{ recommended.memoryGi }}Gi</span>
              </label>
            </div>

            <div v-if="resourceWarning" class="banner bg-warning">
              <i class="icon icon-warning" aria-hidden="true" /> <span>{{ resourceWarning }}</span>
            </div>

            <div v-if="availableFeatures.length" class="features">
              <span class="field-label">Capabilities</span>
              <div class="checkbox-row">
                <label v-for="f in availableFeatures" :key="f" class="checkbox">
                  <input type="checkbox" :value="f" v-model="selections.features" /> {{ featureLabel(f) }}
                </label>
              </div>
            </div>

            <div v-if="hwErrors.length" class="banner bg-warning">
              <ul class="err-list"><li v-for="(e, i) in hwErrors" :key="i">{{ e }}</li></ul>
            </div>
          </div>

          <!-- Step 2 · Values -->
          <div v-show="currentStep === 2">
            <h3 class="step-heading">{{ t('suseai.models.step3', 'Step 3 · vLLM values') }}</h3>
            <p class="step-hint">Pre-filled from your selections. Edit the deployment basics, or the raw YAML.</p>

            <div class="view-toggle">
              <button type="button" class="btn btn-sm" :class="valuesMode === 'form' ? 'role-primary' : 'role-secondary'" @click="valuesMode = 'form'">Form</button>
              <button type="button" class="btn btn-sm" :class="valuesMode === 'yaml' ? 'role-primary' : 'role-secondary'" @click="valuesMode = 'yaml'">YAML</button>
              <button type="button" class="btn btn-sm role-secondary regen" @click="regenerateValues">Reset to selections</button>
            </div>

            <div v-show="valuesMode === 'form'" class="form-grid">
              <label class="field">
                <span class="field-label">Ingress / service type</span>
                <select v-model="selections.serviceType" class="form-control" @change="regenerateValues">
                  <option value="ClusterIP">ClusterIP (internal)</option>
                  <option value="LoadBalancer">LoadBalancer (external)</option>
                  <option value="NodePort">NodePort</option>
                </select>
              </label>
              <label class="field">
                <span class="field-label">Storage size (PVC)</span>
                <input type="text" v-model="selections.pvcStorage" :class="['form-control', { 'input-error': !!storageWarning }]" @change="regenerateValues" />
                <span v-if="recommendedStorage" class="field-hint">Recommended for weights: {{ recommendedStorage }}Gi</span>
              </label>
              <label class="field">
                <span class="field-label">Replicas</span>
                <input type="number" min="1" v-model.number="selections.replicas" class="form-control" @change="regenerateValues" />
              </label>
              <label class="field">
                <span class="field-label">Runtime class</span>
                <input type="text" v-model="selections.runtimeClassName" class="form-control" @change="regenerateValues" />
              </label>
              <label class="field span2">
                <span class="field-label">Hugging Face token</span>
                <select v-model="selections.hfTokenMode" class="form-control" @change="onHfModeChange">
                  <option value="none">Not required (public model)</option>
                  <option value="token">Enter token</option>
                  <option value="secret">Use existing secret</option>
                </select>
              </label>
              <label v-if="selections.hfTokenMode === 'token'" class="field span2">
                <span class="field-label">HF token</span>
                <input type="password" v-model="selections.hfToken" class="form-control" placeholder="hf_…" @change="regenerateValues" />
                <span class="field-hint">Stored by the chart in a generated Secret on the target cluster.</span>
              </label>
              <template v-if="selections.hfTokenMode === 'secret'">
                <label class="field">
                  <span class="field-label">Secret name</span>
                  <select v-if="nsSecrets.length" v-model="selections.hfSecretName" class="form-control" @change="regenerateValues">
                    <option value="">Select a secret…</option>
                    <option v-for="s in nsSecrets" :key="s" :value="s">{{ s }}</option>
                  </select>
                  <input v-else type="text" v-model="selections.hfSecretName" class="form-control" placeholder="my-hf-secret" @change="regenerateValues" />
                  <span class="field-hint">Opaque secret in “{{ namespace }}” on the selected cluster.</span>
                </label>
                <label class="field">
                  <span class="field-label">Secret key</span>
                  <input type="text" v-model="selections.hfSecretKey" class="form-control" placeholder="HF_TOKEN" @change="regenerateValues" />
                </label>
              </template>
              <div class="field span2 compute-summary">
                <span class="field-label">Compute (from Hardware step)</span>
                <div class="chip-row">
                  <span class="chip">{{ selections.precision.toUpperCase() }}</span>
                  <span class="chip">{{ selections.gpuCount }} GPU · TP {{ selections.tensorParallelSize }}</span>
                  <span class="chip">{{ selections.maxModelLen.toLocaleString() }} ctx</span>
                  <span class="chip">gpuMemUtil {{ selections.gpuMemoryUtilization }}</span>
                </div>
              </div>
            </div>

            <div v-if="storageWarning" class="banner bg-warning">
              <i class="icon icon-warning" aria-hidden="true" /> <span>{{ storageWarning }}</span>
            </div>

            <div v-if="valuesMode === 'yaml'" class="yaml-wrap">
              <YamlEditor v-model:value="valuesObj" :as-object="true" class="values-editor" />
            </div>
          </div>

          <!-- Step 3 · Review -->
          <div v-show="currentStep === 3">
            <h3 class="step-heading">{{ t('suseai.models.step4', 'Step 4 · Review') }}</h3>
            <div class="spec-grid review-grid">
              <div class="spec"><span class="spec-label">Model</span><span>{{ model.title }}</span></div>
              <div class="spec"><span class="spec-label">Target cluster</span><span>{{ selectedClusterName }}</span></div>
              <div class="spec"><span class="spec-label">Compatibility</span><span>{{ selectedVerdict ? verdictLabel(selectedVerdict.level) : '—' }}</span></div>
              <div class="spec"><span class="spec-label">Precision</span><span>{{ selections.precision.toUpperCase() }}</span></div>
              <div class="spec"><span class="spec-label">GPUs / TP</span><span>{{ selections.gpuCount }} / {{ selections.tensorParallelSize }}</span></div>
              <div class="spec"><span class="spec-label">Ingress</span><span>{{ selections.serviceType }}</span></div>
            </div>
            <div v-if="selectedVerdict && (selectedVerdict.level === 'warn' || selectedVerdict.level === 'incompatible')" :class="['banner', bannerClass(selectedVerdict.level)]">
              <i :class="['icon', verdictIcon(selectedVerdict.level)]" aria-hidden="true" /> <span>{{ selectedVerdict.message }}</span>
            </div>

            <div class="form-grid deploy-target">
              <label class="field">
                <span class="field-label">Namespace</span>
                <input type="text" v-model="namespace" class="form-control" :disabled="deploying || deployDone" />
              </label>
              <label class="field">
                <span class="field-label">Release name
                  <a class="link-inline suggest" role="button" tabindex="0" @click="suggestName" @keydown.enter="suggestName">Suggest</a>
                </span>
                <input type="text" v-model="release" class="form-control" :class="{ 'input-error': releaseTooLong }" :disabled="deploying || deployDone" />
                <span v-if="releaseTooLong" class="field-error">
                  Too long: the service name “{{ serviceName }}” would exceed 63 chars. Use ≤ {{ MAX_RELEASE }} characters (try Suggest).
                </span>
                <span v-else class="field-hint">Service: {{ serviceName }}</span>
              </label>
            </div>

            <span class="field-label review-yaml-label">Final values.yaml (SUSE Application Collection vLLM)</span>
            <pre class="yaml-preview">{{ valuesYamlText }}</pre>

            <div v-if="deploying || (deployMsg && !deployDone && !deployError)" class="banner bg-info">
              <i class="icon icon-spinner icon-spin" aria-hidden="true" /> <span>{{ deployMsg }}</span>
            </div>
            <div v-if="deployError" class="banner bg-error">
              <i class="icon icon-error" aria-hidden="true" /> <span>{{ deployError }}</span>
            </div>
            <div v-if="deployDone && !deployError" class="banner bg-success">
              <i class="icon icon-checkmark" aria-hidden="true" />
              <span>
                Scheduled on <strong>{{ selectedClusterName }}</strong>. Track it on the
                <a role="button" tabindex="0" class="link-inline" @click="goWorkloads" @keydown.enter="goWorkloads">Workloads</a> page.
              </span>
            </div>

            <!-- Publish as blueprint (alternative to Deploy) -->
            <div class="publish-section">
              <h4 class="publish-heading">{{ t('suseai.models.publishTitle', 'Or publish as a Blueprint') }}</h4>
              <p class="step-hint">Save this configuration as a reusable Blueprint (installable later, and Fleet/CI-friendly) instead of deploying now.</p>
              <div class="form-grid">
                <label class="field span2">
                  <span class="field-label">Blueprint name</span>
                  <input type="text" v-model="bpName" class="form-control" :disabled="publishing || publishDone" />
                </label>
                <label class="field">
                  <span class="field-label">Version (semver)</span>
                  <input type="text" v-model="bpVersion" class="form-control" :disabled="publishing || publishDone" placeholder="1.0.0" />
                </label>
              </div>
              <div v-if="publishError" class="banner bg-error">
                <i class="icon icon-error" aria-hidden="true" /> <span>{{ publishError }}</span>
              </div>
              <div v-if="publishDone && !publishError" class="banner bg-success">
                <i class="icon icon-checkmark" aria-hidden="true" />
                <span>Blueprint <strong>{{ bpName }}</strong> ({{ bpVersion }}) published. See the
                  <a role="button" tabindex="0" class="link-inline" @click="goBlueprints" @keydown.enter="goBlueprints">Blueprints</a> page.</span>
              </div>
            </div>
          </div>

          <!-- Footer -->
          <div class="wizard-footer">
            <div class="footer-left">
              <button class="btn role-secondary" type="button" @click="goBack">{{ t('suseai.models.cancel', 'Cancel') }}</button>
              <button v-if="currentStep > 0" class="btn role-secondary" type="button" @click="back">{{ t('suseai.models.back', 'Back') }}</button>
            </div>
            <div class="footer-right">
              <span v-if="currentStep === WIZARD_STEPS.length - 1 && !deployDone" class="footer-note">
                {{ t('suseai.models.deployVia', 'Deploys the vLLM chart to the selected cluster via Fleet.') }}
              </span>
              <button
                v-if="currentStep < WIZARD_STEPS.length - 1"
                class="btn role-primary"
                type="button"
                :disabled="!canAdvance"
                :title="canAdvance ? '' : nextDisabledReason"
                @click="next"
              >
                {{ nextLabel }}
              </button>
              <button
                v-if="currentStep === WIZARD_STEPS.length - 1"
                class="btn role-secondary"
                type="button"
                :disabled="!canPublish || publishing || publishDone"
                :title="canPublish ? '' : 'Set a blueprint name and semver version'"
                @click="doPublish"
              >
                <i v-if="publishing" class="icon icon-spinner icon-spin" aria-hidden="true" />
                {{ publishing ? t('suseai.models.publishing', 'Publishing…') : (publishDone ? t('suseai.models.published', 'Published') : t('suseai.models.publish', 'Publish as blueprint')) }}
              </button>
              <button
                v-if="currentStep === WIZARD_STEPS.length - 1"
                class="btn role-primary"
                type="button"
                :disabled="!canDeploy || deploying || deployDone"
                :title="canDeploy ? '' : 'Set a namespace and release name'"
                @click="doDeploy"
              >
                <i v-if="deploying" class="icon icon-spinner icon-spin" aria-hidden="true" />
                {{ deploying ? t('suseai.models.deploying', 'Deploying…') : (deployDone ? t('suseai.models.deployed', 'Deployed') : t('suseai.models.deploy', 'Deploy')) }}
              </button>
            </div>
          </div>
        </section>
      </template>
    </div>
  </main>
</template>

<script lang="ts">
import { defineComponent, computed, getCurrentInstance, onMounted, reactive, ref } from 'vue';
import { useT } from '../composables/useT';
import type { ModelCatalogEntry, ModelVerifiedConfig } from '../types/model-catalog';
import { fetchModelsCatalog } from '../services/models-catalog';
import { getModelConfigs } from '../utils/operator-api';
import { getClusterGpuInfo, gpuCompatVerdict, type ClusterGpuInfo, type CompatLevel, type CompatVerdict } from '../services/cluster-gpu';
import { ClusterService } from '../services/cluster-service';
import {
  buildVllmValues, defaultSelections, validateSelections, recommendedResources, recommendedStorageGi,
  recommendedNodeDiskGi, VLLM_IMAGE_FOOTPRINT_GI, parseMemGi, TOGGLEABLE_FEATURES, type VllmSelections,
} from '../services/recipe-to-vllm';
import YamlEditor from '@shell/components/YamlEditor';
import yaml from 'js-yaml';
import { deployModel } from '../services/model-deploy';
import { createBlueprint } from '../utils/blueprint-api';
import { SEMVER_PATTERN, type BlueprintSpec } from '../types/blueprint-types';

const WIZARD_STEPS = ['Cluster', 'Hardware', 'Values', 'Review'];

const FEATURE_LABELS: Record<string, string> = {
  tool_calling: 'Tool calling',
  reasoning:    'Reasoning',
};

const PROVIDER_COLORS: Record<string, string> = {
  'Qwen': '#615ced', 'Meta': '#0668e1', 'Google': '#4285f4', 'Mistral AI': '#fa520f',
  'DeepSeek': '#4d6bfe', 'NVIDIA': '#76b900', 'Microsoft': '#0078d4', 'AMD': '#ed1c24',
};

interface ClusterRow {
  id: string;
  name: string;
  gpu: ClusterGpuInfo;
  verdict: CompatVerdict;
}

export default defineComponent({
  name: 'SuseAIModelDetail',

  components: { YamlEditor },

  setup() {
    const vm = getCurrentInstance();
    const $router = (vm as any)?.proxy?.$router;
    const $store = (vm as any)?.proxy?.$store;
    const route = (vm as any)?.proxy?.$route;
    const currentClusterId = (route?.params?.cluster as string) || 'local';
    const modelId = (route?.query?.id as string) || '';

    const loading = ref(true);
    const model = ref<ModelCatalogEntry | null>(null);
    const logoFailed = ref(false);
    const verifiedConfigs = ref<ModelVerifiedConfig[]>([]);
    const configsLoading = ref(false);

    const clustersLoading = ref(false);
    const clusterError = ref<string | null>(null);
    const clusters = ref<ClusterRow[]>([]);
    const selectedCluster = ref<string>('');

    const providerInitial = (m: ModelCatalogEntry): string => (m.provider || m.title || '?').trim().charAt(0).toUpperCase();
    const providerColor = (provider: string): string => PROVIDER_COLORS[provider] || 'var(--primary)';
    const paramLabel = (m: ModelCatalogEntry): string =>
      m.activeParameters ? `${ m.parameterCount } · ${ m.activeParameters } active` : m.parameterCount;

    const verdictLabel = (l: CompatLevel): string =>
      l === 'validated' ? 'Validated' : l === 'deployable' ? 'Deployable' : l === 'warn' ? 'May fail' : 'Not deployable';
    const verdictIcon = (l: CompatLevel): string =>
      (l === 'validated' || l === 'deployable') ? 'icon-checkmark' : l === 'warn' ? 'icon-warning' : 'icon-error';
    const bannerClass = (l: CompatLevel): string =>
      l === 'validated' ? 'bg-success' : l === 'deployable' ? 'bg-info' : l === 'warn' ? 'bg-warning' : 'bg-error';

    const selectedVerdict = computed<CompatVerdict | null>(() => {
      const row = clusters.value.find(c => c.id === selectedCluster.value);
      return row ? row.verdict : null;
    });

    // --- Wizard state -------------------------------------------------------
    const currentStep = ref(0);
    const valuesMode = ref<'form' | 'yaml'>('form');
    const valuesObj = ref<Record<string, any>>({});
    // Fully-populated so template bindings never hit undefined before the model loads.
    const selections = reactive<VllmSelections>({
      precision: 'bf16', gpuCount: 1, tensorParallelSize: 1, gpuMemoryUtilization: 0.9,
      maxModelLen: 4096, replicas: 1, requestCPU: 4, requestMemory: '16Gi',
      pvcStorage: '50Gi', runtimeClassName: 'nvidia', serviceType: 'ClusterIP',
      hfTokenMode: 'none', hfToken: '', hfSecretName: '', hfSecretKey: 'HF_TOKEN', features: [],
    });

    const hwErrors = computed<string[]>(() => model.value ? validateSelections(model.value, selections) : []);
    const availableFeatures = computed<string[]>(() =>
      model.value ? model.value.tasks.filter(tk => TOGGLEABLE_FEATURES.includes(tk)) : []);
    const featureLabel = (f: string): string => FEATURE_LABELS[f] || f;

    // Recommended min CPU/memory derived from model size; warn if the user goes below.
    const recommended = computed(() => model.value ? recommendedResources(model.value) : { cpu: 0, memoryGi: 0 });
    const resourceWarning = computed<string>(() => {
      const r = recommended.value;
      const parts: string[] = [];
      if (r.cpu && selections.requestCPU < r.cpu) parts.push(`CPU below the recommended ${ r.cpu } cores`);
      if (r.memoryGi && parseMemGi(selections.requestMemory) < r.memoryGi) parts.push(`memory below the recommended ${ r.memoryGi }Gi`);
      return parts.length
        ? `Requesting less than recommended (${ parts.join(', ') }) for a ${ model.value?.parameterCount } model may cause OOM or unstable startup.`
        : '';
    });

    // Recommended PVC size for the model weights (scales with size + precision).
    const recommendedStorage = computed<number>(() =>
      model.value ? recommendedStorageGi(model.value, selections.precision) : 0);
    const nodeDiskEstimate = computed<number>(() =>
      model.value ? recommendedNodeDiskGi(model.value, selections.precision) : 0);
    const imageFootprintGi = VLLM_IMAGE_FOOTPRINT_GI;
    const storageWarning = computed<string>(() =>
      recommendedStorage.value && parseMemGi(selections.pvcStorage) < recommendedStorage.value
        ? `Storage below the recommended ${ recommendedStorage.value }Gi for ${ model.value?.parameterCount } (${ selections.precision.toUpperCase() }) weights — the model download may fail with "no space left on device".`
        : '');

    const selectedClusterName = computed<string>(() =>
      clusters.value.find(c => c.id === selectedCluster.value)?.name || selectedCluster.value || '—');

    const canAdvance = computed<boolean>(() => {
      if (currentStep.value === 0) return !!selectedCluster.value;
      if (currentStep.value === 1) return hwErrors.value.length === 0;
      return true;
    });
    const nextLabel = computed<string>(() =>
      ['Next: Configure hardware', 'Next: vLLM values', 'Next: Review'][currentStep.value] || 'Next');
    const nextDisabledReason = computed<string>(() =>
      currentStep.value === 0 ? 'Select a target cluster to continue'
        : currentStep.value === 1 ? 'Resolve the hardware validation issues to continue' : '');

    const regenerateValues = () => {
      if (model.value) valuesObj.value = buildVllmValues(model.value, selections);
    };

    // Instant, read-only YAML text for the Review step (avoids a heavy CodeMirror mount).
    const valuesYamlText = computed<string>(() => {
      try {
        return yaml.dump(valuesObj.value);
      } catch {
        return '';
      }
    });

    // --- Deploy (Phase 4) ----------------------------------------------------
    const namespace = ref('aif-models');
    const release = ref('');

    // HF token secret picker: list opaque secrets in the target namespace/cluster.
    const nsSecrets = ref<string[]>([]);
    const loadSecrets = async () => {
      if (!selectedCluster.value || !namespace.value.trim()) { nsSecrets.value = []; return; }
      try {
        const res: any = await $store.dispatch('rancher/request', {
          url: `/k8s/clusters/${ encodeURIComponent(selectedCluster.value) }/api/v1/namespaces/${ encodeURIComponent(namespace.value.trim()) }/secrets`,
        });
        const items = res?.data || res?.items || [];
        nsSecrets.value = items
          .filter((s: any) => !s?.type || s.type === 'Opaque')
          .map((s: any) => s?.metadata?.name)
          .filter(Boolean);
      } catch (e) {
        console.warn('[SUSE-AI] list secrets failed', e);
        nsSecrets.value = [];
      }
    };
    const onHfModeChange = () => {
      regenerateValues();
      if (selections.hfTokenMode === 'secret') loadSecrets();
    };
    const deploying = ref(false);
    const deployMsg = ref('');
    const deployError = ref<string | null>(null);
    const deployDone = ref(false);

    // Chart resources are `{release}-vllm-…`; the longest suffix (`-vllm-deployment-vllm`)
    // is 21 chars and k8s caps names at 63, so the release must be ≤ 42 chars.
    const MAX_RELEASE = 42;

    const slugify = (s: string): string =>
      s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    const randomSuffix = (): string => Math.random().toString(36).slice(2, 6);

    const suggestName = () => {
      const base = model.value ? slugify(model.value.title) : 'vllm';
      release.value = `${ base.slice(0, MAX_RELEASE - 5) }-${ randomSuffix() }`;
    };

    const serviceName = computed<string>(() => `${ release.value.trim() || 'release' }-vllm-engine-service`);
    const releaseTooLong = computed<boolean>(() => release.value.trim().length > MAX_RELEASE);

    const canDeploy = computed<boolean>(() =>
      !!selectedCluster.value && !!namespace.value.trim() && !!release.value.trim() && !releaseTooLong.value);

    const goWorkloads = () => {
      $router?.push({ name: 'c-cluster-suseai-workloads', params: { cluster: currentClusterId } }).catch(() => {});
    };

    // --- Publish as blueprint (Phase 5) -------------------------------------
    const bpName = ref('');
    const bpVersion = ref('1.0.0');
    const publishing = ref(false);
    const publishError = ref<string | null>(null);
    const publishDone = ref(false);

    const canPublish = computed<boolean>(() =>
      !!bpName.value.trim() && SEMVER_PATTERN.test(bpVersion.value.trim()));

    const goBlueprints = () => {
      $router?.push({ name: 'c-cluster-suseai-blueprints', params: { cluster: currentClusterId } }).catch(() => {});
    };

    const doPublish = async () => {
      if (!canPublish.value || publishing.value || publishDone.value || !model.value) return;
      publishing.value = true;
      publishError.value = null;
      try {
        const spec: BlueprintSpec = {
          displayName: bpName.value.trim(),
          version:     bpVersion.value.trim(),
          description: model.value.description || `vLLM deployment of ${ model.value.title }`,
          source:      'Custom',
          components: [{
            chartRepo:       'application-collection',
            chartName:       'vllm',
            chartVersion:    '0.1.10',
            vendor:          'suse',
            values:          valuesObj.value,
            targetNamespace: namespace.value.trim() || undefined,
          }],
        };
        await createBlueprint(spec);
        publishDone.value = true;
      } catch (err: any) {
        console.error('Blueprint publish failed:', err);
        publishError.value = err?.status === 409
          ? `A blueprint named "${ bpName.value }" version ${ bpVersion.value } already exists.`
          : (err?.message || 'Publish failed');
      } finally {
        publishing.value = false;
      }
    };

    const doDeploy = async () => {
      if (!canDeploy.value || deploying.value || deployDone.value || !model.value) return;
      deploying.value = true;
      deployError.value = null;
      deployMsg.value = 'Starting…';
      try {
        await deployModel(
          $store,
          {
            clusterId:   selectedCluster.value,
            namespace:   namespace.value.trim(),
            release:     release.value.trim(),
            values:      valuesObj.value,
            displayName: model.value.title,
          },
          (_pct, m) => { deployMsg.value = m; },
        );
        deployDone.value = true;
        deployMsg.value = 'Scheduled for deployment';
      } catch (err: any) {
        console.error('Model deploy failed:', err);
        deployError.value = err?.message || 'Deployment failed';
        deployMsg.value = '';
      } finally {
        deploying.value = false;
      }
    };

    const next = () => {
      if (!canAdvance.value) return;
      if (currentStep.value === 1) regenerateValues(); // entering the Values step
      currentStep.value = Math.min(currentStep.value + 1, WIZARD_STEPS.length - 1);
    };
    const back = () => { currentStep.value = Math.max(currentStep.value - 1, 0); };

    const loadClusters = async (m: ModelCatalogEntry) => {
      clustersLoading.value = true;
      clusterError.value = null;
      try {
        const list = await ClusterService.getClusters($store);
        const rows = await Promise.all(list.map(async (c): Promise<ClusterRow> => {
          let gpu: ClusterGpuInfo;
          try {
            gpu = await getClusterGpuInfo($store, c.id);
          } catch {
            gpu = { clusterId: c.id, hasGpu: false, families: [], products: [], totalGpuCount: 0, totalVramGB: 0 };
          }
          const verdict = gpuCompatVerdict(m.gpuFamilies, m.verifiedFamilies || [], gpu);
          return { id: c.id, name: c.name, gpu, verdict };
        }));
        // Best confidence first: validated → deployable → may fail → not deployable.
        const order: Record<CompatLevel, number> = { validated: 0, deployable: 1, warn: 2, incompatible: 3 };
        rows.sort((a, b) => order[a.verdict.level] - order[b.verdict.level]);
        clusters.value = rows;
        const firstOk = rows.find(r => r.verdict.level === 'validated') || rows.find(r => r.verdict.level === 'deployable');
        if (firstOk) selectedCluster.value = firstOk.id;
      } catch (err) {
        console.error('Failed to load clusters:', err);
        clusterError.value = 'Failed to load clusters';
      } finally {
        clustersLoading.value = false;
      }
    };

    const goBack = () => {
      $router?.push({ name: 'c-cluster-suseai-models', params: { cluster: currentClusterId } })
        .catch(() => {});
    };

    onMounted(async () => {
      try {
        const all = await fetchModelsCatalog();
        const found = all.find(m => m.id === modelId) || null;
        model.value = found;
        if (found) {
          Object.assign(selections, defaultSelections(found));
          suggestName(); // always suggest a short, unique release name up front
          bpName.value = `${ found.title } (vLLM)`;
          regenerateValues();
          // Lazily resolve the full list of verified hardware configurations.
          configsLoading.value = true;
          getModelConfigs(found.id)
            .then((cfgs) => { verifiedConfigs.value = Array.isArray(cfgs) ? cfgs : []; })
            .catch(() => { /* leave empty */ })
            .finally(() => { configsLoading.value = false; });
          await loadClusters(found);
        }
      } catch (err) {
        console.error('Failed to load model:', err);
      } finally {
        loading.value = false;
      }
    });

    const t = useT();

    return {
      loading, model, logoFailed, verifiedConfigs, configsLoading,
      clustersLoading, clusterError, clusters, selectedCluster, selectedVerdict,
      WIZARD_STEPS, currentStep, valuesMode, valuesObj, selections,
      hwErrors, availableFeatures, featureLabel, selectedClusterName, recommended, resourceWarning,
      recommendedStorage, storageWarning, nodeDiskEstimate, imageFootprintGi, nsSecrets, onHfModeChange,
      canAdvance, nextLabel, nextDisabledReason, regenerateValues, valuesYamlText, next, back,
      namespace, release, deploying, deployMsg, deployError, deployDone, canDeploy, doDeploy, goWorkloads,
      MAX_RELEASE, serviceName, releaseTooLong, suggestName,
      bpName, bpVersion, publishing, publishError, publishDone, canPublish, doPublish, goBlueprints,
      providerInitial, providerColor, paramLabel, verdictLabel, verdictIcon, bannerClass,
      goBack, t,
    };
  }
});
</script>

<style lang="scss" scoped>
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.back-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--link, var(--primary));
  cursor: pointer;
  font-size: 13px;
  margin-bottom: 16px;
  &:hover { text-decoration: underline; }
}

.loading-state { display: flex; align-items: center; gap: 8px; color: var(--muted); padding: 12px 0; .icon-spinner { animation: spin 1s linear infinite; } }

.detail-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;

  .detail-logo {
    width: 64px; height: 64px; border-radius: 14px; flex-shrink: 0;
    box-shadow: 0 2px 4px rgba(15, 23, 42, 0.08);
  }
  .provider-avatar {
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 26px; font-weight: 700;
  }
  .detail-heading { flex: 1; min-width: 0; }
  h1 { margin: 0; font-size: 24px; }
  .detail-sub {
    display: flex; gap: 10px; align-items: center; color: var(--muted); font-size: 13px; margin-top: 2px;
    .mono { font-family: monospace; }
  }
  .badge-row { margin-top: 8px; }
}

.card {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
  background: var(--body-bg);
}

.description { margin: 0 0 16px; color: var(--body-text); line-height: 1.6; }

.spec-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px 24px;
}
.spec { display: flex; flex-direction: column; gap: 2px; }
.spec-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }

.verified-configs { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
.config-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip-verified {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
  background: rgba(118, 185, 0, 0.14); color: #4a7a00; border: 1px solid rgba(118, 185, 0, 0.5);
  .icon { font-size: 11px; }
}
body.theme-dark .chip-verified { color: #9bd649; }

.wizard h2 { margin: 0 0 16px; font-size: 18px; }

.steps {
  display: flex;
  gap: 8px;
  list-style: none;
  padding: 0;
  margin: 0 0 20px;
  flex-wrap: wrap;

  .step {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 12px; border-radius: 999px;
    font-size: 12px; font-weight: 600;
    border: 1px solid var(--border); color: var(--muted);

    .step-num {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; border-radius: 50%;
      background: var(--muted); color: var(--body-bg); font-size: 11px;
    }
    &.active { border-color: var(--primary); color: var(--primary); .step-num { background: var(--primary); color: var(--primary-text); } }
    &.done { border-color: var(--success, #34a853); color: var(--success, #34a853); .step-num { background: var(--success, #34a853); color: #fff; } }
    &.upcoming { opacity: 0.6; }
  }
}

.step-heading { margin: 0 0 4px; font-size: 15px; }
.step-hint { margin: 0 0 16px; color: var(--muted); font-size: 13px; }

.cluster-list { display: flex; flex-direction: column; gap: 10px; }

.cluster-row {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;

  &:hover { border-color: var(--primary); }
  &.selected { border-color: var(--primary); background: var(--accent-btn); }

  input[type="radio"] { margin: 0; }
  .cluster-main { flex: 1; min-width: 0; }
  .cluster-name { font-weight: 600; color: var(--body-text); }
  .cluster-gpu { font-size: 12px; color: var(--muted); margin-top: 2px; }
}

.verdict-badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px; border-radius: 999px;
  font-size: 12px; font-weight: 700;
  .icon { font-size: 12px; }

  &.verdict-validated { background: rgba(52, 168, 83, 0.14); color: #227a3b; border: 1px solid rgba(52,168,83,0.5); }
  &.verdict-deployable { background: rgba(0, 120, 212, 0.12); color: #0a63b0; border: 1px solid rgba(0,120,212,0.5); }
  &.verdict-warn { background: rgba(240, 173, 78, 0.16); color: #a5701a; border: 1px solid rgba(240,173,78,0.55); }
  &.verdict-incompatible { background: rgba(217, 83, 79, 0.14); color: #b23b37; border: 1px solid rgba(217,83,79,0.5); }
}

.empty-inline { color: var(--muted); font-style: italic; padding: 8px 0; }

.banner {
  display: flex; align-items: center; gap: 8px;
  margin-top: 16px; padding: 12px 14px; border-radius: 8px; font-size: 13px;
  .icon { font-size: 15px; }
  &.bg-error { background: var(--error-banner-bg); border: 1px solid var(--error); color: var(--error); }
  &.bg-warning { background: rgba(240, 173, 78, 0.14); border: 1px solid rgba(240,173,78,0.6); color: #a5701a; }
  &.bg-success { background: rgba(52, 168, 83, 0.12); border: 1px solid rgba(52,168,83,0.55); color: #227a3b; }
  &.bg-info { background: rgba(0, 120, 212, 0.10); border: 1px solid rgba(0,120,212,0.5); color: #0a63b0; }
}
.link-inline { color: var(--primary); cursor: pointer; text-decoration: underline; }
.node-disk-note { align-items: flex-start; margin-top: 0; margin-bottom: 12px; }

.wizard-footer {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--border);
  .footer-note { color: var(--muted); font-size: 12px; }
}

.model-logo { object-fit: contain; background: #ffffff; border: 1px solid var(--border, #e5e7eb); padding: 8px; }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 0 14px; height: 32px; border-radius: 6px;
  font-weight: 500; font-size: 13px; cursor: pointer; border: 1px solid; text-decoration: none;
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
  .icon { font-size: 14px; }
}
</style>

<style lang="scss" scoped>
// Wizard form fields (Hardware + Values steps)
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  &.span2 { grid-column: 1 / -1; }
}
.field-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 600; }
.field-hint { font-size: 11px; color: var(--muted); }

.form-control {
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--body-text);
  font-size: 14px;
  &:focus { outline: none; border-color: var(--outline); box-shadow: 0 0 0 2px var(--primary-keyboard-focus); }
}
select.form-control { appearance: none; background-image: url("data:image/svg+xml;charset=US-ASCII,<svg xmlns='http://www.w3.org/2000/svg' width='4' height='5'><path fill='%23666' d='m0 1 2 2 2-2z'/></svg>"); background-repeat: no-repeat; background-position: right 8px center; background-size: 12px; }

.features { margin-top: 18px; display: flex; flex-direction: column; gap: 8px; }
.checkbox-row { display: flex; flex-wrap: wrap; gap: 16px; }
.checkbox { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; cursor: pointer; }

.view-toggle { display: flex; gap: 8px; margin-bottom: 14px; .regen { margin-left: auto; } }

.yaml-wrap { margin-top: 4px; }
.values-editor { min-height: 340px; }

.compute-summary .chip-row { margin-top: 6px; }
.chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 600; background: var(--accent-btn); color: var(--body-text); border: 1px solid var(--border);
}

.review-grid { margin-bottom: 8px; }
.deploy-target { margin: 16px 0; }
.field-error { font-size: 11px; color: var(--error, #d9534f); }
.form-control.input-error { border-color: var(--error, #d9534f); }
.suggest { margin-left: 8px; font-size: 11px; font-weight: 500; text-transform: none; }
.publish-section { margin-top: 22px; padding-top: 18px; border-top: 1px dashed var(--border); }
.publish-heading { margin: 0 0 4px; font-size: 14px; }
.review-yaml-label { display: block; margin: 16px 0 6px; }
.yaml-preview {
  margin: 0;
  padding: 14px 16px;
  background: var(--body-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--body-text);
  font-family: ui-monospace, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre;
  overflow: auto;
  max-height: 420px;
}

.err-list { margin: 0; padding-left: 18px; }

.footer-left { display: flex; align-items: center; gap: 8px; }
.footer-right { display: flex; align-items: center; gap: 12px; }
</style>
