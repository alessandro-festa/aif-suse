# AI scheduling: what exists, what is missing, what it would cost to ship

Audience: Product Management. Purpose: help decide whether to take AI scheduling (training jobs,
scheduler backends, multi-cluster compute pools, idle reclaim) into AI Factory, and how far.

This analysis rests on three documents and on the code of branch `aijob-scheduling`:

| Document | What it is |
|---|---|
| [design/aijob.md](../design/aijob.md) | Dave Stanley's original design: `AIJob`, a durable record of one training run |
| [design/ai-scheduling.md](../design/ai-scheduling.md) | The target architecture built on top of it |
| [ai-scheduling-engineering.md](../ai-scheduling-engineering.md) | Engineering log: decisions D-xx, findings F-xx, open issues O-xx |

References such as F-67 or O-13 point into the engineering log. Everything below is written
to be checkable there or in the code. Where something has not been tested, this document says so.

---

## 1. Summary

- **The original work is a solid single-cluster training feature.** It fixes a real defect: today a
  finished training job disappears, along with its logs and outcome. It adds the `AIJob` record,
  a training chart, a UI, sample profiles and a Python SDK.
- **The extension turns it into a multi-cluster scheduling layer.** It covers five scheduler
  backends, four GPU-sharing modes, five job kinds, automatic placement across clusters, a global
  queue and idle reclaim. Most of the target design has been built, and each piece has run at
  least once on the lab.
- **Nothing has run on a real GPU.** The lab is three kind clusters on a laptop (arm64, Kubernetes
  1.31, simulated GPU labels). Every GPU-specific behaviour is proven only up to "the pod was
  scheduled": idle detection, HAMi sharing, the GPU profiles, the vLLM and SGLang engines.
- **Most of what it installs is not SUSE-supported.** KAI, Kueue, Volcano, HAMi, KubeRay and
  Kubeflow Trainer v2 are upstream community charts and images. None of them is in the SAIF
  catalog. The one SUSE chart that should provide training, Kubeflow, cannot install in
  "training only" mode (F-67).
- **Some gaps block a release:**
  - project isolation has never been checked with a non-admin user (O-13);
  - all downstream actions run with one admin-level Rancher token (D-15, D-24);
  - polling-based discovery will not scale as written (O-10).
- **It is a fork.** About 53,500 added lines on top of upstream 2.3.0-rc.5. None of it has been
  reviewed upstream, including the original AIJob work.

The decision is less "build it or not" than "**how far up the ladder in §6**". Each step carries
its own cost and risk.

---

## 2. What the original work delivers (aijob.md)

### 2.1 The problem it solves

Today a training run is a Helm release that creates a Kubernetes Job. When the Job's TTL expires,
the Job, its pods and their logs are deleted. Only the Helm secret remains, and it records what
was asked for, not what happened. The UI can only say "the Job has been cleaned up".

### 2.2 What it adds

| Piece | What it does |
|---|---|
| `AIJob` CRD and controller | A permanent record of each run: what was submitted, when it queued, started and ended, where it ran, which GPUs it used, its exit code. Execution objects are removed after a retention period (7 days by default); the record stays. |
| `gpu-train-job` chart | One chart for plain Jobs and PyTorchJobs, single- or multi-node, with preflight checks |
| Scheduler support | One setting with four values: `none`, `kueue`, `kai`, `runai` |
| Training UI | Jobs list, run detail, submit form, profiles, projects and quotas |
| Profiles and examples | Sample training, test and benchmark profiles that report their own results |
| Python SDK (`rancher_ai`) | Submit and follow runs from Python |
| REST API | List, cancel and delete AIJobs |

Size: 12 commits, about 33,800 added lines. The UI is 19,400 of them, the SDK 4,600, the operator
4,000, examples 2,900 and the chart 2,700.

### 2.3 What it explicitly left out

From aijob.md, "Out of scope for the first version":
- multi-cluster;
- automatic deletion of records;
- artifacts;
- inference endpoints.

It also left four open questions. Their status today:

| Open question in aijob.md | Status on the branch |
|---|---|
| Which namespace holds AIJobs | Answered: one namespace per AI project, `aif-<project>` (D-27) |
| Can `spec.source` name a Blueprint component | Not addressed |
| A cluster-wide default retention in Settings | Not addressed |
| **Install identity:** an AIJob author makes the operator install a chart with the operator's permissions | **Only partly closed.** Custom charts are now off by default (D-04). Downstream installs use the admin token from Settings, and a project check in the operator is the only thing keeping members inside their project (D-24). See risk R-S1. |

### 2.4 Limits of the original

These are listed in ai-scheduling.md §1 and §7:
- single cluster only;
- NVIDIA only;
- two job kinds (Job, PyTorchJob);
- the scheduler list copied by hand into five places;
- Kueue pinned to an older API version;
- Run:ai jobs never shown as queued;
- no Volcano, and no gang scheduling or quota editing outside KAI.

---

## 3. What the extension adds (ai-scheduling.md)

The target: the operator becomes a **meta-scheduler**. A user says what a job needs. AI Factory
picks the cluster and pool. The cluster's own scheduler decides when the job starts. Idle capacity
is taken back when someone else is waiting.

| Area | Built | Proven on the lab |
|---|---|---|
| Workloads sub-menu (Deployments / Jobs / Projects / Compute Profiles / Compute Pools) | yes | built; parts of the UI not yet tried in a browser (O-17) |
| Training chart built into the operator: no chart repository for users | yes | yes |
| One scheduler table shared by chart, operator and UI | yes | yes, plus a 32-case render test |
| `ComputePool`: GPU and CPU pools discovered on every downstream cluster | yes | yes |
| Dispatch to downstream clusters (Helm through the Rancher proxy) | yes | yes, a job ran on a downstream and reported back (F-29) |
| `AIProject`: multi-cluster projects, membership from Rancher roles | yes | yes, **with an admin user only** (O-13) |
| Automatic placement, global queue, backfill | yes | yes, across two clusters (F-42) |
| Idle reclaim (Suspend / Terminate / Never) and hand-off | yes | CPU only (F-51). GPU: unit tests only (F-52) |
| Volcano backend with gang scheduling | yes | yes (F-58) |
| HAMi GPU sharing | yes | up to scheduling only; no real HAMi (F-62) |
| Add-on install from Compute Pools (KAI, Kueue, Volcano, HAMi, Trainer v2, KubeRay) | yes | KAI, Kueue, Trainer 2.1.0 and KubeRay installed; Volcano by hand |
| Job kinds: TrainJob (Trainer v2), RayJob (KubeRay) | yes | yes, on CPU (F-74, F-72) |
| JAX, TensorFlow, DeepSpeed | test profiles only | CPU only (F-71) |
| Inference engines: llama.cpp, SGLang, Ray Serve (and vLLM/Ollama profiles) | yes | llama.cpp and Ray Serve on CPU. vLLM, SGLang and Ray Serve LLM have never run (O-24, O-37) |
| SDK on AI projects and pools | yes | yes, demo on CPU (F-73) |

Size: about 19,700 lines on top of the original, 53,500 in total across 310 files. These counts
include generated CRDs, examples and tests, so they overstate hand-written logic. They are still
a fair measure of what someone would have to review and maintain.

---

## 4. The gap: target design vs. what exists

### 4.1 Designed, not built

