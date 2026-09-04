# NVIDIA OpenShell as SUSE AI Factory Blueprints (prototype)

Status: **prototype**. Blueprint version 0.1.0 was verified end-to-end on a live cluster.
Version 0.2.0 — the current files — changes the Helm release name and drops two workarounds
that change made unnecessary; that change has now been **verified live** (both charts
installed from the UI onto a downstream cluster, and `sandbox connect` succeeding — see
[Known gaps](#14-known-gaps) #11). The split of Blueprint C into per-tenant and shared
variants, and its smaller default model, are **not** yet run live. Everything under
[Blueprint values vs gateway runtime state](#5-blueprint-values-vs-gateway-runtime-state)
and after is design and reference material, not a transcript. Not production-ready — see
[Known gaps](#14-known-gaps).

This document describes how NVIDIA [OpenShell](https://github.com/NVIDIA/OpenShell) is
delivered through the AI Factory operator as **Blueprints**, and records the demonstration
that was run against a real cluster.

- Blueprint A — **OpenShell Gateway**, installed once per cluster.
- Blueprint B — **OpenShell Workspace**, installed once per tenant namespace.
- Blueprint C — **OpenShell Inference (Ollama)**, optional, in two variants: **C1
  per-tenant** (an engine in each tenant namespace, for isolation) and **C2 shared** (one
  engine in `openshell`, for efficiency). Gives sandboxes a model to route
  `inference.local` at.

Everything runs on the **released aif-operator 2.2.0**. No operator code change is
required; the entire *Helm* half of the integration is expressed in Blueprint values. The
other half — providers, policies, workspaces, inference routing — is gateway runtime state
and is applied with the CLI. §5 draws that line precisely; it is the most important section
in this document.

For a linear runbook — Rancher + AI Factory already installed → blueprints installed through
the AI Factory UI → an end user in a shell inside a sandbox talking to a model — see
[`openshell-demo.md`](./openshell-demo.md). This document is the design rationale.

---

## 1. Why two blueprints

OpenShell publishes two Helm charts:

| OCI chart | Chart.yaml `name` | Scope |
|---|---|---|
| `oci://ghcr.io/nvidia/openshell/helm-chart` | `helm-chart` | The gateway: StatefulSet, Service, TLS/JWT cert-gen jobs, config |
| `oci://ghcr.io/nvidia/openshell/openshell-workspace` | `openshell-workspace` | Namespace-scoped prerequisites only: sandbox ServiceAccount, Role, RoleBinding, NetworkPolicy |

The gateway chart can also emit the workspace resources itself
(`workspaceResources.enabled=true`), which produces a **single-tenant** deployment: one
gateway that only ever runs sandboxes in its own namespace.

For multi-tenancy OpenShell offers `workspaceMode: operator`: **one** gateway serves
**many** pre-provisioned namespaces, and an OpenShell *workspace name* maps 1:1 to a
*Kubernetes namespace* of the same name. That maps cleanly onto two blueprints — the
gateway installed once, the per-namespace prerequisites installed once per tenant.

```
                        ┌──────────────────────────────┐
 Blueprint A (once) ───▶│ namespace: openshell         │
                        │  StatefulSet openshell       │
                        │  SA openshell  ◀─────────┐   │
                        └──────────────────────────┼───┘
                                    │ watches ns   │ RoleBinding subject
                                    │ label        │
             ┌──────────────────────┼──────────────┼─────────────────────┐
             ▼                      ▼              │                     ▼
   ┌────────────────────┐  ┌────────────────────┐  │           ┌────────────────────┐
   │ ns: tenant-a       │  │ ns: tenant-b       │  │           │ ns: tenant-N       │
   │  SA openshell-     │  │  SA openshell-     │  │           │  ...               │
   │     sandbox        │  │     sandbox        │  │           │                    │
   │  Role/RoleBinding ─┼──┼─Role/RoleBinding ──┼──┘           │                    │
   │  NetworkPolicy     │  │  NetworkPolicy     │              │                    │
   │  Pod demo-a        │  │  Pod demo-b        │              │                    │
   └────────────────────┘  └────────────────────┘              └────────────────────┘
     Blueprint B (per tenant)
```

### Blueprint C ships in two variants

The inference engine is optional and comes as **two** blueprints deploying the same chart
and the same model, differing in where the engine lives:

| | C1 — per-tenant | C2 — shared |
|---|---|---|
| File | `40-…-ollama-tenant.yaml` | `41-…-ollama-shared.yaml` |
| Namespace | the wizard's (the tenant's) | pinned to `openshell` |
| URL | `http://ollama.<tenant>.svc.cluster.local:11434/v1` | `http://ollama.openshell.svc.cluster.local:11434/v1` |
| Installs | once per tenant | once per cluster |
| Model copies | one per tenant (~400 MB each) | one |
| `persistentVolume` | `false` — no StorageClass needed | `true` — long-lived infrastructure |
| `resources` | unset | requests/limits set; it is a shared dependency |
| Noisy neighbour | none | tenants share one queue |
| Lifecycle | dies with the tenant namespace | outlives any tenant |

**Which one a tenant actually uses is decided by `OPENAI_BASE_URL` in its provider, not by
what is installed.** A cluster can run both — isolation-sensitive tenants get C1, the rest
point at C2 — and because inference routing hot-reloads in ~5 s, moving a tenant between
them is two CLI commands with no sandbox restart.

Three facts make either shape work, all verified in source:

1. **The sandbox pod makes the upstream call, not the gateway.**
   `openshell-supervisor-network` fetches the inference route bundle from the gateway over
   gRPC every ~5 s (`crates/openshell-supervisor-network/src/inference_routes.rs`,
   `DEFAULT_ROUTE_REFRESH_INTERVAL_SECS = 5`) and its own proxy forwards the request. So the
   engine is reached *from* the tenant namespace — which is why co-locating it there (C1)
   keeps the hop intra-namespace, and why reaching across to `openshell` (C2) is an ordinary
   ClusterIP call.
2. **Nothing blocks the cross-namespace case.** The workspace chart's NetworkPolicy is
   Ingress-only with podSelector `openshell.ai/managed-by: openshell` on port 2222 — it adds
   no egress rules. Sandbox policy needs no rule either: `inference.local` is a built-in
   supervisor route, never evaluated against `network_policies` (§8).
3. **Providers and inference routes are workspace-scoped** (§7), so per-tenant routing is
   available regardless of which variant backs it.

Both stay *separate* Blueprints from B rather than components of it, so a tenant can opt out
of inference or switch variants, and so a cluster that already has an engine is not forced to
deploy another. Merging would work — `reconcileBlueprintStatus` fans components out with **no
ordering and no wait-for-ready**
(`operator/internal/controller/aiworkload/blueprint.go:86`), and the components are
independent — it would just remove the choice.

The default model is `qwen2.5:0.5b` (~400 MB, Apache-2.0), chosen so that C1's one-copy-per-
tenant cost stays affordable. It is weak at tool calling: it proves the routing path, not an
agent loop. Stepping up is cheap on C2 and expensive on C1 — `qwen2.5:1.5b` is also
Apache-2.0, while `3b` is under the Qwen Research License.

---

## 2. Does the Fleet delivery path work for OpenShell?

Yes, unchanged. Three properties of the AIWorkload controller make it work
(line numbers against `operator/internal/controller/aiworkload/blueprint.go`):

1. **`spec.defaultNamespace`, not `spec.namespace`** (`:380`, and `:936` on the GitOps
   path). Fleet's `namespace` field would force *every* rendered object into one namespace
   and break cluster-scoped resources; `defaultNamespace` only supplies a default, so the
   workspace chart's namespaced objects and the gateway's cluster-scoped
   ClusterRole/ClusterRoleBinding both render correctly.

2. **`disablePreProcess: true`** (`:297`, `:884`) stops Fleet from interpolating `${...}`
   sequences in values, which OpenShell's config templates contain.

3. **No ClusterRepo allowlist.** `resolveClusterRepo` (`:1068`) resolves a component's
   `chartRepo` to *any* ClusterRepo by name and reads only `spec.url` / `spec.ociRepo`. The
   Settings controller happens to auto-create four repos, but a hand-made one works
   identically. For OCI repos the chart reference is built as `<spec.url>/<chartName>`
   (`:315`, `:893`).

---

## 3. Files

```
examples/openshell/
  00-clusterrepo.yaml                             # ClusterRepo "openshell" → oci://ghcr.io/nvidia/openshell
  10-blueprint-openshell-gateway.yaml             # Blueprint A — gateway
  20-blueprint-openshell-workspace.yaml           # Blueprint B — per-tenant prerequisites
  30-aiworkloads-demo.yaml                        # the demo installs from §12, ready to apply
  40-blueprint-openshell-inference-ollama-tenant.yaml   # Blueprint C1 — engine per tenant ns
  41-blueprint-openshell-inference-ollama-shared.yaml   # Blueprint C2 — one shared engine
  policies/
    README.md                                     # the three policy layers, and which wins
    global-baseline.yaml                          # gateway-wide floor  (policy set --global)
    tenant-suse-ai.yaml                           # per-sandbox: SUSE registries, PyPI, npm, regex redaction
    claude-code-l7.yaml                           # L7-inspected claude_code rule — the provider-attach fix
  providers/
    README.md                                     # profiles vs instances; the two wiring recipes
    suse-litellm-profile.yaml                     # custom profile for direct sandbox → LiteLLM access
docs/
  openshell-blueprints.md                         # this file — design rationale
  openshell-demo.md                               # end-to-end runbook, UI install included
```

The Blueprints live in `examples/` rather than `charts/aif-operator/files/blueprints/` on
purpose: the bundled-files directory ships to *every* chart install, and this prototype
enables `server.auth.allowUnauthenticatedUsers`. Productising means moving them (and
turning that flag off first).

The `policies/` and `providers/` files are **not** Blueprint material at all — they are
gateway runtime state applied with the OpenShell CLI. See §5.

---

## 4. Wiring the two charts together: one release name

The gateway chart names nearly everything after the Helm release, and the workspace chart
has to reference those names from another namespace. Getting them to agree is the whole
problem, and it is solved by a single value on Blueprint A's component:

```yaml
components:
  - chartRepo: openshell
    chartName: helm-chart
    releaseName: openshell        # ← this line
```

`BlueprintComponent.releaseName` (`operator/api/v1alpha1/blueprint_types.go:99`, consumed by
`componentReleaseName`, `blueprint.go:1265`) pins the Helm release name. Without it the
controller derives the release from `chartName`, and OpenShell's gateway chart is literally
named `helm-chart` in its `Chart.yaml` — so the release would be called `helm-chart`.

With `releaseName: openshell`, tracing through
`deploy/helm/openshell/templates/_helpers.tpl`:

- `openshell.fullname` short-circuits (`contains "openshell" "openshell"` is true) → every
  gateway object is named `openshell`, including the ServiceAccount. **No
  `fullnameOverride` needed.**
- `openshell.selectorLabels` → `app.kubernetes.io/instance: openshell`, which is exactly the
  workspace chart's *default* NetworkPolicy podSelector. **No podSelector override needed.**
- The gateway's own `managed_ssh_ingress.gateway_pod_selector` derives from the same labels,
  so both sides agree by construction rather than by two matching overrides.

The Fleet HelmOp name is `blueprintBundleName(workloadName, chartName)`
(`operator/internal/controller/aiworkload/keys.go:21`) — built from the **chart** name, not
the release name — so it is unaffected and there is no collision risk.

Verified by rendering both charts offline at the pinned dev SHA. Gateway, release
`openshell`, no `fullnameOverride`:

```toml
[openshell.drivers.kubernetes.managed_ssh_ingress]
gateway_pod_selector = { "app.kubernetes.io/name" = "openshell", "app.kubernetes.io/instance" = "openshell" }
```

Workspace chart, with the podSelector override **removed**:

```yaml
ingress:
  - from:
      - namespaceSelector:
          matchLabels: { kubernetes.io/metadata.name: openshell }
        podSelector:
          matchLabels:
            app.kubernetes.io/instance: openshell
            app.kubernetes.io/name: openshell
    ports:
      - { protocol: TCP, port: 2222 }
```

Exact match.

### 4.1 Why this used to be three problems

Blueprint 0.1.0 did not use `releaseName`, and paid for it three times. Recorded because
the reasoning is worth keeping, and because anyone reading an older Blueprint will meet it.

1. **Object naming.** Release `helm-chart` made `openshell.fullname` produce
   `helm-chart-openshell`. Worked around with `fullnameOverride: openshell`.
2. **The RoleBinding subject.** `openshell-workspace` grants the *gateway's* ServiceAccount
   sandbox CRUD in the tenant namespace, defaulting the subject to `openshell` in namespace
   `openshell`. Fix 1 made that match; without it every sandbox create failed with a
   permission error.
3. **The NetworkPolicy podSelector — the silent one.** The workspace chart's default
   `instance` selector is `openshell`, but the label carries the *release* name,
   `helm-chart`. The selector matched zero pods and silently blocked the gateway from
   reaching every sandbox on :2222 — `sandbox exec` (gRPC) kept working, only `sandbox
   connect` (SSH) broke. Worked around by setting the override to `helm-chart` on both
   sides.

Problem 2's consequence survives: because the workspace chart hardcodes a *namespace* for
the RoleBinding subject, **Blueprint A still pins `targetNamespace: openshell`** rather than
taking the namespace from the install wizard.

### 4.2 Also pinned: supervisor sideload method

The chart picks `image-volume` vs `init-container` from `.Capabilities.KubeVersion`
(`semverCompare ">=1.35-0"`). `helm template` reports a default capability rather than the
live cluster's version, which makes local rendering disagree with the deployed result.
Blueprint A pins `supervisor.sideloadMethod: init-container`. Drop the pin on
Kubernetes ≥ 1.35.

---

## 5. Blueprint values vs gateway runtime state

**This is the honest answer to "can the admin configure X in the Blueprint?" and about half
the time it is no.** The gateway keeps providers, policies, workspaces and inference routing
in its own database, mutated over gRPC by the CLI. The Helm chart configures the *process*,
not its contents: `deploy/helm/openshell/templates/gateway-config.yaml` renders **no**
policy, provider, workspace or inference section into `gateway.toml`, and the chart ships no
bootstrap Job and no seed ConfigMap.

| Concern | In a Blueprint? | Where it actually lives |
|---|---|---|
| Ingress / exposure | **yes, fully** | `grpcRoute.*`, `openshiftRoute.*`, `service.type`, `pkiInitJob.serverDnsNames`, `certManager.*`, `server.disableTls`, `server.grpcEndpoint` |
| Authentication | **yes** | `server.oidc.*`, `server.auth.allowUnauthenticatedUsers` |
| Workspaces — Kubernetes side | **yes** | `workspaceMode`, `operatorNamespaceLabel`, `workspaceStorageClass`, `workspaceDefaultStorageSize`, `sandboxImage`, + the `openshell-workspace` chart |
| Workspaces — OpenShell RBAC | no | `openshell workspace create` / `member add` |
| Provider credential *backend* | **yes** | `server.credentialStorage.existingSecret`, `server.credentialDrivers.{kubernetesSecrets,vault}`, `server.providerTokenGrants.spiffe` |
| Provider profiles and instances | no | `openshell provider profile import` / `provider create` — **per workspace** |
| Inference engine (the workload) | **yes, as its own Blueprint** | Blueprint C, or the shipped `suse-inference-endpoint` (vLLM + LiteLLM) |
| Inference routing (`inference.local`) | no | `openshell inference set` — **per workspace** |
| Policy validation posture | **yes** | `server.policyValidationFailureMode` |
| Policy content | no | image-baked `policy.yaml`, `openshell policy set [--global]` |
| Egress middleware | no, **but declarative** | `network_middlewares` inside policy YAML — see §10 |
| Gateway interceptors, custom middleware | **no, and currently unreachable** | `gateway.toml` sections the chart does not emit — see §10 |

Practical consequence for a demo or a customer PoC: the Blueprints get you a running,
correctly wired, correctly exposed gateway. Everything that makes it *useful* — a model to
talk to, a policy that permits the egress an agent needs, a provider holding a credential —
is a short scripted CLI sequence afterwards. `examples/openshell/{policies,providers}/`
exists so that sequence is curated files rather than improvisation, and
[`openshell-demo.md`](./openshell-demo.md) Parts 10–13 run it.

---

## 6. Exposing the gateway

The chart offers no `ingress.*` values — it uses **Gateway API** or an **OpenShift Route**,
and the choice has a direct consequence for how clients authenticate.

| Route | Values | TLS | Client auth | Use when |
|---|---|---|---|---|
| `kubectl port-forward` | none | gateway's own TLS, end to end | mTLS via `openshell-client-tls` | demo, dev, this document's §13 |
| Gateway API `GRPCRoute` | `grpcRoute.enabled`, `grpcRoute.hostnames`, `grpcRoute.gateway.*` | **terminated at the Gateway** (Envoy) | mTLS impossible → **OIDC required** | production Kubernetes with a Gateway controller |
| OpenShift `Route`, passthrough | `openshiftRoute.enabled`, `.host` | passthrough; gateway terminates | mTLS preserved | OpenShift |
| `service.type: LoadBalancer` | `service.type` | gateway terminates | mTLS preserved | quick external access |

Two consequences worth stating plainly, because both are easy to get wrong:

- **Gateway API terminates TLS at Envoy.** The gateway then must not also expect TLS on the
  connection Envoy makes to it, so `server.disableTls: true` goes with it — and since the
  gateway never sees a client certificate, `server.oidc.*` stops being optional. A
  `GRPCRoute` that is up while `disableTls` is unset presents as a TLS handshake failure
  from inside the mesh, not as a routing error.
- **Certificate SANs are generated at install time.** Whatever hostname or IP clients will
  actually use must be in `pkiInitJob.serverDnsNames` / `serverIpAddresses` (or the
  cert-manager equivalents) *before* the cert-gen job runs. The stock certificate carries
  `127.0.0.1` and `localhost`, which is why port-forward validates without
  `--gateway-insecure` and a LoadBalancer IP does not.

All of these values are present in Blueprint A, commented out, with the trade-offs written
next to them.

**On `openshell-client-tls`.** The demo copies this Secret's contents into the CLI's
`mtls/` directory and treats it as end-user authentication. NVIDIA documents that bundle on
Kubernetes as *supervisor* material — the credential sandboxes use to call back to the
gateway — not as an end-user credential. Using it as transport auth over a port-forward is
fine for a demo and is labelled as such; it is not a model for handing access to real users.
That is what OIDC is for.

---

## 7. Customising a Blueprint

There are **no install-time parameters.** The install wizard collects only instance name,
namespace, target cluster and deploy strategy — it embeds no values editor
(`ui/pkg/aif-ui/pages/components/BlueprintInstallWizard.vue`).

`AIWorkload.spec.componentValues` looks like the escape hatch and is not: on the Blueprint
path, values are read only from the Blueprint CR itself
(`blueprint.go:317`, `blueprint.go:900`, `gitchart.go:262`), and the only consumer of
`componentValues` is gated on `Spec.Source.App != nil` (`gitops.go:129`). Setting it on a
Blueprint-sourced AIWorkload is **silently ignored** — no error, no event, no status
condition. It is the single most likely way to waste an afternoon here.

The supported way to change values is therefore to **author a new Blueprint version**:
Blueprints → Create, which *does* embed the per-component `ValuesStep`, or edit one of the
YAML files in `examples/openshell/` and `kubectl apply` it under a new `spec.version`.
Blueprint CR names are derived from family + version (`bpCRName`, `blueprint.go:1116`), so a
new version is a new object and existing AIWorkloads keep pointing at the old one until
their `spec.source.blueprint.version` is changed.

This is why Blueprint A ships ~15 commented-out value blocks rather than a minimal file: the
comments are the configuration UI.

---

## 8. Workspaces

"Workspace" means two different things that must both exist and are provisioned by two
different mechanisms.

**The Kubernetes side** — Blueprint B. A namespace, a sandbox ServiceAccount, a Role and
RoleBinding letting the gateway create sandboxes in it, and the :2222 NetworkPolicy. Plus
the namespace label (`ai-factory.suse.com/openshell-workspace=true`) that puts the namespace
on the gateway's allowlist. The gateway picks the label up live, without a restart.

**The OpenShell side** — the gateway's own object, created with
`openshell workspace create --name <same-as-the-namespace>`. The names must match: in
operator mode the workspace name *is* the namespace name. Nothing links the two halves; a
workspace created without the namespace prerequisites fails at sandbox-create time, and a
labelled namespace without a workspace is simply invisible.

OpenShell's RBAC over workspaces — Platform Admin / Workspace Admin / Workspace User,
`openshell whoami`, `workspace member add/remove`, scoped tokens — **is inert in this
prototype.** With `server.auth.allowUnauthenticatedUsers: true`, every caller is accepted as
the same local developer principal and is a Platform Admin, so there is no subject to bind a
role to. Workspace scoping still works (§13.4) and is genuinely useful, but it is *scoping*,
not an authorization boundary. Configure `server.oidc.*` and turn the flag off before
claiming otherwise.

Storage for workspaces is Helm-side: `workspaceStorageClass` (empty string = the cluster
default) and `workspaceDefaultStorageSize`. Both are in Blueprint A.

---

## 9. Providers and inference routing

A **provider profile** defines a provider *type* — its credentials, the endpoints those
credentials are bound to, and the binaries allowed to use them. A **provider instance**
holds concrete values for one gateway. Attaching an instance to a sandbox contributes
generated `_provider_*` rules to that sandbox's effective policy, which is the point:
network policy travels with the credential instead of being copy-pasted into every sandbox.

**Both are workspace-scoped, and this is the trap in a multi-tenant topology.**
`CreateProvider` and `SetInferenceRoute` take a workspace and require Workspace Admin on it
(`crates/openshell-server/src/grpc/provider.rs:2471`,
`crates/openshell-server/src/inference.rs:93`); the CLI's `--workspace` flag defaults to
`default`. NVIDIA's inference-routing page calls the route "gateway-scoped", which is only
true if every sandbox lives in `default`. With Blueprint B's tenants, **`provider create` and
`inference set` must be repeated per tenant workspace**, or tenant sandboxes see no route at
all. Profiles are the exception: `provider profile import --global` registers one
platform-scoped profile for all workspaces, consumed with `provider create --global-profile`.

(Older builds gated this behind `settings set --global --key providers_v2_enabled`. That key
has been removed at the pinned commit — `crates/openshell-core/src/settings.rs` registers only
`ocsf_json_enabled` — so v2 is the only mode and setting it now fails as an unknown key.)

`inference.local` is a **built-in supervisor route**: a sandbox calls
`https://inference.local/v1/...` and the supervisor forwards it to whatever provider the
workspace's inference route points at, stripping the sandbox's view of the credential and
rewriting the model name. It hot-reloads in about five seconds and is intercepted for HTTPS
only.

Two things about it are counter-intuitive and both have cost time:

- **`inference.local` is not evaluated against network policy.** It is not an ordinary
  destination; it never reaches policy evaluation. Adding a `network_policies` rule for it
  does nothing, and a sandbox under the most restrictive baseline can still reach the model.
- **`inference_capable: true` on a profile is metadata only.** Attaching an inference-capable
  provider does *not* create the route. Only `openshell inference set` does.

The common wiring needs **no custom profile** — point the built-in `openai` profile at an
in-cluster engine:

```shell
openshell -g <gw> --workspace <tenant> provider create --name ollama-local --type openai \
  --credential OPENAI_API_KEY=ollama \
  --config OPENAI_BASE_URL=http://ollama.<tenant>.svc.cluster.local:11434/v1
openshell -g <gw> --workspace <tenant> inference set --provider ollama-local --model qwen2.5:0.5b
```

Setting an alternate base URL deliberately makes the built-in `openai`/`anthropic` profiles
**route-only**: OpenShell withholds their static credentials from direct sandbox traffic
while gateway inference routing keeps using the configured upstream. The sandbox never holds
the key — which is the behaviour you want.

Write a custom profile only when code inside the sandbox must call the endpoint itself and
OpenShell should inject the credential at the proxy. `providers/suse-litellm-profile.yaml`
is that case; `providers/README.md` has both recipes and the failure modes
(`credential_endpoint_mismatch`, the L4-only `attach` rejection, import being create-only).

For GPU clusters there is no new Blueprint: use the already-shipped `suse-inference-endpoint`
Blueprint (vLLM behind LiteLLM) and point `OPENAI_BASE_URL` at
`http://litellm.<ns>.svc.cluster.local:4000/v1` with a LiteLLM virtual key as
`OPENAI_API_KEY`.

---

## 10. Policies and extension points

Policy content is not a Helm value, but it *is* declarative — three layers, most specific
wins:

1. **Image-baked** `policy.yaml` (e.g. `OpenShell-Community/sandboxes/base/policy.yaml`) —
   the default for every sandbox from that image.
2. **Per-sandbox**, `openshell policy set <sandbox> --policy <file>` — `tenant-suse-ai.yaml`,
   `claude-code-l7.yaml`.
3. **Gateway-global**, `openshell policy set --global` — `global-baseline.yaml`. Applied
   **in full** to every sandbox, and while one is set the gateway **rejects all
   sandbox-level policy updates**. That is deliberate and it is also a foot-gun; see
   `policies/README.md`.

Within a policy, `network_policies` and `network_middlewares` are **dynamic** — applying
them to a running sandbox takes effect in seconds. `filesystem_policy`, `landlock` and
`process` are **static** and need the sandbox recreated.

Beyond that, OpenShell's extensibility surface has three tiers, and only two are reachable:

| Tier | Mechanism | Reachable from a Blueprint-delivered gateway? |
|---|---|---|
| Helm values | `gateway.toml` fields the chart templates | **yes** |
| Built-in supervisor middleware | `network_middlewares` in policy YAML | **yes** — built-ins need no registration |
| Gateway interceptors, operator-run middleware | `[[openshell.gateway.interceptors]]`, `[[openshell.supervisor.middleware]]` in `gateway.toml` | **no** |

The middle tier is worth using now. `network_middlewares` runs ordered stages over egress
*after* policy admits a request and *before* OpenShell injects provider credentials, and the
built-in `openshell/regex` redactor needs nothing but a policy block:

```yaml
network_middlewares:
  redact-api-tokens:
    middleware: openshell/regex     # openshell/ is reserved for built-ins
    order: 10                       # unique across the policy; lower runs first
    config: { mode: redact }
    on_error: fail_closed
    endpoints:
      include: ["pypi.org", "registry.npmjs.org"]
```

Constraints: max 10 middleware configs, `order` unique, host globs only (`*` one DNS label,
`**` one or more, max 32 patterns), and a `fail_closed` selector is rejected at validation if
it could match a `tls: skip` endpoint. It is regex-based, not parser-aware — defence in
depth against an agent pasting a key into an outbound body, not a guarantee.

**The third tier is blocked upstream, in the chart.** Interceptors and operator-run
middleware register only in `gateway.toml`, and the chart emits neither section and offers
no `extraConfig`, no `extraEnv`, no `extraVolumes`; `crates/openshell-core/src/config.rs` has
no environment-variable config source either. Verified at the pinned commit **and** at
`origin/main`, so bumping the chart version would not help.

That matters because a **governance interceptor** is the proper declarative answer to
providers and policies, and it is the concrete follow-up to this prototype.
`examples/governance-interceptor` upstream vends provider profiles as the gateway's
authoritative profile source, injects a signed `policy.yaml` into every `CreateSandbox`,
rejects attempts to weaken it, blocks profile import/update/delete outside the vended set,
and hot-reloads from files on disk. The files this prototype adds under
`examples/openshell/{policies,providers}/` would become its mounted ConfigMaps — same
content, delivered declaratively instead of by hand. The work is:

1. Build it as a SUSE-owned service seeded from that example, published from the
   `OpenShell-Community` fork (which we own; `NemoClaw`/`OpenShell` are upstream).
2. File an upstream chart PR adding `gateway.interceptors` values. That is the clean route
   and it benefits everyone. Forking the chart into `aif-suse` is the fallback — a second
   chart cannot patch the gateway's `<fullname>-config` ConfigMap without an ownership fight
   with Fleet.

---

## 11. Manual prerequisites

Two steps are deliberately manual in this prototype.

### 11.1 Agent Sandbox CRDs + controller (cluster-wide, once)

OpenShell's Kubernetes driver drives `Sandbox` objects from
[kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox). This
is a hard prerequisite; the gateway chart's own preflight fails the install with a clear
message if the CRDs are absent.

```bash
curl -sL -o /tmp/sandbox-with-extensions.yaml \
  https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.0/sandbox-with-extensions.yaml
kubectl apply -f /tmp/sandbox-with-extensions.yaml
kubectl -n agent-sandbox-system rollout status deploy/agent-sandbox-controller
```

This is not packaged as a Blueprint because agent-sandbox publishes no Helm chart, and
the operator's Fleet path has no generic raw-manifest delivery mode — Fleet Bundles are
used only for pull-secret delivery (`operator/internal/cluster/bundle_client.go`).

### 11.2 Labelling the tenant namespace

Operator mode discovers tenant namespaces by label. Neither the workspace chart nor the
operator's `ensureNamespace` applies labels, so the admin does:

```bash
kubectl label namespace <tenant> ai-factory.suse.com/openshell-workspace=true
```

The gateway picks it up immediately:

```
INFO openshell_driver_kubernetes::driver: operator namespace added to allowlist namespace="tenant-a"
INFO openshell_driver_kubernetes::driver: operator namespace added to allowlist namespace="tenant-b"
```

---

## 12. Verified installation walkthrough

Recorded from the 0.1.0 run. The commands below are updated to the 0.2.0 Blueprint versions;
the outputs are the observed 0.1.0 ones except where §4 supersedes them.

Environment used:

| Component | Version |
|---|---|
| Kubernetes | v1.31.0 (kind, `kind-sims-nvidia-09c3`) |
| Rancher | 2.15.1 |
| aif-operator | 2.2.0 (released chart, unmodified) |
| agent-sandbox | v1.0.0 |
| OpenShell charts | `0.0.0-dev.17171cd9337a2181d4bb5a9e711e1f2ad5f69388` |
| OpenShell gateway | `0.0.117-dev.66+g17171cd93` |
| OpenShell CLI | `0.0.116` |
| Default StorageClass | `standard` |

### Step 1 — ClusterRepo and Blueprints

```bash
kubectl apply -f examples/openshell/00-clusterrepo.yaml \
              -f examples/openshell/10-blueprint-openshell-gateway.yaml \
              -f examples/openshell/20-blueprint-openshell-workspace.yaml \
              -f examples/openshell/40-blueprint-openshell-inference-ollama-tenant.yaml \
              -f examples/openshell/41-blueprint-openshell-inference-ollama-shared.yaml
```

```
clusterrepo.catalog.cattle.io/openshell created
blueprint.ai-factory.suse.com/openshell-gateway-0-2-0 created
blueprint.ai-factory.suse.com/openshell-workspace-0-2-0 created
blueprint.ai-factory.suse.com/openshell-inference-ollama-tenant-0-2-0 created
blueprint.ai-factory.suse.com/openshell-inference-ollama-shared-0-2-0 created
```

> Rancher cannot index `oci://ghcr.io/nvidia/openshell` (ghcr.io exposes no catalog API
> under a namespace path), so the repo stays at `DOWNLOAD TIME ""` and its charts do not
> appear in the UI catalog browser. That affects browsing only — the Blueprint install
> path never reads the index.

### Step 2 — Install Blueprint A (gateway)

Equivalent to the UI install wizard; here as an AIWorkload CR:

```yaml
apiVersion: ai-factory.suse.com/v1alpha1
kind: AIWorkload
metadata:
  name: openshell-gw-local
  namespace: openshell
spec:
  displayName: OpenShell Gateway
  source:
    sourceType: Blueprint
    blueprint: { name: openshell-gateway, version: 0.2.0 }
  targetNamespace: openshell
  targetClusters: ["local"]
  deployStrategy: FleetBundle
```

Result:

```console
$ kubectl get helmop -n fleet-local openshell-gw-local-helm-chart
NAME                            REPO                                       VERSION                  READY
openshell-gw-local-helm-chart   oci://ghcr.io/nvidia/openshell/helm-chart   0.0.0-dev.17171cd9…      1/1

$ kubectl -n openshell get sts,svc,sa
statefulset.apps/openshell   1/1
service/openshell            ClusterIP  8080/TCP,9090/TCP
serviceaccount/openshell               ← §4: named from releaseName, not "helm-chart-openshell"

$ kubectl -n openshell get aiworkload openshell-gw-local -o jsonpath='{.status.phase}'
Running
```

Gateway config confirms operator mode:

```toml
[openshell.drivers.kubernetes]
workspace_mode           = "operator"
grpc_endpoint            = "https://openshell.openshell.svc.cluster.local:8080"
service_account_name     = "openshell-sandbox"
operator_namespace_label = "ai-factory.suse.com/openshell-workspace=true"
supervisor_sideload_method = "init-container"
```

### Step 3 — Onboard tenants with Blueprint B

```bash
for t in tenant-a tenant-b; do
  kubectl create namespace $t
  kubectl label namespace $t ai-factory.suse.com/openshell-workspace=true
  # one AIWorkload per tenant — see the naming rule in 12.1
done
```

```console
$ kubectl get helmop -A | grep openshell-ws
fleet-local  openshell-ws-tenant-a-openshell-workspace  …  1/1
fleet-local  openshell-ws-tenant-b-openshell-workspace  …  1/1

$ kubectl -n tenant-a get sa,role,rolebinding,netpol
serviceaccount/openshell-sandbox
role.rbac.authorization.k8s.io/openshell-workspace-sandbox
rolebinding.rbac.authorization.k8s.io/openshell-workspace-sandbox
networkpolicy.networking.k8s.io/openshell-workspace-sandbox-ssh

$ kubectl -n tenant-a get rolebinding openshell-workspace-sandbox -o jsonpath='{.subjects}'
[{"kind":"ServiceAccount","name":"openshell","namespace":"openshell"}]     ← matches §4
```

### 12.1 Naming rule: AIWorkload names must be globally unique

**This bit us during the demonstration and is a real constraint, not a detail.**

The Fleet bundle/HelmOp name is `<aiworkload-name>-<chartName>`
(`blueprintBundleName`, `keys.go:21`), the HelmOp always lands in `fleet-local`, and **the
AIWorkload's own namespace is not part of the name**. Two AIWorkloads named identically in
different namespaces therefore collide on one HelmOp.

Observed: creating `openshell-ws-local` in both `tenant-a` and `tenant-b` produced a
single HelmOp `openshell-ws-local-openshell-workspace`, with the two AIWorkload
reconcilers fighting over its `spec.defaultNamespace`.

The UI install wizard only checks workload-name uniqueness *within the chosen namespace*
(`ui/pkg/aif-ui/pages/components/BlueprintInstallWizard.vue:140`), so it would let an
admin walk straight into this.

**Rule for now:** include the tenant in the workload name —
`openshell-ws-tenant-a`, `openshell-ws-tenant-b`. With unique names, two independent
HelmOps are created and both tenants reconcile cleanly.

---

## 13. End-user demonstration

### 13.1 Connecting the CLI

The gateway serves gRPC over TLS with client-certificate verification. The chart's
cert-gen job produces both halves; the client half is in the `openshell-client-tls`
Secret. The CLI looks for `ca.crt` / `tls.crt` / `tls.key` under
`~/.config/openshell/gateways/<name>/mtls/`. (On the standing of that Secret, see §6.)

```bash
kubectl -n openshell port-forward --address 127.0.0.1 svc/openshell 28080:8080 &

# 1. register FIRST (see the two warnings below)
openshell gateway add https://127.0.0.1:28080 --name aif-cluster --local

# 2. then install the cluster's client certificates
D=~/.config/openshell/gateways/aif-cluster/mtls; mkdir -p $D
kubectl -n openshell get secret openshell-client-tls -o jsonpath='{.data.tls\.crt}' | base64 -d > $D/tls.crt
kubectl -n openshell get secret openshell-client-tls -o jsonpath='{.data.tls\.key}' | base64 -d > $D/tls.key
kubectl -n openshell get secret openshell-client-tls -o jsonpath='{.data.ca\.crt}'  | base64 -d > $D/ca.crt
chmod 600 $D/tls.key
```

Two things that will silently bite you if you have a **local OpenShell gateway** running
on the same machine (`openshell gateway list` shows one named `openshell`):

- **Do not reuse the name `openshell`.** The local daemon owns that registration and
  rewrites its `metadata.json`, so the name flips back to `https://localhost:17670`
  and every command quietly targets the wrong gateway
  (`workspace 'tenant-a' not found`). Use a distinct name — `aif-cluster` here.
- **Register before copying the certificates.** `gateway add --local` seeds the
  registration's `mtls/` directory from the *local* daemon's CA, overwriting anything
  already there. Doing it in the other order fails with
  `invalid peer certificate: BadSignature`.

The server certificate already carries `127.0.0.1` and `localhost` as SANs, so the
port-forward endpoint validates without `--gateway-insecure`.

```console
$ openshell -g aif-cluster status
  Gateway:         aif-cluster
  Server:          https://127.0.0.1:28080
  Status:          Connected
  Authentication:  Authenticated (mTLS transport)
  Version:         0.0.117-dev.66+g17171cd93
```

The CLI must be **0.0.116 or newer** — `--workspace` and the `openshell workspace`
subcommands do not exist in older builds, so an old CLI can only ever address the
`default` workspace. Install it with the upstream script, which on Apple Silicon
creates a local `nvidia/openshell` Homebrew tap and also starts a local gateway:

```bash
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
```

### 13.2 Creating workspaces

A workspace must be created in the gateway; its name is the tenant namespace name (§8).

```console
$ openshell workspace create --name tenant-a
✓ Created workspace tenant-a
$ openshell workspace create --name tenant-b
✓ Created workspace tenant-b

$ openshell workspace list
NAME      STATUS  CREATED
default   Active  2026-09-03 16:52:35
tenant-a  Active  2026-09-03 17:09:38
tenant-b  Active  2026-09-03 17:09:38
```

### 13.3 Running sandboxes

```console
$ openshell -g aif-cluster --workspace tenant-a sandbox create --name demo-a --detach
Created sandbox: demo-a

$ openshell -g aif-cluster --workspace tenant-b sandbox create --name demo-b --detach
Created sandbox: demo-b
```

> **Do not pass a trailing `-- <command>` if you intend to `sandbox connect` later.**
> Whatever you pass becomes the sandbox's *canonical main process*, and `sandbox
> connect` attaches to exactly that process — it does not start a new shell. Create
> with `-- sleep infinity` and `connect` hangs forever with no output, because it is
> faithfully attached to a sleeping process's (non-existent) terminal. With no
> trailing command the main process defaults to `/bin/bash -l`, which is what makes
> `connect` land in a shell. You can confirm which one a sandbox got:
>
> ```console
> $ kubectl -n tenant-a get pod demo-a -o jsonpath='{.spec.containers[0].env}' | tr ',' '\n' | grep -A1 MAIN_PROCESS_SPEC
> {"version":1,"command":["/bin/bash","-l"],"tty":false,...}
> ```
>
> Also note `-- <command>` sandboxes are short-lived: the pod exits as soon as the
> command finishes, so `sandbox create -- echo hi` fails the 300s readiness wait with
> `Last reported status: MainProcessCompleted`. Use `sandbox exec` for one-shot
> commands against a long-lived sandbox instead.

Each sandbox lands in its own namespace — this is the multi-tenancy claim, verified:

```console
$ kubectl -n tenant-a get sandbox,pod
sandbox.agents.x-k8s.io/demo-a   True   DependenciesReady
pod/demo-a                       1/1    Running

$ kubectl -n tenant-b get sandbox,pod
sandbox.agents.x-k8s.io/demo-b   True   DependenciesReady
pod/demo-b                       1/1    Running
```

`sandbox exec` runs over the gateway's gRPC endpoint:

```console
$ openshell --workspace tenant-a sandbox exec -n demo-a --no-tty -- sh -c 'hostname; id -un'
demo-a
ubuntu

$ openshell --workspace tenant-b sandbox exec -n demo-b --no-tty -- hostname
demo-b
```

`sandbox connect` (and plain `ssh` via the printed ProxyCommand) instead goes over
SSH on :2222, which is the path governed by the NetworkPolicy from §4 — so this is
the command that proves the gateway and workspace charts agree on the pod selector:

```console
$ openshell -g aif-cluster --workspace tenant-a sandbox ssh-config demo-a > /tmp/ssh_config
$ ssh -F /tmp/ssh_config openshell-demo-a.tenant-a 'hostname; id -un; head -2 /etc/os-release'
demo-a
ubuntu
PRETTY_NAME="Ubuntu 24.04.3 LTS"
NAME="Ubuntu"
```

And the interactive form, which is what an end user actually runs:

```console
$ openshell -g aif-cluster --workspace tenant-a sandbox connect demo-a
ubuntu@demo-a:~$ hostname
demo-a
ubuntu@demo-a:~$ id -un
ubuntu
```

`connect` needs a real TTY on the client side — it requests a PTY and attaches the
main process's terminal to it. Running it with stdin/stdout piped (in a script, or
under a CI runner) produces no output and appears to hang.

### 13.4 Isolation

Listing is workspace-scoped:

```console
$ openshell --workspace tenant-a sandbox list
NAME    CREATED              PHASE
demo-a  2026-09-03 17:16:29  Ready

$ openshell --workspace tenant-b sandbox list
NAME    CREATED              PHASE
demo-b  2026-09-03 17:16:50  Ready
```

And a cross-tenant reference is rejected:

```console
$ openshell --workspace tenant-b sandbox exec -n demo-a --no-tty -- hostname
Error: × code: 'Some requested entity was not found', message: "sandbox not found"
```

Read this as scoping, not authorization — §8.

---

## 14. Known gaps

These must be closed before this is anything more than a prototype.

1. **Authentication is off.** Blueprint A sets
   `server.auth.allowUnauthenticatedUsers: true`, so every caller is accepted as a local
   developer principal and any client that can reach the gateway can address *any*
   workspace. The isolation demonstrated in §13.4 is workspace scoping, **not** an
   authorization boundary, and OpenShell's workspace RBAC is inert without a subject (§8).
   The `server.oidc.*` block needed to fix this is present in Blueprint A, commented out
   and annotated with the per-IdP `rolesClaim` values — but it has not been exercised
   against a real IdP.

2. **Namespace labelling is manual.** §11.2. A Blueprint cannot label the namespace the
   operator creates for it. Closing this properly means an operator change (e.g.
   propagating labels onto Fleet's `namespaceLabels`), which was explicitly out of scope
   here.

3. **agent-sandbox install is manual, and cannot become a Blueprint component as things
   stand.** §11.1. Three compounding reasons: a `BlueprintComponent` is chart-only (no
   raw-manifest kind in the CRD schema); agent-sandbox publishes only plain YAML release
   assets, no chart anywhere; and even with a chart, the gateway's preflight is a
   *render-time* `fail` on `.Capabilities.APIVersions` while `reconcileBlueprintStatus`
   creates all component HelmOps in one unordered pass (`blueprint.go:125`), so the gateway
   would render before the CRDs exist. Observed on a downstream cluster: the install fails
   with the preflight message, and Fleet's retry converges it to `1/1` about a minute after
   the CRDs are applied — so it is recoverable, just not clean. The real fix is to package
   agent-sandbox as a chart and ship it as a separate "OpenShell Prerequisites" Blueprint
   that the admin installs first, which keeps ordering explicit and gives CRDs their own
   lifecycle instead of tying them to the gateway's.

4. **Half the configuration is CLI state, not Blueprint values.** §5. Workspaces, provider
   profiles and instances, policy content and inference routing are all applied after
   install with the OpenShell CLI, and providers, inference routes and policies are all
   **per workspace** — so the sequence is repeated for every tenant Blueprint B onboards,
   which is exactly the scaling the blueprints were supposed to remove.
   `examples/openshell/{policies,providers}/` makes it curated rather than improvised, but
   it is still imperative and nothing reconciles it. The governance-interceptor path in §10
   is the fix; it is blocked on an upstream chart gap.

5. **AIWorkload name collisions.** §12.1 — the UI can lead an admin into it.

6. **Gateway exposure is unverified.** The demo cluster had no Gateway API controller, so
   `grpcRoute.*` could not be exercised; the demo used `kubectl port-forward` with the
   `openshell-client-tls` bundle as transport auth, which §6 explains is a demo convenience
   and not a model for real users. The `grpcRoute` / `openshiftRoute` / `certManager` /
   `pkiInitJob` values are shipped commented-out in Blueprint A with their trade-offs
   documented, but **none of those paths has been run**.

7. **Version pinning is a dev commit, and Fleet does not always honour it.** The
   `openshell-workspace` chart is only published as `0.0.0-dev.<sha>` builds — there is no
   `0.0.116` for it, though the gateway chart has one. Both components are therefore
   pinned to the same dev SHA so they stay coherent, and the CLI is one release behind the
   gateway (0.0.116 vs 0.0.117-dev).

   **Observed on Fleet v0.16.1 (Rancher 2.15.1), 2026-09-04:** the operator set
   `spec.helm.version` correctly (`blueprint.go:281`) and `HelmOp.status.version` resolved
   to the pinned SHA, but the Bundle Fleet generated carried **no `version` key at all**.
   The agent then requested "latest stable", which diverges by chart:

   - `helm-chart` has a stable release, so the gateway **silently installed `0.0.116`**
     instead of the pin — `Running`, healthy, wrong version.
   - `openshell-workspace` has only prereleases, so there is no latest stable and it failed
     hard with `could not locate a version matching provided version string ` (empty).

   Bumping `forceSyncGeneration` on the HelmOp makes Fleet rewrite the Bundle with the
   version, after which it deploys immediately. The root cause is not established: five
   probe HelmOps — bare, with the operator's exact flags, with its labels/values in
   `fleet-default`, through the update path, and with a target matching the same downstream
   cluster — all propagated `version` correctly, and a probe with no version produced no
   Bundle at all. It looks like a race at initial Bundle creation, plausibly entangled with
   the preflight-failure retries in gap #3. **Consequence for the runbook: `Running` is not
   a sufficient check.** Verify `Bundle.spec.helm.version` and `helm list` after every
   install.

   Because the pin is what keeps the two charts on one commit, this also means an install
   that looks fine can leave a `0.0.116` gateway paired with a dev-SHA workspace chart.

8. **Single-tenant mode is untested here.** Setting `workspaceResources.enabled: true`
   and dropping Blueprint B should give a simpler one-namespace deployment, but that path
   was not exercised.

9. **Interceptors and operator-run middleware are unreachable.** §10 — an upstream chart
   gap, present on `origin/main`, not a consequence of our pin.

10. **The SUSE-branded sandbox images are not published.** `sandboxes/suse` and
    `sandboxes/openclaw-suse` exist in source in the `OpenShell-Community` fork but no tags
    are pushed to ghcr.io, so `server.sandboxImage` points at the community
    `sandboxes/base:latest`. Overriding it with a SUSE path today gives `ImagePullBackOff`.

11. **`releaseName: openshell` is run-verified — this gap is closed.** §4. Both
    Blueprints have now been installed live from the UI onto a downstream cluster with
    aif-operator 2.2.0, and they produced exactly what `helm template` predicted.
    Blueprint A: StatefulSet `openshell`, ServiceAccount `openshell`, pod labels
    `app.kubernetes.io/name=openshell` + `app.kubernetes.io/instance=openshell`, and

    ```toml
    gateway_pod_selector = { "app.kubernetes.io/name" = "openshell", "app.kubernetes.io/instance" = "openshell" }
    ```

    Blueprint B, **with `gateway.networkPolicy.podSelector` deleted**:
    `networkpolicy/openshell-workspace-sandbox-ssh` with podSelector
    `{app.kubernetes.io/instance: openshell, app.kubernetes.io/name: openshell}` — an exact
    match. And the real test, `sandbox connect` over SSH :2222, **landed a shell on the
    first attempt** (2026-09-04). That is the evidence that mattered; `exec` (gRPC) would
    have passed even with a broken selector.

    The `releaseName` field also survives the round-trip through the **released** 2.2.0
    CRD, not just this repo's dev CRD. One `releaseName` line now replaces all three of
    the 0.1.0 workarounds.
