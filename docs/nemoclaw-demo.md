# NemoClaw → cluster sandbox — minimal demo flow

The short path: deploy the OpenShell stack from the AI Factory UI, then drive a sandbox
running in the cluster with the **local `nemoclaw` binary**, ending in an interactive shell.

This runbook starts at **deployment**. It assumes the Blueprint CRs and the chart
`ClusterRepo` are already registered — if they are not, do Parts 1–2 of
[`openshell-demo.md`](./openshell-demo.md) first.

**Where this stops.** At `nemoclaw <name> connect` — a login shell in the cluster sandbox,
with OpenClaw running inside it. It deliberately does **not** demo `nemoclaw <name> agent`;
see [Why the agent loop is not in this demo](#why-the-agent-loop-is-not-in-this-demo).

**Two clusters, two contexts.** `Blueprint` and `AIWorkload` CRs live on the management
cluster; the gateway, sandboxes and Ollama run on the downstream cluster. Every `kubectl`
below is explicit about which one.

```bash
MGMT=<primary-context>        # aif-operator, Blueprint + AIWorkload CRDs
DOWN=<managed-context>        # openshell gateway, tenant namespaces, sandboxes
```

---

## 1. Namespaces

The wizard's namespace picker does not create namespaces, and the label is what the
workspace Blueprint keys off — without it the chart installs but the gateway cannot see the
tenant, and `sandbox create` later fails with a workspace error that never mentions labels.

```bash
kubectl --context $DOWN create namespace openshell
kubectl --context $DOWN create namespace tenant-a
kubectl --context $DOWN label namespace tenant-a ai-factory.suse.com/openshell-workspace=true
```

The label can be added later — the gateway picks it up live.

## 2. Deploy the stack from the AI Factory UI

**Rancher → top-left product menu → SUSE AI → Blueprints.** Three installs, same three-step
wizard each time. For every one: **Step 2** Deployment Type **Fleet Bundle**, Target Cluster
**local**; **Step 3** Review, **Install**.

> ### Instance names must be globally unique
>
> The Fleet HelmOp is named `<instance-name>-<chartName>` and the AIWorkload's namespace is
> *not* part of it. Two installs sharing an instance name collide on one HelmOp. The
> wizard will not stop you — its uniqueness check only looks within the chosen namespace.
> Put the tenant in the name.

**2.1 — OpenShell Gateway** v0.2.1

| Field | Value |
|---|---|
| Instance Name | `openshell-gw-local` |
| Default Namespace | `openshell` |

A blue banner appears: *1 component deploys to its own fixed namespace and will ignore this
value.* Expected — the Blueprint pins `targetNamespace: openshell`.

**2.2 — OpenShell Workspace** v0.2.0

| Field | Value |
|---|---|
| Instance Name | `openshell-ws-tenant-a` |
| Default Namespace | `tenant-a` |

No banner here: this Blueprint pins no namespace, so the one you pick *is* the tenant.
Onboarding another tenant is one more run of this same wizard.

**2.3 — OpenShell Inference (Ollama, per-tenant)** v0.2.1

| Field | Value |
|---|---|
| Instance Name | `openshell-inf-tenant-a` |
| Default Namespace | `tenant-a` — the tenant's namespace, not `openshell` |

There is also a **shared** variant that pins itself to `openshell` and is installed once per
cluster. Either works; which one a tenant actually uses is decided by the provider URL in
step 3, not here. The per-tenant one keeps this runbook's URLs simple.

**Verify.** In the UI, **Workloads** shows all three as **Running**. On the clusters:

```bash
kubectl --context $MGMT get aiworkload -A          # three, Running
kubectl --context $DOWN -n openshell get sts,svc   # openshell 1/1, ClusterIP 8080/9090
kubectl --context $DOWN -n tenant-a  get pods      # ollama-… must be 1/1
```

Ollama's first start pulls `qwen3:1.7b` (~1.4 GB) before it answers.

> **`Running` is not sufficient — check the chart version pin took.** A dropped pin fails
> silently. On the management cluster the Bundle must carry a version, and on the downstream
> cluster the chart must be `helm-chart-0.0.0-dev.<sha>`:
>
> ```bash
> kubectl --context $MGMT get bundle -A \
>   -o jsonpath='{range .items[*]}{.metadata.name}{" -> "}{.spec.helm.version}{"\n"}{end}' | grep openshell
> helm --kube-context $DOWN list -n openshell
> ```

> **Targeting a downstream cluster rather than `local` renames things.** The HelmOp lands in
> `fleet-default`, not `fleet-local`, and the operator appends the Fleet cluster ID to the
> instance name — e.g. `openshell-gw-local-c-9qtkk`. Find them with
> `kubectl --context $MGMT get helmop -A | grep openshell`. The objects on the downstream
> cluster are unchanged.

The equivalent of all three installs is
[`examples/openshell/30-aiworkloads-demo.yaml`](../examples/openshell/30-aiworkloads-demo.yaml)
if you ever need to script it — the wizard produces the same AIWorkloads.

## 3. Create the OpenShell workspace, provider and inference route

Blueprint B built the *Kubernetes* side of the tenant. The OpenShell **workspace** object,
the provider and the inference route are gateway runtime state and are still manual. The
workspace name must equal the namespace name.

These use your normal `~/.config/openshell` registration, named `aif-cluster`.

**First, open the port-forward.** The gateway is only reachable through it, and nothing so
far has started one — the wrapper in step 4 starts its own, but that is later and on a
separate registration. Without this you get:

```
Error:   x transport error
  |-> tcp connect error
  `-> Connection refused (os error 61)
```

```bash
kubectl --context $DOWN -n openshell port-forward --address 127.0.0.1 svc/openshell 28080:8080 &
```

Start it in the shell you are running the demo from, so it lives as long as the demo does.

If instead you get `bind: address already in use`, a forward is already up — reuse it and
move on. Confirm it is a live one rather than a stale binding:

```bash
lsof -nP -iTCP:28080 -sTCP:LISTEN     # empty output = port is actually free, just retry
```

If `aif-cluster` is not registered yet, do it now — **register first, copy the certificates
second**; the other order fails with `BadSignature`, because `gateway add --local` seeds its
own material into `mtls/`:

```bash
openshell gateway add https://127.0.0.1:28080 --name aif-cluster --local

D=~/.config/openshell/gateways/aif-cluster/mtls; mkdir -p $D
for f in tls.crt tls.key ca.crt; do
  kubectl --context $DOWN -n openshell get secret openshell-client-tls \
    -o "jsonpath={.data.${f/./\\.}}" | base64 -d > "$D/$f"
done
chmod 600 $D/tls.key
```

Confirm before going on — this must print `Connected`:

```console
$ openshell -g aif-cluster status
  Gateway:         aif-cluster
  Server:          https://127.0.0.1:28080
  Status:          Connected
  Authentication:  Authenticated (mTLS transport)
```

> **Do not name the registration `openshell`** if a local OpenShell daemon is running — it
> owns that name and rewrites the endpoint back to `https://localhost:17670`, after which
> every command targets the wrong gateway and fails with `workspace 'tenant-a' not found`.

Now the three pieces of gateway state:

```bash
openshell -g aif-cluster workspace create --name tenant-a

openshell -g aif-cluster --workspace tenant-a provider create \
  --name ollama-local \
  --type openai \
  --credential OPENAI_API_KEY=ollama \
  --config OPENAI_BASE_URL=http://ollama.tenant-a.svc.cluster.local:11434/v1

openshell -g aif-cluster --workspace tenant-a inference set \
  --provider ollama-local --model qwen3:1.7b --no-verify

openshell -g aif-cluster --workspace tenant-a inference set \
  --provider ollama-local --model qwen3:1.7b --no-verify --system
```

> **Set the `--system` route too.** There are two inference routes per workspace: the
> user-facing one and `--system`, used by platform functions including the agent harness.
> Setting only the first leaves OpenClaw without a model.

> **`--workspace` is not optional.** Providers and routes are workspace-scoped and the CLI
> defaults to `default`. Omit it and the tenant's sandboxes see no provider at all.

`--no-verify` skips the pre-save probe, which times out while Ollama is still loading the
model. Drop it once the pod has been up a few minutes.

## 4. Point NemoClaw at the cluster and connect

One command. The wrapper handles the port-forward, an isolated gateway registration, the
mTLS material, sandbox creation, NemoClaw's local registry, and the OpenClaw bootstrap:

```bash
cd examples/openshell
./bin/aif-nemoclaw demo-a connect
```

```console
[aif-nemoclaw] starting port-forward openshell/openshell -> 127.0.0.1:28080
[aif-nemoclaw] registering gateway 'nemoclaw-28080'
[aif-nemoclaw] copying mTLS material from secret/openshell-client-tls
[aif-nemoclaw] creating sandbox 'demo-a' in workspace 'tenant-a'
[aif-nemoclaw] bootstrapping OpenClaw in 'demo-a' (~45s)
✓ Active gateway set to 'nemoclaw-28080'
  ✓ Dashboard port forward re-established.
sandbox@demo-a:~$
```

That prompt is a shell in a pod on the downstream cluster. Prove it from the shell:

```console
sandbox@demo-a:~$ hostname; whoami
demo-a
sandbox
sandbox@demo-a:~$ openclaw --version
OpenClaw 2026.5.18 (50a2481)
sandbox@demo-a:~$ ps -eo pid,tty,stat,args | head -4
    PID TT       STAT COMMAND
      1 ?        SLsl /opt/openshell/bin/openshell-sandbox --workdir /sandbox
     50 pts/0    Ss   /bin/bash -l
    843 ?        Ssl  openclaw
```

And that the cluster-hosted model is reachable from inside the sandbox, through OpenShell's
inference router:

```console
sandbox@demo-a:~$ curl -s https://inference.local/v1/chat/completions \
    -H 'content-type: application/json' \
    -d '{"model":"x","messages":[{"role":"user","content":"say hi"}],"max_tokens":16}'
{"model":"qwen3:1.7b", … "content":"Hi! How are you?"}
```

Note the request said `"model":"x"` and the reply is `qwen3:1.7b` — the router **rewrites
the model name**, strips the sandbox's credential and injects the real one. The model id a
client sends is only a label; the route is the truth.

---

## Do not type `exit`

`connect` attaches to the sandbox's **main** process (`/bin/bash -l`, PID 50). Typing
`exit` terminates it, the pod goes `Completed`, and the sandbox becomes `Unknown` — you must
delete and recreate it.

To leave the session without killing the sandbox, **detach**: close the terminal, or
interrupt the client. The pod stays `Running` and the next `connect` reattaches.

---

## What the wrapper does, and why each step is needed

Useful to narrate; each of these is a trap that cost real debugging time.

| Step | Why |
|---|---|
| `XDG_CONFIG_HOME` to an isolated dir | keeps this registration out of `~/.config/openshell` |
| `NEMOCLAW_GATEWAY_PORT=28080` | NemoClaw derives the gateway *name* from the port: `8080` → `nemoclaw`, else `nemoclaw-<port>`. A non-default port leaves a local `nemoclaw` registration untouched |
| `OPENSHELL_WORKSPACE=tenant-a` | providers, routes and sandboxes are workspace-scoped; unset means `default`, where the tenant's sandboxes are invisible |
| register **then** copy certs | `gateway add --local` seeds its *own* self-signed material into `mtls/`; the other order fails with `BadSignature` |
| copy certs **unconditionally** | "a cert exists" ≠ "our cert exists" — `--local` just wrote one that is not ours. Surfaces later, misleadingly, as *gateway is not reachable* |
| `sandbox create --tty`, no trailing command | the main process is `SandboxSpec.command` (default `/bin/bash -l`). A trailing command replaces it and you get a sandbox you cannot attach a shell to |
| seed `~/.nemoclaw/sandboxes.json` | NemoClaw looks up sandbox names in its own local registry first; a cluster-created sandbox has to be introduced |
| run `openclaw-suse-start` | see below |

NemoClaw never speaks gRPC to the gateway — every sandbox operation shells out to the local
`openshell` binary with `-g <name>` injected. That is the whole seam: no NemoClaw patch, and
no security guard bypassed. The port-forward puts the gateway on a literal `127.0.0.1`,
which is what OpenShell's loopback rule for externally-supervised gateways contemplates.

### The OpenClaw bootstrap

`connect` requires an OpenClaw gateway *already listening inside* the sandbox. It detects a
missing one and tries to recover, but that path is Docker-privileged and fails here:

```
Failure layer: privileged control unavailable - gateway restart failed for 'demo-a'.
PRIVILEGED_CONTROL_UNAVAILABLE
```

The image ships `/usr/local/bin/openclaw-suse-start` to do this setup, but OpenShell never
runs it: the sandbox's main process is `SandboxSpec.command`, not the image `ENTRYPOINT`.
So the wrapper runs it once, explicitly.

Two details worth knowing:

- **Use the start script, not a bare `openclaw gateway`.** The script also pins
  per-provider `timeoutSeconds` and sets thinking **off**. Starting the gateway by hand
  leaves `thinking=medium`, and on CPU that is the difference between slow and unusable.
  Confirm in `/tmp/gateway.log`: `agent model: … (thinking=off, fast=off)`.
- **`CHAT_UI_URL` must be set.** The script hard-requires it, but only to build the browser
  Control UI's CORS origin list — nothing the CLI flow uses. NemoClaw injects it at
  container launch in its Docker topology; nothing sets it here. Without it the script dies
  on `KeyError: 'CHAT_UI_URL'` *after* onboarding but *before* starting the gateway, which
  looks like a successful bootstrap. The wrapper sets it to `http://127.0.0.1:18789`.

---

## Why the agent loop is not in this demo

`nemoclaw demo-a agent` does work — it completes real multi-step tool-calling turns against
the cluster-hosted model — but it is too slow to show live. Measured on the test cluster:

| Model | Agent turn |
|---|---|
| `qwen3:1.7b` | 7m21s; a second, simpler prompt took 5m00s and answered wrongly |
| `qwen2.5:7b-instruct` | >10m, no output |

The bigger model was **worse**, which rules out model quality as the cause. The evidence
points at CPU prompt-eval of OpenClaw's system prompt, which loads seven plugins (browser,
canvas, device-pair, file-transfer, memory-core, phone-control, talk-voice). A larger model
just makes each pass slower. This was not confirmed by a direct prompt-eval measurement, so
treat it as strongly indicated rather than proven.

