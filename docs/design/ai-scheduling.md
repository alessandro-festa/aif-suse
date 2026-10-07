# AI scheduling: training jobs, scheduler backends and compute pools

Status: design + PoC nav (branch `aijob-scheduling`, alessandro-festa fork only).
Builds on [AIJob](aijob.md) (dstanley, `feat/aijob-workloads-page`, commits 1–11 cherry-picked).

## 1. What we start from

dstanley's branch adds an `AIJob` CRD and controller, the `charts/gpu-train-job` chart, sample
profiles, a Python SDK and a training UI in `ui/pkg/aif-ui/training/`. The UI already ships inside
the aif-ui extension, so it isn't a separate product to import. What remained was *where* it sits
in the nav, and how far its scheduler support reaches.

Its scheduler support is one enum, `none | kueue | kai | runai`, copied in five places:

| Where | What it hard-codes |
|---|---|
| `charts/gpu-train-job/values.yaml`, `_podspec.tpl`, `job.yaml`, `pytorchjob.yaml` | `schedulerName: kai-scheduler` / `runai-scheduler`, labels `kai.scheduler/queue`, `project`, `kueue.x-k8s.io/queue-name`, `suspend: true` |
| `charts/gpu-train-job/_preflight.tpl`, `questions.yaml` | CRD probes per backend; `questions.yaml` lacks `runai` |
| `ui/.../training/preflight.ts` | `SchedulerType`, `SCHEDULER_BINDING` |
| `ui/.../training/pages/Submit.vue` | the scheduler dropdown, built from detected CRDs |
| `operator/internal/controller/aijob/observe.go` | Kueue `Workload` pinned to **v1beta1**, `kaiHeld()` (KAI pods only; Run:ai pods are never reported as held) |

The branch also assumes:
- **Single cluster.** The controller installs the chart on `local` with the in-process Helm client, and the UI routes pin `local`.
- **NVIDIA only.** It uses `nvidia.com/gpu`, the GFD labels, `gpu.nvidia.com` DRA, ComputeDomain and `CUDA_MPS_*`.
- **Two workload kinds.** Only `batch/v1 Job` and Training Operator v1 `PyTorchJob` are supported.

Volcano is absent. HAMi appears only as KAI's enforcement layer.

## 2. Nav: a Workloads sub-menu (done in the PoC)

dstanley's nav commit (`ac4b144b`) replaced Apps and Blueprints with a single Catalog entry. It renamed Workloads
to Deployments and moved Projects and Profiles into Settings tabs. We dropped that commit and kept
upstream's sidebar. **Workloads** becomes a group:

```
Overview
Apps
Blueprints
Workloads ▸ Deployments        (existing AIWorkloads.vue — inference / apps / blueprints)
            Training Jobs      (training/pages/Workloads.vue)
            Projects           (training/pages/Projects.vue — Rancher project + queue/quota)
            Compute Profiles   (training/pages/Profiles.vue — browse + Deploy; Edit for writers)
            Compute Pools      (pages/ComputePools.vue — new)
Settings
About
```

Implementation:
- `config/suseai.ts` defines `WORKLOADS_GROUP` and `WORKLOADS_GROUP_TYPES`.
- `product.ts` calls `basicType(types, group)`, `weightGroup` and `setGroupDefaultType`.
- The group label is `nav.group.aifWorkloads` in l10n.
- Virtual types are prefixed (`training-jobs`, `ai-projects`, …). Without the prefix, Rancher's nav could mistake one for a resource type of the same name.
- Routes keep dstanley's names (`jobs`, `projects`, `profiles`), so his deep links still work.
- Links that pointed at `-catalog` or `settings?tab=profiles` now open Compute Profiles.
- Submit, Deploy, Endpoint and Inference Profile stay non-nav routes, reached from buttons.

## 2b. No chart repository (done in the PoC)

dstanley's branch made users point each cluster at a chart repository (the `gpu-train-charts`
ClusterRepo, or the "Add to this cluster" banner) before they could submit. Now the training chart
is **built into the operator**:

- `make train-chart` packages `charts/gpu-train-job` into `operator/internal/trainchart/gpu-train-job.tgz`, embedded with `go:embed` the same way `default-catalog.json` is. The operator image builds from `operator/` alone, so the archive is a generated copy. `TestArchiveMatchesChartSource` fails when it's stale, and release-prepare re-packages it after bumping the chart version.
- `AIJob.spec.source` is optional. Without it the controller installs the embedded chart: `helm.ReleaseSpec.ChartArchive` is loaded in memory, with no pull and no cache entry.
- **Custom charts are opt-in.** An AIJob with a `spec.source` must match `manager.aijobAllowedCharts`. The list is now empty by default, which allows only the built-in chart (dstanley's empty list meant "any chart").
- In the UI, the banner, the ClusterRepo lookup and the direct-install fallback are gone. Submit always creates an AIJob. Preflight reports "Job template built into AI Factory". A custom chart sits behind "Advanced: custom job chart".
- The operator chart no longer creates the `gpu-train-charts` ClusterRepo (its `trainingChart` values and `training-chart-repo.yaml` are removed).
- For multi-cluster dispatch (§6.4), the same archive goes to downstream clusters as an inline Fleet Bundle via `buildGitChartBundle`. It is 28 KB packed and ~140 KB unpacked, well under the 1 MiB Bundle budget. Downstream clusters don't need a repository either.

## 3. Two axes, not one enum

| Axis | Values | Why separate |
|---|---|---|
| **Scheduling / queueing backend** | `none`, `kueue`, `kai`, `runai`, `volcano` | Decides who admits a job and in what order: queues, quota, gang scheduling, preemption |
| **GPU sharing backend** | `none`, `kai-fraction`, `hami`, `dra-mps` | Decides how a GPU is split. HAMi composes with other schedulers (Volcano vGPU, KAI enforcement), so it doesn't compete with them |

## 4. Backend descriptor

There should be one table, shared by the chart helpers, preflight, Submit, Projects and `observe.go`.
It is a Go struct in the operator, and the UI gets it through the API. The chart receives the
*resolved* binding as values, not a backend name.

| Field | KAI | Run:ai | Kueue | Volcano | none |
|---|---|---|---|---|---|
| `detect` (API group) | `scheduling.run.ai` without `run.ai` | `run.ai` | `kueue.x-k8s.io` | `scheduling.volcano.sh` | — |
| `schedulerName` | `kai-scheduler` | `runai-scheduler` | default | `volcano` | default |
| queue binding | pod label `kai.scheduler/queue` | pod label `project` + ns label `runai/queue` | Job label `kueue.x-k8s.io/queue-name` | annotation `scheduling.volcano.sh/queue-name` (+ PodGroup) | — |
| admission | scheduler holds pods | scheduler holds pods | `suspend: true` until admitted | PodGroup `Inqueue` | — |
| gang | PodGrouper (implicit) | PodGrouper | all-or-nothing admission | PodGroup `minMember` | none |
| quota model | Queue tree (`scheduling.run.ai/v2`) | Run:ai Project/Queue (adopt only) | ClusterQueue / Cohort / ResourceFlavor | Volcano Queue (`capability`, `deserved`) | ResourceQuota |
| status observer | pods pending + unbound | same, for `runai-scheduler` | `Workload` (probe v1beta2 → v1beta1) | PodGroup phase | pods |
| sharing support | `kai-fraction` (needs device plugin) | `kai-fraction` | none (rejects existing ResourceClaims) | `hami` (volcano-vgpu) | `dra-mps` |

| Sharing backend | Request shape | Detect |
|---|---|---|
| `kai-fraction` | pod annotation `gpu-memory` / `gpu-fraction` | KAI present |
| `hami` | resources `nvidia.com/gpumem`, `nvidia.com/gpucores`; `schedulerName: hami-scheduler` unless Volcano | node annotation `hami.io/node-nvidia-register` |
| `dra-mps` | shared ResourceClaim, `CUDA_MPS_PINNED_DEVICE_MEM_LIMIT` | DeviceClass `gpu.nvidia.com` + MPS claim |

## 5. Components each backend needs

| Backend | What runs on the cluster | Source (verified 2026-10-07) | In AIF catalog? |
|---|---|---|---|
| **Common (GPU pools)** | NVIDIA GPU Operator (device plugin, GFD, DCGM-exporter) *or* the NVIDIA DRA driver | `gpu-operator`, `nvidia-dra-driver-gpu` | yes |
| **Common (training)** | Kubeflow Training Operator (`PyTorchJob`, v1.9.4) and/or Trainer v2 (`TrainJob`, v2.2.1) | SUSE `oci://registry.suse.com/ai/charts/kubeflow` 0.4.1, subcharts `training-operator` + `trainer` (both on by default) | yes, **Kubeflow** |
| **Common (runtime image)** | PyTorch with CUDA | App Collection `oci://dp.apps.rancher.io/charts/pytorch` 0.4.0 → image `dp.apps.rancher.io/containers/pytorch:2.14.0-nvidia-2.3` | yes, **PyTorch** |
| **Common (idle reclaim)** | Rancher Monitoring (Prometheus) + DCGM-exporter | rancher-monitoring | Rancher chart |
| **KAI** | scheduler, binder, podgrouper, queue-controller, admission webhook | `oci://ghcr.io/nvidia/kai-scheduler/kai-scheduler` v0.20.1 | **no, add it** |
| **Kueue** | controller-manager + webhook (default kube-scheduler) | `oci://registry.k8s.io/kueue/charts/kueue` 0.20.0 | **no, add it** |
| **Volcano** | volcano-scheduler, controllers, admission | `https://volcano-sh.github.io/helm-charts` `volcano` 1.15.3 | **no, add it** |
| **HAMi** | hami-scheduler (extender), hami-device-plugin (GPU Operator `devicePlugin.enabled=false`), mutating webhook | `https://project-hami.github.io/HAMi` `hami` 2.10.0 | **no, add it** |
| **Run:ai** | control plane + `runai-cluster` (runai-scheduler, KAI-based) | NGC `nvidia/runai` (gated) | yes |

How these fit together:
- **Kubeflow.** The SUSE chart is the whole platform (dashboard, pipelines, KServe, Katib, Dex, …). To use it as a training runtime only, install it with the other subcharts disabled. AIF should ship a values preset for that ("Kubeflow — training only").
- **Trainer v2.** It is the long-term path: `TrainJob` plus `ClusterTrainingRuntime`. That needs a third chart template and a `TrainJob` observer next to Job and PyTorchJob.
- **PyTorch image.** The App Collection image should become the default image for the `gpu-train-job` torch profiles, instead of `bci-base` plus a pip install. Then training runs on a SUSE-supported stack.

## 6. Compute pools across clusters

### 6.1 Model

A **`ComputePool`** is a cluster-scoped CRD on the management cluster, one per (cluster, node subset):

```yaml
spec:
  clusterId: c-m-abc123
  nodeSelector: { nvidia.com/gpu.product: NVIDIA-H100-80GB-HBM3 }   # or empty = whole cluster
  kind: gpu            # gpu | cpu
  enabled: true
  priority: 10
  costWeight: 1.0
  allowedProjects: []  # empty = all
  reclaim:
    idleTimeout: 2h
    idleThreshold: 5    # percent
    maxIdleTimeout: 24h # ceiling a profile/project may relax to
    onlyWhenContended: true
status:
  connected: true
  nodes: 4
  allocatable: { cpu: 256, memory: 2Ti, gpus: 32, gpuMemory: 2560Gi }
  free:        { cpu: 120, memory: 900Gi, gpus: 8 }
  gpu: { vendor: nvidia, model: H100-80GB, sharing: [kai-fraction] }
  scheduler: kai
  training: [training-operator, trainer-v2]
  queues: [{ name: team-a, freeGPUs: 4, pending: 2 }]
  monitoring: true
```

How pools are created and used:
- **Discovery.** A pool controller reads every downstream through the Rancher proxy (`/k8s/clusters/<id>`). It creates one default pool per GPU product per cluster, plus one CPU-only pool. Admins can then split, edit or disable them.
- **CPU-only pools are first-class.** They have `kind: cpu`, a GPU mode of none, and the same scheduler descriptor (Kueue and Volcano run fine without GPUs). They cover CPU fine-tuning, evaluation, data prep and llama.cpp work.
- **PoC.** `pages/ComputePools.vue` (`services/compute-pools.ts`) shows the raw material today: each cluster with its CPU/memory/GPU totals and its detected schedulers, sharing and training runtime.

### 6.2 What an AIJob asks for

`AIJob.spec` gains requirements, so a job no longer names its scheduler:

```yaml
spec:
  requirements:
    gpu: { count: 4, model: H100*, minMemory: 80Gi, sharing: none }   # or
    cpu: { cores: 32, memory: 128Gi }
  poolSelector: { matchLabels: { tier: prod } }   # optional
  placement: binpack                                # binpack | spread | cheapest
  reclaimPolicy: Suspend                            # from the profile; Suspend | Terminate | Never
```

### 6.3 Placement: the operator as a meta-scheduler

The placement controller decides **where** a job goes. **When** it runs on that cluster is still up to
the local scheduler (KAI, Kueue, Volcano, Run:ai).

1. **Filter.** Keep pools that are enabled, connected and allowed for the project, whose capability matches (GPU model and memory, gang support for multi-worker jobs, sharing mode), and whose training runtime is present for the job kind.
2. **Score.** Rank by free quota in the project's queue on that pool, queue depth, policy (binpack, spread or cheapest) and `costWeight`.
3. **Bind.** Write `status.placement {poolRef, clusterId, backend, queue, reason}`, then render values from the pool's backend descriptor.
4. **Re-place.** If the job is still unadmitted after a timeout and no pod has started, unbind it and go back to step 1.

### 6.4 Dispatch and observe

- **Dispatch.** Ship the built-in chart to `clusterId` as an inline Fleet Bundle, reusing the AIWorkload code in `operator/internal/controller/aiworkload/` (`buildGitChartBundle`, `chartTgzToBundleResources`, `deleteBundleIn`). A custom `spec.source` uses the HelmOp path (`helmOpGVK`, `deleteHelmOpIn`). This replaces the local `helm.EnsureRelease`, and `local` becomes just another pool.
- **Observe.** `observe.go` and `report.go` take a client per cluster, built on the Rancher proxy (cached per cluster), instead of the manager's own client.
- **UI.** RunDetail, podlog and podevents read the cluster from `status.placement.clusterId`.
- **Projects across clusters.** An "AI project" is logical. It maps to a queue (or ResourceQuota) on each pool's cluster. The Projects page shows it per pool.

### 6.5 Global queue and deferred placement

- **Submission never fails** for lack of capacity. When no pool fits, the AIJob goes to `Pending` with reason `NoPoolAvailable` and waits in a **global queue**, ordered by priority, project fair-share and submit time.
- **Retries.** The placement controller watches `ComputePool` status (connected, free capacity, enabled) and retries the head of the queue on every change, plus a periodic resync. When a pool comes back or frees up, the next eligible job is placed.

### 6.6 Idle reclaim and hand-off

- **Activity signal.** Prometheus on each cluster, reached through the proxy (`/k8s/clusters/<id>/api/v1/namespaces/cattle-monitoring-system/services/http:rancher-monitoring-prometheus:9090/proxy`):
  - GPU pools: `DCGM_FI_DEV_GPU_UTIL` per pod.
  - CPU pools: `rate(container_cpu_usage_seconds_total)` against the request.
- **Idle.** A job is idle when its usage stays under `idleThreshold` for the whole `idleTimeout`. The controller records `status.activity {lastActiveAt, utilisation, idleSince}`.
- **Timeout.** Each pool has a default; a profile or project may override it, up to `maxIdleTimeout`.
- **When reclaim fires.** Only if another job is waiting for that pool (`onlyWhenContended`, on by default), so no work is evicted for nothing.
- **Release policy, per profile:**
  - `Suspend`: run the checkpoint hook if the profile has one (the chart already mounts a checkpoint PVC). Then suspend (Job `spec.suspend`, PyTorchJob `runPolicy.suspend`, or scale to 0) and requeue at the original submit time.
  - `Terminate`: delete the HelmOp and release, and set phase `Reclaimed`.
  - `Never`: e.g. production inference. The job is still reported as idle.
- **Hand-off.** Once the pods are gone and the capacity is really free, place the next queued job. Record an Event and a `status.reclaimHistory` entry.
- **Relation to cluster schedulers.** KAI, Kueue and Volcano still preempt inside a cluster by their own rules. AIF reclaim only frees capacity that is held but unused, which those schedulers can't see.
- **Known gaps:**
  - Clusters without Monitoring get pools marked `reclaim: unsupported`.
  - Fractional or shared GPUs need per-pod attribution (DCGM pod mapping or HAMi's own metrics).

## 7. Gaps carried over from the AIJob branch

1. The scheduler enum is copied in 5 places. Replace it with the descriptor (§4).
2. Scheduler names are literals in the chart, `observe.go` and `quota.ts`.
3. Queue label keys are literals. Namespaces get KAI and Run:ai labels at the same time.
4. Kueue `Workload` is pinned to v1beta1 in the operator while the chart probes v1beta2.
5. Run:ai pods (`runai-scheduler`) are never reported as held/Queued.
6. Gang scheduling is implicit (KAI PodGrouper, Kueue admission). There's nothing for Volcano `minMember`.
7. Fractional GPUs are KAI-only. HAMi resource requests are missing.
8. The only quota editors are the KAI Queue tree and ResourceQuota. Kueue ClusterQueue and Volcano Queue are missing.
9. `AIJob.status.queue` has Kueue/KAI-specific fields. Replace them with `{backend, queue, admitted, reason}`.
10. NVIDIA-only resource keys, GFD labels and DRA attribute names.
11. Only Job and PyTorchJob are supported. `TrainJob` (Trainer v2) is missing.
12. Single cluster (`local`): §6 addresses this.

## 8. Phases

| # | Phase | Done when |
|---|---|---|
| 0 | Branch, cherry-pick, Workloads sub-menu, Compute Pools PoC page, built-in training chart (no repository), this doc | ✅ tests green; build ok |
| 1 | Backend descriptor; refactor KAI/Kueue/Run:ai behind it (chart, preflight, Submit, observe) | the enum exists in one place; existing tests pass |
| 2 | `ComputePool` CRD + discovery via the cluster proxy (GPU and CPU pools) | pools appear for local + downstream-1/-2 |
| 3 | Multi-cluster dispatch (Fleet HelmOp) + proxy-based observe | a job runs on a downstream and its status/logs/result show up |
| 4 | Placement controller + global queue + deferred placement | a job submitted with no free pool starts when one frees up |
| 5 | Activity controller + idle reclaim + per-profile policy + hand-off | an idle notebook-style job is suspended and the queued job takes its pool |
| 6 | Volcano backend | job queued and gang-scheduled by Volcano |
| 7 | HAMi on the sharing axis | a fractional job lands via HAMi |
| 8 | Catalog entries (KAI, Kueue, Volcano, HAMi; Kubeflow training-only preset) + "install a scheduler on this cluster" empty state | install from Compute Pools |
| 9 | Generic `AIJob.status.queue`; Trainer v2 `TrainJob` template + observer | — |

Lab: kind-sims-datacenter (management) plus downstream-1 and downstream-2. Target is a different
scheduler on each downstream (e.g. KAI on one, Kueue CPU-only on the other).
