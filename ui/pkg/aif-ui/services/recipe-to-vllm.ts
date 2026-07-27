import type { ModelCatalogEntry } from '../types/model-catalog';

/**
 * Recipe → AppCo vLLM helm values translation (masterplan §6).
 *
 * Turns a model recipe plus the wizard's hardware/deployment selections into a
 * values block for the SUSE Application Collection vLLM chart
 * (chartRepo: application-collection, chartName: vllm). Phase 1 will enrich the
 * feature→arg mapping with the exact per-recipe args from recipes.vllm.ai; for
 * now feature flags emit best-effort defaults the user can edit.
 */

export type ServiceType = 'ClusterIP' | 'LoadBalancer' | 'NodePort';

export interface VllmSelections {
  /** Precision variant, must be one of the model's precisions. */
  precision: string;
  /** GPUs requested per replica (also the tensor-parallel degree upper bound). */
  gpuCount: number;
  tensorParallelSize: number;
  /** 0–1 fraction of GPU memory. */
  gpuMemoryUtilization: number;
  /** Served context window; must be ≤ the model's native context length. */
  maxModelLen: number;
  replicas: number;
  /** CPU cores requested per replica (chart requires modelSpec.requestCPU). */
  requestCPU: number;
  /** Memory requested per replica, e.g. "16Gi" (chart requires modelSpec.requestMemory). */
  requestMemory: string;
  pvcStorage: string;
  runtimeClassName: string;
  serviceType: ServiceType;
  /** How the Hugging Face token is supplied. */
  hfTokenMode: HfTokenMode;
  /** Raw token (when hfTokenMode === 'token'). */
  hfToken?: string;
  /** Existing secret name + key (when hfTokenMode === 'secret'). */
  hfSecretName?: string;
  hfSecretKey?: string;
  /** Enabled capability keys (subset of the model's tasks), e.g. ["tool_calling"]. */
  features: string[];
}

export type HfTokenMode = 'none' | 'token' | 'secret';

const QUANTIZED = ['fp8', 'fp4', 'nvfp4', 'mxfp4', 'mxfp8', 'int8', 'int4', 'awq', 'gptq'];

// AppCo vLLM serving image. The chart requires explicit modelSpec.registry + tag,
// and defaults to docker.io if registry is omitted (→ pull-access-denied). We pin the
// SUSE Application Collection registry and the 0.13.0 tag: the bundled 0.19.0-5.x
// builds are missing 'pydantic_extra_types' and 500 on chat completions (per the
// operator's inference-endpoint-litellm-vllm blueprint). Bump alongside VLLM_CHART_VERSION.
const VLLM_IMAGE_REGISTRY = 'dp.apps.rancher.io';
const VLLM_IMAGE_TAG = '0.13.0-5.3';

/** Capability keys the wizard offers as toggles (must map to concrete vLLM args). */
export const TOGGLEABLE_FEATURES = ['tool_calling', 'reasoning'];

/** Parse the leading numeric part of a parameter-count string, e.g. "70B" → 70. */
function parseParamB(s: string): number {
  const m = /([\d.]+)/.exec(s || '');
  return m ? parseFloat(m[1]) : 0;
}

/**
 * Recommended minimum host CPU / memory requests derived from model size. Weights
 * load into GPU VRAM; host RAM is for the runtime + weight staging + KV overhead, so
 * these are conservative tiers rather than the full weight size. Used as the wizard's
 * default min request; going below risks OOM/instability (the UI warns).
 */
export function recommendedResources(model: ModelCatalogEntry): { cpu: number; memoryGi: number } {
  const p = parseParamB(model.parameterCount);
  if (p <= 0)   return { cpu: 4,  memoryGi: 16 };
  if (p < 8)    return { cpu: 4,  memoryGi: 16 };
  if (p < 35)   return { cpu: 8,  memoryGi: 32 };
  if (p <= 100) return { cpu: 16, memoryGi: 64 };
  return { cpu: 32, memoryGi: 128 };
}

/** Parse a memory string like "16Gi"/"16G" to a GiB number (0 if unparseable). */
export function parseMemGi(s: string): number {
  const m = /([\d.]+)\s*(Gi|G)?/i.exec((s || '').trim());
  return m ? parseFloat(m[1]) : 0;
}

/** Approximate bytes-per-parameter for a precision (for weight-size estimation). */
function bytesPerParam(precision: string): number {
  switch ((precision || '').toLowerCase()) {
  case 'bf16': case 'fp16':                                    return 2;
  case 'fp8': case 'int8':                                     return 1;
  case 'fp4': case 'nvfp4': case 'mxfp4': case 'int4': case 'awq': case 'gptq': return 0.5;
  default:                                                     return 2;
  }
}

/**
 * Recommended PVC size (GiB) for the model weights download, from parameter count ×
 * bytes-per-parameter (precision) plus ~30% headroom + a small base for the tokenizer/
 * cache. This is the persistent volume that holds the Hugging Face download — too small
 * and the download fails with "no space left on device".
 */
export function recommendedStorageGi(model: ModelCatalogEntry, precision: string): number {
  const p = parseParamB(model.parameterCount);
  if (p <= 0) return 20;
  const weightsGB = p * bytesPerParam(precision);
  return Math.max(20, Math.ceil(weightsGB * 1.3) + 10);
}

/** Rough extracted footprint of the vLLM CUDA image on a node, in GiB. */
export const VLLM_IMAGE_FOOTPRINT_GI = 15;

/**
 * Rough minimum free disk a target node needs: the vLLM CUDA image (~15 GiB extracted)
 * plus the model weights — on kind / local-path storage the PVC lives on the node disk
 * too, so both count. Under this, deploys fail with "no space left on device".
 */
