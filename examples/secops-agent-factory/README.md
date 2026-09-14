# SecOps Agent Factory — reference Blueprints

Illustrative AI Factory Blueprints for the architecture described in
[`docs/architecture/sovereign-agentic-secops.md`](../../docs/architecture/sovereign-agentic-secops.md):
an autonomous vulnerability-remediation system built from NVIDIA Nemotron
models, AI-Q, the NIM Operator, the NVIDIA RAG Blueprint and OpenShell, packaged
and governed by SUSE AI Factory with NVIDIA.

**None of this has been installed end to end.** The cluster this was authored
against has simulated GPUs (`run.ai/fake.gpu=true`), so no model in these
blueprints has ever served a token. What follows is an honest ledger of what was
actually checked.

---

## Three Blueprints, and what is *not* in them

| | |
|---|---|
| `10-blueprint-openshell-gateway.yaml` | **SecOps OpenShell Gateway** — the governed execution substrate. Once per cluster |
| `11-blueprint-openshell-workspace.yaml` | **SecOps OpenShell Workspace** — namespace-scoped sandbox prerequisites. Once per tenant |
| `20-blueprint-secops-agent-factory.yaml` | **SecOps Agent Factory** — the application stack: embedding, guardrails, the vulnerability corpus, and the AI-Q workflow. Four components |

Everything else is an **app**, installed from AI Factory → Apps. That is not a
simplification for the sake of a smaller diagram; it is the convention the
product's own blueprints already follow. Both shipped NVIDIA blueprints in this
repo serve a Nemotron model and yet ship no LLM and no operator:

```
charts/aif-operator/files/blueprints/nvidia-aiq-with-rag-1.0.0.yaml
  → nvidia-blueprint-rag + aiq2-web        (2 components)
charts/aif-operator/files/blueprints/nvidia-rag-minimal-2-6-0.yaml
  → nvidia-blueprint-rag                   (1 component)
```

Both name the NIM Operator as a prerequisite and expect the model to exist. So:
**operators and the model plane come from Apps; the Blueprint carries the
application stack.** Each of these is a first-class entry in
`operator/internal/catalog/default-catalog.json`:

| App | Chart | Where it goes | Values |
|---|---|---|---|
| NVIDIA NIM Operator *(Supported)* | `k8s-nim-operator` 3.1.2 | cluster-wide | chart defaults |
| NVIDIA NIM for LLMs *(Supported)* | `nim-llm` 2.0.4-pb6.6 | `ns-secops-models`, release **`nemotron-ultra`** | [`apps/nim-llm-nemotron-ultra.values.yaml`](apps/nim-llm-nemotron-ultra.values.yaml) |
| NVIDIA NIM for LLMs *(Supported)* | `nim-llm` 2.0.4-pb6.6 | `ns-secops-models`, release **`nemotron-lightning`** | [`apps/nim-llm-nemotron-lightning.values.yaml`](apps/nim-llm-nemotron-lightning.values.yaml) |
| NeMo Data Store / Evaluator / Customizer | `nemo-*` 25.6.0 | `ns-secops-flywheel`, optional | [`apps/nemo-flywheel.values.yaml`](apps/nemo-flywheel.values.yaml) |

**The release names are part of the contract.** Every endpoint in blueprint 20
and in `configs/config_secops.yml` addresses the two models as
`nemotron-ultra.ns-secops-models` and `nemotron-lightning.ns-secops-models`.
Install them under different names and the agent plane starts cleanly and 404s
on its first call.

Two constraints are worth knowing before you try to reshape this further:

- **`Blueprint.spec.components` is a CEL list-map keyed on `chartName`**
  (`operator/api/v1alpha1/blueprint_types.go`, `+listMapKey=chartName`). Two
  components named `nim-llm` in one Blueprint are rejected by the API server, so
  Ultra and Lightning could never have shared a Blueprint. Installing them as
  apps makes that constraint moot rather than working around it.
- **There is no install ordering *within* a Blueprint.** The operator emits one
  Fleet HelmOp per component and Fleet applies them concurrently;
  `buildComponentMatrix` in
  `operator/internal/controller/aiworkload/blueprint.go` sorts components for
  status display only, and there is no `dependsOn` anywhere in the operator. So
  the four components of blueprint 20 come up together: `rag-server`
  crash-loops until the embedding NIM serves, and AI-Q restarts until
  `rag-server` answers. Both recover on their own, but a live demo will show a
  wall of red for a few minutes unless the apps are already up.

