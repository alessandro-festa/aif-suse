<!--
SPDX-FileCopyrightText: Copyright (c) 2026 SUSE LLC. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Building the OpenShell stack on SUSE Linux Enterprise BCI 16.0

Four images, all on SLE BCI 16.0, all `linux/amd64` + `linux/arm64`:

| Image | Base | What it is |
|---|---|---|
| `sandbox` | `bci-micro:16.0` | the container an agent runs inside |
| `supervisor` | `bci-micro:16.0` | statically linked binary injected *into* the sandbox at pod start |
| `gateway` | `bci-micro:16.0` | the cluster-side gRPC gateway |
| `openclaw` | `sandbox` | the sandbox plus the OpenClaw CLI — the image the demo pins |

They replace three foreign bases: `OpenShell-Community/sandboxes/suse` (BCI, but
`bci-base` and arm64-only), `gcr.io/distroless/cc-debian13` (gateway) and
`alpine:3.22` (supervisor).

## Quick start

```sh
./build.sh all                       # native arch, loaded into the local docker daemon
./build.sh gateway                   # one image
./build.sh all --push                # linux/amd64,linux/arm64 manifest lists to $REGISTRY
```

Overridable via the environment: `REGISTRY`, `TAG`, `SRC`, `COMMUNITY`,
`BUILDER`, `UPSTREAM`. `TAG` defaults to the OpenShell commit the AI Factory
Blueprints pin, `17171cd9337a2181d4bb5a9e711e1f2ad5f69388`.

### Prerequisites

- Docker with buildx. The script creates its own `docker-container` builder.
- An `~/Documents/dev/OpenShell` clone containing the pinned commit. `build.sh`
  makes a detached worktree of it at `/tmp/openshell-src`; the gateway and
  supervisor builds use that as their build context, never this repo.
- `~/Documents/dev/OpenShell-Community/sandboxes/openclaw-suse` for the
  openclaw layer's `policy.yaml`, start scripts, `policy-proxy.js` and `proto/`.
- QEMU binfmt for the foreign half of a `--push` build (Docker Desktop has it).

### The throwaway local registry

Local (non-`--push`) builds start a `registry:2` container on
`127.0.0.1:5055`. This is not decoration. `Dockerfile.openclaw` is `FROM` the
sandbox image, and buildx cannot resolve a `FROM` against the docker daemon's
image store — it always goes to a registry, so a locally built, never-pushed
base is invisible to it. Pushing to a plain-HTTP localhost registry with
`docker push` does not work either: the daemon insists on HTTPS, and changing
that means editing the user's daemon config.

The way out is to let BuildKit do the push rather than the daemon — it takes
`registry.insecure=true` per output, and with the builder created
`--driver-opt network=host` its `localhost` is the host's. The registry is left
running between invocations so `./build.sh sandbox` and a later
`./build.sh openclaw` compose. Remove it with:

```sh
docker rm -f openshell-bci-registry
```

## Size

Measured on `linux/arm64`, against the images currently in use:

| Image | Before | After | |
|---|---|---|---|
| sandbox | 2.87 GB (`sandboxes/suse:latest`) | **318 MB** | 9× |
| openclaw | 3.61 GB (`sandboxes/openclaw-suse:latest`) | **800 MB** | 4.5× |
| gateway | — (distroless/cc-debian13) | **106 MB** | |
| supervisor | — (alpine:3.22) | **70.7 MB** | |

Most of the sandbox saving is not the base swap. It comes from dropping
toolchains and agent CLIs that were never part of the sandbox contract: `gcc`,
`gcc-c++`, `make`, `vim`, a uv-managed Python, and the bundled `claude`,
`codex`, `opencode`, `copilot` and `gh` binaries. The base swap
(`bci-base` 106 MB → `bci-micro` 20 MB) is worth ~86 MB of it.

`git` is the one thing deliberately kept from that list, at a measured 25 MB
(`git-core`, not `git` — the latter drags in git-web, git-email, gitk, tk and
perl). `policy.yaml`'s `github` rule is bound to the binary `/usr/bin/git`, so
without it the rule is inert and an agent cannot clone.

The other policy rules bound to dropped binaries — `gitlab` (`/usr/bin/glab`),
`claude_code` (`/usr/local/bin/claude`) and part of `nvidia`
(`/usr/local/bin/opencode`) — stay inert by design. Those are alternative agents
to OpenClaw, which is what this stack drives.

The gateway is larger than a Rust binary has any right to be because
`bundled-z3` statically links the Z3 SMT solver into it — see below.

## Accounts

`policy.yaml` pins `run_as_user: sandbox` by name, and nothing upstream pins a
number. A bare `useradd -r` therefore hands out a different UID on every
rebuild, which makes PVC ownership and `fsGroup` non-reproducible across image
versions. These are fixed:

| Image | User | UID:GID | Home | Shell |
|---|---|---|---|---|
| sandbox, openclaw | `supervisor` | 1000:1000 | `/nonexistent` | `/usr/sbin/nologin` |
| sandbox, openclaw | `sandbox` | 1001:1001 | `/sandbox` | `/bin/bash` |
| gateway | *(numeric only)* | 1000:1000 | — | — |
| supervisor | root-owned binary, mode 0555 | — | — | — |

The gateway's 1000:1000 matches the Helm chart's `securityContext`
(`runAsUser: 1000`, `fsGroup: 1000`). It is numeric because `bci-micro` has no
matching passwd entry, which Kubernetes does not need.

## Verifying a build

```sh
# sandbox — the contract binaries, at the paths policy.yaml matches
docker run --rm openshell-bci/sandbox:dev -c \
  'nsenter --version; command -v node python3 bash curl; id sandbox'

# supervisor — must be static, because it is executed inside other images
docker run --rm --entrypoint /bin/sh openshell-bci/supervisor:dev -c \
  'ldd /openshell-sandbox; /usr/sbin/nft --version; /openshell-sandbox --version'
#   -> "not a dynamic executable", nftables v1.1.3, openshell-sandbox 0.0.0

# and with upstream's own checker, which needs readelf (so: on Linux)
bash tasks/scripts/verify-static-binary.sh ./openshell-sandbox
#   -> statically linked: no PT_INTERP, no DT_NEEDED

# gateway
docker run --rm openshell-bci/gateway:dev --version

# openclaw
docker run --rm --entrypoint /usr/local/bin/openclaw openshell-bci/openclaw:dev --version
```

Two checks that look redundant and are not:

- **The gateway's compiled-in supervisor tag.** `strings` the binary for the tag
  immediately after `ghcr.io/nvidia/openshell/supervisor`. If it is absent the
  gateway falls back to the floating `:dev` tag, whose published manifest has no
  `/openshell-sandbox`, and every sandbox dies in `Init:StartError` — surfaced
  by the CLI only as a bare `PodFailed: Pod failed`.
- **The supervisor's static linkage.** A dynamically linked supervisor loads
  fine in its own image and then fails inside any sandbox image with a different
  glibc. `Dockerfile.supervisor` fails the build rather than ship one.

## Notes on each image

### sandbox

Two stages, SUSE's canonical minimal-image pattern: install into `/installroot`
from a `bci-base` builder, then `COPY --from` that tree onto `bci-micro`. The
shipped image has no `rpm` and no `zypper`. User creation also happens in the
builder (`useradd --root /installroot`), which keeps `shadow` out.

Three traps are worth knowing:

- `python313` installs only `/usr/bin/python3.13`. The unversioned
  `/usr/bin/python3` that every script actually calls comes from `python3-base`.
- `useradd --system` caps IDs at `SYS_UID_MAX` (499) on SLE and warns when an
  explicit UID exceeds it, so `--system` is deliberately not used here.
- **`tar` is not in `bci-micro`**, and the chart's `workspace-init` init
  container seeds the workspace PVC by piping `/sandbox` through `tar -cf` /
  `-xf`. Without it that container exits 1 with
  `find: 'tar': No such file or directory` and the CLI reports only
  `PodFailed: Pod failed`. No compression is used, so `gzip`/`xz` are not needed.

`sftp-server` lives at `/usr/libexec/ssh/sftp-server` on SLE, not Debian's
`/usr/lib/openssh`. Upstream hardcodes no path for it, so this is fine.

### supervisor

Upstream defaults to `x86_64/aarch64-unknown-linux-musl`. **SLE_BCI 16.0
packages no musl at all** — no `musl`, `musl-devel`, `musl-gcc`, no
`rust-std-*-musl` — and the `rust1.95` RPM installs only the native gnu std
target.

Rather than pull in rustup (a network download in the base layer, and the end of
any OBS story), this uses upstream's own second supported variant:
`SUPERVISOR_LIBC=glibc-static`, which
`tasks/scripts/stage-prebuilt-binaries.sh` implements as the gnu triple built
with `-C target-feature=+crt-static`. Their comment says both options produce a
fully static binary. SLE_BCI ships `glibc-devel-static`, which is the piece that
makes it work.

Residual risk, stated honestly: statically linked glibc cannot `dlopen` NSS
modules, so `getaddrinfo()`-based DNS degrades. The supervisor uses rustls with
webpki-roots (its own bundled root store, no filesystem trust lookup), but name
resolution needs verifying at runtime rather than inferred from a successful
link — the `--version` smoke test does not cover it.

**There is no `iptables-legacy` on SLE 16.** Its iptables 1.8.11 is nft-backend
only and ships no `xtables-legacy-multi`. This is safe:
`install_sidecar_bypass_rules()` (`netns/mod.rs:651`) calls `nft` first and only
falls back to iptables-legacy if the nft path itself errors, and SLE 16 puts
`nft` at `/usr/sbin/nft`, the first entry in `NFT_SEARCH_PATHS`. We lose a
fallback that should never fire.

