# Engineering: multi-user notebook training on SUSE AI Factory

*2026-11-05. Status: prototype validated on a lab cluster (`README.md`); this document is the plan to
make it a product feature. Everything marked **verified** was run on the lab; the rest is design.*

## 1. Goal

- **Data scientists** train models from **Jupyter notebooks**, several users on a shared cluster, without kubectl or
  kubeconfig files.
- **Admins** govern this from the **SUSE AI Factory UI** (Workloads > Scheduling): GPU queues and quotas, which
  projects may train, who may train, what is running, and stopping it.
- **Fair GPU sharing** between projects: guaranteed quota, borrowing when idle, GPU fractions for small jobs.

## 2. Architecture

```
            Rancher (identity, projects, RBAC, OIDC provider, cluster proxy)
              │                         │                              │
   AIF UI: Workloads > Scheduling   JupyterHub (multi-user)        local Jupyter
   (admin)                          one notebook server per user   (Rancher API token)
              │                         │  Kubeflow SDK + aif-training │
              ▼                         ▼                              ▼
   ───────────────────────── Kubernetes API (a downstream or the local cluster) ─────────────────────────
     KAI Queues           TrainJob ──admission (VAP: aif-trainjobs, aif-gpu-pods, aif-namespace-labels)
     namespace labels        │
     (managed + queue)       ▼
                       Kubeflow Trainer ──▶ JobSet ──▶ Jobs ──▶ Pods ──▶ KAI scheduler (queue, quota, GPU share)
                       (ClusterTrainingRuntimes aif-*)            └── outputs PVC per run (kept after the job)
```

**Who does what:**