---

## What is verified, and what is not

| Claim | Status | How it was checked |
|---|---|---|
| All 3 Blueprint CRs are accepted by the API server | **verified** | `kubectl apply --dry-run=server` against a live AI Factory cluster — exercises the semver regex, the `source` enum, the `listMapKey=chartName` uniqueness constraint and the DNS-1123 length limits |
| All 3 follow the operator's naming convention | **verified** | the checks in `charts/aif-operator/tests/default-blueprints-convention.sh`, applied to this directory |
| The AIWorkload CRs are schema-valid | **partly** | one document dry-ran clean; the others fail only on `namespaces … not found`, which is a missing prerequisite, not a schema error |
| `config_secops.yml`, `secops_domain_catalog.yml`, `remediation-sandbox.yaml` are valid YAML | **verified** | `yq` |
| Every chart repo/name/version triple resolves | **verified** | the five ClusterRepos were checked against the live cluster; chart versions against the repo indexes |
| `nim-llm`, `k8s-nim-operator`, `nemo-*` and `aiq2-web` are catalog apps | **verified** | `operator/internal/catalog/default-catalog.json`; the first three are labelled `"supported"` |
| `k8s-nim-operator` 3.1.2 value keys | **verified** | `helm show values` (this chart is anonymously readable) |
| `nvidia-blueprint-rag` v2.6.0 value keys, including the NIM subchart list | **verified** | `helm show values`. The chart bundles `nim-llm`, `nim-vlm`, `nim-vlm-captioning`, `nvidia-nim-llama-nemotron-embed-1b-v2`, `-embed-vl-1b-v2`, `-rerank-1b-v2` and `-rerank-vl-1b-v2` — and no Nemotron 3 embedding model, which is why the embedding NIM is a separate component and the reranker is not |
| `aiq2-web` 2.2.1 value keys | **verified** | `helm show values`; also diffed against upstream `deploy/helm/deployment-k8s/values.yaml` at tag v2.2.0 — identical but for image tags |
| OpenShell chart value keys | **verified** | `helm show values oci://ghcr.io/nvidia/openshell/helm-chart` at the pinned version |
| OpenShell policy grammar (`rules`, `deny_rules`, `access`, `allow_encoded_slash`) | **verified** | read from `crates/openshell-policy/src/lib.rs` and `merge.rs` in the OpenShell source |
| Every AI-Q `_type` used in `config_secops.yml` exists | **verified** | read from upstream `NVIDIA-AI-Blueprints/aiq` at tag v2.2.0 |
| `nim-llm` 2.0.4-pb6.6 value keys | **UNVERIFIED** | NGC-gated (403 anonymous). Keys were taken from the same chart as rendered inside `nvidia-blueprint-rag` v2.6.0, where it appears as the `nimOperator.nim-llm` subchart. Keys marked `# UNVERIFIED:` inline could not be checked at all |
| `nvidia-nim-nemotron-3-embed-1b` and `nemo-*` value keys | **UNVERIFIED** | both repos NGC-gated. The embedding and guardrails `values:` blocks, and everything in `apps/nemo-flywheel.values.yaml`, are illustrative |
| NIM **image tags** for the Nemotron models | **UNVERIFIED** | placeholders. A wrong tag fails the NIM Operator's hardware-profile lookup with a message that does not mention the tag. Check the NGC catalog and pin an exact version |
| The SecOps sandbox image | **DOES NOT EXIST** | specified in `sandbox-image/`, not built |
| AI-Q driving a remote OpenShell gateway from Kubernetes | **NOT BUILT** | see the gap below |
| SUSE Observability chart versions, Service names and OTLP ports | **verified** | `suse-observability` 2.10.3 rendered locally; the collector Service is `<release>-otel-collector` with ports 4317 / 4318 / 8888 |
| SUSE Security chart versions and the controller API surface | **verified** | `rancher-charts` catalog index on a live cluster (`110.0.1+up2.11.1`); the REST paths from SUSE and NeuVector documentation |
| SUSE Application Collection Python index and `index-url` exclusivity | **verified** | SUSE Distribution Platform setup notes; 809 packages listed at apps.rancher.io/libraries |
| The individual package names in `sandbox-image/requirements.txt` | **UNVERIFIED** | the index search is client-side; only `aiohttp`, `anyio`, `attrs`, `asyncssh` were observed directly |
| OpenShell injecting the SUSE Security API key at the egress boundary | **UNVERIFIED** | the policy grammar is real; the gateway-side secret plumbing for this endpoint was not traced |
| Any of the three SUSE integrations running | **NOT RUN** | neither SUSE Security nor SUSE Observability is installed on the authoring cluster |

