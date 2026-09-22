# Quickstart — SecOps Agent Factory, zero-GPU profile

A step-by-step install path. [`README.md`](README.md) is the reference: it explains *why* every
choice below is what it is, and it is where you go when a step fails. This file is only the order
of operations.

Budget about **90 minutes**, most of it waiting — the first llama.cpp start pulls ~2.4 GB of GGUF.

---

## What you need before you start

**Two clusters, both registered in Rancher.**

| Role | What runs there | Referred to below as |
|---|---|---|
| **Primary** | Rancher, the AI Factory operator. All `ClusterRepo`, `Blueprint` and `AIWorkload` CRs are applied here. | `<primary-context>` |
| **Managed** | Everything that does work: the models, Qdrant, Gitea, the OpenShell gateway and every agent sandbox. | `<managed-context>` |

`<primary-context>` and `<managed-context>` are your own kubectl context names — substitute them
everywhere. Nothing in this profile assumes a particular Kubernetes distribution, container runtime
or host OS.

**Both clusters must satisfy:**

- [ ] Rancher-managed, and the managed cluster registered (it needs a Rancher cluster ID)
- [ ] The AI Factory operator installed on the primary, with the `Blueprint` and `AIWorkload` CRDs
- [ ] **>= 12 GB allocatable memory** on the managed cluster, and **no reliance on swap** — the
      profile is sized so that an overcommit is an OOM kill, not a slowdown:
      ```sh
      kubectl --context <managed-context> get nodes \
        -o custom-columns='NODE:.metadata.name,ALLOC-MEM:.status.allocatable.memory'
      ```
- [ ] A default `StorageClass` on the managed cluster supporting `ReadWriteOnce`. ~21 Gi total is
      claimed. The profile does **not** need `ReadWriteMany`.
- [ ] Node architecture matching the published images. The sandbox image is currently `linux/arm64`
      only — on amd64 nodes it schedules and then dies with an exec-format error. See the
      `sandboxImage` note in [`10-blueprint-openshell-gateway.yaml`](10-blueprint-openshell-gateway.yaml).
- [ ] `kubectl`, `helm`, `jq` and the `openshell` CLI on your workstation

**You do not need:** a LoadBalancer provider, an ingress controller on the managed cluster, or any
GPU. Every UI below is reached with `kubectl port-forward`.

---

## Step 1 — SUSE Security on both clusters

The agents cannot run without it: SUSE Security is the oracle at both ends of the remediation loop,
and with it absent the pipeline reports a flawless estate.

Follow [`integrations/suse-security/README.md`](integrations/suse-security/README.md) end to end —
it is a federation, so it is two installs plus a join handshake, and it has its own traps.

Then **turn workload auto-scan on** in the managed cluster's NeuVector UI. It defaults to OFF, and
with it off every finding query returns an empty set while answering `200`. This is the single most
convincing wrong answer the profile can produce.

**Verify** — from a pod on the managed cluster, the endpoint the sandbox policies name must answer:

```sh
kubectl --context <managed-context> -n default run nv-probe --rm -it --restart=Never \
  --image=registry.suse.com/bci/bci-base:16.0 -- \
  curl -sk https://neuvector-svc-controller-api.cattle-neuvector-system:10443/v1/eula
```

Any HTTP response proves the seam. A DNS failure means `controller.apisvc.type` was not set.

---

## Step 2 — ClusterRepos, on the primary

Blueprint components resolve a chart repo by the **name** of a Rancher `ClusterRepo`, and the
operator resolves it with its own client — so this goes on the primary even though every chart
lands on the managed cluster.

```sh
kubectl --context <primary-context> apply -f 00-clusterrepos.yaml
kubectl --context <primary-context> get clusterrepo
```

**Verify:** all three report `Downloaded`.

---

## Step 3 — Prerequisites on the managed cluster

```sh
# Agent-sandbox CRDs and controller. NOT a Blueprint component -- agent-sandbox
# ships raw YAML, and Blueprint components are chart-only.
kubectl --context <managed-context> apply -f \
  https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.0/sandbox-with-extensions.yaml

# Namespaces. The sandbox namespace MUST carry the label the gateway watches --
# a missing label surfaces as "sandbox create failed" with no mention of labels.
for ns in openshell ns-secops-sandboxes ns-secops-cpu ns-secops-forge; do
  kubectl --context <managed-context> create namespace $ns
done
kubectl --context <managed-context> label namespace ns-secops-sandboxes \
  ai-factory.suse.com/openshell-workspace=true

# Gitea's admin credentials, BEFORE the chart installs -- it otherwise ships a
# well-known password in plain text. Exactly two keys are read.
kubectl --context <managed-context> -n ns-secops-forge create secret generic gitea-admin-secret \
  --from-literal=username=gitea_admin \
  --from-literal=password="$(openssl rand -base64 24)"
```

