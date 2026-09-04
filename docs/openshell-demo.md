# OpenShell on SUSE AI Factory — end-to-end demo runbook

A linear script for demonstrating NVIDIA [OpenShell](https://github.com/NVIDIA/OpenShell)
delivered as SUSE AI Factory Blueprints: **starting from a cluster that already runs Rancher
and AI Factory**, through installing the blueprints **in the AI Factory UI**, to an end user
in a shell inside a sandbox, talking to a model that never leaves the cluster, under a
policy the admin wrote.

Design rationale, the values-vs-runtime-state boundary and the known gaps live in
[`openshell-blueprints.md`](./openshell-blueprints.md). This file is the runbook.

Everything runs on **released aif-operator 2.2.0**, unmodified.

> **Provenance.** Parts 1–9 were run end to end on a live cluster against Blueprint version
> 0.1.0; their outputs are transcripts. Parts 10–13, and the Blueprint 0.2.0 changes noted
> inline, have **not** been run live yet — treat those commands as the intended script and
> expect to correct the outputs on first run.

**Total time:** ~35 minutes for the whole thing, ~20 for Parts 1–9. Most of it is image
pulls and one model pull.

| Part | What you show | Time |
|---|---|---|
| 0 | Preconditions | — |
| 1 | Cluster prep (agent-sandbox, namespaces) | 3 min |
| 2 | Register the charts and blueprints | 1 min |
| 3 | **Install the gateway from the UI** | 3 min |
| 4 | **Onboard a tenant from the UI** | 2 min |
| 5 | Point the CLI at the cluster | 3 min |
| 6 | Create the workspace | 30 s |
| 7 | Create a sandbox and get a shell | 3 min |
| 8 | Run Claude Code inside it | 3 min |
| 9 | Show the isolation boundary | 1 min |
| 10 | **Install an inference engine from the UI** | 4 min |
| 11 | **Wire inference routing** — the agent talks to a local model | 4 min |
| 12 | **Customise a policy** — egress control and secret redaction | 5 min |
| 13 | Workspace RBAC (narrated) | 2 min |

---

## Part 0 — Preconditions

This runbook assumes Rancher and SUSE AI Factory are **already installed and healthy**. It
is not an install guide for either.

| Component | Required | Verify |
|---|---|---|
| Rancher | ≥ 2.15 | UI loads, `local` cluster Active |
| aif-operator + aif-ui extension | 2.2.0 | `kubectl -n suse-ai get deploy aif-operator` Ready; **SUSE AI** appears in Rancher's product menu |
| Kubernetes | ≥ 1.29 (v1.31.0 used) | `kubectl version` |
| Default StorageClass | yes | `kubectl get sc` shows one marked `(default)` |
| Outbound access to ghcr.io | yes | the OpenShell charts and images are pulled from there |
| OpenShell CLI | ≥ 0.0.116 | `openshell --version` |

Install the CLI on the laptop you are demoing from:

```bash
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
openshell --version    # must be >= 0.0.116, older builds have no `--workspace`
```

Anything below 0.0.116 has no `workspace` subcommand and can only address the `default`
workspace — the multi-tenancy demo simply will not work.

> **If you already run a local OpenShell gateway** (the installer starts one; check with
> `openshell gateway list`), read the two warnings in Part 5 before you register the
> cluster gateway. They cost an hour the first time.

Optional, only if you plan to run Part 10 on GPUs rather than the CPU Ollama blueprint: a
working GPU Operator and the `suse-inference-endpoint` blueprint's prerequisites.

---

## Part 1 — Cluster prep

Two things the blueprints cannot do for themselves.

> **Run every command in this Part against the cluster you will install the gateway
> *onto*, not against the Rancher cluster.** If you target a downstream cluster in Part 3,
> that is where the CRDs, the `openshell` namespace and the tenant namespaces have to be.
> Blueprints and ClusterRepos are Rancher-side; everything in Part 1 is workload-side. It
> is an easy mistake to make when both clusters are in the same kubeconfig.

### 1.1 Agent Sandbox CRDs + controller

OpenShell's Kubernetes driver drives `Sandbox` objects from
[kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox). Hard
prerequisite — the gateway chart's preflight fails the install with a clear message if it
is missing.

```bash
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.0/sandbox-with-extensions.yaml
kubectl -n agent-sandbox-system rollout status deploy/agent-sandbox-controller
```

**Why this is not a Blueprint component.** Three reasons, in increasing order of how hard
they are to work around:

1. A `BlueprintComponent` is chart-only — `chartName`, `chartRepo`, `chartVersion`,
   `releaseName`, `targetNamespace`, `values`, `vendor`. There is no raw-manifest kind.
2. agent-sandbox publishes no Helm chart. Every release asset is plain YAML
   (`sandbox.yaml`, `extensions.yaml`, `sandbox-with-extensions.yaml`); there is nothing at
   ghcr.io or registry.k8s.io to point a component at. We would have to package and host
   one.
3. Even with a chart it would race. The preflight is a **render-time** `fail` reading
   `.Capabilities.APIVersions` (a discovery snapshot taken before templating), and
   `reconcileBlueprintStatus` creates every component's HelmOp in one pass with no ordering
   and no wait-for-ready (`blueprint.go:125`). The gateway would render against a cluster
   that does not have the CRDs yet.

Point 3 is survivable — Fleet retries, and an install that fails this way **self-heals
within about a minute** once the CRDs land, with no need to delete or re-run anything (see
Troubleshooting). But it means a red error in the UI on every fresh install, so a
prerequisite is the honest design. Closing this properly means packaging agent-sandbox as a
chart and shipping it as its own "OpenShell Prerequisites" Blueprint, installed first —
tracked as a gap in [`openshell-blueprints.md`](./openshell-blueprints.md).

### 1.2 Namespaces, and the label that matters

```bash
kubectl create namespace openshell

for t in tenant-a tenant-b; do
  kubectl create namespace $t
  kubectl label namespace $t ai-factory.suse.com/openshell-workspace=true
done
```

The gateway runs in `workspaceMode: operator` — one gateway serving many pre-provisioned
namespaces — and discovers tenant namespaces **by that label**. Forget it and the
namespace is invisible to the gateway; `sandbox create` will fail with a workspace error
that does not mention labels at all.

You can add the label later; the gateway picks it up live:

```
INFO openshell_driver_kubernetes::driver: operator namespace added to allowlist namespace="tenant-a"
```

---

## Part 2 — Register the charts and the blueprints

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

**Why this step is `kubectl` and not the UI.** A Blueprint is a cluster-scoped CR; the AI
Factory UI can author them (Blueprints → Create), but these carry hand-tuned values that
would be tedious to retype live. Applying the YAML is the honest shortcut. Everything
*after* this point is UI.

> Rancher cannot index `oci://ghcr.io/nvidia/openshell` — ghcr.io exposes no catalog API
> under a namespace path — so the ClusterRepo shows an empty `DOWNLOAD TIME` and its
> charts do not appear in Rancher's catalog browser. Harmless: the Blueprint install path
> never reads the index, it resolves `oci://<spec.url>/<chartName>` directly.

**A question you will be asked here:** *can I change the values at install time?* No. The
install wizard collects only name, namespace, cluster and deploy strategy — there is no
values editor on the install path, and `AIWorkload.spec.componentValues` is silently ignored
for Blueprint-sourced workloads. To change values you author a new Blueprint version
(Blueprints → Create, or edit the YAML and bump `spec.version`). That is why Blueprint A
ships with every optional block present and commented out: the file *is* the configuration
surface. See [`openshell-blueprints.md`](./openshell-blueprints.md#7-customising-a-blueprint).

---

## Part 3 — Install the gateway from the AI Factory UI

**Rancher → top-left product menu → SUSE AI → Blueprints.**

Three new cards are there; the two OpenShell ones are badged with the NVIDIA logo (that
comes from `spec.source: Nvidia`), the Ollama one with SUSE's:

- **OpenShell Gateway** v0.2.0 · 1 component
- **OpenShell Workspace** v0.2.0 · 1 component
- **OpenShell Inference (Ollama)** v0.1.0 · 1 component

Click **Install** on **OpenShell Gateway**. Three-step wizard:

**Step 1 — Basic Information**

| Field | Value |
|---|---|
| Instance Name | `openshell-gw-local` |
| Default Namespace | `openshell` |

You will see a blue info banner:

> *1 component deploys to its own fixed namespace and will ignore this value.*

That banner is worth pointing at. Blueprint A pins `targetNamespace: openshell` on its
component, because the workspace chart's RoleBinding hardcodes the gateway
ServiceAccount's namespace. Whatever namespace you pick here, the gateway lands in
`openshell`.

**Step 2 — Target Cluster**

- Deployment Type: **Fleet Bundle**
- Target Cluster: tick **local**

**Step 3 — Review**

The components table is the second thing worth pointing at:

```
Components (1)
  helm-chart   Release: openshell   → openshell (fixed)
```

Chart `helm-chart`, release `openshell`. The chart really is named `helm-chart` in its
`Chart.yaml`, and by default the operator would name the Helm release after it — which
breaks the workspace chart, because every gateway object name and every
`app.kubernetes.io/instance` label is derived from the release name. Blueprint A therefore
sets `releaseName: openshell` on the component, and that one line is what makes the two
charts agree. [`openshell-blueprints.md`](./openshell-blueprints.md) §4 has the trace, and
§4.1 records the three separate workarounds it replaced.

Hit **Install**. A progress modal runs, then you land on **Workloads**.

**Verify** (~60–90 s, dominated by the image pull):

```console
$ kubectl get helmop -n fleet-local openshell-gw-local-helm-chart
NAME                            REPO                                       VERSION               READY
openshell-gw-local-helm-chart   oci://ghcr.io/nvidia/openshell/helm-chart   0.0.0-dev.17171cd9…   1/1

$ kubectl -n openshell get sts,svc,sa
statefulset.apps/openshell   1/1
service/openshell            ClusterIP   8080/TCP,9090/TCP
serviceaccount/openshell                 ← named "openshell", not "helm-chart-openshell"

$ kubectl -n openshell get aiworkload openshell-gw-local -o jsonpath='{.status.phase}'
Running
```

In the UI, **Workloads** shows `openshell-gw-local` · **Running**.

> **Check the version pin took.** Do this after *every* Blueprint install — `Running` is not
> sufficient, because a dropped pin fails silently on any chart that has a stable release.
>
> ```bash
> # on the Rancher cluster — must print the pinned version, not empty
> kubectl get bundle -A -o jsonpath='{range .items[*]}{.metadata.name}{" -> "}{.spec.helm.version}{"\n"}{end}' | grep openshell
>
> # on the target cluster — CHART must be helm-chart-0.0.0-dev.<sha>
> helm list -n openshell
> ```
>
> If the version is empty, force-sync the HelmOp (see Troubleshooting). Observed on Fleet
> v0.16.1: both Bundles were generated without `spec.helm.version` even though the operator
> set it and `HelmOp.status.version` resolved correctly, and the gateway silently installed
> `0.0.116` instead of the pin.

> **If you targeted a downstream cluster instead of `local`,** two names change and the
> commands above will look like they found nothing:
>
> - the HelmOp lands in **`fleet-default`**, not `fleet-local`;
> - the operator appends the Fleet cluster ID to the instance name, so the AIWorkload and
>   HelmOp are `openshell-gw-<name>-<clusterid>-…` — e.g.
>   `openshell-gw-local-c-9qtkk-helm-chart`.
>
> Find them with `kubectl get helmop -A | grep openshell` on the Rancher cluster. The
> gateway objects themselves are on the downstream cluster, unchanged:
>
> ```console
> $ kubectl -n openshell get sts,svc,sa
> statefulset.apps/openshell   1/1
> service/openshell            ClusterIP   8080/TCP,9090/TCP
> serviceaccount/openshell
> serviceaccount/openshell-sandbox
> ```

---

## Part 4 — Onboard a tenant from the UI

Back to **Blueprints**, **Install** on **OpenShell Workspace**.

**Step 1 — Basic Information**

| Field | Value |
|---|---|
| Instance Name | `openshell-ws-tenant-a` |
| Default Namespace | `tenant-a` |

> ### The one rule you must not break
>
> **Instance names must be globally unique, not just unique per namespace.**
>
> The Fleet HelmOp is named `<instance-name>-<chartName>` and always lands in
> `fleet-local` — the AIWorkload's own namespace is *not* part of the name. Installing
> this blueprint into `tenant-a` and `tenant-b` both as `openshell-ws-local` produces
> **one** HelmOp with two controllers fighting over its `defaultNamespace`.
>
> The wizard will not stop you: its uniqueness check only looks within the chosen
> namespace (`BlueprintInstallWizard.vue:140`). Put the tenant in the name.

No banner this time — Blueprint B deliberately pins no `targetNamespace`, so the namespace
you choose here *is* the tenant.

Steps 2 and 3 as before (Fleet Bundle, local, Install).

Then repeat the whole thing for `tenant-b` / `openshell-ws-tenant-b`. **This is the demo's
point**: onboarding tenant N is one more run of the same wizard.

**Verify:**

```console
$ kubectl get helmop -A | grep openshell-ws
fleet-local  openshell-ws-tenant-a-openshell-workspace  …  1/1
fleet-local  openshell-ws-tenant-b-openshell-workspace  …  1/1

$ kubectl -n tenant-a get sa,role,rolebinding,netpol
serviceaccount/openshell-sandbox
role.rbac.authorization.k8s.io/openshell-workspace-sandbox
rolebinding.rbac.authorization.k8s.io/openshell-workspace-sandbox
networkpolicy.networking.k8s.io/openshell-workspace-sandbox-ssh
```

No workloads — Blueprint B only grants the shared gateway permission to run sandboxes here,
plus the NetworkPolicy that lets it reach their SSH port.

---

## Part 5 — Point the CLI at the cluster

The gateway serves gRPC over TLS with client-certificate verification. The chart's cert-gen
job produces both halves; the client half is in the `openshell-client-tls` Secret.

```bash
kubectl -n openshell port-forward --address 127.0.0.1 svc/openshell 28080:8080 &

# 1. REGISTER FIRST
openshell gateway add https://127.0.0.1:28080 --name aif-cluster --local

# 2. THEN install the cluster's client certificates
D=~/.config/openshell/gateways/aif-cluster/mtls; mkdir -p $D
kubectl -n openshell get secret openshell-client-tls -o jsonpath='{.data.tls\.crt}' | base64 -d > $D/tls.crt
kubectl -n openshell get secret openshell-client-tls -o jsonpath='{.data.tls\.key}' | base64 -d > $D/tls.key
kubectl -n openshell get secret openshell-client-tls -o jsonpath='{.data.ca\.crt}'  | base64 -d > $D/ca.crt
chmod 600 $D/tls.key
```

Two traps if a **local** OpenShell gateway is running on the same laptop:

- **Do not name the registration `openshell`.** The local daemon owns that name and
  rewrites its `metadata.json`, silently flipping the endpoint back to
  `https://localhost:17670`. Every subsequent command then targets the wrong gateway and
  fails with `workspace 'tenant-a' not found`. Use a distinct name — `aif-cluster` here,
  and pass `-g aif-cluster` on every command below.
- **Register before copying the certificates.** `gateway add --local` seeds the
  registration's `mtls/` directory from the *local* daemon's CA and overwrites whatever is
  there. The other order fails with `invalid peer certificate: BadSignature`.

The server certificate carries `127.0.0.1` and `localhost` as SANs, so the port-forward
endpoint validates without `--gateway-insecure`.

```console
$ openshell -g aif-cluster status
  Gateway:         aif-cluster
  Server:          https://127.0.0.1:28080
  Status:          Connected
  Authentication:  Authenticated (mTLS transport)
  Version:         0.0.117-dev.66+g17171cd93
```

> **Say this if asked "is that how real users connect?"** No. Port-forward plus the
> `openshell-client-tls` bundle is a demo convenience; NVIDIA documents that bundle on
> Kubernetes as *supervisor* material, not an end-user credential. A real deployment exposes
> the gateway with a Gateway API `GRPCRoute` or an OpenShift Route and authenticates users
> with OIDC. Both sets of values ship commented-out in Blueprint A —
> [`openshell-blueprints.md`](./openshell-blueprints.md#6-exposing-the-gateway) has the
> decision matrix.

---

## Part 6 — Create the workspaces

Blueprint B built the Kubernetes side of the tenant. The OpenShell *workspace* object is
still a separate, manual creation — nothing links the two yet. Its name must equal the
namespace name.

```console
$ openshell -g aif-cluster workspace create --name tenant-a
✓ Created workspace tenant-a
$ openshell -g aif-cluster workspace create --name tenant-b
✓ Created workspace tenant-b

$ openshell -g aif-cluster workspace list
NAME      STATUS  CREATED
default   Active  2026-09-03 16:52:35
tenant-a  Active  2026-09-03 17:09:38
tenant-b  Active  2026-09-03 17:09:38
```

---

## Part 7 — Create a sandbox and get a shell

```console
$ openshell -g aif-cluster --workspace tenant-a sandbox create --name demo-a --detach --tty
Created sandbox: demo-a
```

First one takes ~60 s: the sandbox image is ~1.1 GB.

> ### Always pass `--tty` on create
>
> `--tty` "defaults to auto-detection (on when stdin and stdout are terminals)", and the
> decision is **frozen into the sandbox's main process spec at create time** — `connect`
> cannot add a PTY later. `--detach` does *not* imply one.
>
> So creating the sandbox from anything without a terminal — a script, CI, a `kubectl exec`,
> an agent tool call — bakes in `"tty":false`. `bash -l` then runs with no terminal, and a
> later `connect` from a real terminal attaches to a process that has nowhere to draw:
> **the sandbox is `Ready`, `connect` returns no error, and you just sit there.**
> Indistinguishable from the `-- sleep infinity` hang below, and the recovery is the same —
> delete and recreate. Passing `--tty` explicitly makes it independent of where you ran it.
>
> ```console
> $ kubectl -n tenant-a get pod demo-a \
>     -o jsonpath='{.spec.containers[0].env[?(@.name=="OPENSHELL_MAIN_PROCESS_SPEC")].value}'
> {"version":1,"command":["/bin/bash","-l"],"tty":true,...}     ← good
> {"version":1,"command":["/bin/bash","-l"],"tty":false,...}    ← connect will hang
>
> $ kubectl -n tenant-a exec demo-a -c agent -- ps -eo pid,tty,stat,args
>  50 pts/0  Ss+  /bin/bash -l      ← good: on a terminal, foreground
>  50 ?      S    /bin/bash -l      ← no terminal; connect shows nothing
> ```

> ### Do not pass a trailing `-- <command>`
>
> Whatever you pass becomes the sandbox's **canonical main process**, and `sandbox connect`
> attaches to *exactly that process* — it never starts a new shell.
>
> Create with `-- sleep infinity` and `connect` hangs forever with no output, because it is
> faithfully attached to a sleeping process's non-existent terminal. This is the single
> most confusing failure in the whole demo, because nothing errors.
>
> With no trailing command the main process defaults to `/bin/bash -l`, which is what makes
> `connect` land in a shell. Check which one a sandbox got:
>
> ```console
> $ kubectl -n tenant-a get pod demo-a -o jsonpath='{.spec.containers[0].env}' \
>     | tr ',' '\n' | grep MAIN_PROCESS_SPEC
> {"version":1,"command":["/bin/bash","-l"],...}      ← good
> {"version":1,"command":["sleep","infinity"],...}    ← connect will hang
> ```
>
> Corollary: `-- <command>` sandboxes are short-lived. `sandbox create -- echo hi` fails
> the 300 s readiness wait with `Last reported status: MainProcessCompleted`, because the
> pod exits before it is ever Ready. Use `sandbox exec` for one-shot commands.

Each sandbox lands in its own namespace — the multi-tenancy claim, made concrete:

```console
$ kubectl -n tenant-a get sandbox,pod
sandbox.agents.x-k8s.io/demo-a   True   DependenciesReady
pod/demo-a                       1/1    Running
```

Now the payoff:

```console
$ openshell -g aif-cluster --workspace tenant-a sandbox connect demo-a
ubuntu@demo-a:~$ hostname
demo-a
ubuntu@demo-a:~$ id -un
ubuntu
```

Three things to know before you do this in front of an audience:

1. **`connect` needs a real TTY.** It requests a PTY and attaches the main process's
   terminal to it. Piped into a script or a CI runner it produces no output and looks
   exactly like the `sleep infinity` hang above.
2. **Typing `exit` ends the sandbox, and it does not come back.** The sandbox's lifetime
   *is* the main process's lifetime, so exiting `bash -l` drives the pod to `Succeeded`
   and the sandbox out of `Ready`. The next `connect` fails with:

   ```
   Error:   x code: 'The system is not in a state required for the operation's execution',
            message: "sandbox is not ready"
   ```

   `sandbox start` will **not** rescue it — that only resumes a sandbox suspended with
   `sandbox stop`, and it returns `PodSucceeded: Pod completed successfully`. The only
   recovery is `sandbox delete` + `sandbox create`, which loses the workspace volume.
   Verified live on 2026-09-04. This is by design, but it will surprise a room.

   **To pause a sandbox, use `stop`/`start`, not `exit`** — that is the supported path and
   it preserves the workspace:

   ```console
   $ openshell -g aif-cluster --workspace tenant-a sandbox stop demo-a
   ✓ Stopped sandbox demo-a           # pod deleted, sandbox Ready=False/SandboxSuspended
   $ openshell -g aif-cluster --workspace tenant-a sandbox start demo-a
   ✓ Started sandbox demo-a           # ~15 s back to Ready=True/DependenciesReady
   ```

   A file written to `/sandbox` before the stop is still there after the start — verified.
3. **Dropping the connection does not.** Close the terminal or Ctrl-C the client and the
   sandbox stays `Ready`; reconnecting reattaches read-write and replays the scrollback.
   Verified. (The supervisor also implements a Ctrl-P Ctrl-Q detach sequence —
   `openshell-supervisor-process/src/ssh.rs:406` — but the CLI does not advertise it and I
   could not get it to fire through a scripted PTY; just close the client.)

This is also the step that proves the two charts agree on the gateway pod selector
([`openshell-blueprints.md`](./openshell-blueprints.md) §4): `connect` goes over SSH on
:2222, which is exactly the traffic the tenant NetworkPolicy governs. If the podSelector
were wrong, `sandbox exec` (gRPC) would still work and only `connect` would fail — a nasty
half-broken state, and the reason the 0.2.0 release-name change must be re-verified with
this command and not with `exec`. **Done: `connect` landed a shell on the first attempt
against a stack installed from the 0.2.0 Blueprints on 2026-09-04**, with
`gateway.networkPolicy.podSelector` removed from Blueprint B and `releaseName: openshell`
the only thing keeping the two charts in agreement.

---

## Part 8 — Run Claude Code inside the sandbox

Claude Code is baked into the sandbox base image
(`OpenShell-Community/sandboxes/base/Dockerfile:91`), so there is nothing to install.

The interesting part is OpenShell's **binary-aware egress policy**. The image declares
which binaries may reach which hosts (`sandboxes/base/policy.yaml`): `/usr/local/bin/claude`
and `/usr/bin/node` may reach `api.anthropic.com`; nothing else may reach anything.

Same URL, two different binaries — verified live:

```console
$ openshell -g aif-cluster --workspace tenant-a sandbox exec -n demo-a --no-tty -- \
    curl -sS -m 10 https://api.anthropic.com/v1/models
curl: (56) CONNECT tunnel failed, response 403

$ openshell -g aif-cluster --workspace tenant-a sandbox exec -n demo-a --no-tty -- \
    node -e 'fetch("https://api.anthropic.com/v1/models").then(r=>console.log("status:",r.status))'
status: 401
```

`curl` is refused at the proxy. `node` gets through and reaches Anthropic, which answers
401 because no key was sent. That is the whole idea: the agent can call its model, and
nothing else in the sandbox can call anything.

Now with a key. A deliberately bogus one first, to show the request really does leave the
sandbox and reach Anthropic:

```console
$ openshell -g aif-cluster --workspace tenant-a sandbox exec -n demo-a --no-tty \
    --env ANTHROPIC_API_KEY=sk-ant-DUMMY -- claude -p "say hi"
Failed to authenticate. API Error: 401 API key is invalid.
```

Swap in a real key and it answers.

Or interactively, which demos better:

```console
$ openshell -g aif-cluster --workspace tenant-a sandbox connect demo-a
ubuntu@demo-a:~$ export ANTHROPIC_API_KEY=sk-ant-…
ubuntu@demo-a:~$ claude
```

> **The `provider attach` path does not work out of the box.** OpenShell's intended flow is
> `provider create --type claude-code --credential ANTHROPIC_API_KEY=…` followed by
> `sandbox provider attach demo-a claude`, so the key is injected by the gateway and never
> typed into a shell. `provider create` succeeds; `attach` fails:
>
> ```
> credentialed endpoint 'statsig.anthropic.com:443' in rule 'claude_code' uses L4-only;
> configure L7 inspection or explicitly set allow_uninspected_credentials: true
> ```
>
> The base image's policy declares statsig/sentry as L4-only while the gateway runs
> `policy_validation_failure_mode = "fail_closed"`, and `attach` re-validates against the
> *image's* declared policy.
>
> `examples/openshell/policies/claude-code-l7.yaml` is the **candidate** fix: it redeclares
> those endpoints with `protocol: rest` so the proxy can inspect them. Apply it before
> attaching:
>
> ```bash
> openshell -g aif-cluster --workspace tenant-a policy set demo-a \
>   --policy examples/openshell/policies/claude-code-l7.yaml --wait
> openshell -g aif-cluster --workspace tenant-a sandbox provider attach demo-a claude
> ```
>
> **This has not been confirmed to work.** If a per-sandbox policy is not enough — because
> `attach` validates the image policy rather than the effective one — the fix belongs in
> `OpenShell-Community/sandboxes/openclaw-suse/policy.yaml`, which is a repo we own. Until
> then use `--env` / `export`, and note the credential key must be the **environment
> variable name** (`ANTHROPIC_API_KEY=…`), not `api_key=…`.

---

## Part 9 — Show the isolation boundary

```console
$ openshell -g aif-cluster --workspace tenant-a sandbox list
NAME    CREATED              PHASE
demo-a  2026-09-03 17:16:29  Ready

$ openshell -g aif-cluster --workspace tenant-b sandbox list
NAME    CREATED              PHASE
demo-b  2026-09-03 17:16:50  Ready

$ openshell -g aif-cluster --workspace tenant-b sandbox exec -n demo-a --no-tty -- hostname
Error: × code: 'Some requested entity was not found', message: "sandbox not found"
```

**Say this out loud:** in this prototype that is *workspace scoping*, not an authorization
boundary. Blueprint A sets `server.auth.allowUnauthenticatedUsers: true` so the demo needs
no OIDC provider, which means any client that can reach the gateway can address any
workspace by passing `--workspace`. The Kubernetes-level isolation underneath it is real —
separate namespaces, separate ServiceAccounts, NetworkPolicies — but the gateway is not
enforcing who you are. See gap #1 in
[`openshell-blueprints.md`](./openshell-blueprints.md#14-known-gaps).

---

## Part 10 — Install an inference engine from the UI

Everything so far proved isolation. The rest proves *usefulness*: an agent that talks to a
model the data never leaves the cluster for.

There are **two** inference blueprints in the list, deploying the same chart and model. This
is the demo's decision point, so make it out loud.

| | **OpenShell Inference (Ollama, per-tenant)** | **OpenShell Inference (Ollama, shared)** |
|---|---|---|
| Engine lives in | the tenant's namespace | `openshell` (pinned) |
| Install | once per tenant | once per cluster |
| Model copies | one per tenant, ~400 MB each | one |
| Storage | no PVC — no StorageClass needed | PVC on by default — **needs a default StorageClass** |
| Trade | isolation | efficiency; tenants share one queue |

**Which one a tenant uses is decided in Part 11 by the provider URL, not here.** So a cluster
can run both, and moving a tenant between them later is two CLI commands with no sandbox
restart. The demo below installs both — that is to show the choice, not a recommendation.

**Install the per-tenant one: Blueprints → OpenShell Inference (Ollama, per-tenant) → Install.**

| Field | Value |
|---|---|
| Instance Name | `openshell-inf-tenant-a` |
| Default Namespace | `tenant-a` — the tenant's own namespace, not `openshell` |

**Then the shared one: Blueprints → OpenShell Inference (Ollama, shared) → Install.**

| Field | Value |
|---|---|
| Instance Name | `openshell-inf-shared` |
| Default Namespace | `openshell` (pinned — the banner appears again) |

Fleet Bundle, `local`, Install. Give every install a **globally unique** instance name — the
HelmOp is `<instance-name>-ollama` and the namespace is not part of it, so two tenants reusing
a name collide on one HelmOp.

> ### Why either placement works
>
> The upstream call is made by the **sandbox pod's own supervisor**, not by the gateway:
> `openshell-supervisor-network` pulls the route bundle from the gateway over gRPC every
> ~5 s and then proxies the request itself. Co-locating the engine (per-tenant) keeps that
> hop intra-namespace; reaching across to `openshell` (shared) is an ordinary ClusterIP call.
>
> Nothing blocks the cross-namespace case: the workspace NetworkPolicy is Ingress-only on
> sandbox pods, and `inference.local` is a built-in supervisor route that is never evaluated
> against sandbox network policy (Part 12).
>
> Both pin the service name with `fullnameOverride: ollama`, so both URLs are deterministic —
> `http://ollama.<tenant>.svc.cluster.local:11434/v1` and
> `http://ollama.openshell.svc.cluster.local:11434/v1`.

**Verify.** The chart is up in a minute; the model pull adds a little more.

```console
$ kubectl -n tenant-a rollout status deploy/ollama
$ kubectl -n tenant-a exec deploy/ollama -- ollama list
NAME             ID            SIZE     MODIFIED
qwen2.5:0.5b     a8b0c5157701  397 MB   1 minute ago

$ kubectl -n openshell rollout status deploy/ollama
```

> If the shared engine's pod stays `Pending`, check the PVC — that variant enables
> `persistentVolume` by default and needs a default StorageClass. Without one, author a
> Blueprint version with it disabled.

> **On model size.** `qwen2.5:0.5b` is picked for footprint, not capability — ~400 MB is what
> makes a per-tenant engine affordable. It handles chat and proves the `inference.local` path
> end to end, but it is **weak at tool calling**, so do not expect a convincing Claude Code
> agent loop from it. Step up to `qwen2.5:1.5b` (~1 GB) or `3b` (~2 GB) if the demo needs one
> — but note `3b` is under the Qwen Research License, while `0.5b` and `1.5b` are Apache-2.0.

> **On GPUs, skip this blueprint.** Install the shipped **SUSE Inference Endpoint**
> blueprint instead (vLLM behind LiteLLM) and substitute
> `http://litellm.<ns>.svc.cluster.local:4000/v1` with a LiteLLM virtual key everywhere
> Part 11 says Ollama. Nothing else changes.

---

## Part 11 — Wire inference routing

Two commands per tenant, and then the agent has a model. **This is where the choice from
Part 10 is actually made** — the only difference between a dedicated and a shared engine is
the URL.

`tenant-a` gets its own engine:

```bash
# a provider instance pointing the built-in `openai` type at the in-cluster engine
openshell -g aif-cluster --workspace tenant-a provider create \
  --name ollama-local \
  --type openai \
  --credential OPENAI_API_KEY=ollama \
  --config OPENAI_BASE_URL=http://ollama.tenant-a.svc.cluster.local:11434/v1

# route inference.local at it
openshell -g aif-cluster --workspace tenant-a inference set \
  --provider ollama-local --model qwen2.5:0.5b
openshell -g aif-cluster --workspace tenant-a inference get
```

`tenant-b` uses the shared one — same two commands, different URL, and nothing extra
installed in `tenant-b`:

```bash
openshell -g aif-cluster --workspace tenant-b provider create \
  --name ollama-shared \
  --type openai \
  --credential OPENAI_API_KEY=ollama \
  --config OPENAI_BASE_URL=http://ollama.openshell.svc.cluster.local:11434/v1

openshell -g aif-cluster --workspace tenant-b inference set \
  --provider ollama-shared --model qwen2.5:0.5b
```

> **The choice is reversible and live.** Route bundles refresh every ~5 s, so re-running
> these two commands for a tenant moves it between engines with no sandbox restart. Worth
> demonstrating: point `tenant-a` at the shared URL, wait five seconds, and its running
> sandbox is talking to the other engine.

> ### `--workspace` is not optional here
>
> Providers and inference routes are **workspace-scoped** — `CreateProvider` and
> `SetInferenceRoute` both take a workspace and require Workspace Admin on it. The CLI
> defaults `--workspace` to `default`. Leave it off and everything lands in a workspace no
> tenant sandbox can see, and `demo-a` reports no inference route with nothing obviously
> wrong anywhere.
>
> Repeat both commands for `tenant-b`, **with tenant-b's own URL**
> (`http://ollama.tenant-b.svc.cluster.local:11434/v1`) if you installed an engine there, or
> tenant-a's if you are sharing one. (NVIDIA's inference-routing page describes the route as
> "gateway-scoped"; that holds only when every sandbox lives in `default`.)

**No custom provider profile is needed for this.** Setting an alternate base URL on the
built-in `openai` type deliberately makes it *route-only*: OpenShell withholds the static
credential from direct sandbox traffic while gateway inference routing keeps using the
upstream. The sandbox never holds a key. (`examples/openshell/providers/` documents the
other case — a custom profile, for when code inside the sandbox must call the endpoint
itself.)

Now from inside the sandbox:

```console
$ openshell -g aif-cluster --workspace tenant-a sandbox connect demo-a
ubuntu@demo-a:~$ curl -s https://inference.local/v1/chat/completions \
    -H 'content-type: application/json' \
    -d '{"model":"qwen2.5:0.5b","messages":[{"role":"user","content":"say hi in five words"}]}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["choices"][0]["message"]["content"])'
```

> **There is no `jq` in the sandbox image.** `python3` (from `/sandbox/.venv`) and `node` are
> there; `jq` is not, and a piped `jq` fails with `bash: jq: command not found` *after* the
> request has already succeeded — so the model answered and you just cannot see it. Drop the
> pipe entirely if you would rather show the raw response; the JSON is short.

Then the same thing through Claude Code, with no Anthropic key anywhere:

```console
ubuntu@demo-a:~$ ANTHROPIC_BASE_URL="https://inference.local" ANTHROPIC_API_KEY=unused claude --bare
```

`--bare` skips the OAuth login flow and uses `ANTHROPIC_API_KEY` directly. The key is a
placeholder — the privacy router strips it, injects the provider's real credential and
rewrites the model, so nothing the sandbox supplies reaches the upstream.

> ### Three things that will trip you here
>
> - **`inference.local` needs no network policy rule.** It is a built-in supervisor route,
>   not an ordinary destination, and it is never evaluated against `network_policies`. Even
>   the most restrictive policy in Part 12 leaves it reachable. Adding a rule for it does
>   nothing.
> - **The trailing `/v1` differs per client.** Claude Code wants
>   `ANTHROPIC_BASE_URL=https://inference.local` with **no** `/v1`; OpenCode and OpenAI SDKs
>   want `https://inference.local/v1`. Getting it wrong gives a 404 that looks like a
>   routing failure.
> - **`inference set` probes the upstream before saving.** If Ollama is still pulling the
>   model it fails verification. Wait, or pass `--no-verify` and re-run `inference get`
>   once the pull finishes.

**The point to make out loud:** the model endpoint, the credential and the route are gateway
state, held per workspace. The sandbox knows only the name `inference.local`. Change the
provider and every sandbox in that workspace follows within about five seconds, with no
restart and no edit inside any sandbox — and `tenant-b` can point at a completely different
model without `tenant-a` noticing.

---

## Part 12 — Customise a policy

This is the admin-facing half. Policy content is not a Helm value — it is a YAML document
applied to the gateway — but it *is* declarative, versionable and reviewable.

Start from what a sandbox has now:

```bash
openshell -g aif-cluster --workspace tenant-a policy get demo-a --base > /tmp/demo-a-base.yaml
openshell -g aif-cluster --workspace tenant-a policy get demo-a --full   # incl. generated _provider_* rules
```

Apply a curated tenant policy — SUSE registries, PyPI and npm, and nothing else:

```bash
openshell -g aif-cluster --workspace tenant-a policy set demo-a \
  --policy examples/openshell/policies/tenant-suse-ai.yaml --wait
```

`--wait` blocks until the supervisor confirms the reload. **No restart, and the sandbox stays
connected** — `network_policies` and `network_middlewares` are hot-reloadable.
`filesystem_policy`, `landlock` and `process` are not; changing those needs the sandbox
recreated. Prove the hot part live, from the shell you are already in:

```console
ubuntu@demo-a:~$ pip download requests -d /tmp/x     # allowed
ubuntu@demo-a:~$ curl -sS -m 10 https://example.com  # denied at the proxy
```

Incremental edits, with a dry run first. `--add-endpoint` opens a host;
`--add-allow` narrows an already-open host to specific methods and paths:

```bash
# host:port[:access[:protocol[:enforcement[:options]]]]
openshell -g aif-cluster --workspace tenant-a policy update demo-a \
  --add-endpoint 'github.com:443:read-only:rest:enforce' \
  --binary /usr/bin/git --dry-run

# host:port:METHOD:path_glob
openshell -g aif-cluster --workspace tenant-a policy update demo-a \
  --add-allow 'api.github.com:443:GET:/repos/**' --dry-run
```

### The redaction beat

`tenant-suse-ai.yaml` also carries a `network_middlewares` block wiring OpenShell's built-in
`openshell/regex` redactor. It runs on egress *after* policy admits the request and *before*
credential injection, so a key an agent pastes into an outbound body never leaves:

```console
ubuntu@demo-a:~$ curl -sS -X POST https://pypi.org/ -d 'token=sk-ant-api03-REALLOOKINGKEY'
```

The token is replaced before the request leaves the supervisor. If a middleware stage fails
instead, `on_error: fail_closed` denies the request outright and you see:

```json
{"error":"middleware_denied","reason_code":"..."}
```

Two caveats worth saying rather than hiding: it is regex-based, not parser-aware — defence in
depth, not a guarantee — and it cannot apply to `tls: skip` endpoints, which the validator
enforces by rejecting a `fail_closed` selector that could match one.

This is also the only part of OpenShell's extensibility surface reachable from a
Blueprint-delivered gateway. Gateway interceptors and custom operator-run middleware register
in `gateway.toml`, which the chart does not template — see
[`openshell-blueprints.md`](./openshell-blueprints.md#10-policies-and-extension-points) for
what that blocks and the governance-interceptor plan that fixes it.

### The gateway-wide floor

`examples/openshell/policies/global-baseline.yaml` shows the other scope:

```bash
openshell -g aif-cluster policy set --global --policy examples/openshell/policies/global-baseline.yaml
```

> **Only do this at the very end of the demo, or not at all.** A global policy is applied
> **in full** to every sandbox, and while one is set the gateway **rejects every
> sandbox-level policy update**. Everything you did earlier in this Part stops working until
> `openshell -g aif-cluster policy delete --global`.

---

## Part 13 — Workspace RBAC (narrated, not demonstrated)

OpenShell has a real RBAC model over workspaces — Platform Admin, Workspace Admin, Workspace
User; `openshell whoami`; `workspace member add/remove`; scoped tokens.

**It is inert in this demo, and you should say so.** With
`server.auth.allowUnauthenticatedUsers: true` every caller is accepted as the same local
developer principal and is a Platform Admin, so there is no subject to bind a role to:

```console
$ openshell -g aif-cluster whoami
```

To make this real, configure `server.oidc.*` in Blueprint A — `issuer`, `audience`,
`rolesClaim` (`realm_access.roles` for Keycloak, `roles` for Entra ID, `groups` for Okta),
`adminRole` and `userRole` (both or neither) — and set `allowUnauthenticatedUsers: false`.
The block is present and annotated in `10-blueprint-openshell-gateway.yaml`, commented out.
Changing it means authoring Blueprint version 0.3.0 (Part 2's note), not editing the running
workload.

Until then, the honest claim is: **Kubernetes-level isolation is real and enforced; gateway
identity is not.**

---

## Cleanup

```bash
for t in tenant-a tenant-b; do
  openshell -g aif-cluster --workspace $t sandbox list -o json \
    | jq -r '.[].name' | xargs -r -n1 openshell -g aif-cluster --workspace $t sandbox delete
done

openshell -g aif-cluster policy delete --global      # only if you ran Part 12's last step
for t in tenant-a tenant-b; do
  openshell -g aif-cluster --workspace $t inference delete
  openshell -g aif-cluster --workspace $t provider delete ollama-local 2>/dev/null
  openshell -g aif-cluster --workspace $t provider delete ollama-shared 2>/dev/null
done

kubectl delete aiworkload -n tenant-a openshell-ws-tenant-a
kubectl delete aiworkload -n tenant-b openshell-ws-tenant-b
kubectl delete aiworkload -n tenant-a openshell-inf-tenant-a
kubectl delete aiworkload -n openshell openshell-inf-shared
kubectl delete aiworkload -n openshell openshell-gw-local
kubectl delete ns tenant-a tenant-b openshell

kubectl delete -f examples/openshell/10-blueprint-openshell-gateway.yaml \
                  -f examples/openshell/20-blueprint-openshell-workspace.yaml \
                  -f examples/openshell/40-blueprint-openshell-inference-ollama-tenant.yaml \
                  -f examples/openshell/41-blueprint-openshell-inference-ollama-shared.yaml \
                  -f examples/openshell/00-clusterrepo.yaml
```

Deleting an AIWorkload in the UI (Workloads → ⋮ → Delete) does the same thing.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `sandbox connect` hangs, no output, no error | Sandbox created with `-- sleep infinity`; connect is attached to the sleeping main process | Recreate with no trailing command (Part 7) |
| `sandbox connect` hangs, sandbox is `Ready`, main process *is* `bash -l` | Sandbox was created from a non-terminal (script/CI/agent tool call), so TTY auto-detection baked `"tty":false` into the main process spec | Delete and recreate with an explicit `--tty` (Part 7). `connect` cannot attach a PTY after the fact |
| `sandbox connect` produces nothing in a script | No TTY on the client side | Run it in a real terminal; use `sandbox exec` in scripts |
| Sandbox goes `Ready → False / PodSucceeded` right after you use it | You typed `exit`; the main process *is* the sandbox | Expected. Close the client instead of exiting; to pause, `sandbox stop` then `sandbox start` |
| Reconnect fails with `"sandbox is not ready"` | Same cause — the sandbox is `PodSucceeded` from a previous `exit` | `sandbox start` cannot revive it (`PodSucceeded: Pod completed successfully`). `sandbox delete` + `sandbox create`; the workspace volume is lost |
| `sandbox exec demo-a -- cmd` runs `demo-a` as the command | `exec` takes the sandbox via `-n/--name`, unlike `connect`/`stop`/`start`/`delete` which take it positionally | `sandbox exec -n demo-a -- cmd` |
| `jq: command not found` inside a sandbox | The sandbox image ships `python3` and `node`, not `jq` | Pipe to `python3 -c ...` instead (Part 11), or drop the pipe and read the raw JSON |
| `workspace 'tenant-a' not found` | Command hit the local laptop gateway, not the cluster | Pass `-g aif-cluster`; never name the registration `openshell` |
| `invalid peer certificate: BadSignature` | Certificates copied before `gateway add` overwrote them | Re-copy the three files from `openshell-client-tls` |
| `sandbox create` fails with `The system is not in a state required for the operation's execution` / `workspace 'tenant-a' is not in the operator namespace allowlist`, and the namespace looks fine | Namespace missing the discovery label. The message names the *workspace*, so it reads like a gateway or workspace-registration problem — it is not. `workspaceMode: operator` finds tenant namespaces purely by label, and a recreated namespace comes back without it | `kubectl label ns <t> ai-factory.suse.com/openshell-workspace=true`. Applied live, no gateway restart: `kubectl -n openshell logs openshell-0 \| grep allowlist` shows `operator namespace added to allowlist` within a second. Verified 2026-09-04 |
| `downloading OCI chart …: helm chart download: could not locate a version matching provided version string ` (note the trailing space — the version is *empty*) | Fleet generated the Bundle without `spec.helm.version`, so the agent asked for "latest stable". `openshell-workspace` publishes only `0.0.0-dev.*` prereleases, so there is no latest stable and it fails hard | `kubectl -n fleet-default patch helmop <name> --type=merge -p '{"spec":{"forceSyncGeneration":1}}'` — Fleet rewrites the Bundle with the version and it deploys within seconds. Always verify with the version check below |
| Gateway is `Running` but on the wrong chart version | Same root cause, silent instead of fatal: `helm-chart` *does* have a stable release, so the empty version resolved to `0.0.116` rather than the pinned dev SHA | `helm list -n openshell` — if `CHART` is not `helm-chart-0.0.0-dev.<sha>`, force-sync as above. See §7 of the design doc |
| Gateway install fails at preflight: `Agent Sandbox is required but neither agents.x-k8s.io/v1beta1 nor …` | agent-sandbox CRDs absent **on the target cluster** — easy to hit when you install onto a downstream cluster but prepped the Rancher one | Run Part 1.1 against the target cluster. Do **not** delete the failed workload: Fleet retries and the HelmOp goes `1/1` on its own within ~60 s. Never set `agentSandbox.preflight.enabled=false` — it is telling the truth |
| Two tenants' resources appear in one namespace | AIWorkload instance-name collision | Unique instance names (Part 4) |
| Sandbox pod stuck `Pending` on its PVC | No default StorageClass | Set one, or set `workspaceStorageClass` in Blueprint A |
| `exec` works but `connect` fails | Gateway/workspace charts disagree on the pod selector | Blueprint A must set `releaseName: openshell` — design doc §4 |
| Values you set on the AIWorkload have no effect | `componentValues` is ignored on the Blueprint path | Author a new Blueprint version — design doc §7 |
| `policy set <sandbox>` rejected | A gateway-global policy is in force | `policy delete --global`, or fold the change into the global file |
| `provider attach` fails with `uses L4-only` | The image policy declares that endpoint without `protocol:` | Apply `policies/claude-code-l7.yaml` first (Part 8) |
| `inference set` fails verification | Engine still pulling the model | Wait, or `--no-verify` and re-check with `inference get` |
| Sandbox reports no inference route; `inference get` looks fine | Provider/route created in the `default` workspace | Both are workspace-scoped — re-run with `--workspace <tenant>` (Part 11) |
| `settings set --key providers_v2_enabled` fails as an unknown key | The key was removed; v2 is the only mode | Drop the command |
| HTTP 403 `credential_endpoint_mismatch` | Request host/port/path is outside the profile's declared endpoints | Fix the profile's `endpoints`, not the request |
| Agent gets 404 from `inference.local` | Wrong trailing `/v1` for that client | Claude Code: no `/v1`. OpenAI SDKs and OpenCode: `/v1` |
| `GRPCRoute` is up but the CLI cannot connect | Gateway API terminates TLS at Envoy; gateway still expects it | Set `server.disableTls: true` — and then OIDC is mandatory |

---

## What to say at the end

- Three blueprints, released operator 2.2.0, **zero operator code changes** — the whole Helm
  half of the integration is Blueprint values.
- Onboarding tenant N is one more run of the install wizard.
- The sandbox is a real Kubernetes pod in the tenant's own namespace, with the agent's
  network egress restricted per binary, talking to a model that never leaves the cluster.
- The admin controls egress and secret redaction with a reviewable YAML policy, applied to a
  running sandbox in seconds.
- And it is a **prototype**: auth is off, roughly half the configuration is CLI state rather
  than Blueprint values, three steps are still manual (agent-sandbox, namespace labels,
  workspace creation), and the gateway is reached over a port-forward. Every gap is
  enumerated in [`openshell-blueprints.md`](./openshell-blueprints.md#14-known-gaps).