---

## The engineering gap

Two things in here are designed rather than shipped, and they are the two that
matter most.

**1. AI-Q → OpenShell on Kubernetes.** NVIDIA's AI-Q 2.2 operator guide
(`docs/source/deployment/openshell.md`) certifies OpenShell **0.0.88** and the
**Docker** runtime path. The stock `nvcr.io/nvidia/blueprint/aiq-agent:2.2.x`
image ships no OpenShell client SDK and no gateway-registration step. Blueprint
20 configures the remote-gateway mode the same guide documents, but
configuration is not the whole job — an aiq-agent image with the SDK, a
registration step, and validation of the Kubernetes sandbox driver are all
missing.

**2. A gateway version that can do both.** Chart 0.0.88 — the one AI-Q certifies
— was inspected on ghcr.io and has no `workspaceMode`, no
`operatorNamespaceLabel`, no `workspaceResources` and no
`policyValidationFailureMode`. The shared-gateway, one-namespace-per-tenant
topology this architecture needs cannot be built on it. Those keys arrive later:
`workspaceMode` and `policyValidationFailureMode` by 0.0.116,
`workspaceResources` only in dev builds after that. Relatedly, the companion
`openshell-workspace` chart has **only dev tags** — no numbered release exists.

Neither gap is hidden in these files; both are written at the top of the
blueprint they affect. NVIDIA's guide is also the reason the gap is worth
closing in a Blueprint rather than in application code:

> OpenShell is an external runtime and authentication boundary, not merely a
> Python dependency: an operator must own the gateway service, registration,
> credentials, version, and availability.

An AI Factory Blueprint is exactly that operator.

---

## Layout

| File | What it is |
|---|---|
| `00-clusterrepos.yaml` | The five NGC / ghcr.io ClusterRepos. Normally already present on an AI Factory cluster |
| `10-blueprint-openshell-gateway.yaml` | OpenShell gateway — the governed execution substrate |
| `11-blueprint-openshell-workspace.yaml` | Per-namespace sandbox prerequisites; install once per tenant |
| `20-blueprint-secops-agent-factory.yaml` | The stack: Nemotron 3 Embed, NeMo Guardrails, NVIDIA RAG v2.6.0 over a CVE / advisory / SBOM corpus, and AI-Q 2.2 running the SecOps workflow |
| `30-aiworkloads.yaml` | The install set, in dependency order. Do not apply as one unit |
| `apps/` | Helm values for the charts installed from AI Factory → **Apps**, not as Blueprints: the two Nemotron tiers and the NeMo flywheel |
| `configs/config_secops.yml` | The AI-Q workflow. Adapted from upstream `config_openshell.yml` |
| `configs/secops_domain_catalog.yml` | Domain catalog for source routing — how the SecOps specialization is declared |
| `policies/remediation-sandbox.yaml` | The OpenShell sandbox policy. **This file is the security boundary** |
| `integrations/README.md` | The three SUSE platform integrations — Security, Observability, Application Collection. **Configuration, not installation** |
| `integrations/suse-security-prereq.md` | What the customer installs and configures on the SUSE Security side before any of this works |
| `integrations/otel-instrumentation.yaml` | `Instrumentation` CR pointing the agent namespace at the customer's SUSE Observability collector |
| `sandbox-image/` | Specification for the remediation sandbox container — Containerfile, curated `requirements.txt`, `uv.toml`. **The image does not exist** |

### Installed here vs assumed present

Three SUSE products appear all over the architecture diagrams and **none of them
is installed by these Blueprints**:

| Product | Who installs it | What this directory contributes |
|---|---|---|
| SUSE Security (NeuVector) | the customer, via Rancher **Cluster Tools** | the four API calls the agents may make, and the explicit denial of everything else (`policies/remediation-sandbox.yaml`, network policy `suse_security`) |
| SUSE Observability | the customer, from `charts.rancher.com/server-charts/prime/suse-observability` | the OTLP endpoints in blueprints 10 and 20, plus an `Instrumentation` CR |
| SUSE Application Collection | nothing to install — it is a registry | the exclusive Python `index-url`, the `uv.toml`, and the narrowed egress rule that makes the curation enforceable |