| Item in ai-scheduling.md | State |
|---|---|
| Pool `priority`, `costWeight`, `allowedProjects` (§6.1) | Not in the API |
| A job states requirements (`requirements`, `poolSelector`, `binpack/spread/cheapest`) (§6.2) | Not built. Needs are derived from the chart values, and the only rule is "most free capacity wins" (D-30) |
| Re-place a job that stays unadmitted (§6.3 step 4) | Not built (O-19) |
| Priority and fair-share in the global queue (§6.5) | Not built: first come, first served, with backfill (D-30) |
| Per-node fit | Not built. Placement counts pool totals, so a 12-CPU pod can be "placed" on two 10-CPU nodes and then never start (O-18, O-29) |
| Quota editors for Kueue ClusterQueue and Volcano Queue (§7 item 8) | Not built (O-3) |
| Several HAMi slices per pod; HAMi under Volcano | Not built (O-32, O-30) |
| Non-NVIDIA GPUs (§7 item 10) | Not built. NVIDIA resource names and labels throughout |
| Nodes that expose GPUs through DRA only | Counted as CPU nodes (O-9). DRA claims and fractional GPUs are not counted as used (O-11) |
| Kubeflow "training only" preset (§5) | Blocked by the SUSE chart (F-67) |
| App Collection PyTorch image as the default training image (§5) | Not done. Profiles use `bci-base` plus pip installs at start (O-7) |
| Inference endpoints placed automatically | Not built. Users pick the pool by hand (D-37). Members cannot deploy endpoints at all yet (O-22) |
| What aijob.md said AIJob enables: log links, metrics, aggregates (success rate, queue wait, GPU hours) | Not covered by this work |

### 4.2 Built differently from the design

These are deliberate decisions, but PMs should know about them, because each one changes a
property of the product:

| Design said | Built | Consequence |
|---|---|---|
| Jobs reach downstream clusters as Fleet Bundles (§6.4) | Helm runs through the Rancher proxy (D-20) | Errors show up at once. But if Rancher or the operator is down, nothing downstream is installed, observed, cleaned up or reclaimed. Fleet would have kept going. |
| Idle detection from Rancher Monitoring Prometheus (§6.6) | Direct sampling of kubelet and DCGM through the proxy (D-40) | No Monitoring dependency. More load on Rancher (R-P2). |
| AI project = a labelled Rancher project (D-23) | `AIProject` resource managed by AI Factory (D-27) | Multi-cluster projects work. It is a second project concept beside Rancher's. |

### 4.3 Documentation drift

The phase table in ai-scheduling.md §8 still shows phases 2–8 as not done. The engineering log
shows them done. The engineering log is the accurate one.

---

## 5. Risks

Each risk is rated by **likelihood** (that it bites a customer) and **impact** (if it does).

### 5.1 Supportability: what customers would run that SUSE does not support

The SAIF catalog (`operator/internal/catalog/default-catalog.json`) has 12 SUSE AI apps:
Milvus, Ollama, Open WebUI (three charts), PyTorch, SUSE AI Deployer, the Observability
Extension, vLLM, Qdrant, LiteLLM and Kubeflow. Its NVIDIA section includes Run:ai, the GPU
Operator and the DRA driver. Against that:

| Component the feature installs or relies on | Source | In SAIF catalog? | SUSE-supported? |
|---|---|---|---|
| NVIDIA GPU Operator / DRA driver | NVIDIA | yes | partner |
| Run:ai | NVIDIA (NGC, gated) | yes | partner; **never tested here** (O-8, F-14) |
| PyTorch (App Collection) | SUSE | yes | yes, **but not used** by default (O-7) |
| Kubeflow (SUSE chart 0.4.1) | SUSE | yes | yes, **but cannot install training-only**: it pulls in Istio, cert-manager, Jupyter and pipelines objects (F-67) |
| KAI scheduler | `ghcr.io/kai-scheduler` | **no** | **no** |
| Kueue | `registry.k8s.io` | **no** | **no** |
| Volcano | volcano-sh Helm repo | **no** | **no** |
| HAMi | project-hami Helm repo | **no** | **no** |
| KubeRay | ray-project Helm repo | **no** | **no** |
| Kubeflow Trainer v2 + JobSet | `ghcr.io/kubeflow` | **no** | **no** (D-52 says so) |
| llama.cpp, SGLang, Ray Serve charts | our fork's `inference-engines` branch | **no** | **no**; SGLang image is `latest`, unpinned (O-24) |
| Training images in profiles | `bci-base`, `python:3.12`, `rayproject/ray`, pip at start | — | base image only; the frameworks are pulled from PyPI at run time |

