# SUSE platform integrations

Three SUSE products carry this architecture, and **none of them is installed by
the Blueprints in this directory**. They are platform prerequisites: the
customer already runs them, installed the way SUSE documents them, on the same
Rancher Prime cluster the AI Factory operator manages.

| Product | Installed how | What this architecture does with it |
|---|---|---|
| **SUSE Security** (NeuVector) | Rancher → Cluster Tools, chart `neuvector` from `rancher-charts` | Produces the findings that start a job, and re-scans the rebuilt image that ends one |
| **SUSE Observability** | its own Helm repo, `charts.rancher.com/server-charts/prime/suse-observability` | The single timeline where all six feedback loops are visible, and the export the flywheel trains on |
| **SUSE Application Collection** | nothing to install — a registry | Supplies the curated, signed Python libraries and base image the remediation sandbox is built from |

What this directory contributes is the **seam**: the exact endpoints, secrets,
env vars and egress rules that connect the agent stack to products that are
already there. That is a much smaller surface than an install, and it is the
part a partner actually has to engineer.

**Status: designed, not run.** Every endpoint, service name, value key and API
path below was read from a rendered chart, a chart's own templates, product
documentation or source. Nothing has been exercised end to end — the authoring
cluster has neither a SUSE Observability license nor SUSE Security installed.
Where something could not be checked it says so.

---

## 1. SUSE Security — the loop's start and end

SUSE Security is not a bolt-on here. It is **both** ends of the primary
execution path: it emits the finding that opens a job, and it is the oracle that
decides whether the job succeeded. An agent that patches an image and declares
victory is worthless; an agent whose patch is graded by the same scanner that
raised the alarm is auditable.

### Where it lives

Installed from Rancher Cluster Tools, SUSE Security lands in
`cattle-neuvector-system`. The controller's REST API is:

```
https://neuvector-svc-controller.cattle-neuvector-system:10443
```

Authentication is a token obtained from `POST /v1/auth`, then passed as the
`X-Auth-Token` header on every subsequent call. An API key created under
*Settings → Users, API Keys & Roles* can be used directly as that token, which
is what a non-interactive agent needs.

### The four calls this architecture makes

| Call | Who makes it | Why |
|---|---|---|
| `POST /v1/auth` | validation agent, inside the sandbox | exchange the API key for a session token |
| `POST /v1/scan/repository` | validation agent | scan the rebuilt image, by repository + tag |
| `GET /v1/scan/repository/…` | validation agent | retrieve the result to diff against the pre-patch scan |
| `GET /v1/scan/scanner` | triage agent, out of band | read `cvedb_version` and `cvedb_create_time` — a remediation graded against a stale CVE database is not evidence of anything |

Everything else the API offers — `/v1/policy/rule`, `/v1/admission/rules`,
`/v1/group`, `/v1/file/config` — is **explicitly denied** to the sandbox. Those
endpoints rewrite the security posture of the cluster. An agent that can edit
`/v1/admission/rules` can admit the image it just built, which removes the
reviewer the whole architecture is built around. See
`../policies/remediation-sandbox.yaml`, network policy `suse_security`.

### The credential

The agent never holds the SUSE Security API key. OpenShell injects it at the
egress boundary: the sandbox issues a request with a placeholder, and the
gateway substitutes the real value on the way out. That is the same mechanism
used for the git forge token, and it is why a prompt-injected advisory cannot
exfiltrate either.

```
kubectl create secret generic openshell-suse-security-api \
  -n openshell --from-literal=api-key='<NeuVector API key>'
```

**UNVERIFIED:** the precise OpenShell gateway value that binds this Secret to
the `suse_security` endpoint's credential rewrite. The policy grammar for
`request_body_credential_rewrite` and `websocket_credential_rewrite` was read
from `crates/openshell-policy/src/lib.rs`, but the Helm-values plumbing that
supplies the secret material to the gateway was not traced.

### Two signals, not one

SUSE Security feeds the corpus twice over, and the two are different in kind:

- **Registry scanning** — the vulnerability list per image. This is the raw
  finding count, and on its own it is the 4,000-row spreadsheet nobody reads.
