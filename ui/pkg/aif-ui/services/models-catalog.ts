import type { ModelCatalogEntry } from '../types/model-catalog';
import { MODELS_SNAPSHOT } from '../assets/models-snapshot';
import { getModels } from '../utils/operator-api';

/**
 * Fetch the Models catalog (vLLM recipes, normalized to ModelCatalogEntry).
 *
 * Primary source: the operator's GET /api/v1/models (Phase 1) — the operator owns
 * the catalog end to end (bundled default today; a remote recipes source can be
 * layered in behind the same shape). If the operator is unreachable or returns an
 * empty list, we fall back to the bundled UI snapshot so the page still renders.
 */
export async function fetchModelsCatalog(): Promise<ModelCatalogEntry[]> {
  try {
    const data = await getModels();
    if (Array.isArray(data) && data.length) return data as ModelCatalogEntry[];
    console.warn('[SUSE-AI] /api/v1/models returned no entries; using bundled snapshot');
  } catch (err) {
    console.warn('[SUSE-AI] /api/v1/models unavailable; using bundled snapshot', err);
  }
  return MODELS_SNAPSHOT.slice();
}