| ID | Risk | Likelihood | Impact |
|---|---|---|---|
| R-C1 | Customers install schedulers from the Compute Pools page and open support cases SUSE cannot service | high | high |
| R-C2 | **Air-gapped installs break.** Add-ons, engines and profiles pull from ghcr.io, registry.k8s.io, community Helm repos and PyPI. None of these is mirrored in a SUSE registry. | high in regulated accounts | high |
| R-C3 | Versions are hard-coded in the UI (O-34). The design doc names KAI v0.20.1 but the add-on installs v0.18.3. Upstream projects move fast: Kueue's API version changed and Trainer went 2.1 → 2.3 during this work. Every bump needs a code change and a release. | high | medium |
| R-C4 | The SUSE path for training (the Kubeflow chart) is blocked. It needs a training-only mode from the SUSE Kubeflow team (O-33). Until then the only working runtime is upstream Trainer. | certain until fixed | medium |
| R-C5 | Kubernetes version limits: Trainer ≥ 2.2 and Kueue with TrainJob need Kubernetes ≥ 1.32. Shared GPUs through DRA need ≥ 1.34. Customers on older RKE2 get a reduced feature set, which the UI explains only in places. | medium | medium |

### 5.2 Security

| ID | Risk | Likelihood | Impact |
|---|---|---|---|
| R-S1 | **One admin-level credential does everything downstream.** Discovery, installs, Rancher project and role-binding writes and activity sampling all use the token an admin authorizes in Settings (D-15, D-24, D-29). A bug in the project check, or a chart that renders more than expected, runs with admin power on every downstream cluster. aijob.md's open question on install identity is still open. | medium | high |
| R-S2 | **Project isolation is unverified for non-admins.** Every lab check ran as a Rancher admin (F-32, O-13, O-16). What a member or a read-only user can see or do is untested live. | unknown | high; **release blocker** |
| R-S3 | Any AI project member can read every AI project's name, clusters and owners (D-33) | certain | low to medium, depending on the customer |
| R-S4 | Training profiles install packages from PyPI when they start. That is a supply-chain path into GPU nodes. | medium | medium |

### 5.3 Scalability

| ID | Risk | Likelihood | Impact |
|---|---|---|---|
| R-P1 | **Discovery polls everything, every minute:** every active pod on every downstream cluster, plus the kubelet stats of every pool node (O-10, F-59). That cost grows with clusters × pods × nodes, and it all goes through Rancher. Fine on three kind clusters. Unknown at 20 clusters with 500 nodes. The log itself says "before production". | high at scale | high |
| R-P2 | **Rancher is on every request path.** Installs, observation, logs, activity sampling and project writes all go through the Rancher proxy. Rancher's load and availability become AI Factory's. | high at scale | high |
| R-P3 | One placement pass serialises all waiting jobs (a single reconcile key, D-30). It is simple and correct, but it has no measured ceiling. | medium | medium |
| R-P4 | Pool figures lag up to a minute. A fix exists (F-50), but placement still uses pool totals rather than per-node fit (O-18), so jobs can be placed where they never start. Nothing re-places them (O-19). | medium | medium; jobs stuck with no clear reason |

### 5.4 Reliability and correctness

| ID | Risk | Likelihood | Impact |
|---|---|---|---|
| R-R1 | **No real-GPU validation.** The lab has simulated GPU labels only (F-27, F-52, F-62). This covers GPU idle detection, HAMi, KAI fractions, the GPU framework profiles (51–55), vLLM, SGLang and Ray Serve LLM. GPU work is the core use case. | certain until tested | high |
| R-R2 | **Reclaim can lose work.** Suspend uninstalls the run. Its checkpoint volume stays on the cluster where it ran. If the queue later places the run on another cluster, it starts from scratch (O-28). Reclaim is off by default (D-43), which limits the blast radius. | medium where reclaim is on | high for long trainings |
| R-R3 | If the operator or Rancher is down, nothing is installed, observed, cleaned up or reclaimed downstream (consequence of D-20) | medium | medium |
| R-R4 | The test surface is large: 5 schedulers × 4 sharing modes × 5 job kinds × CPU/GPU × Kubernetes versions. The lab covers a diagonal of that matrix, not the matrix. | high | medium |
| R-R5 | Several real defects only showed up on a live cluster: Fleet reporting "Ready" while nothing was installed (F-68), duplicate role bindings (F-38), a startup race (F-40), stale scheduler detection (F-69). More of this class should be expected on real customer clusters. | high | medium |
| R-R6 | Two pre-existing test failures are tolerated locally (F-17, F-53) | low | low |