This contradicts the single-turn benchmark in the MODEL CHOICE block of
[`40-blueprint-openshell-inference-ollama-tenant.yaml`](../examples/openshell/40-blueprint-openshell-inference-ollama-tenant.yaml),
where `qwen2.5:7b-instruct` scored 8/9 at 5.2s against `qwen3:1.7b`'s 5/9 at 9.2s. Both are
accurate: the 7 B is the better model for a *single* short request, and the worse choice
under an agent harness on CPU. Stepping up the model does not rescue the agent loop here; a
GPU inference path would be the thing to change.

If you want to show the agent anyway, pre-warm the model and script one short prompt, and
pass `--agent main` (without it: `No target session selected`).

---

## Troubleshooting

**`gateway 'nemoclaw-28080' is not answering`** — usually a dead port-forward, not certs.
Check `/tmp/aif-nemoclaw-pf.log`, and that `secret/openshell-client-tls` is the *client*
cert.

**Sandbox is `Unknown` and the pod is `Completed`** — someone typed `exit` in a `connect`
session. Recreate:

```bash
openshell -g aif-cluster --workspace tenant-a sandbox delete demo-a
openshell -g aif-cluster --workspace tenant-a sandbox create --name demo-a --detach --tty
```

(`sandbox delete` takes bare names — there is no `--force` flag.)

