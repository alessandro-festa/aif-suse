# SUSE Security as a two-cluster federation

The CPU profile runs its agents on `downstream-1`. SUSE Security is the oracle at
**both** ends of the remediation loop — triage reads a finding from it, and validation
asks it to rescan after the patch. So the agents need a controller REST API they can
reach, and the human needs one place to read findings from.

A single install cannot give both. This directory is the two-cluster arrangement that can.

| Cluster | Context | Role | Values |
|---|---|---|---|
| `sims-datacenter` | `kind-sims-datacenter` | federated **primary** (master) | [`primary-sims-datacenter.values.yaml`](primary-sims-datacenter.values.yaml) |
| `downstream-1` | `kind-downstream-1` | federated **managed** (remote) | [`managed-downstream-1.values.yaml`](managed-downstream-1.values.yaml) |

This replaces the cross-cluster NodePort sketch that an earlier draft of the plan used.
The reason is one line in the managed values: setting `controller.apisvc.type` creates
`neuvector-svc-controller-api` on port 10443 in `cattle-neuvector-system`, **on the same
cluster as the agents**. So the `suse_security` group in the sandbox policies names an
ordinary in-cluster DNS host, instead of a node IP and NodePort that differ in every
environment and would have to be edited at install time. The policy file is the security
boundary and the most carefully argued file in the example; keeping it declarative and
environment-independent is worth a second install of NeuVector.

### A bug this surfaced in the GPU profile

