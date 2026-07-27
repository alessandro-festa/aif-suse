# Models — vLLM inference recipes → deploy / blueprint

Developer guide for the **Models** feature: a Rancher-UI menu that lets a user browse
validated vLLM inference recipes (mirroring [recipes.vllm.ai](https://recipes.vllm.ai)),
configure hardware/optimizations in a wizard, and finish by either **deploying** the model
or **publishing it as a Blueprint** — always served by the **SUSE Application Collection
(AppCo) vLLM Helm chart**.

> Status: developed on the `suse-llm` exploration branch. This guide targets anyone
> maintaining the feature or preparing it for upstream (SUSE/aif) merge.

## 1. Architecture at a glance

```
recipes.vllm.ai ──(operator, server-side, cached)──► GET /api/v1/models        ─┐
   /models.json + per-model JSON                      GET /api/v1/models/configs │
                                                                                 ▼
                                              Rancher UI extension (aif-ui, Vue 3)
                                              Models browse ─► Model detail + wizard
                                                                        │
                             recipe + user selections ─► AppCo vLLM values.yaml
                                                                        │
                                        ┌───────────────────────────────┴───────────┐
                                   Deploy (Fleet bundle + AIWorkload)        Publish as Blueprint
                                   POST /api/v1/namespaces/{ns}/aiworkloads  POST /api/v1/blueprints
```

- **Operator** owns the catalog: it fetches recipes.vllm.ai, normalizes/filters, caches
  (6 h background refresh, bundled fallback), and serves it. The UI stays thin.
- **UI** renders the catalog, runs the wizard, translates a recipe into AppCo vLLM Helm
  values, and drives deploy/publish through the **existing** operator REST API +
  Rancher/Fleet primitives (no new CRDs).

## 2. Components & file map

**Operator (`operator/`)**
| File | Role |
|---|---|
| `internal/models/models.go` | `Entry`/`HardwareConfig` types, embedded `default-models.json`, `Normalize`, `Bundled` |
| `internal/models/recipes.go` | Live fetch of recipes.vllm.ai (index + per-model JSON, concurrent), `enrich`, `FetchHardwareConfigs`, GPU-family map |
| `internal/models/default-models.json` | Bundled fallback catalog (curated NVIDIA vLLM LLMs) |
| `internal/api/models.go` | `GET /api/v1/models` (cached list, background refresh) + `GET /api/v1/models/configs?id=` (verified configs, on-demand) |
| `cmd/main.go` | Registers `NewModelsHandler()` on the API mux |

**UI (`ui/pkg/aif-ui/`)**
| File | Role |
|---|---|
| `config/suseai.ts` | Nav entry: `PAGE_TYPES.MODELS`, `VIRTUAL_TYPES`, `NAV_WEIGHTS=35` (between Apps 40 / Blueprints 30), `BASIC_TYPES` |
| `routing.ts` | Routes `…-models` (browse) and `…-model-detail` (detail+wizard, id via `?id=`) |
| `pages/Models.vue` | Browse page: search + facets (validation, GPU vendor/family, size, arch, precision), verified badges |
| `pages/ModelDetail.vue` | Detail overview + 4-step wizard (Cluster → Hardware → Values → Review) + deploy/publish |
| `types/model-catalog.ts` | `ModelCatalogEntry`, `ModelVerifiedConfig` (mirror operator JSON) |
| `services/models-catalog.ts` | `fetchModelsCatalog()` → operator `/api/v1/models`, snapshot fallback |
| `services/recipe-to-vllm.ts` | Recipe + selections → AppCo vLLM values; resource/storage sizing helpers |
| `services/cluster-gpu.ts` | Cluster GPU detection (node labels) + compatibility verdict |
| `services/model-deploy.ts` | Deploy via Fleet bundle + AIWorkload record |
| `utils/operator-api.ts` | `getModels()`, `getModelConfigs()` |
| `assets/models-snapshot.ts` | UI-side fallback snapshot |

## 3. Data model

`ModelCatalogEntry` (operator `Entry`, JSON-identical): `id` (hf id), `title`, `provider`,
`description`, `architecture` (dense|moe), `parameterCount`/`activeParameters`,
`contextLength`, `precisions[]`, `gpuVendor`, `gpuFamilies[]` (**supported** — a recipe
exists), `verifiedFamilies[]` (**verified** — `meta.hardware == "verified"`), `tasks[]`,
`minVllmVersion`, `recipeUrl`, `sizeBucket`, `logoUrl`, `communityValidated`, `free`.
`ByHardware` (per-hardware recipe paths) is kept server-side only (`json:"-"`) to resolve
`ModelVerifiedConfig[]` (`hardware`, `gpuCount`, `vramPerGpuGB`, `totalVramGB`) lazily.

**Supported vs verified** is the core distinction: `by_hardware` in a recipe only means a
recipe file exists (supported); real verification comes from `meta.hardware`. The UI colors
family badges green only for verified families and greys the rest.

## 4. Recipe → AppCo vLLM values (`services/recipe-to-vllm.ts`)

`buildVllmValues(model, selections)` emits the AppCo vLLM chart shape:
`servingEngineSpec.runtimeClassName` + `modelSpec[]` (`name` (short constant `vllm`),
`registry` `dp.apps.rancher.io`, `repository` `containers/vllm-openai`, `tag`, `modelURL`,
`requestCPU/Memory/GPU`, `pvcStorage`, `vllmConfig`{dtype, maxModelLen, tensorParallelSize,
gpuMemoryUtilization, extraArgs}, optional `hf_token`) + `routerSpec` (serviceType, ports).
Precision→dtype, features→extraArgs, quantized→`--kv-cache-dtype fp8`. Pull auth
(`global.imagePullSecrets`) is injected by `createFleetBundle` for the `suse-ai` library.

## 5. Deploy & publish

- **Deploy** (`services/model-deploy.ts`): resolves the `application-collection` ClusterRepo,
  ensures registry pull-secrets, schedules a **Fleet bundle** (`createFleetBundle`) that
  installs `vllm` `0.1.10`, and records an **AIWorkload** CR (`sourceType: App`). Fleet path
  works for the local mgmt cluster and downstream clusters.
- **Publish as Blueprint**: builds a `BlueprintSpec` (`source: Custom`, one `vllm` component)
  and calls `createBlueprint()` (`POST /api/v1/blueprints`) — reuses the existing Blueprint API.

## 6. Cluster compatibility & sizing

- **Verdict** (`gpuCompatVerdict`): reads cluster GPU from `nvidia.com/gpu.product` /
  `.count` / `.memory` node labels → `validated` (family verified), `deployable`
  (supported, unverified), `may fail` (NVIDIA GPU but unsupported family), `not deployable`
  (no NVIDIA GPU). User may proceed past a warning.
- **Sizing**: `recommendedResources` (CPU/mem by size tier), `recommendedStorageGi`
  (weights = params × bytes/param(precision) × 1.3 + 10, min 20Gi),
  `recommendedNodeDiskGi` (≈15 GiB image + weights). The wizard defaults to these and warns
  when the user goes below.

## 7. Key decisions & rationale

- **Operator-proxied catalog** (not UI-direct): avoids browser CORS, enables server-side
  normalization/filtering + a bundled air-gap fallback, keeps the UI thin.
- **No new CRDs**: deploy reuses AIWorkload/Fleet; publish reuses Blueprint. Minimises
  upstream surface area.
- **Filter = NVIDIA + text-LLM**: only recipes runnable on the AppCo vLLM chart and on
  NVIDIA cards are surfaced; the data model stays vendor-generic (UI defaults to NVIDIA).
- **Verification via `meta.hardware`**, not `by_hardware` (supported ≠ verified).
- **`modelSpec.name` is a short constant** (`vllm`) so chart resource names
  (`{release}-{name}-…`, capped at 63 chars) depend only on the release; the wizard validates
  release length and suggests a short random name.
- **Image tag `0.13.0-5.3`**: the AppCo `0.19.0-5.x` builds are broken (missing
  `pydantic_extra_types`, 500 on chat) per the bundled `inference-endpoint-litellm-vllm`
  blueprint. `registry` must be set explicitly or the chart falls back to docker.io.
- **Lazy verified-configs endpoint**: per-hardware profiles are fetched on demand (per model
  view), not in the bulk refresh, to bound outbound calls.

## 8. Constants to bump

`services/recipe-to-vllm.ts`: `VLLM_CHART` handling uses `0.1.10` (in `model-deploy.ts`),
`VLLM_IMAGE_REGISTRY`, `VLLM_IMAGE_TAG`, `VLLM_IMAGE_FOOTPRINT_GI`. `internal/models/recipes.go`:
`recipesBase`, `fetchWorkers`, refresh interval in `internal/api/models.go`.

## 9. Build, run, test

- **UI**: node 24 + `yarn install --ignore-engines`; `yarn build-pkg aif-ui`; `yarn serve-pkgs`
  then Rancher → Extensions → Developer Load the served URL. (See `AGENTS`/CI for production
  packaging.)
- **Operator**: `make docker-build IMG=…`; deploy the image; the API is reached by the UI
  through the k8s service proxy (`/k8s/clusters/{id}/…/services/http:{svc}:{port}/proxy`).
- **Verify**: `GET /api/v1/models` returns the catalog; `GET /api/v1/models/configs?id=<hf>`
  returns verified configs.

## 10. Known limitations / upstream considerations

- Bundled `default-models.json` is a small curated fallback; the live source is authoritative.
- vLLM image tag/registry are pinned constants — should track AppCo chart releases.
- Multi-node recipes are not modelled (AppCo vLLM single-node `modelSpec`); they are surfaced
  as supported but the wizard targets single-node.
- HF token: choice of existing secret or inline token; consider making it mandatory for gated
  models upstream.
- The operator performs outbound fetches to recipes.vllm.ai; air-gapped installs rely on the
  bundled fallback (or a future admin-configured mirror URL, mirroring the app-catalog `remoteUrl`).
