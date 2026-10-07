# AI scheduling — engineering notes

The working document for engineers implementing AI scheduling in AI Factory: training jobs
(AIJob), pluggable scheduler backends, multi-cluster compute pools, placement and idle reclaim.

- **What and why:** [design/ai-scheduling.md](design/ai-scheduling.md), the target architecture.
- **AIJob itself:** [design/aijob.md](design/aijob.md) (dstanley).
- **This file:** decisions with their reasons and rejected alternatives, verified findings and
  traps, how to build and test, where the code is, open issues, and notes per phase. Keep it
  current: a decision or finding goes here when it is made, not at the end of the phase.

Branch: `aijob-scheduling` on the alessandro-festa fork (`origin`), based on SUSE/aif `main`
(2.3.0-rc.4). It is never pushed to `upstream` or to dstanley's fork.

---

## 1. Status

| Phase | Scope | State | Commit |
|---|---|---|---|
| 0 | dstanley's AIJob work cherry-picked; Workloads sub-menu; Compute Pools view; built-in training chart (no repository); design doc | done | `f36a018e` (+ cherry-picks `ce8c1302..9a9fd67e`) |
| 1 | Scheduler backend table (`schedulers.yaml`) behind chart, operator and UI; Kueue v1beta2; Run:AI held pods | done | `40153155` |
| 2 | `ComputePool` CRD, discovery of GPU and CPU-only pools on every cluster via the Rancher proxy | done, verified on the lab | `e5ff421d` |
| 3a | Dispatch: `spec.pool` / `spec.targetNamespace`, Helm install on the pool's cluster through the Rancher proxy, pods kept to the pool's nodes, observe + cleanup there | done, verified end to end on the lab | — |
| 3b | One local namespace per AI project; RBAC from Rancher project membership; jobs held inside their project | done, verified on the lab | — |
| 3c | UI: pool picker in Submit/Deploy, jobs in the project namespace, run details from the job's cluster, Projects per cluster, members read pools | built; backend verified on the lab, UI flow to be tried in the browser | — |
| 3 | (3a/3b/3c committed together) | done | `e0826f92` |
| 4a | `AIProject` (multi-cluster AI projects) + `AIProjectMembers`; replaces 3b's label-based projects | done, verified on the lab | — |
| 4b | Placement controller (meta-scheduler) + global queue + deferred placement; CPU-only runs in the chart | done, verified on the lab across two clusters | — |
| 4c | UI: AI Projects page; project picker + "Automatic" pool in Submit/Deploy | built; requests verified through Rancher; to try in the browser | — |
| IE | Inference engines: vLLM, Ollama (App Collection), llama.cpp, SGLang ("Inference Engines Apps" custom repo) as inference profiles; inference deploy in an AI project's pool | done; llama.cpp verified end to end on downstream-1; Apps page and deploy page to try in the browser | `50499978`, `06769b24`, `bd31a1cd` |
| 5 | Activity controller (Prometheus via the proxy), idle reclaim, per-profile policy, hand-off | — | — |
| 6 | Volcano backend | — | — |
| 7 | HAMi on the GPU-sharing axis | — | — |
| 8 | Catalog entries (KAI, Kueue, Volcano, HAMi; Kubeflow training-only preset) + "install a scheduler here" | — | — |
| 9 | Generic `AIJob.status.queue`; Trainer v2 `TrainJob` | — | — |

---

## 2. Decision log

Each entry: the decision, the alternatives we rejected, and why. Newest last.

**D-01 Branch from upstream `main`, cherry-pick dstanley selectively** (2026-10-07).
His branch was 13 ahead / 25 behind. We took commits 1–11 and skipped `ac4b144b` (nav reorg) and
`63d8df91` (Python SDK, deferred; nothing depends on it).
*Rejected:* branching from his tip and merging `main` (keeps his history, but adopts his nav).

**D-02 Workloads is a sub-menu; upstream's sidebar stays.**
Workloads ▸ Deployments / Training Jobs / Projects / Compute Profiles / Compute Pools. The entry
was "Queues & Quotas" and was renamed **Projects** at review.
*Rejected:* dstanley's Catalog + Deployments reorganisation (a bigger UX change for the fork).
Virtual types are prefixed (`training-jobs`, `ai-projects`, …): Rancher's nav treats a virtual
type named like a resource type as that type (F-12).

**D-03 The training chart is built into the operator; no chart repository in the user's path.**
`charts/gpu-train-job` is embedded (`operator/internal/trainchart`). An AIJob with no
`spec.source` installs it from memory. A custom chart is a hidden "Advanced" option, and needs an
admin to list it in `manager.aijobAllowedCharts`.
*Rejected:* an operator-managed `gpu-train-charts` ClusterRepo on every cluster. That still needs
a published chart location and mirror handling when air-gapped.