**Killing the in-sandbox OpenClaw gateway.** Its process rewrites its argv to just
`openclaw`, so `pkill -f "openclaw gateway"` never matches it — while
`pgrep -f "openclaw gateway"` *does* match your own `bash -lc` wrapper. Both fail in
opposite, misleading directions. `openclaw gateway stop` prints *Gateway service disabled*
but leaves the process alive. Kill the PID from `/tmp/gateway.log`'s
`gateway already running (pid N)`.

**Ollama's HelmOp stuck `Pending`, release `failed`** —
`PersistentVolumeClaim "ollama" is invalid: spec.resources.requests.storage: Forbidden:
field can not be less than previous value`. PVCs grow but never shrink; the Blueprint's
`persistentVolume.size` is now below what the PVC was created at. Delete the PVC (losing the
pulled model) or raise the size in a new Blueprint version.

**Agent says `No target session selected`** — pass `--agent main`; discover ids with
`openclaw agents list` inside the sandbox.

---

## Cleanup

```bash
openshell -g aif-cluster --workspace tenant-a sandbox delete demo-a
pkill -f "port-forward.*28080"
rm -rf ~/.aif-nemoclaw
```

Then remove the three installs from **SUSE AI → Workloads** in the UI (or
`kubectl --context $MGMT delete aiworkload -A --all` if nothing else is installed), and drop
the namespaces:

```bash
kubectl --context $DOWN delete namespace tenant-a openshell
```