### 5.5 Product and organisational

| ID | Risk | Likelihood | Impact |
|---|---|---|---|
| R-O1 | **Fork divergence.** The original AIJob work is not merged upstream either. Taking the extension means reviewing about 53,500 lines at once, or splitting them. Upstream work such as draft PR #160 (moving AIWorkloads to a system namespace) would collide with this namespace model. | high | high |
| R-O2 | It overlaps with Run:ai, which SUSE already lists in the catalog and which does queueing, quotas and fractions. A customer with Run:ai gets two schedulers' UIs. Run:ai support here is untested. | medium | medium |
| R-O3 | It introduces a second "project" concept (AIProject) beside Rancher projects. That needs documentation and support training. | medium | low to medium |
| R-O4 | Some UI flows have never been clicked through in a browser (O-17, 3c and 4c in the status table) | high | low |

---

## 6. Options

The ladder below is cumulative. Each step includes the ones before it.

| Option | Scope | What must be done before GA | Main risks carried |
|---|---|---|---|
| **0. Do nothing** | Keep today's Helm-release training | — | The original problem stays: runs vanish along with their outcome |
| **1. AIJob only (single cluster)** | dstanley's scope, plus the built-in chart (no repository) and the shared scheduler table. Schedulers are whatever the customer already runs; AIF installs none. | Upstream review of the original 12 commits. Install identity (R-S1, single-cluster form). Real-GPU test of the chart. | R-O1 (smaller), R-R1 |
| **2. + Supported scheduler add-ons** | Option 1, plus Compute Pools as a view and add-on install for the schedulers SUSE decides to support | A support decision per component (§5.1). SUSE-registry mirrors for air-gap. A version-update process. | R-C1–R-C3 |
| **3. + Multi-cluster with manual pool choice** | Option 2, plus ComputePool, AIProject and dispatch. The user picks the pool. | Non-admin isolation test (R-S2). Scoped credentials (R-S1). Discovery reworked to watches or aggregation (R-P1). | R-P1, R-P2, R-R3, R-S1 |
| **4. Full target: placement, global queue, idle reclaim** | Everything built on the branch | All of the above. Per-node fit, re-place, priority and fair-share (O-18, O-19). Checkpoints that move between clusters (O-28). GPU idle detection on real GPUs. | All of §5 |

What changes the risk picture most, whichever option is chosen:
1. **A real GPU cluster** for a validation pass (R-R1). Without one, no GPU claim in this feature is
   proven.
2. **A support decision per component** in §5.1. That decides between Option 1 and Option 2 and
   beyond.
3. **A non-admin isolation test and a scoped credential model** (R-S1, R-S2). These are a
   precondition for any multi-cluster option.
4. **An agreement with upstream** on how to land the original AIJob work (R-O1). Everything here
   depends on it.

---

## 7. Questions for the PM group

1. Is the target customer single-cluster today? If so, Option 1 delivers the user-visible value
   (runs that don't vanish) at a fraction of the risk.
2. Which schedulers will SUSE support: none, Kueue only, KAI (NVIDIA-aligned), Volcano? Each one
   is a commitment to track a fast-moving upstream.
3. Is relying on Run:ai, already in the catalog, an acceptable answer for customers who need
   queues, quotas and fractions, instead of building our own?
4. Can the SUSE Kubeflow team provide a training-only mode (F-67)? Without it there is no
   SUSE-supported training runtime.
5. Is air-gap a must-have for the first release? If yes, every component in §5.1 needs a mirror,
   or it has to be dropped.
6. Who owns the upstream review of the original AIJob work, and on what timeline?