**D-04 Empty `aijobAllowedCharts` means built-in only** (it meant "any chart" in dstanley's code).
The operator installs with its own service account, so custom charts are opt-in.

**D-05 Two axes: scheduler backend × GPU-sharing backend.**
Scheduler: none / kueue / kai / runai / volcano. Sharing: none / kai-fraction / hami / dra-mps.
HAMi composes with schedulers rather than replacing one.

**D-06 The backend table lives in the chart (`schedulers.yaml`), mirrored by tests.**
The chart's templates read it (`.Files.Get`), the operator reads it from the embedded chart, and
the UI keeps `schedulers.ts` with a parity test.
*Rejected:* the operator owns the table and serves it over the API. That adds runtime wiring, UI
pages would wait on it, and a standalone chart install would need resolved values passed by hand.

**D-07 Phase 1 is a refactor, not new backends.** Volcano and HAMi stay in phases 6–7.

**D-08 Multi-cluster from the start; CPU-only pools are first-class.**

**D-09 Placement is automatic: the operator is a meta-scheduler.** It decides *where* a job runs;
the cluster's own scheduler decides *when*.
*Rejected:* user picks the pool (simpler, but not what was asked); MultiKueue (forces Kueue on
every cluster).

**D-10 Downstream observation goes through the Rancher cluster proxy; no agent downstream.**
*Rejected:* a downstream aif-agent (another component to version); Fleet status only (too coarse).

**D-11 Submissions are always accepted.** No fitting pool means a global queue, re-evaluated when
a pool's status changes.

**D-12 Idle means low utilisation:** DCGM GPU utilisation, or CPU usage, from Rancher Monitoring
Prometheus via the proxy.
*Rejected:* wall-clock leases only; heartbeat-only.

**D-13 Release policy per Compute Profile:** Suspend / Terminate / Never.

**D-14 The idle timeout is a pool default.** A profile or project may override it, up to the
pool's ceiling.

**D-15 Pool discovery authenticates downstream with the Rancher token from AIF Settings**
(`rancherCatalog.tokenSecretRef`, plus Rancher's internal CA). `local` uses the operator's
in-cluster client and needs no token. Without a token, downstream pools report
`Connected=False / NoRancherToken`.
*Rejected:* an operator-minted Rancher token (a long-lived credential the operator created
itself); Rancher's per-cluster SA tokens in `cattle-global-data` (cluster-admin, Rancher internals).

**D-16 Discovery never rewrites a pool's spec; pools are owned by their Rancher cluster.**
Discovery creates a pool only when no pool of that name exists. Administrators can edit,
disable or add pools (an added pool needs the `ai-factory.suse.com/cluster` label to be refreshed).
Owner reference = `clusters.management.cattle.io`, so a removed cluster takes its pools with it.
A GPU model that disappears leaves its pool at 0 nodes rather than deleting an object an admin may
have edited.

**D-17 One reconcile per Rancher cluster, refreshed every minute; status is written every time.**
Writing on every refresh keeps `observedAt` honest. Status writes don't re-trigger reconciles,
because both watches use `GenerationChangedPredicate`.

**D-18 A cluster the operator cannot read gets no pools.** There's nothing to discover from
without its nodes. The UI lists clusters with no pool as "Not discovered", and shows the
token banner when any of them is a downstream cluster.

**D-19 Rancher's `local` cluster never has compute pools; pools are named after their cluster.**
`local` hosts Rancher and AI Factory, not AI work. The controller ignores it (event predicate +
early return), the CRD refuses `clusterId: local` (CEL), and the UI hides it, "Not discovered"
rows included. A pool's default `displayName` is the cluster name. The Kind (GPU/CPU) and GPU
model tell a cluster's pools apart, so the page has no separate Cluster column. Reviewer's decision.
(As a result `RancherAccess` only ever builds proxy clients; the in-cluster local reader is gone.)

**D-20 Jobs reach downstream clusters with Helm through the Rancher proxy, not Fleet.**
The AIJob controller keeps its in-process Helm install/uninstall and points it at
`<rancher>/k8s/clusters/<id>` with the Settings token (D-15). dstanley's install-once / cancel /
retention logic is reused unchanged. Chart preflight errors come back at once and fail the job
with the real reason. This supersedes the design doc's Fleet Bundle (§6.4).
*Rejected:* a Fleet Bundle. It survives the operator being briefly down, but errors arrive only
through BundleDeployment status and the job logic would need rework.

**D-21 Until placement exists, a job names its pool: `spec.pool` (+ `spec.targetNamespace`).**
Both are immutable (CEL). The pool's node selector is injected as the chart's `poolSelector`
(required node affinity), overriding submitted values. `status.placement {pool, clusterId,
namespace}` is recorded *before* the install, so cancel, retention and delete still reach the
release after the pool is deleted. A job without a pool runs on the operator's cluster, unchanged.
A job whose pool is missing or disabled, or whose cluster needs a token that isn't set, waits
Pending with reason `PoolNotFound` / `PoolDisabled` / `NoRancherToken`. Phase 4 fills `spec.pool`
when it is empty.

**D-22 One namespace on local per AI project holds its AIJobs** (Phase 3b). The count grows with
projects, not with clusters × namespaces. Members get access through RoleBindings derived from
Rancher project membership.
*Rejected:* a single namespace with an admission check (weak read isolation); mirroring every
downstream namespace on local (namespace count). The reviewer was concerned about the number of
namespaces on local.

**D-23 An AI project is a Rancher project on a downstream cluster labelled
`ai-factory.suse.com/ai-project=true`.** Only such projects get a namespace on local
(`aif-<cluster>-<project>`), so the count is exactly the AI projects. Default/System projects and
projects on `local` never get one. Owner and member get `aif-aijob-editor` (create, cancel,
delete); read-only gets `aif-aijob-viewer`; other role templates grant nothing. Subjects are
written as Rancher writes its own (user ID as `User`, group principal as `Group`). Deleting the
Rancher project deletes the namespace (job finalizers uninstall the releases). Unmarking keeps
it, so jobs are never lost by accident. Reviewer's decisions.

**D-24 A job in an AI project's namespace runs only inside that project.** Before installing,
its pool must be on the project's cluster, and its target namespace there must carry
`field.cattle.io/projectId: <cluster>:<project>`. Otherwise the job fails at once with
`NotInProject`; a missing target namespace waits (`TargetNamespaceNotFound`). The operator
installs with the Settings token (admin power), so this check, not the token, is what keeps a
project's members inside their project. Jobs outside project namespaces are created by people
who can create AIJobs anywhere (administrators) and are not restricted.

**D-25 Pages that place runs move to the pool's cluster.** Choosing a pool in Submit/Deploy
navigates to the same page on the pool's cluster (query `pool=`). Every preflight fact
(namespaces, queues, GPUs, schedulers) is then read from the cluster the run will use, without
changing dstanley's preflight code. What lives on local is read through `training/placement.ts`
regardless of the page's cluster: pools, profiles, the AI project namespace, the AIJob POST. The
Projects page likewise works per downstream cluster and offers a cluster picker on local.

**D-26 Members read compute pools through one ClusterRoleBinding.** Pools are cluster-scoped,
so a namespace RoleBinding cannot grant them. The `aiproject` controller keeps
`aif-computepool-viewers` → `aif-computepool-viewer` with the union of all AI projects' members
(one object, whatever the number of projects).

**D-27 AI projects span clusters: an `AIProject` resource owned by AI Factory** (supersedes
D-23). It is cluster-scoped, so only admins write it, and holds the display name, the clusters
it spans (each with its namespace there, optionally adopting an existing Rancher project) and
its owners. The operator keeps:
- on local, namespace `aif-<project>` (owned by the AIProject) with the jobs RoleBindings, and an
  `AIProjectMembers` object named `members`;
- on each cluster, a Rancher project (adopted or created, labelled `ai-factory.suse.com/aiproject`),
  the namespace in it, and one Rancher project role binding per member.

Members reach their pods and logs everywhere through Rancher as usual. Deleting an AIProject
removes what lives on local; Rancher projects and downstream namespaces are left, because they may
hold data. Reviewer's decision (cross-cluster now).

**D-28 Owners manage members through a namespaced object, not a webhook.** Members beyond the
owners live in `AIProjectMembers/members` in the project's namespace on local. Owners get a
RoleBinding to `aif-aiproject-members-editor` (resourceName `members`), so they can change who is
in the project but never which clusters it spans. No admission webhook is needed.

**D-29 Rancher objects are written through Rancher with the Settings token.** Rancher projects
and project role bindings are written as the administrator who authorized the token, so
Rancher's own webhook decides who may grant what. The operator's service account gets no RBAC on
them.

**D-30 Placement: one queue, most free, first come, with backfill.** A job in an AI project's
namespace with no `spec.pool` waits (`WaitingForPlacement`) instead of running locally. One
placement pass (a single reconcile key) runs over every waiting job in submission order:
- the job's needs come from its values over the built-in chart's defaults;
- candidates are the pools on the project's clusters;
- the fitting pool with the most free GPUs (CPU for CPU runs) wins;
- jobs placed but not started count against their pool, so free capacity is not double-booked
  before the pool's figures refresh.

A job that doesn't fit doesn't hold back smaller ones (backfill). The pass writes
`status.placement` (and annotates the job, so the AIJob controller reacts at once), or
`status.placementMessage` with why nothing fits. Each pool's refusal is spelled out. It decides
where; the cluster's scheduler decides when. Priority and fair-share are not implemented.

**D-31 The nav's Projects is the AI Projects page; a cluster's Rancher projects and quotas are
"Quotas".** One concept per name. dstanley's per-cluster page (Rancher projects, ResourceQuota,
KAI/Kueue queues) stays, reached from each cluster row of an AI project. Its 3c "make AI project"
label path is removed.

**D-32 Submit/Deploy: project first, then the pool; Automatic by default.** With Automatic the page
stays on local and shows only the cluster-independent checks (`automaticPlacementChecks`) plus
"placed automatically"; the placement controller makes the capacity and queue checks on every
cluster the project spans. Picking a specific pool moves the page to that cluster (D-25), and the
target namespace is the project's namespace there.

**D-33 Members of any AI project can read all AIProjects** (the pool-viewer ClusterRole also
reads `aiprojects`), so the project picker needs no per-project ClusterRoleBinding. Trade-off:
project names, clusters and owners are visible across projects.

**D-34 Inference engines are inference profiles over Blueprints, one per engine.** vLLM
(`application-collection/vllm 0.1.10`) and Ollama (`application-collection/ollama 1.76.0`) come
from the App Collection; llama.cpp and SGLang come from the "Inference Engines Apps". Each engine
has a one-component Blueprint (`examples/training/blueprints/inference-*`) and a profile
(`examples/training/profiles/4x-engine-*`). Small defaults that run anywhere: Ollama granite4:350m-h
and llama.cpp Qwen2.5-0.5B GGUF on CPU; vLLM and SGLang Qwen2.5-1.5B on one GPU.

**D-35 Why a Blueprint even for an App Collection chart.** An App-sourced AIWorkload is installed
by the UI (it writes the Fleet HelmOp in `fleet-default`), which project members cannot do; a
Blueprint-sourced one is installed by the operator. The Blueprint also pins the values the profile
promises (model, GPUs, cache) and that the deploy pre-flight reads. Alternative, not taken: profiles
naming an App directly, which needs Fleet write for members or an operator change.

**D-36 llama.cpp and SGLang are two charts, served from a branch of their own.**
`charts/inference-engines/{llama-cpp,sglang}`, published by `git subtree split` to the fork's
`inference-engines` branch. The AI Factory git custom repo "Inference Engines Apps" (ClusterRepo
`aif-engines`) points at that branch, so Rancher indexes only these two charts (F-45). A first
version was one chart with an `engine` switch; replaced at the user's request: separate apps, own
logos.

**D-37 Inference deploy: project, then a pool, no Automatic.** There is no placement controller for
AIWorkloads, so the user picks the pool. The page moves to the pool's cluster for the GPU and node
facts (as D-32); the AIWorkload is recorded on local in `aif-<project>` with `targetClusters` =
the pool's cluster and `targetNamespace` = the project's namespace there. Without pools the page
works as before (cluster store, namespace picker).

**D-38 The inference summary reads each engine's values shape.** vLLM: `servingEngineSpec.modelSpec`;
Ollama: `ollama.models.run`, `ollama.gpu`, `persistentVolume`; llama-cpp/sglang: `model.*`,
`gpu.count`, `resources`, `cache`. Engines without a router get their Service as the endpoint
(`<release>.<ns>.svc:<port>/v1`). A CPU engine gets no GPU, model-fit or GPU-node headroom checks.

**D-39 Custom repo app logos come from Rancher's own icon link.** The Apps page renders only raster
data URLs (no browser request to a publisher host; `utils/catalog-logo.ts`). For custom repos it
now fetches Rancher's same-origin `?link=icon` with the user's session and inlines it: raster types
only, at most 50 per load, 64 KiB each. Charts in a git repo reference their icon as
`file://<chart>/icon.png` (F-46). Logos are the projects' own: llama.cpp (MIT), SGLang (Apache-2.0).

---

## 3. Findings

Verified facts and traps, each found the hard way. **[bug]** = a defect found;
**[trap]** = easy to get wrong; **[fact]** = verified.

**F-01 [fact] SUSE Kubeflow chart** `oci://registry.suse.com/ai/charts/kubeflow` 0.4.1 ships
`training-operator` v1.9.4 (PyTorchJob, which the chart and `observe.go` use) and `trainer` v2.2.1
(TrainJob). Both are enabled by default, alongside the full platform (dashboard, pipelines,
KServe, Katib, Dex, …). As a training runtime only, it needs a values preset with the rest disabled.

**F-02 [fact] App Collection PyTorch chart** `oci://dp.apps.rancher.io/charts/pytorch` 0.4.0
deploys a runtime. Its image is `dp.apps.rancher.io/containers/pytorch:2.14.0-nvidia-2.3`: the
candidate default image for `gpu-train-job` torch profiles (today `bci-base` + pip).

**F-03 [fact] Scheduler charts** (checked 2026-10-07):

| Backend | Chart | Latest stable |
|---|---|---|
| KAI | `oci://ghcr.io/nvidia/kai-scheduler/kai-scheduler` | v0.20.1 |
| Kueue | `oci://registry.k8s.io/kueue/charts/kueue` | 0.20.0 |
| Volcano | `https://volcano-sh.github.io/helm-charts` (`volcano`) | 1.15.3 |
| HAMi | `https://project-hami.github.io/HAMi` (`hami`) | 2.10.0 |

Run:AI is already in `operator/internal/catalog/default-catalog.json` (NGC-gated).

**F-04 [trap] KAI and Run:AI share the `scheduling.run.ai` Queue CRD.** Only the `run.ai` API
group tells them apart. Picking `kai` on a Run:AI cluster leaves pods Pending with no event.
Run:AI binds the queue with the pod label `project` and needs the namespace label `runai/queue`.

**F-05 [trap] `on` is a boolean in YAML 1.1** (Helm's parser). A key named `on:` becomes `true:`.
The table uses `queue.target`.

**F-06 [trap] `helm package` rewrites `Chart.yaml`.** The embedded-chart drift test compares
parsed metadata for that one file and bytes for the rest.

**F-07 [trap] Go caches test results even when a test reads files outside the module.** Use
`-count=1` to prove a drift test fails.

**F-08 [trap] The controller-runtime fake client lists an unregistered GVK as empty**, where a
real API server returns "no match". Code that stops at the first version that doesn't error
works live but not in tests. The Workload lookup tries each version until the object is found.

**F-09 [bug, pre-existing] `gpu.mode=auto` errors on clusters without `resource.k8s.io/v1`**
(Kubernetes < 1.34, e.g. the lab). `lookup` of an API the server doesn't serve is a hard template
error. Not fixed yet (§6).

**F-10 [bug, fixed P1] Nil `detect` on the `none` backend** crashed the chart's preflight. Only
the live `--dry-run=server` run found it; offline renders never reach preflight (F-11).

**F-11 [trap] The chart's preflight only runs when it can see a cluster.** Its `$online` guard is
a `lookup` of the release namespace, which is empty under `helm template`. To test its branches
offline, render a scratch copy with `$online := true` and simulate APIs with `--api-versions`
(§4.4). Under `--dry-run=server`, `--api-versions` is ignored.

**F-12 [trap] Rancher nav and virtual-type names.** A virtual type named like a resource type
(e.g. `endpoints`) is treated as that type and shows its count.

**F-13 [fact] Fleet Bundle size.** `buildGitChartBundle` caps unpacked chart resources at 1 MiB
(etcd object limit). `gpu-train-job` is 28 KB packed and ~140 KB unpacked, so it fits.

**F-14 [bug, fixed P1] UI/chart mismatch on GPU-memory shares under Run:AI.** The UI offered them;
the chart refused them. The UI now follows the table. Run:AI likely supports `gpu-memory`
fractions: enable with `sharing: [kai-fraction]` on `runai` after testing on a Run:AI cluster.

**F-15 [fact] Rancher aggregates cpu, memory and pods only** in
`clusters.management.cattle.io` `status.allocatable` / `status.requested`. GPUs must be read from
each cluster's nodes.

**F-16 [fact] The operator already holds a Rancher API client** (`internal/infra/rancher`),
built by the Settings controller from `rancherCatalog.url` (default
`https://rancher.cattle-system.svc`), `tokenSecretRef` and the internal CA
(`cattle-system/tls-rancher-internal-ca`). The lab's Settings has no token configured.

**F-17 [bug, pre-existing upstream] `TestValidateCredentials_RancherCatalogDiscoversInternalCA`
fails on macOS.** The x509 error text differs; it fails on pristine `main` too. Ignore locally.

**F-18 [trap] The UI build type-checks test files.** A change that makes constants plain `string`
(rather than literal types) breaks inferred object types in tests. `vitest` passes; `build-pkg`
fails.

**F-19 [bug, fixed P2] The chart's `manager-role.yaml` holds two documents**: the ClusterRole,
then a namespaced Role. Rules appended at the end of the file land in the Role and show up only on
a cluster, as "forbidden". `charts/aif-operator/tests/rbac-parity.sh` (run in chart CI) now checks
that the ClusterRole grants everything `operator/config/rbac/role.yaml` declares.

**F-20 [bug, pre-existing, fixed P2] The ClusterRole did not grant `events` create/patch.** Only
the namespaced Roles did, so events on objects in other namespaces (an AIJob in a user's
namespace) were refused and dropped. The parity check found it.

**F-21 [trap] On the lab, CRD fields are owned by managers `sims` (the original install's client)
and `aif-operator-crds` (the chart's CRD job).** Applying newer CRDs needs
`kubectl apply --server-side --force-conflicts --field-manager=aif-operator-crds`. Inspect
`--show-managed-fields` first: here `sims` wrote at install time, not a separate patch.

**F-22 [trap] `helm upgrade --wait` waits on the `aif-ui` InstallAIExtension**, which becomes
not-ready when the chart bumps the UI version. The release is marked failed even though the
operator rolled out. Upgrade without `--wait` and check the Deployment rollout instead.

**F-23 [fact] Live check on the lab:** `local-cpu` reports cpu 10, memory 22841872Ki, requested
1120m / 636Mi, exactly Rancher's own `clusters.management.cattle.io/local` status. The
refresh advances `observedAt` within the 60s resync.

**F-25 [trap] A dev-loaded UI is shadowed by an installed UI plugin of the same version.**
Upgrading the lab operator with the branch chart made it install the published `aif-ui`
2.3.0-rc.4, the same name and version as the dev build. Rancher then served the published
plugin and the Workloads sub-menu disappeared. Keep the installed UI on a different version
(`--set aiExtension.source.helm.version=… --set aiExtension.extension.version=…`), as the runbook
does.

**F-26 [bug, fixed P2] client-go refuses a CA together with skip-verify** ("specifying a root
certificates file with the insecure flag is not allowed"). Settings can say
`insecureSkipVerify: true` while the operator also discovers Rancher's internal CA, so the proxy
client was never built and every downstream cluster failed silently (no pool, so nowhere to
record it). `ClusterConfig` now drops the CA under skip-verify, as the catalog client does. Each
unreadable cluster is also logged ("Cannot read cluster for compute pools", with the reason).

**F-27 [fact] Lab discovery result:** `c-xvstz-cpu` (downstream-1, 2 nodes), and
`c-fg8qv-cpu` and `c-fg8qv-gpu-l40s` (downstream-2: 1 node, 2 × L40S at 48 GB, from the lab's
simulated GPU labels). All Connected within one resync of the token being set. After D-19,
`local-cpu` is gone and the API refuses to create a pool on `local` (checked with a server-side dry run).

**F-28 [bug, pre-existing, fixed P3a] Every DRA `lookup` crashed the chart on Kubernetes < 1.34.**
Five lookups of `resource.k8s.io/v1` (gpuMode auto, the computeDomain and DRA DeviceClass checks,
ResourceSlices in the disk-pressure and headroom checks) had no check that the API exists. A
`lookup` of an unserved API is a hard template error, so the install failed even with
`gpu.mode=device-plugin`. All are now guarded by `gpu-train-job.hasDRA`
(`.Capabilities.APIVersions.Has "resource.k8s.io/v1"`). Offline renders are unchanged (32-case
matrix), and live renders work on the lab's downstream clusters. Closes O-1 / F-09.

**F-29 [fact] End-to-end on the lab (P3a):** AIJob `dispatch-smoke-2` was created on the management
cluster with `pool: c-fg8qv-gpu-l40s`. The operator recorded the placement, installed the release
on downstream-2 through Rancher, and the pod ran on `downstream-2-worker` (node affinity
`nvidia.com/gpu.product In [L40S]`). The AIJob went Running → Succeeded, read from downstream-2,
with `resources: 1 × L40S`. Deleting the AIJob uninstalled the release on downstream-2 (Job, pod
and Helm release secret gone).

**F-30 [trap] AIJob `spec.category` is an enum** (inference, training, agent, rag, data,
custom). "test" is refused; test and benchmark runs are `training` with a profile.

**F-31 [fact] Rancher 2.15 PRTBs live in namespaces of two shapes** (`c-fg8qv-p-g6vrf` and
older `p-bcqsr`). Match PRTBs by their `projectName` field (`<cluster>:<project>`), never by
namespace.

**F-32 [fact] Lab check (P3b):** a Rancher project created on downstream-2 with the AI-project
label gave a namespace on local and an `aif-aijob-editor` RoleBinding for its creator's
`creator-project-owner` PRTB. An AIJob from that namespace targeting `default` (Default project)
failed with `NotInProject` and installed nothing. Deleting the project removed the namespace and
the job. Isolation for a *non-admin* member is unverified live (the lab user is a Rancher admin,
who can do everything anyway): O-13.

**F-33 [trap] A terminating namespace keeps triggering its controller.** Every status update
during deletion re-enqueues; check `DeletionTimestamp` before deleting again.

**F-34 [trap] The cluster store follows the page's cluster.** On a page moved to a downstream
cluster, `cluster/schemaFor` / `cluster/findAll` answer for that cluster. Anything on local
(profiles, ComputePools, AIJobs) must be read with an explicit `/k8s/clusters/local/...` request.
Submit used one ConfigMap list for both profiles (local) and the user's ConfigMaps (target cluster);
they are now separate.

**F-35 [trap] Members rarely may list pods cluster-wide downstream.** Placed runs' pods are read
per namespace (`/api/v1/namespaces/<ns>/pods?labelSelector=ai-factory.suse.com/job-id`), not
cluster-wide.

**F-36 [fact] Lab state for UI testing:** Rancher project "AI Team" (`c-fg8qv:p-aiteam`, marked)
with namespace `ai-team` on downstream-2. Its namespace on local `aif-c-fg8qv-p-aiteam` has an
editor binding for user-2khzq, who is also in `aif-computepool-viewers`. AIJob `team-smoke-1`
(pool `c-fg8qv-gpu-l40s`, target `ai-team`) ran on downstream-2-worker: the project-boundary
pass case, live.

**F-37 [trap] With no profiles there is no Deploy.** Compute Profiles shows a tile, and a
Deploy button, per profile ConfigMap in `ai-profiles` on local. A fresh install has none, and the
lab had none. Apply `examples/training/profiles/00-namespace-rbac.yaml` and the training profiles
(10–13, 30–38) to get some. The full form (Submit) is reached from Training Jobs → **New** →
"Custom training job (full form)".

**F-38 [trap] Rancher refuses a duplicate project role binding** ("duplicate prtb not allowed").
The project's creator already holds `project-owner` through `creator-project-owner`, so adopting
a project and binding its owner again failed. Only the live lab showed it; fake clients accept
anything. The operator now treats a role the member already has through a binding it did not make
as satisfied, and never touches bindings it did not make.

**F-39 [fact] Lab check (P4a):** AIProject `vision` spans downstream-1 and downstream-2. The
operator created Rancher projects `c-fg8qv:p-v8q79` and `c-xvstz:p-5cdht`, namespace `vision` in
each, the owner's role bindings, `aif-vision` on local with its members object and RoleBindings,
and the pool-viewer binding. AIProject `aiteam` adopted `c-fg8qv:p-aiteam` with namespace
`ai-team`. Both Ready. The 3b-style namespace `aif-c-fg8qv-p-aiteam` was retired.

**F-40 [bug, fixed P4b] Startup race: controllers ran before Settings published the Rancher
token.** Discovery marked every downstream pool `Connected=False / NoRancherToken` for a minute
after each operator restart, and a placement pass in that window avoided those clusters (a CPU run
went to the cluster with half the free CPU). `ConnectionHolder.Resolved()` now tells "no token"
from "not read yet". Until Settings is read, discovery retries in 5s without touching the pools,
and jobs wait as `ConnectingToRancher`. Verified: a CPU run submitted right after a restart went
to the right cluster.

**F-41 [bug, pre-existing, fixed P4b] The training chart could not run a CPU-only job.**
`gpusPerNode: 0` still ran the GPU preflight ("no node advertises nvidia.com/gpu") and set
`NPROC_PER_NODE=0`. `gpuMode` now returns `none` with no GPUs and no share, which switches off the
GPU request, the DRA claim and the GPU checks; `NPROC_PER_NODE` is at least 1. GPU renders are
byte-identical (32-case matrix); verify-render checks the CPU case.

**F-42 [fact] Lab check (P4b):** in AIProject `vision` (downstream-1 + downstream-2), two jobs
with no pool were placed by the queue: a 1-GPU run → `c-fg8qv-gpu-l40s` (the only GPU pool on the
project's clusters), Running then Succeeded on downstream-2-worker; a CPU run →
`c-xvstz-cpu` (≈19 free CPU against ≈9), Running on downstream-1-worker.

**F-43 [fact, pre-existing upstream] The Settings controller reconciles about every 15s** ("Rancher
catalog client configured" twice per cycle) with nothing changing. Harmless but noisy; not ours.

**F-44 [bug, ours, recurrence of F-34] Compute Profiles and the inference deploy page read through
the cluster store.** On a downstream cluster page they listed no profiles and no blueprints, and
the deploy page said AI Factory was not installed. Profiles, Blueprints and AIWorkloads are now
read from local explicitly (`localProfileConfigMaps`, `localBlueprints`, `localAIWorkloads`).

**F-45 [fact] A git ClusterRepo indexes every Chart.yaml in the branch.** Pointed at
`aijob-scheduling` it listed aif-operator, aif-ui and gpu-train-job beside the engine. Hence the
dedicated branch (D-36); marking those charts hidden would hide them in every repo that ships them.

**F-46 [fact] Rancher rewrites every chart's `icon` in the index to its own
`/v1/catalog.cattle.io.clusterrepos/<repo>?chartName=…&link=icon` URL.** For git repos `link=icon`
opens the icon as a path in the clone: a `data:` icon fails with 500 ("open …/data:image/png…"),
`file://<path>` (relative to the branch root) works. HTTP repos' remote icons are fetched by Rancher.

**F-47 [fact] A git ClusterRepo picks up new commits only on its refresh interval or when
`spec.forceUpdate` is set to a new timestamp** (the `field.cattle.io/forceUpdate` annotation does
nothing). After `git push origin inference-engines`, patch `spec.forceUpdate`.

**F-48 [fact] Lab check (IE):** AIWorkload `llm-cpu` in `aif-vision`, Blueprint `inference-llamacpp`
→ `c-xvstz`/`vision`: Fleet Running, pod Ready in about a minute, `/v1/models` lists
`qwen2.5-0.5b-instruct-q4_k_m`, a chat completion answers. The chart's PVC keeps the model across
reinstalls (`helm.sh/resource-policy: keep`), so it outlives the endpoint and must be deleted by hand.

**F-24 [fact] Settings already has a way to create the token**: Settings → Rancher API Access →
Authorize creates a Rancher API token as the logged-in user and stores it in the operator
namespace. Discovery reuses it (D-15).


---

## 4. Runbook

### 4.1 Workspace

```bash
# isolated worktree (the main checkout stays on other work)
git -C ~/Documents/dev/aif-suse worktree list
cd ~/Documents/dev/aif-suse-aijob
git remote -v   # origin = alessandro-festa fork; upstream + dstanley have push DISABLE
```

### 4.2 Operator

```bash
cd operator
make generate manifests     # after any API type change (deepcopy + CRDs, copied to charts/aif-operator/crds)
make train-chart            # after ANY change under charts/gpu-train-job (re-embeds the chart)
go build ./...
# envtest binaries: reuse the main checkout's
export KUBEBUILDER_ASSETS=$(cd ~/Documents/dev/aif-suse/operator/bin/k8s/1.35.0-darwin-arm64 && pwd)
go test -count=1 $(go list ./... | grep -v /e2e)   # F-17 is the one expected failure on macOS
```

### 4.3 UI

```bash
export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"   # node 24; --ignore-engines (node-ipc caps at 22)
cd ui
yarn install --ignore-engines --frozen-lockfile
yarn -s vitest run                                  # unit tests (jest is not used)
npx eslint pkg/aif-ui/training                      # 0 errors expected; warnings are pre-existing
yarn build-pkg aif-ui                               # the real compile, type-checks tests too (F-18)
yarn serve-pkgs                                     # http://127.0.0.1:4500/aif-ui-<ver>/aif-ui-<ver>.umd.min.js
```

Load it in Rancher: Preferences → Extension Developer Features, then Extensions → ⋮ → Developer
Load with that URL. After a rebuild at the same version, hard-refresh and Developer Load again.

### 4.4 Chart

```bash
./charts/gpu-train-job/verify-render.sh            # the chart's own render checks
helm lint charts/aif-operator
```

The **render matrix** proves a refactor changes nothing. Render before (from `git archive HEAD`)
and after, then `diff -r`:

```bash
# render.sh <chartdir> <outdir>: scheduler × kind × share × nodes, preflight off
for s in none kueue kai runai; do for k in job pytorchjob; do for share in 0 4096; do for n in 1 2; do
  q=""; [ "$s" != none ] && q="--set scheduler.queue=team-a"
  helm template t "$c" --namespace ns --set scheduler.type=$s $q --set job.kind=$k \
    --set gpu.sharedMemoryMiB=$share --set job.nodes=$n --set preflight.enabled=false > "$o/$s-$k-$share-$n.yaml" 2>&1
done; done; done; done
```

For the **preflight branches** (F-11), copy the chart to a scratch directory, replace
`{{- $online := lookup "v1" "Namespace" "" .Release.Namespace }}` with `{{- $online := true }}`,
and render with `--set preflight.enabled=true --set gpu.mode=device-plugin` plus each of:
`""`, `--api-versions scheduling.run.ai/v2/Queue`, the same plus `--api-versions run.ai/v1/Cluster`,
`--api-versions kueue.x-k8s.io/v1beta1/LocalQueue`, and `--api-versions kueue.x-k8s.io/v1beta2/LocalQueue`.
Normalise template line numbers before diffing: `sed -E 's/\.(tpl|yaml):[0-9]+:[0-9]+/.\1:L/g'`.
A live read-only check: `helm template … --dry-run=server --kube-context kind-sims-datacenter`.

### 4.5 Lab

- Management: `kind-sims-datacenter` (Rancher, AIF operator in `aif-operator`). Downstreams:
  `kind-downstream-1` (`c-xvstz`), `kind-downstream-2` (`c-fg8qv`). No GPUs; Kubernetes < 1.34.
- Always pass `--context`.
- Dev operator image, as done in Phase 2:

```bash
cd operator
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags "-X main.version=<v> -X main.commit=<sha>" -o /tmp/aif-op-img/manager cmd/main.go
printf 'FROM gcr.io/distroless/static:nonroot\nWORKDIR /\nCOPY manager .\nUSER 65532:65532\nENTRYPOINT ["/manager"]\n' > /tmp/aif-op-img/Dockerfile
docker build -t ghcr.io/suse/aif-operator:<tag> /tmp/aif-op-img            # a new tag each time
kind load docker-image ghcr.io/suse/aif-operator:<tag> --name sims-datacenter
kubectl --context kind-sims-datacenter apply --server-side --force-conflicts \
  --field-manager=aif-operator-crds -f ../charts/aif-operator/crds/       # F-21
helm --kube-context kind-sims-datacenter upgrade aif-operator ../charts/aif-operator -n aif-operator \
  --set crds.manageWithJob=false --set manager.image.tag=<tag> --set manager.image.pullPolicy=Never \
  --set aiExtension.source.helm.version=2.3.0-rc.3 --set aiExtension.extension.version=2.3.0-rc.3   # no --wait (F-22); UI ≠ dev build version (F-25)
kubectl --context kind-sims-datacenter get computepools
```

- Inference Engines Apps, after changing `charts/inference-engines/`:

```bash
git subtree split --prefix=charts/inference-engines -b inference-engines && git push origin inference-engines
kubectl --context kind-sims-datacenter patch clusterrepo aif-engines --type merge \
  -p "{\"spec\":{\"forceUpdate\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}"          # F-47
kubectl --context kind-sims-datacenter apply -f examples/training/blueprints/ -f examples/training/profiles/
```

---

## 5. Code map

| Area | Path | Notes |
|---|---|---|
| Nav | `ui/pkg/aif-ui/config/suseai.ts`, `product.ts`, `routing.ts` | `WORKLOADS_GROUP`, `basicType(types, group)`, `setGroupDefaultType` |
| Training UI | `ui/pkg/aif-ui/training/` | dstanley's pages; `routes.ts` names kept (`jobs`, `projects`, `profiles`) |
| Scheduler table (UI copy) | `ui/pkg/aif-ui/training/schedulers.ts` | `holdsPods`, `usesQueueTree`, `placesGpuMemoryShares`, `podQueueLabel`, `workloadQueueLabel`, `backendForSchedulerName` |
| Preflight (UI) | `ui/pkg/aif-ui/training/preflight.ts` | per-backend checks keyed off the table |
| Compute Pools page | `ui/pkg/aif-ui/pages/ComputePools.vue`, `services/compute-pools.ts` | P0: browser-side discovery; P2: reads `ComputePool` |
| Scheduler table (canonical) | `charts/gpu-train-job/schedulers.yaml` | read by templates via `gpu-train-job.backend` |
| Chart binding | `charts/gpu-train-job/templates/_helpers.tpl`, `_podspec.tpl`, `job.yaml`, `pytorchjob.yaml` | `queueWorkloadLabels`, `suspended`, `queuePodLabels`, `podScheduling` |
| Chart preflight | `charts/gpu-train-job/templates/_preflight.tpl` | `lookup`-based; see F-11 |
| Embedded chart | `operator/internal/trainchart/` | `Archive()`, `Backends()`, drift test |
| Helm client | `operator/internal/infra/helm/` | `ReleaseSpec.ChartArchive`: install from memory |
| AIJob controller | `operator/internal/controller/aijob/` | `releaseSpec` (built-in vs custom), `observe.go` (`podQueueLabels`, `schedulerHeld`), Workload v1beta2→v1beta1 |
| AIJob API | `operator/api/v1alpha1/aijob_types.go` | `spec.source` optional (immutable either way) |
| Rancher client | `operator/internal/infra/rancher/` | catalog client; `clusters.go`: `Connection`, `ConnectionHolder`, `ClusterConfig` (proxy REST config) |
| ComputePool API | `operator/api/v1alpha1/computepool_types.go` | cluster-scoped; `clusterId` immutable (CEL) |
| Pool discovery | `operator/internal/controller/computepool/` | `discover.go` (pure: `discoverPools`, `poolStatus`, `detectStack`), `access.go` (local vs proxy), `computepool_controller.go` |
| Chart RBAC | `charts/aif-operator/templates/rbac/manager-role.yaml` | hand-maintained; `tests/rbac-parity.sh` |
| AI projects | `operator/internal/controller/aiproject/` | namespace per marked project; RoleBindings from PRTBs; `NamespaceFor`, labels |
| Project RBAC roles | `charts/aif-operator/templates/rbac/aijob-roles.yaml` | `aif-aijob-editor` / `aif-aijob-viewer`; operator may only `bind` these |
| Cross-cluster UI helpers | `ui/pkg/aif-ui/training/placement.ts` | `fetchPools`, `poolLabel`, `localProfileConfigMaps`, `aiProjectNamespaceFor`, `createAIJob`, `placedPods`, `podsOfPlacedJob` |
| Placement (meta-scheduler) | `operator/internal/controller/placement/` | `NeedsOf` (values over chart defaults), `choose` / `refuse` (pure), the queue pass |
| AI projects | `operator/internal/controller/aiproject/` (rewritten in 4a) | `AIProject` → local namespace + RoleBindings, per-cluster Rancher project / namespace / PRTBs via `TokenRancher` |
| Job dispatch | `operator/internal/controller/aijob/target.go` | `targetFor` (pool → cluster/namespace, placement wins), `helmFor` / `remoteFor` (proxy clients cached per connection), `unplaced` reasons |
| Pool affinity (chart) | `charts/gpu-train-job/templates/_helpers.tpl` `gpu-train-job.affinity`, `hasDRA` | `poolSelector` value → required node affinity |
| Inference Engines Apps | `charts/inference-engines/{llama-cpp,sglang}` | published to branch `inference-engines` (README there); `icon.png` per chart |
| Engine Blueprints / profiles | `examples/training/blueprints/inference-*`, `examples/training/profiles/4x-engine-*` | ClusterRepos `application-collection`, `aif-engines` |
| Inference summary + checks | `ui/pkg/aif-ui/training/inference.ts` | `summarizeBlueprint` (`vllmSummary`, `otherEngineSummary`), `inferenceChecks`, `endpointUrl`, `aiWorkloadFor(…, recordNamespace)` |
| Inference deploy | `ui/pkg/aif-ui/training/pages/DeployEndpoint.vue` | project → pool; `createAIWorkload` on local |
| Custom app logos | `ui/pkg/aif-ui/services/app-collection.ts` | `rancherIconUrl`, `inlineRancherIcon`, in `fetchCustomRepoApps` |

---

## 6. Open issues and backlog

| # | Issue | Where | Phase |
|---|---|---|---|
| O-1 | ~~`gpu.mode=auto` errors without `resource.k8s.io/v1` (F-09)~~ fixed in P3a (F-28) | — | — |
| O-2 | Enable KAI-style shares under Run:AI after testing (F-14) | `schedulers.yaml` | 7 |
| O-3 | Projects page quota setting is `'kai' \| 'resourcequota'`; it should follow the table's `quota` | `projects.ts`, `Projects.vue`, `resourcequota.ts` | quota editors |
| O-4 | `AIJob.status.queue` is Kueue/KAI-specific (`kaiQueue` also carries Run:AI's queue) | `aijob_types.go` | 9 |
| O-5 | Python SDK (`63d8df91`) not brought in | — | later |
| O-6 | Kubeflow "training only" values preset | catalog | 8 |
| O-7 | Make the App Collection PyTorch image the default training image (F-02) | `gpu-train-job` values / profiles | later |
| O-8 | Run:AI namespace-label preflight branch is only reviewed, never executed (needs a real Namespace) | `_preflight.tpl` | when a Run:AI cluster is available |
| O-9 | GPU nodes without GFD labels are counted as CPU-only; DRA-only GPU nodes (ResourceSlices, no labels) likewise | `computepool/discover.go` | with DRA support in placement |
| O-10 | Discovery lists every active pod of every cluster each minute; at scale, aggregate per node or watch | `computepool/access.go` | before production |
| O-11 | Requested GPUs count `nvidia.com/gpu` only; DRA claims and KAI/HAMi fractions are not in `requested` | `computepool/discover.go` | 4 (placement) / 7 |
| O-12 | `aijobAllowedCharts` and other operator values on the lab come from chart defaults; the lab runs the branch chart with `crds.manageWithJob=false` | lab | — |
| O-13 | Verify project isolation live with a non-admin Rancher user (member and read-only) | lab | before release |
| O-14 | ~~Project members need to read ComputePools~~ done in 3c (D-26) | — | — |
| O-15 | ~~The Projects page must set the AI-project label~~ done in 3c: creation, Run:AI adoption, and "Make AI project" for existing projects | — | — |
| O-16 | The Training Jobs list reads AIJobs through the cluster store on local; check what a non-admin member sees (Steve lists namespaces the user can access) | UI | with O-13 |
| O-18 | Placement ignores per-node fit (a 4-GPU-per-node run counts pool totals), priority and fair-share | `placement/fit.go` | later |
| O-19 | A placed job that stays unadmitted is not re-placed elsewhere (design §6.3 step 4) | placement | later |
| O-20 | Picking members by typed user ID or group principal is crude; use Rancher's principal search | `AIProjects.vue` | later |
| O-21 | The project picker lists every project; filter to the ones the user is a member of | `Submit.vue` | later |
| O-22 | Members cannot create AIWorkloads in `aif-<project>` (not in `aif-aijob-editor`). Granting it as is would let them target any cluster: needs an AIWorkload check that `targetClusters`/`targetNamespace` are the project's | operator + roles | before members deploy endpoints |
| O-23 | The Endpoints list (Workloads, inference tab) reads AIWorkloads through the cluster store; the deploy page sends you to it on local | `Workloads.vue` | with O-16 |
| O-24 | SGLang and vLLM engine profiles are untested on a real GPU (the lab's GPUs are simulated); `lmsysorg/sglang:latest` is not pinned | lab / `charts/inference-engines/sglang` | when a GPU cluster is available |
| O-25 | The `inference-engines` branch is published by hand (`git subtree split`); automate it, or a chart version bump on push | CI | later |
| O-17 | The UI's 3c flows (pool picker → cluster switch → submit; Projects on a downstream cluster) are covered by unit tests of their logic, not by component tests; try them in the browser | UI | now |

---

## 7. Conventions

- Commits are authored by the fork owner with no co-author trailer; pushed only to `origin`, only
  when asked.
- Generated copies always have a test that fails when they drift: the embedded chart
  (`TestArchiveMatchesChartSource`) and the UI scheduler table (`schedulers-parity.test.ts`).
- Refactors are proven with before/after renders (§4.4), not just green tests.
- Don't edit dstanley's files beyond what a phase needs; record what was changed and why here.

---

## 8. Phase notes

### Phase 0
- Cherry-picks applied cleanly. Links in dstanley's pages that pointed at routes from the skipped
  nav commit (`-catalog`, `settings?tab=profiles`) now open Compute Profiles.
- Built-in chart: `ReleaseSpec.ChartArchive` short-circuits `loadChart` (no pull, no cache entry).
  The direct-install fallback in Submit, the ClusterRepo lookup and `ChartRepoBanner` were removed.
- The operator chart no longer creates `gpu-train-charts`. release-prepare runs
  `make -C operator train-chart` after bumping the chart version.

### Phase 1
- Chart renders are byte-identical for every valid scheduler (32-case matrix). Preflight branches
  are identical in forced-online offline renders and a live `--dry-run=server`.
- Behaviour changes, all deliberate: unknown `scheduler.type` refused; Run:AI pods reported Queued;
  Kueue Workload found at v1beta2 or v1beta1; no KAI-style shares under Run:AI in the UI (F-14).
- `isQueueScheduler` was split into the specific questions it stood for.

### Phase 3c — as built
- Submit/Deploy: a "Compute pool" picker (hidden while authoring a profile); `choosePool` moves the
  route to the pool's cluster and the page re-fetches. New facts `pool`, `poolsAvailable` and
  `aiProjectNamespace`, and preflight checks `pool` ("Choose a compute pool") and `project`
  ("Namespace … is not in an AI project"). Submit POSTs the AIJob to local with `spec.pool` and
  `spec.targetNamespace`, then returns to Training Jobs on local. Without pools (an older
  operator), everything works as before.
- Training Jobs: placed runs get their pods from the placement cluster, per namespace, tagged
  `__clusterId`. Rows and `Run` carry `clusterId`; RunDetail reads events and logs from it.
- Projects: a cluster picker on local; on a downstream cluster, "Make an existing Rancher project
  an AI project". New and Run:AI-adopted projects are marked through the steve project model
  (Norman creation may not keep labels).
- Operator: `aif-computepool-viewers` ClusterRoleBinding (D-26); the project roles may `get` their
  own namespace (Submit checks it exists).
- Tests: placement helpers (5), the pool/project checks (4), `aiJobFor` with a pool, placed run
  rows, the pool-viewers binding.

### Phase 3b — as built
- `aiproject` controller, keyed by the Rancher project. It watches projects, PRTBs (mapped by
  `projectName`) and its own namespaces. RoleBinding names are derived from the PRTB UID and
  role. A role change replaces the binding (`roleRef` is immutable); a subject change updates it.
- The operator chart ships the two ClusterRoles. The operator gets `bind` on exactly those, plus
  rolebindings CRUD, namespaces create/delete, and read on projects and PRTBs. The RBAC parity
  check passes.
- `checkProject` in `target.go` (D-24) runs only before placement. After that, the placement is
  authoritative.
- Tests: role mapping (users, groups, custom roles ignored, other projects ignored), membership
  changes, only marked downstream projects, unmark keeps / delete removes, a same-named foreign
  namespace left alone; the five boundary cases plus a job outside any project. Then the lab (F-32).

### Phase 3a — as built
- `target` carries the cluster, namespace and clients (Helm, reader, log reader). Every
  reconcile path (install, observe, report, cancel, retention, finalize) takes it, so local jobs
  use exactly the clients they did before. All existing AIJob tests pass unchanged.
- Helm for a downstream cluster: `cli.EnvSettings` with `KubeAPIServer` / `KubeToken` /
  `KubeInsecureSkipTLSVerify`. Helm only takes a CA as a file, so it is written once per CA to a
  temp file. Clients are cached by cluster, namespace and a fingerprint of the connection, so a
  new token rebuilds them.
- The chart got `poolSelector` and one shared affinity helper (it replaced two copies of the
  anti-affinity block); renders without a pool are byte-identical.
- Tests: install on the pool's cluster and namespace with `poolSelector`; observe from the
  downstream reader; the three waiting reasons; cleanup after the pool is deleted; deletion of a
  never-placed job; CEL immutability of `pool` / `targetNamespace`. Then the lab (F-29).

### Phase 2 — as built
- Delivered as planned below, plus: an RBAC parity check (F-19, F-20); "Not discovered" rows for
  clusters with no pool (D-18); the Settings "Rancher API Access" text now names discovery.
- Settings publishes `rancher.Connection` (URL, token, CA) through a `ConnectionHolder`, next to the
  catalog client it already built. `RancherAccess` caches one proxy client per cluster until the
  connection changes.
- Pool names: `<cluster>-gpu-<product-slug>`, `<cluster>-gpu` (GPU nodes that do not name their
  product), `<cluster>-cpu`. The CPU pool selector excludes labelled GPU nodes; cordoned nodes are
  not counted.
- Detection reuses `trainchart.Backends()` (`detect.group` / `detect.unless`), the same table as
  the chart and UI. A scheduler's `sharing` modes are reported when it is installed, and HAMi
  from its node annotation.
- Verified: unit tests (discovery, status, stack, reconciler with a fake cluster), envtest for the
  CRD rules, then the lab (F-23, F-27), after fixing F-26.
- Compute Pools styling: kind and stack values as outlined tags (GPU in the primary colour),
  status as a coloured dot with text. Theme variables only (`--border`, `--primary`, `--success`,
  `--error`, `--info`, `--muted`), so it follows light and dark themes.

### Phase 2 — plan (original)
- **CRD `ComputePool`** (cluster-scoped, `ai-factory.suse.com/v1alpha1`).
  - spec: `clusterId`, `nodeSelector` (a `metav1.LabelSelector`, so a CPU pool can say "no GPU
    label"), `kind: gpu|cpu`, `enabled`, `displayName`.
  - status: `connected` condition, nodes, allocatable / requested / free (cpu, memory, gpus), GPU
    models and memory, detected schedulers, sharing, training runtimes, `observedAt`.
  - Fields for later phases (priority, cost, reclaim) are added when those phases need them.
- **Discovery controller.** For every `clusters.management.cattle.io`, create one pool per GPU
  product (`nvidia.com/gpu.product`) and one CPU-only pool, if missing. Pools are labelled as
  discovered, owned by the cluster object (garbage-collected with it), and their spec is never
  overwritten, so admin edits stick.
- **Status refresh.** Periodic, per cluster, through a client per cluster. `local` uses the
  in-cluster client; downstream clusters use `<rancher>/k8s/clusters/<id>` with the Settings token
  (D-15). Schedulers are detected from API groups using `trainchart.Backends()` `detect` (the same
  table again). HAMi is detected from node annotations; Kubeflow runtimes from API groups.
- **UI.** Compute Pools reads `ComputePool` objects; the browser-side discovery from Phase 0 is
  removed.
- **Verification.** Unit + envtest, then a dev operator image deployed to the lab: pools must
  appear for `local`, `downstream-1` and `downstream-2`.