- **Runtime enforcement** — which of those images is actually running, in which
  namespace, talking to what. This is the reachability signal that turns 4,000
  rows into the nine that matter, and it is the single biggest reason the triage
  agent can be a 30B model instead of a 550B one. Ranking is easy when the input
  is already filtered by whether the vulnerable code path is exposed.

The second signal reaches SUSE Observability through the agent's
`otel.integrations.suseRuntimeEnforcer` StackPack, not through the REST API.

---

## 2. SUSE Observability — where the feedback loops become visible

A long-running agent system is not debuggable from logs. One CVE remediation
fans out into an orchestrator, N concurrent researchers, a writer, a sandbox and
a validation pass — dozens of spans across five namespaces, with retries and
escalations in the middle. Four of the six feedback loops in Figure 3 exist only
as relationships between spans.

### The endpoint everything points at

With the server installed at release name `suse-observability` in namespace
`suse-observability`, the in-cluster OTLP receiver is:

```
http://suse-observability-otel-collector.suse-observability.svc.cluster.local:4317   # OTLP/gRPC
http://suse-observability-otel-collector.suse-observability.svc.cluster.local:4318   # OTLP/HTTP
```

Verified by rendering chart `suse-observability` 2.10.3 with that release name:
the Service `suse-observability-otel-collector` exposes `otlp` 4317, `otlp-http`
4318 and `metrics` 8888, and a second Service
`suse-observability-otel-collector-grpc` exposes 4317 alone.

**The release name is load-bearing.** The Service name is
`<release>-otel-collector`. Install the server under a different release name
and every exporter in this architecture resolves a hostname that does not exist
— and an OTLP exporter that cannot resolve its endpoint does not crash the
workload, it drops spans into a sidecar log nobody is reading. If your existing
install uses a different release name, change the endpoint in three places: the
`aiq2-web` and `nvidia-blueprint-rag` components of
`20-blueprint-secops-agent-factory.yaml`, and
`10-blueprint-openshell-gateway.yaml`.

### Who emits what

| Emitter | Mechanism | Carries |
|---|---|---|
| AI-Q agent plane | `OTEL_EXPORTER_OTLP_ENDPOINT` env, set on the `aiq2-web` component of blueprint 20 | orchestrator → researcher → writer span tree, token counts, escalation decisions |
| OpenShell gateway | native `otlp.endpoint` Helm value, set in blueprint 10 | sandbox create/exec/destroy, **every egress decision the policy engine made** |
| NeMo Relay, inside the sandbox | ships in the sandbox image, emits ATOF/ATIF/OTLP | the remediation agent's own trajectory, including `subagent_trajectories` |
| RAG / knowledge plane | `OTEL_EXPORTER_OTLP_ENDPOINT`, set on the `nvidia-blueprint-rag` component of blueprint 20 | retrieval latency, rerank scores, which chunks were actually cited |
| SUSE Security | the agent's `suseRuntimeEnforcer` StackPack | runtime topology and enforcement events |
| Kubernetes itself | the SUSE Observability agent | pods, nodes, GPU utilisation, the topology map |

The gateway line is the interesting one. OpenShell's egress log is a security
artefact — every host, method and path the agent tried, allowed or denied — and
putting it on the same timeline as the agent's reasoning spans means "why did
the agent try to reach that host" is one click, not a correlation exercise
across two products.

### Agent-side configuration worth turning on

These are value keys in `suse-observability-agent` 1.6.1, read from
`helm show values`. They are **the customer's install to change**, not ours, but
this architecture depends on two of them:

```yaml
otel:
  enabled: true                      # master switch; defaults to false
  integrations:
    suseSbomScanner: true            # DEFAULTS TO FALSE — turn it on
    suseRuntimeEnforcer: true        # defaults to true
    suseAdmissionController: true    # defaults to true; unused here
    rancherAgent: true               # defaults to false
```

`suseSbomScanner` defaults off and matters most. In this architecture the SBOM
is not a compliance artefact filed away — it is one of the three input signals
in Figure 2 and one of the corpus sources in blueprint 20.

`rancherAgent` enriches every log record with the Rancher URL and cluster ID,
which is what makes a trajectory in the flywheel corpus attributable to a
specific managed cluster months later. It needs `cattle-system` to exist, which
is true on any AI Factory cluster.