| Piece | Role |
|---|---|
| **Rancher** | Who the user is, which project (namespaces) they belong to, the proxy every client goes through |
| **KAI Scheduler** | Places training pods by queue: quota, over-quota borrowing, gang scheduling, GPU sharing |
| **Kubeflow Trainer v2 + JobSet** | Turns one `TrainJob` into the pods of a (distributed) PyTorch run; the Python SDK users submit with |
| **aif-training-runtimes** (Dave Stanley's chart) | The compute profiles (ClusterTrainingRuntimes) and the admission policy that makes every job respect its queue and limits |
| **aif-training** (SDK option) | Labels a job's pods with the namespace's KAI queue |
| **JupyterHub** | One authenticated notebook server per user, inside the cluster |
| **AIF UI, Scheduling** | The admin console over all of the above (prototype built, `README.md` §7) |

## 3. Dependencies

| Dependency | Version (tested) | Why it is needed | Constraints |
|---|---|---|---|
| **Kubernetes** | 1.34.3 (verified) | — | **≥ 1.32**: Trainer 2.2+'s CRDs use CEL that 1.31 can't compile. ≥ 1.30 for ValidatingAdmissionPolicy |
| **Rancher** | 2.15.3 (verified) | Projects, users, API tokens, cluster proxy; the embedded **OIDC provider** for JupyterHub sign-in | The OIDC provider: feature `oidc-provider` (default on in 2.15) plus an `OIDCClient` |
| **KAI Scheduler** | v0.18.3 (verified; Dave: v0.18.2) | Queues with GPU quota per project, fair share and reclaim, gang scheduling for multi-node, GPU fractions (`aif-share-*`) | GPU sharing mode: default `NonMemoryEnforced`; Dave tested `HamiCore` (memory-enforced) |
| **Kubeflow Trainer** | 2.2.1 (verified), upstream chart `oci://ghcr.io/kubeflow/charts/kubeflow-trainer` | `TrainJob` + `ClusterTrainingRuntime` CRDs and controller; the SDK targets it | SDK must match: Trainer 2.2 ↔ `kubeflow` SDK 0.4.x (`runtimePatches`); 2.1 ↔ 0.3.x. The upstream chart lacks the runtime-read grant (§6, gap 2) |
| **JobSet** | 0.11.0 (bundled by Trainer 2.2.1, verified) | Trainer runs every TrainJob as a JobSet | **≥ 0.11** for the per-run outputs volume (`volumeClaimPolicies`); SUSE's Kubeflow 0.4.1 ships 0.10.1 |
| **aif-training-runtimes** | dstanley `842be554` (verified, 36/36 admission tests) | Compute profiles and policy | Not published yet; needs gaps 1–3 fixed (§6) |
| **aif-training** SDK option | dstanley `842be554` (verified) | Queue label on the pods | pip from git today; to publish |
| **JupyterHub** (Zero to JupyterHub) | chart 4.4.4 / JupyterHub 6.1.1 (current; not yet deployed) | Multi-user notebooks (§4) | Authenticator for Rancher OIDC (GenericOAuthenticator); KubeSpawner |
| **Storage class** | `standard` (local-path, RWO) on the lab | Outputs volume per run; notebook home volumes | Multi-node runs with outputs need **RWX** (the policy refuses multi-node on RWO, verified case 18) |
| **NVIDIA GPU Operator** | — (simulated GPU on the lab) | Real GPUs: device plugin, drivers, DCGM | KAI GPU sharing on top. Untested on real GPUs |
| **Images** | `pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime` | The runtimes' trainer image | **amd64 only**: arm64 nodes need emulation (verified, slow) or a multi-arch image (App Collection) |

## 4. Why JupyterHub (and not "everyone runs Jupyter locally")

The local path works (README §9, a Rancher API token in the notebook), but it doesn't hold up as the product for
a multi-user customer:

| Need | Local Jupyter | JupyterHub |
|---|---|---|
| Who is the user | a Rancher API token pasted on each laptop, long-lived | Single sign-on with Rancher (OIDC), no tokens handled by users |
| Setup | Python, the SDK and certificates on every laptop | Nothing: open a URL |
| Same environment for everyone | Whatever each laptop has | Admin-curated images (SDK and versions pinned to the cluster's Trainer) |
| Data next to compute | Data goes laptop → cluster | Home and dataset volumes in the cluster |
| Notebook resources | The laptop | Per-user CPU/memory limits, chosen from profiles |
| Idle sessions | n/a | Culled after a timeout, freeing resources |
| Audit | Jobs show the token's user | Jobs and servers tied to the signed-in user |

A notebook itself needs no GPU: it **submits** TrainJobs, which get GPUs through KAI. So the hub is CPU-only and
cheap.

### 4.1 JupyterHub integration design

1. **Sign-in: Rancher's embedded OIDC provider.**
   - Create an `OIDCClient` for the hub, and use JupyterHub's `GenericOAuthenticator` (`oauthenticator`).
   - Rancher users and groups become hub users and groups.
   - *To verify:* which claims Rancher puts in its ID token (username, groups).
2. **Where a user's server runs: KubeSpawner**, in a hub namespace (`jupyterhub`), with a per-user home PVC.
3. **How a notebook submits as its user.** This is the key decision:

   | Option | How | Pros | Cons |
   |---|---|---|---|
   | A. Per-namespace SA (the prototype's "notebook access", verified) | One SA `notebook` per project namespace, bound to `ai-trainer` | Built and working | All users of the namespace share one identity, so no per-user audit; servers must run in the project namespace |
   | **B. Per-user SA (recommended)** | When the admin grants AI Trainer, AIF also creates SA `nb-<user>` in each project namespace, bound to `ai-trainer`. The spawner mounts a token for it (projected, short-lived) and sets the default namespace | Per-user identity and audit, no secrets handled by users, revoking the grant removes it | AIF must reconcile SAs per user per namespace (a small controller, or the UI) |
   | C. User's Rancher token in the server | The hub obtains a Rancher token for the user at sign-in and injects it | The real Rancher identity end to end | Rancher's OIDC tokens are not API tokens; minting tokens for users is sensitive. *Not verified that it is even possible* |

4. **Profiles.** "CPU notebook (small/medium)" images with `kubeflow==0.4.1` and `aif-training` preinstalled, pinned to the cluster's Trainer version.
5. **Culling:** `jupyterhub-idle-culler` (in the chart), e.g. 1 h idle.
6. **Access:** an Ingress on the hub's hostname. Or, for a first version, the Rancher service proxy.

## 5. Why not the whole Kubeflow platform

Kubeflow also ships notebooks (Kubeflow Notebooks), so "install Kubeflow" looks like the shortcut. It doesn't fit:

1. **It can't be installed partially.** SUSE's chart (`oci://registry.suse.com/ai/charts/kubeflow` 0.4.1, a technology preview) cannot install "training only" (our finding F-67, verified on an earlier lab):
   - three subcharts render unconditionally: Istio resources, the cert-manager Certificate/Issuer, and a kubeflow `Profile`;
   - validations require Knative/KServe domains even with those disabled;
   - it refuses demo credentials for components that are off.
2. **It duplicates Rancher.**
   - Kubeflow has its own identity (Dex + oauth2-proxy), its own tenancy (Profiles), its own RBAC model and its own dashboard.
   - Rancher already provides projects, users, SSO and RBAC, and AIF provides the UI. Two tenancy models must be kept in sync by hand: each Profile namespace must also be a Rancher project namespace with the queue labels.
3. **Istio breaks the training path.** Profile namespaces have Istio sidecar injection on:
   - a sidecar keeps running after the training container exits, so a TrainJob's pods may never complete;
   - the proxy's init container comes from `docker.io/istio/…`, outside the runtimes' allowed registries, so the GPU-pod policy **refuses every GPU pod** (Dave's verified test case 35);
   - fixing this means `sidecar.istio.io/inject: "false"` on every runtime, and keeping it there.
4. **Footprint and operations.**
   - Istio, Knative, KServe, Katib, Pipelines (+ its object store), Dex, oauth2-proxy and the central dashboard, for a feature that needs Trainer, JobSet, KAI and a hub;
   - every upgrade moves all of them;
   - the chart is a technology preview.
5. **What we actually use from it is small and available upstream, standalone:** Trainer + JobSet (one Helm chart) and the Kubeflow SDK (pip). JupyterHub covers notebooks without Istio, Profiles or Dex.

**Kubeflow pieces kept:** Trainer v2, JobSet, the Kubeflow SDK. **Dropped:** dashboard, Profiles, Notebooks, Istio, Dex, Pipelines, KServe, Katib. Pipelines and Katib can be added later as standalone components if a customer asks.

## 6. Work to do

### 6.1 Fixes to Dave's branch (report upstream to him)

| # | Gap (all verified) | Fix |
|---|---|---|
| 1 | `RoleTemplate ai-trainer` with `external: true` is hidden by Rancher's member editor (`!role.external`) | Keep it external, and grant it from AIF (the Scheduling UI does, via a ProjectRoleTemplateBinding in the project's **backing namespace** `<cluster>-<project>`). Or ship it non-external with the rules inline |
| 2 | The upstream Trainer Helm chart has no `kubeflow-trainer-view-cluster-runtimes`, so non-admins can't list or get runtimes | Ship the ClusterRole + binding to `system:authenticated` in `aif-training-runtimes` (as the UI's Readiness fix does) |
| 3 | `namespace_queue()` reads the Namespace; `ai-trainer` lacks `get namespaces`, so a notebook SA gets 403 | Add `{apiGroups: [""], resources: ["namespaces"], verbs: ["get"]}` to the `ai-trainer` ClusterRole. **Verified safe:** bound by a RoleBinding, it allows only that namespace (200 on own, 403 on others, no list) |

### 6.2 Product work

| Area | Work | Size |
|---|---|---|
| Packaging | Publish `aif-training-runtimes` (OCI, versioned with AIF) and the `aif-training` wheel; multi-arch default images (App Collection PyTorch) | S |
| Cluster add-ons | Install KAI, Trainer (+JobSet ≥ 0.11), the runtimes and JupyterHub from the AIF UI per cluster, with the Kubernetes ≥ 1.32 gate. The `aijob-scheduling` branch already has an add-on installer (Fleet HelmOp per cluster) to reuse | M |
| Scheduling UI | Productize the prototype: l10n, component tests, RBAC-aware actions (hide what the admin can't do), per-queue assigners (`aif-queue-assigner` with `resourceNames`) so project owners manage their own queue | M |
| Per-user notebook identity (option B) | When AI Trainer is granted, create or remove SA `nb-<user>` + `ai-trainer` binding per project namespace. Implement in the UI first, then an operator reconciler watching PRTBs | M |
| JupyterHub | Chart values preset: Rancher OIDC (`OIDCClient` + GenericOAuthenticator), KubeSpawner hook that mounts the user's `nb-<user>` token and sets `NAMESPACE`, CPU profiles with the SDK preinstalled, culler, Ingress | M |
| Notebook images | CPU notebook image (SLE BCI base) with `kubeflow==<matching>` and `aif-training` | S |
| Validation | Real-GPU runs: `aif-share-4g` (KAI fraction), `aif-gpu` multi-node with RWX outputs, NCCL; arm64 nodes | M |
| Docs | User guide (notebook), admin guide (Scheduling page), install guide (dependencies above) | S |

### 6.3 Open questions

1. Rancher OIDC claims: are groups included? (They drive hub admin and allowed users.)
2. Multi-cluster: one hub per cluster, or one hub that submits to several clusters through the Rancher proxy (option C style)?
3. Quotas beyond GPUs: KAI's CPU and memory units (millicores / MB) to confirm on the queue status of a running job.
4. Retention of outputs PVCs: who cleans them up, and when (Dave's chart keeps them; nothing deletes them).
5. Do we need Kueue anywhere? (No: KAI covers queueing for this path.)

## 7. Verified on the lab (for reference)

- KAI v0.18.3 + Trainer 2.2.1 / JobSet 0.11.0 + aif-training-runtimes on Kubernetes 1.34.3.
- Admission: 36/36 of Dave's cases.
- Notebook SA in-cluster: CPU TrainJob Complete, KAI-placed in the namespace queue, outputs PVC kept.
- Local Jupyter with a Rancher API token, as standard user `trainer1` through the Rancher proxy: TrainJob Complete, accuracy 0.995, model saved (README §9).
- Gaps 1–3 reproduced; the fix for 3 verified.
- Amd64 PyTorch image on arm64 nodes: runs under emulation.
