/**
 * TEMPORARY curated snapshot backing the Models browse page (Phase 2).
 *
 * This is a hand-picked, realistic subset of vLLM-deployable LLM recipes so the
 * Models page can be evaluated visually before the operator endpoint exists.
 * It will be REPLACED by GET /api/v1/models (Phase 1), which serves the same
 * ModelCatalogEntry shape normalized from recipes.vllm.ai. Do not rely on these
 * exact values for deployment — they are for look-and-feel only.
 */
import type { ModelCatalogEntry } from '../types/model-catalog';

/**
 * Best-effort provider → brand-icon slug (Simple Icons CDN). Unknown providers
 * fall back to the initial-avatar in the UI (img onerror). Phase 1's operator
 * endpoint will supply proper per-model logos.
 */
const PROVIDER_ICON: Record<string, string> = {
  'Qwen':        'alibabadotcom',
  'Meta':        'meta',
  'Google':      'google',
  'Mistral AI':  'mistralai',
  'DeepSeek':    'deepseek',
  'NVIDIA':      'nvidia',
  'AMD':         'amd',
};

const RAW_MODELS: ModelCatalogEntry[] = [
  {
    id: 'Qwen/Qwen3-4B', title: 'Qwen3-4B', provider: 'Qwen',
    description: 'Compact dense model with hybrid thinking/instruct modes; fits on a single GPU.',
    architecture: 'dense', parameterCount: '4B', contextLength: 40960,
    precisions: ['bf16', 'fp8'], gpuVendor: 'nvidia', gpuFamilies: ['H100', 'H200', 'B200'],
    tasks: ['text', 'reasoning', 'tool_calling'], minVllmVersion: '0.8.5',
    recipeUrl: 'https://recipes.vllm.ai/Qwen/Qwen3-4B', sizeBucket: 'small',
  },
  {
    id: 'Qwen/Qwen3-32B', title: 'Qwen3-32B', provider: 'Qwen',
    description: 'Mid-large dense model for strong reasoning and tool use.',
    architecture: 'dense', parameterCount: '32B', contextLength: 40960,
    precisions: ['bf16', 'fp8'], gpuVendor: 'nvidia', gpuFamilies: ['H100', 'H200', 'B200', 'GB200'],
    tasks: ['text', 'reasoning', 'tool_calling'], minVllmVersion: '0.8.5',
    recipeUrl: 'https://recipes.vllm.ai/Qwen/Qwen3-32B', sizeBucket: 'medium',
  },
  {
    id: 'Qwen/Qwen3-235B-A22B', title: 'Qwen3-235B-A22B', provider: 'Qwen',
    description: 'Large MoE model; 235B total / 22B active parameters.',
    architecture: 'moe', parameterCount: '235B', activeParameters: '22B', contextLength: 131072,
    precisions: ['bf16', 'fp8'], gpuVendor: 'nvidia', gpuFamilies: ['H200', 'B200', 'GB200'],
    tasks: ['text', 'reasoning', 'tool_calling'], minVllmVersion: '0.8.5',
    recipeUrl: 'https://recipes.vllm.ai/Qwen/Qwen3-235B-A22B', sizeBucket: 'xlarge',
  },
  {
    id: 'meta-llama/Llama-3.1-8B-Instruct', title: 'Llama 3.1 8B Instruct', provider: 'Meta',
    description: 'General-purpose 8B instruct model with 128K context.',
    architecture: 'dense', parameterCount: '8B', contextLength: 131072,
    precisions: ['bf16', 'fp8'], gpuVendor: 'nvidia', gpuFamilies: ['A100', 'H100', 'H200'],
    tasks: ['text', 'tool_calling'], minVllmVersion: '0.6.0',
    recipeUrl: 'https://recipes.vllm.ai/meta-llama/Llama-3.1-8B-Instruct', sizeBucket: 'small',
  },
  {
    id: 'meta-llama/Llama-3.3-70B-Instruct', title: 'Llama 3.3 70B Instruct', provider: 'Meta',
    description: 'High-quality 70B instruct model; multi-GPU tensor-parallel.',
    architecture: 'dense', parameterCount: '70B', contextLength: 131072,
    precisions: ['bf16', 'fp8'], gpuVendor: 'nvidia', gpuFamilies: ['H100', 'H200', 'B200'],
    tasks: ['text', 'tool_calling'], minVllmVersion: '0.6.4',
    recipeUrl: 'https://recipes.vllm.ai/meta-llama/Llama-3.3-70B-Instruct', sizeBucket: 'large',
  },
  {
    id: 'mistralai/Mistral-Small-24B-Instruct', title: 'Mistral Small 24B', provider: 'Mistral AI',
    description: 'Efficient 24B dense instruct model.',
    architecture: 'dense', parameterCount: '24B', contextLength: 32768,
    precisions: ['bf16', 'fp8'], gpuVendor: 'nvidia', gpuFamilies: ['H100', 'H200'],
    tasks: ['text', 'tool_calling'], minVllmVersion: '0.7.0',
    recipeUrl: 'https://recipes.vllm.ai/mistralai/Mistral-Small-24B-Instruct', sizeBucket: 'medium',
  },
  {
    id: 'google/gemma-2-9b-it', title: 'Gemma 2 9B IT', provider: 'Google',
    description: 'Compact instruction-tuned dense model.',
    architecture: 'dense', parameterCount: '9B', contextLength: 8192,
    precisions: ['bf16'], gpuVendor: 'nvidia', gpuFamilies: ['A100', 'H100', 'H200'],
    tasks: ['text'], minVllmVersion: '0.5.4',
    recipeUrl: 'https://recipes.vllm.ai/google/gemma-2-9b-it', sizeBucket: 'small',
  },
  {
    id: 'deepseek-ai/DeepSeek-V3', title: 'DeepSeek-V3', provider: 'DeepSeek',
    description: 'Very large MoE model; 671B total / 37B active parameters.',
    architecture: 'moe', parameterCount: '671B', activeParameters: '37B', contextLength: 163840,
    precisions: ['fp8'], gpuVendor: 'nvidia', gpuFamilies: ['H200', 'B200', 'GB200'],
    tasks: ['text', 'reasoning'], minVllmVersion: '0.7.2',
    recipeUrl: 'https://recipes.vllm.ai/deepseek-ai/DeepSeek-V3', sizeBucket: 'xlarge',
  },
  {
    id: 'microsoft/Phi-3-mini-4k-instruct', title: 'Phi-3 Mini 4K', provider: 'Microsoft',
    description: 'Small, capable 3.8B dense model for constrained hardware.',
    architecture: 'dense', parameterCount: '3.8B', contextLength: 4096,
    precisions: ['bf16'], gpuVendor: 'nvidia', gpuFamilies: ['A100', 'H100'],
    tasks: ['text'], minVllmVersion: '0.5.0',
    recipeUrl: 'https://recipes.vllm.ai/microsoft/Phi-3-mini-4k-instruct', sizeBucket: 'small',
  },
  {
    id: 'nvidia/Llama-3.1-Nemotron-70B-Instruct', title: 'Llama 3.1 Nemotron 70B', provider: 'NVIDIA',
    description: 'NVIDIA-tuned 70B instruct model optimized for helpfulness.',
    architecture: 'dense', parameterCount: '70B', contextLength: 131072,
    precisions: ['bf16', 'fp8'], gpuVendor: 'nvidia', gpuFamilies: ['H100', 'H200', 'B200'],
    tasks: ['text', 'reasoning'], minVllmVersion: '0.6.4',
    recipeUrl: 'https://recipes.vllm.ai/nvidia/Llama-3.1-Nemotron-70B-Instruct', sizeBucket: 'large',
  },
  {
    id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', title: 'Mixtral 8x7B Instruct', provider: 'Mistral AI',
    description: 'Sparse MoE model; 47B total / 13B active parameters.',
    architecture: 'moe', parameterCount: '47B', activeParameters: '13B', contextLength: 32768,
    precisions: ['bf16', 'fp8'], gpuVendor: 'nvidia', gpuFamilies: ['A100', 'H100', 'H200'],
    tasks: ['text', 'tool_calling'], minVllmVersion: '0.6.0',
    recipeUrl: 'https://recipes.vllm.ai/mistralai/Mixtral-8x7B-Instruct-v0.1', sizeBucket: 'medium',
  },
  {
    id: 'Qwen/Qwen2.5-Coder-32B-Instruct', title: 'Qwen2.5 Coder 32B', provider: 'Qwen',
    description: 'Code-specialized 32B dense model.',
    architecture: 'dense', parameterCount: '32B', contextLength: 131072,
    precisions: ['bf16', 'fp8'], gpuVendor: 'nvidia', gpuFamilies: ['H100', 'H200', 'B200'],
    tasks: ['text', 'code'], minVllmVersion: '0.6.3',
    recipeUrl: 'https://recipes.vllm.ai/Qwen/Qwen2.5-Coder-32B-Instruct', sizeBucket: 'medium',
  },
  // --- Non-NVIDIA entries: present in the data model but hidden by the default
  //     NVIDIA GPU-family filter (decision D3). Switch the vendor facet to see them.
  {
    id: 'amd/Llama-3.1-70B-Instruct-FP8', title: 'Llama 3.1 70B (AMD FP8)', provider: 'AMD',
    description: 'AMD-optimized FP8 checkpoint for MI300X-class accelerators.',
    architecture: 'dense', parameterCount: '70B', contextLength: 131072,
    precisions: ['fp8'], gpuVendor: 'amd', gpuFamilies: ['MI300X', 'MI325X'],
    tasks: ['text'], minVllmVersion: '0.6.4',
    recipeUrl: 'https://recipes.vllm.ai/amd/Llama-3.1-70B-Instruct-FP8', sizeBucket: 'large',
  },
  {
    id: 'google/gemma-2-27b-it-tpu', title: 'Gemma 2 27B (TPU)', provider: 'Google',
    description: 'TPU-targeted recipe (Trillium v6e).',
    architecture: 'dense', parameterCount: '27B', contextLength: 8192,
    precisions: ['bf16'], gpuVendor: 'tpu', gpuFamilies: ['Trillium'],
    tasks: ['text'], minVllmVersion: '0.7.0',
    recipeUrl: 'https://recipes.vllm.ai/google/gemma-2-27b-it', sizeBucket: 'medium',
  },
];

// Stamp shared presentation/metadata defaults: a brand logo (where known) plus the
// "community validated" and "free" badges (true for every recipe in this snapshot).
export const MODELS_SNAPSHOT: ModelCatalogEntry[] = RAW_MODELS.map((m) => {
  const slug = PROVIDER_ICON[m.provider];

  return {
    ...m,
    logoUrl:            m.logoUrl ?? (slug ? `https://cdn.simpleicons.org/${ slug }` : undefined),
    communityValidated: m.communityValidated ?? true,
    free:               m.free ?? true,
  };
});