### The AI Assistant is deliberately not used

SUSE Observability 2.10.3 ships an AI Assistant whose `ai.assistant.provider`
accepts exactly two values: `bedrock` and `anthropic`. Both are hosted APIs
outside the cluster. Enabling it in an architecture whose central claim is that
no token crosses the customer boundary would contradict the architecture, so
this design leaves it off.

`ai.mcp`, however, is a different thing and is worth turning on. The chart's own
comment: *"Enables the MCP Server for use with external code assistants,
**without** enabling the AI Assistant or configuring an LLM provider."* So the
MCP server runs with no external LLM anywhere in the path — and MCP is the
protocol AI-Q's agents already speak for tool access. That turns SUSE
Observability from a dashboard a human reads afterwards into **a tool the agents
can query**: *"has this service been unhealthy since the patch merged?"* is a
question the validation agent should be able to ask, and this is the supported
way to ask it.

**UNVERIFIED:** that AI-Q 2.2 can register this MCP server without additional
auth plumbing. The value key is real and the protocol matches; the integration
is designed, not demonstrated.

### Auto-instrumentation, if you want it

SUSE AI Factory's own monitoring guide installs the OpenTelemetry Operator and
Collector **from the SUSE Application Collection**:

```bash
helm install opentelemetry-operator oci://dp.apps.rancher.io/charts/opentelemetry-operator \
  --namespace suse-observability --version <CHART-VERSION> \
  --set manager.autoInstrumentation.go.enabled=true \
  --set global.imagePullSecrets={application-collection}
```

With the Operator present, `otel-instrumentation.yaml` in this directory injects
Python auto-instrumentation into the AI-Q backend by annotation, so the agent
plane produces spans without an application change. SUSE's guide points at the
OpenLIT SDK for the LLM-specific spans on top of that.

---

## 3. SUSE Application Collection — the sandbox's supply chain

This is the integration that is easiest to overlook and hardest to argue with.

The remediation sandbox is the only place in this architecture where code nobody
reviewed executes with a write credential in reach. Building that container out
of packages pulled from the open internet at build time would undo every other
control on this page: an agent that patches CVEs using a toolchain assembled
from unsigned PyPI wheels is not a security product.

So the sandbox image is built from SUSE's Distribution Platform, end to end:

| Layer | Source |
|---|---|
| Base image | `registry.suse.com/bci/bci-base:16.0` — the same base the SUSE OpenShell sandboxes use |
| OS packages | SUSE repositories via `zypper`, against the host's SCC entitlement |
| **Python libraries** | `https://dp.apps.rancher.io/libraries/python/simple/` — the curated index, 809 packages |
| Helm charts (platform) | `oci://dp.apps.rancher.io/charts/<name>` |
| Container images (platform) | `dp.apps.rancher.io/containers/<name>:<tag>` |

The Python index is configured exactly as SUSE documents it — `index-url`, not
`extra-index-url`, so pip resolves from the curated index **only** and cannot
silently fall back to public PyPI:

```ini
# .venv/pip.conf
[global]
index-url = https://USER:TOKEN@dp.apps.rancher.io/libraries/python/simple/
```

`uv` does not read `pip.conf`; it needs its own file with `default = true`,
which has the same exclusive effect:

```toml
# uv.toml
[[index]]
url = "https://USER:TOKEN@dp.apps.rancher.io/libraries/python/simple/"
default = true
```

See `../sandbox-image/` for the Containerfile that uses both, and for how the
credential is kept out of the image layers.

There is a second-order effect worth stating. Because the sandbox's entire
dependency set comes from one host, the OpenShell egress policy for
`dp.apps.rancher.io` can be narrow and read-only — and every other package host
in the world can stay denied. A build that reaches for `pypi.org` fails at the
policy engine, loudly, at the moment it happens. Supply-chain policy stops being
a document and becomes a network rule.

---

## Files here

| File | What it is |
|---|---|
| `otel-instrumentation.yaml` | Illustrative `Instrumentation` CR wiring the AI-Q namespace to the SUSE Observability collector |
| `suse-security-prereq.md` | The prerequisite checklist and the API-key creation steps |