### gateway

Upstream's `deploy/docker/Dockerfile.gateway` does not compile anything — their
CI builds the binary natively per architecture, stages it under
`deploy/docker/.build/prebuilt-binaries/<arch>/` and copies it into
`gcr.io/distroless/cc-debian13`. This replaces that two-step flow with a
self-contained multi-stage build, which is both reproducible from source and the
only shape that could move to OBS.

SLE_BCI 16.0 packages `rust1.95`/`cargo1.95`, which is exactly the toolchain
pinned in OpenShell's `rust-toolchain.toml`. No rustup, no drift, no third-party
repository.

`--features bundled-z3` is not optional despite the name:
`stage-prebuilt-binaries.sh:180-182` force-appends it to the gateway's feature
list unconditionally. The chain is
`openshell-gateway → openshell-server → openshell-prover → z3/bundled`, and it
exists because the policy prover links the Z3 SMT solver. Linking a system
libz3 instead is not an option here — SLE_BCI 16.0 packages no z3 at all
(`zypper se z3` and `zypper se --provides libz3.so` both come back empty), so
the vendored C++ build is the only path. That is what `cmake`, `gcc-c++` and
`python313` are doing in the builder stage, and it dominates the build time
(~7 of ~16 minutes on an M-series host).

Z3 also leaves the gateway with a `DT_NEEDED` on `libstdc++.so.6`, which
`bci-micro` does not carry (distroless/cc-debian13 does, which is why upstream
never hits it). A third stage stages `libstdc++6` through `--installroot`.
Without it the image starts and immediately dies with
`error while loading shared libraries: libstdc++.so.6`, which reads like a
broken build rather than a missing runtime package. Note that the builder stage's
own `--version` smoke test passes regardless, because `gcc-c++` put libstdc++
there — a runtime library gap is only visible in the final image.

**glibc floor.** Upstream cross-compiles with cargo-zigbuild against a glibc
2.28 floor because they target Debian. We compile natively per-arch and run on
`bci-micro:16.0`, so builder and runtime share SLE 16's glibc and the floor is
unnecessary. The consequence is that this binary is *not* portable to older
glibc distributions, unlike upstream's. Fine for an image whose runtime ships in
the same manifest; do not lift the binary out of it.

### openclaw

A thin layer on the sandbox image: `npm install -g openclaw@2026.5.18` plus the
three runtime deps of `policy-proxy.js`, then `policy.yaml`, the two start
scripts, `policy-proxy.js` and `proto/`.

The globally installed node modules are not on node's default `require` path.
`openclaw-suse-start.sh` sets `NODE_PATH=$(npm root -g)` itself, so a bare
`node -e 'require("js-yaml")'` failing in this image is the test being wrong,
not the image.

`ENTRYPOINT ["sleep", "infinity"]` is kept from upstream and is deliberately not
`/bin/bash`: when the image is deployed as a bare Kubernetes Pod (aif-nc's
`PreDeployInCluster` mode) bash exits immediately for want of a TTY and the pod
crashloops. The normal OpenShell path is unaffected — it runs
`SandboxSpec.command` and ignores the entrypoint.

## Open Build Service portability

The Dockerfiles are written so the RPM-only ones could move to
[build.opensuse.org](https://build.opensuse.org/) later. Each carries
`#!BuildTag:` directives and a per-package rationale comment. Nothing here has
been built on OBS yet — this is an assessment, not a claim.

The constraint that decides everything is that **OBS builds have no network
access**. Every input must be an RPM from a configured repository or a source
file in the package.

| Image | OBS-capable | What it would need |
|---|---|---|
| sandbox | yes | SLE_BCI 16.0 repo on the project; `registry.suse.com` configured as a download-on-demand registry for the two base images |
| supervisor | yes | the same, plus the OpenShell source and a `cargo vendor` tarball |
| gateway | yes | the same as supervisor |
| openclaw | **no** | every transitive node module vendored as a source tarball |

The `cargo vendor` route is available because `Cargo.lock` has **zero git
dependencies** — everything resolves to crates.io, so a fully offline vendor
tarball is possible. This is also what makes the supervisor viable: the
`glibc-static` variant removed the rustup dependency that would otherwise have
put a network download in the base layer.

Two further OBS details that will matter when someone tries this:

- Pinned package versions fail as "unresolvable" on OBS. The install lists here
  are unpinned, which is deliberate.
- `#!ArchExclusiveLine` / `#!ArchExcludedLine` would be needed if the image set
  is ever restricted to a subset of the four architectures BCI publishes
  (x86_64, aarch64, ppc64le, s390x). Today all four Dockerfiles are
  arch-agnostic except `Dockerfile.supervisor`, which maps `TARGETARCH` to a
  Rust target triple and fails loudly on anything other than amd64/arm64.

`Dockerfile.openclaw` is kept as a separate file from `Dockerfile.sandbox`
precisely so that the npm dependency does not contaminate the image that *is*
OBS-capable.