**Verify:** `kubectl --context <managed-context> get crd | grep sandbox` lists the agent-sandbox
CRDs, and the four namespaces exist with the label on `ns-secops-sandboxes`.

---

## Step 4 — Set your Rancher cluster ID

`30-aiworkloads.yaml` targets the managed cluster by its **Rancher cluster ID**, which is generated
at registration and is not the kubectl context name. The committed value is one environment's.

```sh
kubectl --context <primary-context> get clusters.management.cattle.io \
  -o custom-columns='ID:.metadata.name,NAME:.spec.displayName'
```

Put your managed cluster's ID into all three `targetClusters:` entries in
[`30-aiworkloads.yaml`](30-aiworkloads.yaml).

Two other places carry environment-specific Rancher values. Fix them now, before the charts install:

- `charts/secops-cpu-agents/values.yaml` → `rancher.serverHost`, `rancher.serverPort`,
  `rancher.clusterId`
- `integrations/suse-security/*.values.yaml` → `global.cattle.*` (done in step 1)

---

## Step 5 — The gateway and the workspace

Order matters. Sandbox configuration is validated at first use, not at startup, so installing the
agent plane first gives you a system that looks healthy and fails on the first sandbox.

```sh
kubectl --context <primary-context> apply -f 10-blueprint-openshell-gateway.yaml
kubectl --context <primary-context> apply -f ../openshell/20-blueprint-openshell-workspace.yaml

# Document 1 of 30-aiworkloads.yaml -- the gateway.
# Wait for Ready before applying document 2.
```

**Verify, and `Running` is not sufficient** — Fleet can silently drop the chart version pin:

```sh
kubectl --context <managed-context> -n openshell get pods
helm --kube-context <managed-context> list -n openshell     # confirm the pinned version
```

For a downstream target the HelmOp lands in **`fleet-default`**, not `fleet-local`, and the operator
appends the Fleet cluster ID to the instance name.

Then apply document 2 (the workspace) and wait for it in turn.

---

## Step 6 — Copy the gateway's client TLS secret

The gateway's PKI job has now run, so `openshell-client-tls` exists. The agent plane needs it in its
own namespace:

```sh
kubectl --context <managed-context> -n openshell get secret openshell-client-tls -o yaml \
  | sed 's/namespace: openshell/namespace: ns-secops-cpu/' \
  | kubectl --context <managed-context> apply -f -
```

---

## Step 7 — Register providers with the gateway

**Everything here is workspace-scoped.** Omit `--workspace` and the sandboxes see nothing, with no
error to say so. `<gw>` is your gateway address.

First the shared inference route:

```sh
openshell -g <gw> --workspace ns-secops-sandboxes provider create \
  --name llamacpp-shared --type openai \
  --credential OPENAI_API_KEY=unused \
  --config OPENAI_BASE_URL=http://secops-cpu-llm.ns-secops-cpu.svc.cluster.local:8000/v1
openshell -g <gw> --workspace ns-secops-sandboxes inference set \
  --provider llamacpp-shared --model qwen3-4b --no-verify
```

Then the three custom providers. OpenShell has no builtin profile for any of them, so each needs
`provider profile import` before `provider create`:

```sh
cd integrations/openshell-profiles
for p in suse-security git-forge app-collection; do
  openshell -g <gw> --workspace ns-secops-sandboxes provider profile import --file $p.yaml
done
```

**SUSE Security.** Mint the key in the managed cluster's NeuVector UI under *Settings → Users, API
Keys & Roles*, with the **admin** role — deliberately, see the note in
[`integrations/openshell-profiles/suse-security.yaml`](integrations/openshell-profiles/suse-security.yaml).
The credential format is `<key name>:<key secret>`, not a bearer token:

```sh
openshell -g <gw> --workspace ns-secops-sandboxes provider create \
  --name suse-security --type suse-security --credential NEUVECTOR_API_KEY="<name>:<secret>"
```

**Git forge.** The `secops-bot` token — you mint this in step 9, so come back for it.

**Application Collection.** The credential already exists in the cluster, as the
`application-collection` Secret in `aif-operator` on the primary. **Move it, do not retype it**, and
do not let it reach your terminal:

```sh
APPCO_BASIC=$(kubectl --context <primary-context> -n aif-operator \
  get secret application-collection -o jsonpath='{.data.user} {.data.token}' |
  { read -r u t; printf '%s:%s' "$(printf %s "$u" | base64 -d)" \
                                "$(printf %s "$t" | base64 -d)" | base64 | tr -d '\n'; })
openshell -g <gw> --workspace ns-secops-sandboxes provider create \
  --name app-collection --type app-collection --credential APPCO_BASIC="$APPCO_BASIC"
unset APPCO_BASIC
```

