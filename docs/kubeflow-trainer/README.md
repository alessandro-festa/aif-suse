# Kubeflow Trainer scheduling in SUSE AI Factory: test and prototype

*Demo video (2:36, not in git; ask the author): `aif-notebook-training-demo.mp4`, covering the admin settings, the user procedure, and an end-to-end run. It was recorded with `lab/record.py` (Playwright) and cut with `lab/edit.py` (ffmpeg).*

*See also `ENGINEERING.md`: dependencies (KAI, Kubeflow Trainer, JupyterHub), why JupyterHub, why not the whole Kubeflow, and the work to do.*

*2026-11-05. Prototype only. The code is on branch `kubeflow-trainer-scheduling` of
alessandro-festa/aif-suse (upstream/main + Dave's commit + the Scheduling UI).*

## 1. Why we did this

**The customer ask:**
- data scientists submit training jobs from **Jupyter notebooks**;
- admins **administer** those jobs (queues, quotas, who may train, what ran) from the AI Factory UI.

Dave Stanley (SUSE) has a fork of AI Factory, `github.com/dstanley/aif`. We tested whether his work covers this, and found it covers the cluster side. We then built the missing admin UI on top of it, as a **Workloads > Scheduling** menu in the AIF extension.

## 2. What is on Dave's fork

| Branch | Date | What it is | Kubeflow |
|---|---|---|---|
| `prototype/aijob` | 2026-10-11, 56 commits | The AIJob CRD and controller, a Training UI, a Python SDK. Our `aijob-scheduling` branch descends from it. | Narrow: an optional `job.kind=pytorchjob` (Training Operator v1), and a "Kubeflow pipeline" origin label |
| **`prototype/kubeflow-trainer`** | 2026-10-28, 1 commit `842be554` | **Kubeflow Trainer v2 integration.** No operator or UI changes. | The real thing: TrainJobs submitted with the Kubeflow SDK, scheduled by KAI |

**We chose `prototype/kubeflow-trainer`.** It is the Kubeflow path, and its submission model ("submit from a notebook with the Kubeflow SDK") is exactly the customer's. `prototype/aijob` would have needed:
- Dave's operator image (`ghcr.io/dstanley/aif-operator:2.3.0-rc.4-pr7-020e2e17`);
- a dev-loaded UI;
- a self-hosted `gpu-train-job` chart, which is published nowhere, and the operator refuses git-backed repos.

What `prototype/kubeflow-trainer` adds:
- **`charts/aif-training-runtimes`:**
  - Four ClusterTrainingRuntimes, which serve as the compute profiles:

    | Runtime | Runs on | Limits |
    |---|---|---|
    | `aif-share-4g` | a 4 GiB KAI GPU share | 1 node, 4 h |
    | `aif-share-8g` | an 8 GiB KAI GPU share | 1 node, 8 h |
    | `aif-gpu` | whole GPUs | ≤4 nodes, ≤8 GPUs per node, 24 h |
    | `aif-cpu` | CPUs | ≤4 nodes, 8 h |

  - Three ValidatingAdmissionPolicies:
    - `aif-trainjobs`: a TrainJob must use an `aif-*` runtime, in its namespace's KAI queue, within the runtime's limits, from approved registries, with no privilege, host path or placement in its patches;
    - `aif-gpu-pods`: any GPU pod must use KAI and the namespace's queue;
    - `aif-namespace-labels`: only admins or assigners may set the queue and managed labels.
  - RBAC: the ClusterRoles `ai-trainer`, `aif-queue-assigner` and `aif-namespace-manager`.
- **`sdk/aif-training`:** `namespace_queue(client)`, a Kubeflow SDK option that labels the trainer pods with the queue of the namespace the client submits to. It fails closed.

## 3. The lab

Kubeflow Trainer 2.2+ cannot install on Kubernetes 1.31: its JobSet and runtime CRDs use a CEL rule that 1.31 cannot compile (our earlier finding F-70). The first sims cluster (`sims-nvidia-3901`) was 1.31, so we rebuilt it on 1.34, the version Dave tested on.

```sh
cd ~/Documents/innovation/sims
./bin/sims gpu create --vendor nvidia --name sims-nvidia-kft --k8s-version v1.34.3 \
  --workers 1 --gpus-per-worker 1 --apps rancher-prime,cert-manager,aif-nvidia
```

| Component | Version | How |
|---|---|---|
| Kubernetes (kind) | 1.34.3 | sims (`--k8s-version`; its default is 1.31.0) |
| Rancher | 2.15.3 | sims |
| AIF operator | 2.4.0 | `helm install aif-operator oci://ghcr.io/suse/chart/aif-operator --version 2.4.0`. sims' `aif-nvidia` app points at `0.1.0-dev.1`, which does not exist |
| KAI Scheduler | v0.18.3 | `oci://ghcr.io/kai-scheduler/kai-scheduler/kai-scheduler`. Default GPU sharing mode `NonMemoryEnforced` |
| Kubeflow Trainer + JobSet | 2.2.1 + 0.11.0 | upstream `oci://ghcr.io/kubeflow/charts/kubeflow-trainer` (it bundles JobSet 0.11, needed for the outputs volumes) |
| aif-training-runtimes | Dave's commit | `helm install … -f lab/values.yaml` (`outputs.enabled: true`) |
| GPU | 1 simulated (KWOK) | CUDA does not really exist; only scheduling and admission can be tested |

**Why not the SUSE Kubeflow chart** (`oci://registry.suse.com/ai/charts/kubeflow` 0.4.1)? On a plain cluster it cannot install "training only". It always renders Istio, cert-manager and Profile objects (our earlier finding F-67). For the runtimes, upstream Trainer is enough.

**Setup:**
- KAI queues (`lab/queues.yaml`): `aif-root` > `aif-submit` (GPU quota 1), `scdoc-transcription`. These are the names Dave's tests use.
- Rancher project `training` with namespace `aif-submit`, labelled `ai-factory.suse.com/managed=true` and `kai.scheduler/queue=aif-submit`.
- Namespace `tenant-default`, unmanaged.
- Standard user `trainer1`, holding AI Trainer in `training`.

**After the AIF UI dev build:**
- The packaged AIF UI is disabled (`helm upgrade aif-operator … --reuse-values --set aiExtension.enabled=false`), so the dev-loaded build is the only one. With both loaded, Rancher merges their menus.
- The AIF registry secrets (`application-collection`, `suse-registry`, `nvidia-registry` in `aif-operator`, Opaque `user`/`token`) must be added by hand. sims does not keep the credentials.

## 4. What we tested, and the results

| Test | Result |
|---|---|
| Dave's admission suite (`tests/policy/run.sh`, server dry runs) | **36/36 pass.** That covers: queue, share, GPU caps, CPU/memory caps, registries, deadlines, privileged/hostPath/serviceAccount/placement patches, GPU pods outside KAI, and multi-node on RWO outputs |
| `trainer1` RBAC through Rancher | can create TrainJobs in `aif-submit` (after the fixes in §5) |
| **Notebook path:** a JupyterLab image (`quay.io/jupyter/minimal-notebook`) in `aif-submit` under SA `notebook` bound to `ai-trainer`; `pip install kubeflow==0.4.1 aif-training`; `lab/run.py aif-cpu` | **Works.** TrainJob `Complete`. Pod placed by `kai-scheduler` with `kai.scheduler/queue=aif-submit`. `/outputs/result.txt` written to a retained 10Gi PVC (`outputs-<job>`) |
| amd64-only image on arm64 nodes | Every `pytorch/pytorch` tag is single-arch amd64. It runs on the arm64 kind worker under emulation (`torch 2.7.1+cu128 x86_64`), slowly. Use a multi-arch image on real arm64 |
| GPU runtimes | Admission is covered by the suite. A real run is not possible on the simulated GPU |

## 5. Gaps found in Dave's branch (to report to him)

1. **The "AI Trainer" RoleTemplate cannot be picked in Rancher.**
   - His README asks for a RoleTemplate with `external: true`.
   - Rancher's project member editor filters roles with `!role.builtin && !role.external && !role.hidden` (`@rancher/shell/components/form/ProjectMemberEditor.vue`), so the role never shows up.
   - Workaround: create the ProjectRoleTemplateBinding directly, in the project's backing namespace (`local-p-xxxxx`, not `p-xxxxx`, on Rancher 2.15). Our UI does this.
2. **On upstream Trainer, nobody can see the runtimes.**
   - His RBAC relies on `kubeflow-trainer-view-cluster-runtimes` (ClusterTrainingRuntimes readable by `system:authenticated`).
   - The upstream Trainer **Helm chart** does not ship it; the kustomize manifests and the SUSE chart apparently do.
   - Without it, `client.list_runtimes()` / `get_runtime()` fail for non-admins. Our UI's Readiness tab detects this and creates it.
3. **A notebook service account cannot use `namespace_queue()`.**
   - The option reads the Namespace object for its queue label, and `ai-trainer` does not grant `get namespaces`.
   - It works through a Rancher kubeconfig, because Rancher's project roles cover it. An in-cluster notebook SA gets **HTTP 403**.
   - Fix: a namespaced Role with `get` on `namespaces`, `resourceNames: [<ns>]`. Our UI's "Notebook access" creates it, with the SA and the `ai-trainer` binding.
   - Simpler fix for Dave: add `get` on `namespaces` to the `ai-trainer` ClusterRole itself. Bound by a RoleBinding, it allows only that namespace; **verified**: 200 on its own namespace, 403 on another, no list.
   - Note: `kubectl auth can-i get namespace/x` says "no" unless you add `-n x`.

## 6. Jupyter: why not Kubeflow Notebooks (yet)

Dave's design already submits from a notebook: `namespace_queue` uses the notebook pod's service account when it runs in the cluster. **Any Jupyter in a project namespace works**, once its SA has `ai-trainer` and `get` on its namespace. We proved this with the probe above.

**Kubeflow Notebooks** (the notebook controller and the Jupyter web app) are possible, but costly:
- **The whole platform.** They come with Profiles, Istio, Dex/oauth2-proxy and the central dashboard. The SUSE chart cannot be trimmed (F-67).
- **Namespace mapping.** Each Kubeflow Profile namespace must also be in a Rancher project, and labelled `managed` plus a queue (admin-only). Nothing does that today.
- **Istio sidecars (likely blocker).** Profile namespaces have Istio injection on, so the trainer pods get the proxy:
  - the sidecar keeps running after training, so a TrainJob may never complete;
  - the proxy's init image (`docker.io/istio/...`) is outside the allowed registries, so **GPU pods are refused**. That is exactly Dave's test case 35.
  - The likely fix, untested: `sidecar.istio.io/inject: "false"` on the runtimes' pod templates.

**Recommendation:** for many users, **JupyterHub** (sign-in with Rancher's OIDC provider, one server per user, a per-user service account bound to `ai-trainer`), not Kubeflow Notebooks; see `ENGINEERING.md` §4–5. For a single user, a local Jupyter with a Rancher API token (§9).

## 7. The UI: Workloads > Scheduling

**Why:** Dave's branch is CLI-only for admins. Every admin step in this lab was kubectl or YAML, and two of them work around Rancher (the hidden role, the backing namespace). The customer wants admins in the AI Factory UI.

**Where:** the AIF extension. **Workloads** becomes a sub-menu with **Deployments** (the former Workloads page) and **Scheduling**. This uses the same group mechanism as our `aijob-scheduling` branch (`basicType(…, 'aifWorkloads')`, `weightGroup`, `setGroupDefaultType`).

**What, one tab each.** There is a cluster selector at the top; every call goes through Rancher's cluster proxy with the admin's own rights, so it works for downstream clusters too.

| Tab | Does | Replaces |
|---|---|---|
| **Readiness** | Checks: KAI running, Trainer running, JobSet ≥ 0.11, the runtimes chart, the `ai-trainer` ClusterRole, runtime read for all users, the Rancher "AI Trainer" role. One-click fixes for the last two | Gaps 1 and 2 |
| **Queues & Quotas** | Lists KAI queues as a tree, with GPU quota, limit and use, and the namespaces in each. Create, edit or delete (refuses to delete a queue still in use) | `lab/queues.yaml` |
| **Projects** | For a Rancher project: per namespace, enable training (managed label + queue), change the queue, disable; flags broken states (managed without a queue, unknown queue, queue without managed); enable **notebook access** (SA + `ai-trainer` + namespace read). AI Trainers: grant or revoke the role per user | namespace labels, the PRTB, gap 3 |
| **Runtimes** | Read-only list of the `aif-*` runtimes: what each runs on, node and time limits, image, allowed registries | `kubectl get clustertrainingruntimes` |
| **Training Jobs** | Every TrainJob, filterable by namespace: runtime, queue, state (with why it is Pending), age. Expand for pods, scheduler and node, and their **logs**. **Suspend/Resume** and **Delete** (the outputs volume is kept). Refreshes every 10 s | kubectl get/logs/delete |

**Design choices:**
- Notebooks submit, the UI administers: no "submit" form. Job submission stays in the Kubeflow SDK, as the customer asked.
- No new operator code or API: the page reads and writes Kubernetes objects through the Rancher proxy. Admission still enforces everything, whatever the UI does.
- Status uses outlined tags and status dots, not solid badges (house style).
- The pure logic is in `services/scheduling/model.ts`, unit-tested (17 tests). The cluster calls are in `api.ts`.

**Files** (branch `kubeflow-trainer`, under `ui/pkg/aif-ui/`):
- `config/suseai.ts`, `product.ts`, `routing.ts`, `l10n/en-us.yaml`: the menu group and the route;
- `pages/Scheduling.vue`;
- `components/scheduling/{ReadinessTab,QueuesTab,ProjectsTab,RuntimesTab,JobsTab}.vue`, plus `sched.scss`;
- `services/scheduling/{model,api}.ts`, plus `__tests__/model.test.ts`.

Branch history:
1. upstream/main `ac9c4b0c` (2.4.0-rc.1)
2. Dave's commit, cherry-picked
3. the UI, uncommitted

**Checks:** vitest 580/580 (17 new); `yarn build-pkg aif-ui` passes; eslint has 0 errors (warnings are `any` types only).

## 8. Running the prototype

```sh
cd ui    # from the repo root
export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"
yarn build-pkg aif-ui && yarn serve-pkgs      # http://127.0.0.1:4500/aif-ui-2.4.0-rc.1/aif-ui-2.4.0-rc.1.umd.min.js
kubectl --context=kind-sims-nvidia-kft -n cattle-system port-forward svc/rancher 8443:443
```

In Rancher (https://localhost:8443): avatar > Preferences > Extension Developer Features. Then Extensions > ⋮ > Developer Load, and paste the URL. Open SUSE AI Factory > Workloads > Scheduling.

**From a notebook** (in a namespace with notebook access, SA `notebook`):

```python
!pip install "kubeflow==0.4.1" "aif-training @ git+https://github.com/dstanley/aif@prototype/kubeflow-trainer#subdirectory=sdk/aif-training"
from kubeflow.common.types import KubernetesBackendConfig
from kubeflow.trainer import CustomTrainer, TrainerClient
from aif_training import namespace_queue

client = TrainerClient(backend_config=KubernetesBackendConfig(namespace="aif-submit"))
job = client.train(runtime=client.get_runtime("aif-cpu"), trainer=CustomTrainer(func=train),
                   options=[namespace_queue(client)])
```

`lab/run.py` is the full example.

## 9. Step by step: train from a local Jupyter

You sign in to **Rancher with an API token**: no kubeconfig, and every call goes through Rancher's
proxy with your Rancher rights. The notebook is `lab/local-train.ipynb`; these are the steps around it.

**Admin, once per project** (SUSE AI Factory > Workloads > Scheduling):
1. **Readiness**: everything green. Use the two buttons if "Runtimes readable by every user" or "AI Trainer" is red.
2. **Queues & Quotas**: a queue for the project, e.g. `aif-submit` with a GPU quota.
3. **Projects**: pick the project, then **Enable training** on its namespace with that queue, and **Grant AI Trainer** to the user.

**User, once:**
1. Rancher > avatar > **Account & API Keys** > **Create API Key**. Scope: none, or the cluster. Copy the token
   (`token-xxxxx:yyyy`). It is shown once.
2. Know your cluster ID and namespace: Rancher's cluster ID is `local` for the local cluster, `c-xxxxx` for a
   downstream one (shown in the cluster's URL), and the namespace is the one the admin enabled.
3. A Python 3.10+ environment with Jupyter:
   ```sh
   python3 -m venv ~/aif-nb && source ~/aif-nb/bin/activate
   pip install jupyterlab "kubeflow==0.4.1" \
     "aif-training @ git+https://github.com/dstanley/aif@prototype/kubeflow-trainer#subdirectory=sdk/aif-training"
   ```
   The SDK version must match the cluster's Trainer: `kubeflow` 0.4.x for Trainer 2.2.

**User, each session:**
```sh
export RANCHER_URL=https://rancher.example.com
export CLUSTER_ID=local          # or c-xxxxx
export NAMESPACE=aif-submit
read -s RANCHER_TOKEN && export RANCHER_TOKEN   # paste the token; it is not echoed or kept in history
jupyter lab docs/kubeflow-trainer/lab/local-train.ipynb
```

Then run the cells top to bottom:

| Cell | What happens |
|---|---|
| Connect | Fetches Rancher's CA from `$RANCHER_URL/cacerts` (so TLS is verified with a private CA), builds a Kubernetes client for `$RANCHER_URL/k8s/clusters/$CLUSTER_ID` with `Authorization: Bearer <token>`, and lists the runtimes (`aif-cpu`, `aif-gpu`, `aif-share-4g`, `aif-share-8g`) |
| Training function | A small PyTorch MLP that learns two interleaved spirals (2,000 points, 300 epochs), printing loss and test accuracy every 50 epochs and saving the model to `$OUTPUT_DIR/spiral-mlp.pt`. It runs **on the cluster**: the SDK ships the function's source |
| Submit | `trainer.train(runtime=get_runtime("aif-cpu"), trainer=CustomTrainer(func=train), options=[namespace_queue(trainer)])`. `namespace_queue` puts the run in the namespace's KAI queue; without it the admission policy refuses the job |
| Follow | Waits for the run and prints its log. The run also shows in Scheduling > Training Jobs |

**Lab specifics** (Rancher through `kubectl port-forward svc/rancher 8443:443`): use `RANCHER_URL=https://localhost:8443`.
The port-forward reaches Rancher's own listener, whose certificate names `localhost`, so TLS verifies against Rancher's
CA without anything else. `RANCHER_TLS_SERVER_NAME` is only for a URL whose host isn't on the certificate: e.g. an
IP in front of an ingress whose certificate names `rancher.example.com`.

**Verified on the lab (2026-11-05)** as `trainer1` (standard user, AI Trainer in project `training`), signed in with
a Rancher API key, notebook executed top to bottom (`jupyter nbconvert --execute`):
- runtimes listed: `aif-cpu`, `aif-gpu`, `aif-share-4g`, `aif-share-8g`;
- TrainJob `b1505f878ad2` Complete, its pod placed by `kai-scheduler` with `kai.scheduler/queue=aif-submit`;
- the log reached test accuracy 0.995 at epoch 300, and `spiral-mlp.pt` was saved on the retained volume `outputs-<job>`.

**Processes per node.** torchrun starts one process per GPU, or for `aif-cpu` two (`PET_NPROC_PER_NODE=2`, set
by Trainer). A function without `DistributedDataParallel` runs once per process, so the example only logs and
saves on rank 0 (`RANK`). A real distributed run wraps the model in DDP instead.

**When it fails:**
- `401`: the token is wrong or expired.
- `403` on `clustertrainingruntimes`: Readiness "Runtimes readable by every user" is red.
- `403` on `namespaces`: you're not in the project.
- `403` on `trainjobs`: you don't hold AI Trainer.
- `ValueError … isn't managed by AI Factory` / `no valid queue`: training isn't enabled on the namespace.
- The job is refused at admission: the message names the rule, e.g. `this project's TrainJobs run in KAI queue …`.
- The job stays Pending: the queue is over quota, or no node fits. Scheduling > Training Jobs shows the scheduler's reason.

**From JupyterHub** (the target for many users, see `ENGINEERING.md` §4): the same notebook without the token cell.
The server runs in the cluster with a per-user service account, so the client is just
`KubernetesBackendConfig(namespace=NAMESPACE)`.

## 10. Open items

- Run a real GPU job on `aif-share-4g` / `aif-gpu`; needs a GPU cluster.
- A "launch a JupyterLab" action in the Projects tab: deploy a notebook with SA `notebook`, reachable through the Rancher service proxy.
- Test Kubeflow Notebooks with Istio (§6), if the customer wants them.
- Per-queue assigners (`aif-queue-assigner` with `resourceNames`), so project owners can manage their own queues.
- Report gaps 1 to 3 to Dave.
