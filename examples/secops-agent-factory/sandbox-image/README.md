# SecOps remediation sandbox image

**This image does not exist.** This directory is its specification — the thing
`10-blueprint-openshell-gateway.yaml` and `configs/config_secops.yml` refer to
as `registry.suse.com/suse/ai/openshell-secops-sandbox:0.1.0`. Nothing here has
been built.

## Why it is in this repository at all

The sandbox is the only place in this architecture where code nobody reviewed
runs with a write credential within reach. Everything else — the model plane,
the knowledge plane, the agent plane — reasons. This container *acts*. So its
supply chain is not a packaging detail, it is the architecture's weakest point,
and leaving it as "some image with the tools in it" would hollow out the rest of
the design.

Three registries, one vendor:

| Layer | Source | Why not the usual thing |
|---|---|---|
| Base | `registry.suse.com/bci/bci-base:16.0`, through the OpenShell Community SUSE sandbox | SUSE already ships and maintains a BCI-based OpenShell sandbox. Building a second base would mean maintaining a second base. |
| OS packages | SUSE repositories, `zypper` | Entitled, signed, and on a lifecycle somebody is accountable for. |
| Python | `https://dp.apps.rancher.io/libraries/python/simple/` | 809 curated packages from the SUSE Application Collection, set as `index-url` so public PyPI is not a fallback. |

## The `index-url` decision

From SUSE's own Distribution Platform setup notes: *"By setting `index-url` (not
`extra-index-url`), pip will use **only** this repository."* That sentence is
the control.

With `extra-index-url`, a dependency the Application Collection does not carry
is fetched from PyPI and the build succeeds — which is the failure mode, because
nobody reads a successful build log. With `index-url`, the same dependency
fails resolution at build time with a name nobody can miss.

`uv` does not read `pip.conf`. It needs `uv.toml` with `default = true`, which
has the same exclusive effect. Both files are installed, because an agent asked
to install a package will reach for whichever tool it knows.

The honest consequence is written into `requirements.txt`: this list is a gate.
If the sandbox needs something SUSE does not curate, the answer is to do
without, ask for it to be curated, or vendor it and own its CVEs — not to widen
the index.

## Credentials

The Distribution Platform token appears in exactly two places, neither of them a
layer in the image:

- **At build time**, as a BuildKit secret mount (`--mount=type=secret,id=dp`),
  present only for the `RUN` that consumes it.
- **At run time**, injected by OpenShell at the egress boundary, the same way
  the git forge token and the SUSE Security API key are. The `pip.conf` that
  ships in the image names the index host and carries no credential, so an agent
  that reads it learns a hostname.

That is why `dp.apps.rancher.io` appears in the `suse_platform` network policy
in `../policies/remediation-sandbox.yaml` as a read-only endpoint: a sandbox
that installs a package is making an allowed, logged, credential-injected GET,
and a sandbox that tries `pypi.org` is making a denied one.

## Build

```bash
export DP_USER='you@example.com'
export DP_TOKEN='<Distribution Platform token>'

# 1. the OpenShell Community SUSE base, from the sibling repo
buildah build -t openshell-suse:latest \
  ~/…/OpenShell-Community/sandboxes/suse

# 2. this image on top of it
buildah build \
  --build-arg BASE_IMAGE=openshell-suse:latest \
  --secret id=dp,src=<(printf '%s:%s' "$DP_USER" "$DP_TOKEN") \
  -t openshell-secops-sandbox:0.1.0 .
```

Then scan it with SUSE Security before it is allowed to scan anything else, and
reference it **by digest** — not by tag — in the Blueprint. A mutable tag on the
one container in the system that holds write credentials defeats the provenance
argument the rest of this architecture makes.

## What is verified

| Claim | Status |
|---|---|
| `registry.suse.com/bci/bci-base:16.0` is the base SUSE uses for its OpenShell sandboxes | **verified** — `OpenShell-Community/sandboxes/suse/Dockerfile` line 14 |
| `https://dp.apps.rancher.io/libraries/python/simple/` is the Application Collection Python index, and `index-url` makes it exclusive | **verified** — SUSE Distribution Platform setup notes |
| `uv.toml` with `default = true` is uv's equivalent | **verified** — same source |
| The index carries 809 Python packages | **verified** — apps.rancher.io/libraries |
| `aiohttp`, `anyio`, `attrs`, `asyncssh` are in the index | **verified** — listed on apps.rancher.io/libraries |
| Every other name in `requirements.txt` | **UNVERIFIED** — the index search is client-side; checking needs Distribution Platform credentials |
| `buildah`, `skopeo`, `patch`, `diffutils` are installable from BCI 16 repos | **UNVERIFIED** — not attempted |
| Any of this builds | **NOT BUILT** |
