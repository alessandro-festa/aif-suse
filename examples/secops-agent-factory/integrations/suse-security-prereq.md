# SUSE Security — prerequisite checklist

SUSE Security is **not installed by these Blueprints**. It is assumed present,
installed the way SUSE ships it.

## 1. Install (customer side, once per cluster)

Rancher → the target cluster → **Cluster Tools** → **SUSE Security**. Rancher
installs the `neuvector-crd` chart first and then `neuvector`, both from the
`rancher-charts` catalog, into namespace `cattle-neuvector-system`.

The current release in `rancher-charts` (branch `release-v2.15`, read from the
catalog index on a live cluster) is:

| Chart | Version | Upstream |
|---|---|---|
| `neuvector-crd` | `110.0.1+up2.11.1` | neuvector/core 2.11.1 |
| `neuvector` | `110.0.1+up2.11.1` | neuvector/core 2.11.1 |

On RKE2 the container runtime is containerd, so the enforcer needs the
containerd socket path rather than the Docker default. Rancher's chart questions
handle this; a manual Helm install does not.

## 2. Turn on registry scanning

The triage signal in Figure 2 is *"SUSE Security finding"*, and it only exists
if SUSE Security is scanning the registry the agents are expected to patch.

Under *Assets → Registries*, add the registry holding the customer's own images
— typically `registry.suse.com` mirrors plus a private Harbor or the SUSE
Application Collection namespace the customer publishes to. Scanning must be
periodic, not on-demand, or the "nightly ingestion" loop in Figure 3 has nothing
to ingest.

Sanity check the CVE database is fresh before trusting any of this:

```bash
curl -sk -H "X-Auth-Token: $TOKEN" \
  https://neuvector-svc-controller.cattle-neuvector-system:10443/v1/scan/scanner \
  | jq '.scanners[] | {id, cvedb_version, cvedb_create_time}'
```

A remediation graded against a stale CVE database is not evidence of anything.
This is the one call the triage agent makes out of band, and it is a hard gate:
if `cvedb_create_time` is older than the scan it is about to trust, the job
should refuse to start rather than produce a confident wrong answer.

## 3. Create the API key the agents use

*Settings → Users, API Keys & Roles → Add API Key.*

Give it the **narrowest role that can scan**. It does not need, and must not
have, permission to modify admission rules, network rules or the exported
configuration — the sandbox policy denies those paths at the network layer as
well, but two independent controls beat one.

Store it where OpenShell can inject it, not where the agent can read it:

```bash
kubectl create secret generic openshell-suse-security-api \
  -n openshell --from-literal=api-key='<NeuVector API key>'
```

The sandbox never sees this value. It issues requests with a placeholder and the
gateway substitutes the real credential at the egress boundary — the same
mechanism that keeps the git forge token out of the agent's context.

## 4. Confirm the API is reachable from the sandbox namespace

The remediation sandboxes run in `ns-secops-sandboxes`, which
`11-blueprint-openshell-workspace.yaml` gives a NetworkPolicy. That policy
governs **ingress** to sandboxes. Egress from a sandbox to
`neuvector-svc-controller.cattle-neuvector-system:10443` goes through the
OpenShell gateway and is governed by the `suse_security` network policy in
`../policies/remediation-sandbox.yaml`, which allows exactly four paths and
denies the rest.

If the cluster also runs a default-deny CNI NetworkPolicy in
`cattle-neuvector-system`, the gateway's egress needs an explicit allow there
too. That is a cluster-specific detail this directory cannot pre-empt, and it
fails in the least helpful way possible: the scan call times out and the
validation agent reports the patch as unverified rather than as blocked.

## What is verified, and what is not

| Claim | Status |
|---|---|
| Chart names and versions in `rancher-charts` | **verified** — read from the catalog index ConfigMaps on a live AI Factory cluster |
| Namespace `cattle-neuvector-system`, controller API on `:10443`, `POST /v1/auth` + `X-Auth-Token` | **verified** — SUSE and NeuVector documentation |
| `GET /v1/scan/scanner` response fields (`cvedb_version`, `cvedb_create_time`) | **verified** — NeuVector automation documentation |
| `POST /v1/scan/repository` as the image-scan entry point | **partly** — the documented automation script scans a repository/tag through the controller API; the exact request and response schema was not read from the OpenAPI spec |
| OpenShell credential injection for this endpoint | **UNVERIFIED** — the policy grammar is real, the gateway-side secret plumbing was not traced |
| Any of it running | **NOT RUN** — SUSE Security is not installed on the authoring cluster |