[`../../../secops-agent-factory/policies/remediation-sandbox.yaml:217`](../../../secops-agent-factory/policies/remediation-sandbox.yaml#L217)
points its `suse_security` group at:

```yaml
- host: neuvector-svc-controller.cattle-neuvector-system
  port: 10443
```

That Service exists, but it is the **headless** controller Service and it listens on
18300/18301 only. The Service that serves the REST API on 10443 is
`neuvector-svc-controller-**api**`, and the chart does not create it at all unless
`controller.apisvc.type` is set. The GPU policy was written against a cluster with no
NeuVector installed, so nothing caught it.

The five CPU policies must use the `-api` name. It is a one-token difference, but the
GPU file is wrong as committed and should be corrected too.

## What is *not* here

This is a **platform prerequisite, not a Blueprint component.** SUSE Security is not
installed by `20-blueprint-secops-cpu.yaml` and must not be — it is cluster
infrastructure with its own lifecycle, owned by whoever owns the cluster, exactly as
[`../../../secops-agent-factory/integrations/suse-security-prereq.md`](../../../secops-agent-factory/integrations/suse-security-prereq.md)
describes for the GPU profile. The Blueprint consumes it; it does not manage it.

## Measured facts these files depend on

Everything below was read from the live clusters, not assumed. Re-check before reusing
these files anywhere else — most of it is per-environment.

| Fact | Value | How to re-check |
|---|---|---|
| Rancher server URL | `https://rancher-192-168-1-74.sslip.io:8443` | `kubectl get settings.management.cattle.io server-url -o jsonpath='{.value}'` |
| `downstream-1` Rancher cluster ID | `c-jhrj6` | `kubectl get clusters.management.cattle.io -o custom-columns='ID:.metadata.name,NAME:.spec.displayName'` |
| System project — `local` / `downstream-1` | `p-5ptgb` / `p-glplv` | `kubectl get projects.management.cattle.io -n <clusterId>` |
| Node IPs | `10.89.0.2` (primary); `10.89.0.3/.4/.5` (downstream-1) | `kubectl get nodes -o wide` |
| NodePorts in use | **none**, on either cluster — 30443/30444 are free | `kubectl get svc -A -o json \| jq '..\|.nodePort? // empty'` |
| Chart version | `110.0.1+up2.11.1` (core 2.11.1) | `ClusterRepo/rancher-charts`, branch `release-v2.15` |

The Rancher URL is the sslip.io ingress, **not** a port-forward. The distinction is
load-bearing: `global.cattle.url` is what the controller builds its Rancher SSO redirect
from, and a port-forward port changes between sessions, so an SSO login configured
against one would break silently the next day. The previous install had exactly this
bug — `https://localhost:56861/`.

## Install

Rancher's chart repo is a git repo, not a Helm repo, so `helm pull --repo
https://git.rancher.io/charts` returns a 404. Clone it:

```sh
git clone --depth 1 -b release-v2.15 https://git.rancher.io/charts /tmp/rcharts
CHARTS=/tmp/rcharts/charts
VER=110.0.1+up2.11.1
```

The CRD chart is separate and must go first on each cluster — a fresh cluster has no
NeuVector CRDs (verified: the previous uninstall removed them).

### 1. Primary — `sims-datacenter`

```sh
helm install neuvector-crd "$CHARTS/neuvector-crd/$VER" \
  --kube-context kind-sims-datacenter \
  -n cattle-neuvector-system --create-namespace

helm install neuvector "$CHARTS/neuvector/$VER" \
  --kube-context kind-sims-datacenter \
  -n cattle-neuvector-system \
  -f primary-sims-datacenter.values.yaml
```

### 2. Managed — `downstream-1`

```sh
helm install neuvector-crd "$CHARTS/neuvector-crd/$VER" \
  --kube-context kind-downstream-1 \
  -n cattle-neuvector-system --create-namespace

helm install neuvector "$CHARTS/neuvector/$VER" \
  --kube-context kind-downstream-1 \
  -n cattle-neuvector-system \
  -f managed-downstream-1.values.yaml
```

### 3. The Rancher UI extension

Rancher 2.15 has **no built-in SUSE Security navigation** — it comes from an extension, and on a
fresh Rancher it is not installed. Without it there is no *SUSE Security* entry in the cluster menu
and the federation join (step 4) has no UI to happen in.

The chart is in the `rancher-ui-plugins` ClusterRepo, which is git-backed, so clone rather than
`helm repo add`:

```sh
git clone --depth 1 -b main https://github.com/rancher/ui-plugin-charts /tmp/uiplugins

helm install neuvector-ui-ext /tmp/uiplugins/charts/neuvector-ui-ext/2.2.1 \
  --kube-context kind-sims-datacenter -n cattle-ui-plugin-system
```

Install it on the **primary only** — Rancher extensions are a management-cluster concern and the one
install serves every cluster in the selector. Wait for `STATE: cached`:

```sh
kubectl --context kind-sims-datacenter get uiplugins.catalog.cattle.io -A
```

A hard refresh of the browser is needed after it caches, or the nav entry will not appear.

### 4. Join the federation

Not a Helm step — the join is a runtime handshake with a one-time token, so it cannot be
expressed in values. In the **primary's** SUSE Security UI (Rancher → cluster
`local` → SUSE Security):

1. **Multi-Cluster Management → Promote to primary cluster.**
   Set the reachable master address to `10.89.0.2` port `30443` — the NodePort from
   `primary-sims-datacenter.values.yaml`. Copy the generated join token.
2. In the **managed** cluster's UI (Rancher → cluster `downstream-1` → SUSE Security):
   **Multi-Cluster Management → Join primary cluster**, with server `10.89.0.2`,
   port `30443`, and the token from step 1.

`10.89.0.0/24` is the podman network **inside** the VM. It is not routable from macOS —
that is fine, because only the clusters need to reach each other. The human reaches both
UIs through Rancher.

## Reaching the console

Two routes, and they are not equivalent.

**Through Rancher — use this one.** It is the surface the plan's human-in-the-loop design depends on
(*"what did SUSE Security find, and did the rescan clear it?"*), it authenticates with your Rancher
identity via SSO, and the cluster selector switches between the primary and `downstream-1`:

```sh
kubectl --context kind-sims-datacenter -n cattle-system port-forward svc/rancher 8443:443
```

then <https://localhost:8443> → pick the cluster → **SUSE Security** in the left nav.

**Direct to the manager — for debugging only.** Bypasses Rancher entirely, so it needs the local
admin password and gives no federated view:

```sh
kubectl --context kind-sims-datacenter -n cattle-neuvector-system \
  port-forward svc/neuvector-service-webui 8444:8443
```