> `--credential` puts the secret in the CLI's argv, where it is visible in `ps` for the life of the
> command. That is the interface OpenShell offers. It is a one-time step on an operator's
> workstation and the credentials never reach a manifest, a chart or a sandbox — but do not run it
> on a shared jump host.

---

## Step 8 — The stack

```sh
kubectl --context <primary-context> apply -f 20-blueprint-secops-cpu.yaml
# then document 3 of 30-aiworkloads.yaml
```

This installs three charts — `secops-cpu-inference` 0.1.2, `secops-cpu-knowledge` 0.1.4,
`secops-cpu-agents` 0.3.8.

The first llama.cpp start pulls ~2.4 GB of GGUF. The startup probe allows 20 minutes for it, and
the PVC means it happens once rather than on every restart.

**The orchestrator will CrashLoopBackOff until step 9 finishes.** That is expected — it is waiting
for `secops-gitea-token`, which cannot be minted until Gitea is up and seeded.

**Verify:**

```sh
kubectl --context <managed-context> -n ns-secops-cpu get pods
curl -s localhost:8000/v1/models   # behind a port-forward to svc/secops-cpu-llm
```

---

## Step 9 — Seed Gitea and hand the orchestrator its token

Follow the **Seeding Gitea** section of [`README.md`](README.md). It is seven scripted steps and
each one matters — in particular:

- **Branch protection with a merge whitelist**, not `enable_push: false`. The latter locks out the
  admin too and the repository can never be seeded or corrected.
- **Create the approval labels up front.** Gitea offers a reviewer only labels the repository
  already has, so without them human gate #1 is a plan issue with no way to approve it, and the
  orchestrator polls silently until its 30-minute timeout.

Then the token, as a **file**, never an environment variable:

```sh
kubectl --context <managed-context> -n ns-secops-cpu create secret generic secops-gitea-token \
  --from-literal=token="<token>"
kubectl --context <managed-context> -n ns-secops-cpu rollout restart deploy/secops-cpu-orchestrator
```

Register it with the gateway too — this is the `git-forge` provider deferred from step 7:

```sh
openshell -g <gw> --workspace ns-secops-sandboxes provider create \
  --name git-forge --type git-forge --credential GITEA_TOKEN="<token>"
```

**Verify:** the orchestrator leaves CrashLoopBackOff and its status page answers.

---

## Step 10 — Run it

Port-forward the two surfaces you need in front of an audience:

```sh
kubectl --context <managed-context> -n ns-secops-forge port-forward svc/gitea-http 3000:3000 &
kubectl --context <managed-context> -n ns-secops-cpu port-forward svc/secops-cpu-orchestrator 8088:8080 &
```

- Gitea — <http://localhost:3000> — both human gates happen here
- Orchestrator status — <http://localhost:8088>, and `/api/state` for JSON

The pipeline is twelve steps with three human gates. See **The three human gates** in
[`README.md`](README.md) for what you are being asked to approve and why.

To reset between runs: [`reset-demo.sh`](reset-demo.sh). It refuses rather than cleans if a run is
still in flight.

---

## When something fails

| Symptom | Almost always |
|---|---|
| `sandbox create failed`, no mention of labels | the `ai-factory.suse.com/openshell-workspace=true` label is missing from `ns-secops-sandboxes` |
| Sandbox pods die in `Init:StartError` | supervisor image tag mismatch — it must move in lockstep with the gateway chart version |
| `ErrImageNeverPull` | `sandboxImagePullPolicy` is `Never` from an older gateway blueprint |
| exec-format error on a sandbox | node architecture does not match the sandbox image |
| Run reports zero findings, cheerfully | NeuVector workload auto-scan is off (step 1) |
| Orchestrator CrashLoopBackOff | `openshell-client-tls` or `secops-gitea-token` missing (steps 6 and 9) |
| AIWorkload stalls, ClusterRepo "not ready" | `00-clusterrepos.yaml` went to the managed cluster instead of the primary |
| Policy denial for `inference.local` | the URL is `http://`; it must be `https://` |
| NeuVector SSO returns 401 | Rancher's `server-url` is a port-forward — see `integrations/suse-security/README.md` |
| Chart fix had no effect | `perHelmOpRenderDigest` hashes the version, not the content. Bump `chartVersion`. |

[`README.md`](README.md) has the long-form version of each of these, plus the five bugs the first
live runs found.