export function recommendedNodeDiskGi(model: ModelCatalogEntry, precision: string): number {
  return VLLM_IMAGE_FOOTPRINT_GI + recommendedStorageGi(model, precision);
}

export function isQuantized(precision: string): boolean {
  return QUANTIZED.includes((precision || '').toLowerCase());
}

export function precisionToDtype(precision: string): string {
  switch ((precision || '').toLowerCase()) {
  case 'bf16': return 'bfloat16';
  case 'fp16': return 'float16';
  default:     return 'auto'; // quantized checkpoints load in their native dtype
  }
}

/** Sensible starting selections for a model. */
export function defaultSelections(model: ModelCatalogEntry): VllmSelections {
  const res = recommendedResources(model);
  return {
    precision:            model.precisions[0] || 'bf16',
    gpuCount:             1,
    tensorParallelSize:   1,
    gpuMemoryUtilization: 0.9,
    maxModelLen:          Math.min(model.contextLength, 16384),
    replicas:             1,
    requestCPU:           res.cpu,
    requestMemory:        `${ res.memoryGi }Gi`,
    pvcStorage:           `${ recommendedStorageGi(model, model.precisions[0] || 'bf16') }Gi`,
    runtimeClassName:     'nvidia',
    serviceType:          'ClusterIP',
    hfTokenMode:          'none',
    hfToken:              '',
    hfSecretName:         '',
    hfSecretKey:          'HF_TOKEN',
    features:             [],
  };
}

/** Validate selections against the model. Returns human-readable error strings. */
export function validateSelections(model: ModelCatalogEntry, s: VllmSelections): string[] {
  const errs: string[] = [];
  if (!model.precisions.includes(s.precision)) {
    errs.push(`Precision "${ s.precision }" is not supported by this model (${ model.precisions.join(', ') }).`);
  }
  if (!(s.gpuCount >= 1)) errs.push('GPU count must be at least 1.');
  if (!(s.tensorParallelSize >= 1)) errs.push('Tensor-parallel size must be at least 1.');
  if (s.tensorParallelSize > s.gpuCount) errs.push('Tensor-parallel size cannot exceed the GPU count.');
  if (s.gpuCount % Math.max(s.tensorParallelSize, 1) !== 0) {
    errs.push('GPU count should be a multiple of the tensor-parallel size.');
  }
  if (!(s.maxModelLen >= 1)) errs.push('Max model length must be a positive number.');
  if (s.maxModelLen > model.contextLength) {
    errs.push(`Max model length cannot exceed the model's context length (${ model.contextLength }).`);
  }
  if (!(s.gpuMemoryUtilization > 0 && s.gpuMemoryUtilization <= 1)) {
    errs.push('GPU memory utilization must be between 0 and 1.');
  }
  if (!(s.replicas >= 1)) errs.push('Replicas must be at least 1.');
  if (!(s.requestCPU >= 1)) errs.push('CPU request must be at least 1.');
  if (!s.requestMemory?.trim()) errs.push('Memory request is required (e.g. 16Gi).');
  if (!s.pvcStorage?.trim()) errs.push('Storage size is required.');
  return errs;
}

/** Best-effort feature → vLLM args. Exact parsers come from recipe data in Phase 1. */
function featureArgs(features: string[]): string[] {
  const args: string[] = [];
  if (features.includes('tool_calling')) args.push('--enable-auto-tool-choice', '--tool-call-parser', 'hermes');
  if (features.includes('reasoning')) args.push('--reasoning-parser', 'deepseek_r1');
  return args;
}

/** Build the AppCo vLLM chart values from a model + selections. */
export function buildVllmValues(model: ModelCatalogEntry, s: VllmSelections): Record<string, any> {
  const extraArgs = featureArgs(s.features);
  if (isQuantized(s.precision)) extraArgs.push('--kv-cache-dtype', 'fp8');

  const modelSpec: Record<string, any> = {
    // Short, constant name: chart resource names are `{release}-{modelSpec.name}-…`
    // (e.g. `-engine-service`, `-deployment-vllm`), capped at 63 chars by k8s. Keeping
    // this short means the release name is the only length knob (validated in the UI).
    name:            'vllm',
    registry:        VLLM_IMAGE_REGISTRY,
    repository:      'containers/vllm-openai',
    tag:             VLLM_IMAGE_TAG,
    imagePullPolicy: 'IfNotPresent',
    modelURL:        model.id,
    replicaCount:  s.replicas,
    requestCPU:    s.requestCPU,
    requestMemory: s.requestMemory,
    requestGPU:    s.gpuCount,
    pvcStorage:    s.pvcStorage,
    vllmConfig:   {
      dtype:                precisionToDtype(s.precision),
      maxModelLen:          s.maxModelLen,
      tensorParallelSize:   s.tensorParallelSize,
      gpuMemoryUtilization: s.gpuMemoryUtilization,
      ...(extraArgs.length ? { extraArgs } : {}),
    },
  };
  if (s.hfTokenMode === 'token' && s.hfToken?.trim()) {
    modelSpec.hf_token = s.hfToken.trim();
  } else if (s.hfTokenMode === 'secret' && s.hfSecretName?.trim()) {
    modelSpec.hf_token = { secretName: s.hfSecretName.trim(), secretKey: s.hfSecretKey?.trim() || 'HF_TOKEN' };
  }

  return {
    servingEngineSpec: {
      runtimeClassName: s.runtimeClassName,
      modelSpec:        [modelSpec],
    },
    routerSpec: {
      enableRouter:  true,
      serviceType:   s.serviceType,
      containerPort: 8000,
      servicePort:   80,
    },
  };
}