then <https://localhost:8444>. Same command against `--context kind-downstream-1` reaches the
managed cluster's own manager.

### The admin password is NOT `admin`

Every NeuVector guide says the first login is `admin` / `admin`. **On this install it is not**, and
the failure is actively unhelpful: the controller logs `Wrong password`, and after five attempts it
logs `User admin is temporarily blocked from login because of too many failed login attempts` and
locks the account for five minutes — so the obvious next move, trying again, makes it worse.

The cause is a Secret the chart did not create. With `bootstrapPassword: ""` a
**`neuvector-bootstrap-secret` is generated anyway**, with a random password, and the admin account
is initialised from it. Read it back per cluster:

```sh
kubectl --context kind-sims-datacenter -n cattle-neuvector-system \
  get secret neuvector-bootstrap-secret -o jsonpath='{.data.bootstrapPassword}' | base64 -d; echo
```

The two clusters get **different** passwords. `kind-downstream-1` needs the same command with its
own context.

If the account is locked, wait five minutes — there is no reset command, and restarting the
controller does not clear it.

**Do not try to fix this with `helm upgrade --set bootstrapPassword=…`.** The upgrade fails with
`invalid ownership metadata … missing key "app.kubernetes.io/managed-by"`, because the Secret
already exists and Helm refuses to adopt an object it did not create. To choose the password, set
`bootstrapPassword` **at first install**, before the Secret is generated — it is deliberately left
empty in the two values files here so that no password is committed to the repository.

None of this affects the designed path: **Rancher SSO needs no local password at all**, and the
agents authenticate with an API key, not with the admin account.

Note the Rancher port-forward and `global.cattle.url` are **different things**. The port-forward is
how your browser reaches Rancher; `global.cattle.url` is the sslip.io ingress the controller builds
its SSO redirect from. Setting the latter to a `localhost:<port>` port-forward URL is the bug the
previous install had.

## Verify

```sh
# 1. One controller and one scanner per cluster, not three.
for c in kind-sims-datacenter kind-downstream-1; do
  echo "== $c"; kubectl --context $c -n cattle-neuvector-system get deploy
done

# 2. The REST API Service exists on downstream-1 at the port the policy names.
kubectl --context kind-downstream-1 -n cattle-neuvector-system \
  get svc neuvector-svc-controller-api -o wide
#    expect: ClusterIP, port 10443

# 3. Federation services are up with the pinned node ports.
kubectl --context kind-sims-datacenter -n cattle-neuvector-system \
  get svc neuvector-svc-controller-fed-master      # 11443 -> 30443
kubectl --context kind-downstream-1 -n cattle-neuvector-system \
  get svc neuvector-svc-controller-fed-managed     # 10443 -> 30444

# 4. The managed cluster shows as connected in the primary's federated view.
```

Then the check that actually matters for the agents — from a pod **on downstream-1**,
the policy's endpoint must resolve and answer:

```sh
kubectl --context kind-downstream-1 -n default run nv-probe --rm -it --restart=Never \
  --image=registry.suse.com/bci/bci-base:16.0 -- \
  curl -sk https://neuvector-svc-controller-api.cattle-neuvector-system:10443/v1/eula
```

An HTTP response of any kind proves the seam. A DNS failure means
`controller.apisvc.type` did not take.

## The API key

The agents authenticate with an API key, created in the **managed** cluster's UI under
*Settings → Users, API Keys & Roles*, as
[`../../../secops-agent-factory/integrations/README.md`](../../../secops-agent-factory/integrations/README.md)
documents. It is stored as a Secret and **injected by the gateway at the egress
boundary** — the sandbox never holds it, and an agent that reads its own environment
learns nothing.

Scope it to the least role that satisfies the four calls the policy allows
(`POST /v1/auth`, `POST /v1/scan/repository`, `GET /v1/scan/repository/**`,
`GET /v1/scan/scanner`). The demo's point is the denial, not the grant: `POST
/v1/policy/rule` must fail **at the sandbox policy**, before the request is ever made,
not at NeuVector's own authorization. Both layers should refuse it; only one of them is
the thing being demonstrated.