That separation is deliberate. A platform team that already runs SUSE Security
does not want an agent Blueprint installing a second copy of it, and an
architecture that can only work if it owns the whole cluster is not one anybody
adopts incrementally. What is genuinely new here is the *integration*, and that
is what these files carry.

---

## Prerequisites

Cluster-wide, before anything here:

- **NVIDIA GPU Operator**, installed from the SUSE AI Factory release manifest
  (v26.3.1, precompiled driver 595 from `registry.suse.com/third-party/nvidia`).
  Do not install a second copy.
- **NVIDIA NIM Operator** (`k8s-nim-operator` 3.1.2), from AI Factory → Apps.
  Wait for the Deployment to be Available and the `NIMService`/`NIMCache` CRDs to
  be established.
- **The two Nemotron NIMs**, from AI Factory → Apps, with the exact release names
  in the table above. A 550B-A55B orchestrator tier does not fit the single-card
  footprint that examples like "NVIDIA RAG (minimal, low-GPU)" target — see the
  sizing profiles in the architecture document for the downgrade path.
- **Elasticsearch (ECK) Operator** — RAG v2.6.0 defaults its vector store to
  Elasticsearch, not Milvus.
- **Kubernetes Agent Sandbox CRDs and controller**:
  ```
  kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.0/sandbox-with-extensions.yaml
  ```
- A default **StorageClass**, or sandbox and model PVCs stay Pending.
- An **OIDC provider**. Unlike the prototype in `examples/openshell/`, blueprint
  10 does not enable `allowUnauthenticatedUsers`, because an unauthenticated
  gateway makes every caller a Platform Admin — and a Platform Admin can rewrite
  the policy governing a sandbox that holds a write credential.
- **SUSE Security**, installed through Rancher Cluster Tools, with **registry
  scanning enabled** and an API key stored as the Secret
  `openshell-suse-security-api`. This is a hard dependency of the validation
  loop, not a nice-to-have: without a scanner that is not the agent, a
  remediation is an assertion. See
  [`integrations/suse-security-prereq.md`](integrations/suse-security-prereq.md).
- **SUSE Observability**, release name `suse-observability`, with the agent
  installed on the cluster. The release name is load-bearing — the collector
  Service is `<release>-otel-collector`, and it is hard-coded in both blueprints
  that emit spans. See [`integrations/README.md`](integrations/README.md).
- A **SUSE Application Collection** (Distribution Platform) account and token.
  Needed to build the sandbox image, and for the shipped SUSE blueprints that
  pull charts from `oci://dp.apps.rancher.io/charts`.

Namespaces, labels and secrets: see the header of `30-aiworkloads.yaml` and the
`REQUIRES:` blocks in each blueprint's `description`. The failures from missing
prerequisites are consistently unhelpful — a missing namespace label surfaces as
"sandbox create failed" with no mention of labels.

---

## Install order

Apply one document at a time and wait for Ready. The ordering is not cosmetic:

1. `00-clusterrepos.yaml` (if the repos are not already there)
2. **Apps**: NIM Operator → Ready, CRDs established; then ECK; then the two
   `nim-llm` releases. The Ultra tier pulls a 550B model, so expect the NIMCache
   to take a long time before the NIMService is ever Ready
3. Namespaces, labels, the `aiq-credentials` Secret and the two ConfigMaps
4. Blueprint 10, then 11 → **before** the agent factory. Sandbox configuration is
   validated at first use, not at startup, so installing the agents first gives
   you a system that looks healthy and fails on the first remediation
5. Blueprint 20
6. Optionally, the NeMo flywheel apps — last, and only after remediations have
   been running for a while. Read the deprecation notice first

---

## Deprecation

`apps/nemo-flywheel.values.yaml` and the `nemo-guardrails` component of blueprint
20 use NeMo Microservices charts, which NVIDIA **sunsets on 1 October 2026** in
favour of NeMo Platform (`github.com/NVIDIA-NeMo/nemo-platform` — a single
all-in-one chart with embedded OPA). Build against NeMo Platform; use the
flywheel values as a description of the loop, not as an install target.
