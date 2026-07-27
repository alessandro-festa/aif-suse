/**
 * Model catalog types for the "Models" menu (vLLM recipes → AppCo vLLM).
 *
 * A ModelCatalogEntry is the normalized, browse-optimized shape the Models page
 * consumes. It is intentionally decoupled from the raw recipes.vllm.ai JSON: in
 * Phase 1 the operator will fetch recipes.vllm.ai (/models.json + per-model JSON),
 * normalize + filter (NVIDIA GPU family, vLLM-deployable LLMs) and serve this exact
 * shape from GET /api/v1/models. Until then a curated snapshot backs the page
 * (see assets/models-snapshot.ts). Keep this shape in sync with the operator's
 * future Go type.
 */

export type GpuVendor = 'nvidia' | 'amd' | 'tpu' | 'cpu';

/** One vLLM-community-verified hardware configuration for a model. */
export interface ModelVerifiedConfig {
  hardware: string;
  gpuCount: number;
  vramPerGpuGB: number;
  totalVramGB: number;
}
export type ModelArchitecture = 'dense' | 'moe';

/** Coarse size buckets derived from parameter count, used for the Size facet. */
export type SizeBucket = 'small' | 'medium' | 'large' | 'xlarge';

export interface ModelCatalogEntry {
  /** Hugging Face id, e.g. "Qwen/Qwen3-4B" — the stable unique key. */
  id: string;
  /** Display name, e.g. "Qwen3-4B". */
  title: string;
  /** Provider / family label, e.g. "Qwen", "NVIDIA", "Meta". */
  provider: string;
  description?: string;

  architecture: ModelArchitecture;
  /** Total parameters, human string e.g. "4B", "235B-A22B". */
  parameterCount: string;
  /** Active parameters for MoE models, e.g. "22B". Omitted for dense. */
  activeParameters?: string;
  /** Native context length in tokens. */
  contextLength: number;

  /** Precision variants available, e.g. ["bf16", "fp8"]. */
  precisions: string[];

  /** GPU vendor — the data model is vendor-generic; the UI defaults to nvidia. */
  gpuVendor: GpuVendor;
  /** Supported GPU family display names, e.g. ["H100", "H200", "B200"]. */
  gpuFamilies: string[];
  /** Subset of gpuFamilies actually vLLM-community-verified; may be empty. */
  verifiedFamilies?: string[];

  /** Recipe tasks/capabilities, e.g. ["text"], ["multimodal", "reasoning"]. */
  tasks: string[];

  minVllmVersion?: string;
  /** Link to the source recipe page on recipes.vllm.ai. */
  recipeUrl?: string;
  /** Derived size bucket for the Size facet. */
  sizeBucket: SizeBucket;

  /** Author-validated recommended hardware (from the recipe's hardware_profile). */
  recHardware?: string;
  /** Author-validated GPU count for the recommended profile. */
  recGpuCount?: number;
  /** Author-validated total GPU memory (GB) for the recommended profile. */
  recVramGB?: number;

  /** Optional brand/model logo URL; the UI falls back to a provider initial avatar. */
  logoUrl?: string;
  /** Recipe is community-validated (recipes.vllm.ai). Shown as a card badge. */
  communityValidated?: boolean;
  /** Model/recipe carries no license cost. Shown as a "Free" card badge. */
  free?: boolean;
}
