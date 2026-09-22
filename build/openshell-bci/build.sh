#!/usr/bin/env bash
#
# SPDX-FileCopyrightText: Copyright (c) 2026 SUSE LLC. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Build the OpenShell stack on SUSE Linux Enterprise BCI 16.0.
#
#   ./build.sh <sandbox|supervisor|gateway|openclaw|all> [--push] [--platform P]
#
# Defaults to a native single-arch build loaded into the local docker daemon.
# `--push` switches to a multi-arch manifest pushed to $REGISTRY; the two are
# mutually exclusive because buildx cannot --load a manifest list.
#
# Environment overrides:
#   REGISTRY   image name prefix         (default ghcr.io/alessandro-festa/openshell-bci)
#   TAG        image tag                 (default $OPENSHELL_COMMIT)
#   SRC        OpenShell build context   (default /tmp/openshell-src, auto-created)
#   COMMUNITY  openclaw asset directory  (default ~/Documents/dev/OpenShell-Community/...)
#   BUILDER    buildx builder to use     (default openshell-bci, auto-created)
#   UPSTREAM   OpenShell clone to worktree from (default ~/Documents/dev/OpenShell)

set -euo pipefail

# The OpenShell commit the AI Factory Blueprints pin. The gateway, the
# supervisor and the Helm chart version must all move together — see
# examples/openshell/10-blueprint-openshell-gateway.yaml and the
# supervisor.image.tag trap in docs/openshell-blueprints.md.
OPENSHELL_COMMIT=17171cd9337a2181d4bb5a9e711e1f2ad5f69388

REGISTRY="${REGISTRY:-ghcr.io/alessandro-festa/openshell-bci}"
TAG="${TAG:-${OPENSHELL_COMMIT}}"
SRC="${SRC:-/tmp/openshell-src}"
COMMUNITY="${COMMUNITY:-${HOME}/Documents/dev/OpenShell-Community/sandboxes/openclaw-suse}"
BUILDER="${BUILDER:-openshell-bci}"
UPSTREAM="${UPSTREAM:-${HOME}/Documents/dev/OpenShell}"

# Throwaway registry used only by local builds — see the openclaw section.
LOCAL_REGISTRY_NAME=openshell-bci-registry
LOCAL_REGISTRY_PORT=5055
LOCAL_REGISTRY=localhost:${LOCAL_REGISTRY_PORT}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PLATFORM=""
PUSH=0
TARGET=""

usage() {
    sed -n '7,21p' "${BASH_SOURCE[0]}" | sed 's/^#\s\?//'
    exit "${1:-1}"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        sandbox|supervisor|gateway|openclaw|all) TARGET="$1"; shift ;;
        --push)     PUSH=1; shift ;;
        --platform) PLATFORM="$2"; shift 2 ;;
        -h|--help)  usage 0 ;;
        *) echo "unknown argument: $1" >&2; usage ;;
    esac
done

[[ -n "${TARGET}" ]] || usage

# A local build should follow the host; a --push build is pointless unless it
# produces the manifest list the clusters actually need.
if [[ -z "${PLATFORM}" ]]; then
    if (( PUSH )); then
        PLATFORM="linux/amd64,linux/arm64"
    else
        case "$(uname -m)" in
            arm64|aarch64) PLATFORM="linux/arm64" ;;
            x86_64|amd64)  PLATFORM="linux/amd64" ;;
            *) echo "cannot infer platform for $(uname -m); pass --platform" >&2; exit 1 ;;
        esac
    fi
fi

if (( ! PUSH )) && [[ "${PLATFORM}" == *,* ]]; then
    echo "ERROR: a multi-platform build cannot be loaded into the docker daemon; add --push" >&2
    exit 1
fi

# --- source tree ------------------------------------------------------------
# A detached worktree at the pinned commit, so the build never depends on
# whatever the OpenShell checkout happens to have checked out. Reused across
# runs; remove with `git -C "${UPSTREAM}" worktree remove ${SRC}`.
prepare_src() {
    [[ -d "${SRC}/crates" ]] && return 0
    echo "==> creating worktree ${SRC} at ${OPENSHELL_COMMIT:0:12}"
    git -C "${UPSTREAM}" cat-file -e "${OPENSHELL_COMMIT}^{commit}" 2>/dev/null || {
        echo "ERROR: ${OPENSHELL_COMMIT} not in ${UPSTREAM}; run: git -C ${UPSTREAM} fetch --all" >&2
        exit 1
    }
    git -C "${UPSTREAM}" worktree add --detach "${SRC}" "${OPENSHELL_COMMIT}"
}

# --- builder ----------------------------------------------------------------
# A docker-container builder is required for multi-platform output, and
# `network=host` is required for the local-registry hop below. Docker Desktop's
# own "default" builder is also docker-container these days, so there is no
# docker-driver builder to fall back on and no way to read the daemon's image
# store from a build — which is the whole reason the local registry exists.
prepare_builder() {
    if ! docker buildx inspect "${BUILDER}" >/dev/null 2>&1; then
        echo "==> creating buildx builder ${BUILDER}"
        docker buildx create --name "${BUILDER}" \
            --driver docker-container --driver-opt network=host --bootstrap >/dev/null
    fi
}

# --- local registry ---------------------------------------------------------
# Only needed to build the openclaw layer locally. openclaw is FROM the sandbox
# image, and buildx cannot resolve a FROM against the docker daemon's image
# store — it always goes to a registry. Pushing to a plain-HTTP localhost
# registry with `docker push` fails too, because the daemon demands HTTPS and
# fixing that means editing the user's daemon config.
#
# So the push is done by BuildKit instead of the daemon: BuildKit accepts
# `registry.insecure=true` per output, and with `network=host` its "localhost"
# is the host's. It binds to 127.0.0.1 only, and is deliberately left running
# between invocations so that `./build.sh sandbox` and a later
# `./build.sh openclaw` compose. Remove it with:
#   docker rm -f openshell-bci-registry
start_local_registry() {
    if docker inspect "${LOCAL_REGISTRY_NAME}" >/dev/null 2>&1; then
        docker start "${LOCAL_REGISTRY_NAME}" >/dev/null 2>&1 || true
        return 0
    fi
    echo "==> starting throwaway registry on 127.0.0.1:${LOCAL_REGISTRY_PORT}"
    docker run -d --name "${LOCAL_REGISTRY_NAME}" \
        -p "127.0.0.1:${LOCAL_REGISTRY_PORT}:5000" registry:2 >/dev/null
    sleep 2
}

# --- build ------------------------------------------------------------------
# $1 image name, $2 build context, then any number of extra buildx flags.
build() {
    local name="$1" context="$2"; shift 2
    local image="${REGISTRY}/${name}:${TAG}"
    local -a outputs

    if (( PUSH )); then
        outputs=(--output "type=image,name=${image},push=true")
    else
        outputs=(--output "type=docker,name=${image}")
        # The sandbox is additionally published to the throwaway registry so the
        # openclaw layer, built next, has something to be FROM.
        if [[ "${name}" == "sandbox" ]]; then
            start_local_registry
            outputs+=(--output "type=image,name=${LOCAL_REGISTRY}/sandbox:${TAG},push=true,registry.insecure=true")
        fi
    fi

    echo "==> ${image}  [${PLATFORM}]"
    docker buildx build \
        --builder "${BUILDER}" \
        --platform "${PLATFORM}" \
        "${outputs[@]}" \
        -f "${HERE}/Dockerfile.${name}" \
        "$@" \
        "${context}"
}

# The sandbox Dockerfile COPYs nothing from its context, so it gets this
# directory rather than the repo root.
build_sandbox()    { build sandbox "${HERE}"; }
build_supervisor() { prepare_src; build supervisor "${SRC}"; }

build_gateway() {
    prepare_src
    # Load-bearing: unset, the gateway binary resolves the supervisor image to
    # the floating :dev tag, whose published manifest has no /openshell-sandbox.
    # Every sandbox then dies in Init:StartError, surfaced only as "PodFailed".
    build gateway "${SRC}" --build-arg "OPENSHELL_IMAGE_TAG=${TAG}"
}

build_openclaw() {
    [[ -d "${COMMUNITY}" ]] || {
        echo "ERROR: openclaw assets not found at ${COMMUNITY}; set COMMUNITY=" >&2
        exit 1
    }
    local base
    if (( PUSH )); then
        base="${REGISTRY}/sandbox:${TAG}"
    else
        # Populated by build_sandbox. If it is missing, BuildKit's own
        # "failed to resolve source metadata" names the exact ref, so there is
        # nothing useful to add by pre-checking here.
        start_local_registry
        base="${LOCAL_REGISTRY}/sandbox:${TAG}"
    fi
    build openclaw "${COMMUNITY}" --build-arg "BASE_IMAGE=${base}"
}

prepare_builder

case "${TARGET}" in
    sandbox)    build_sandbox ;;
    supervisor) build_supervisor ;;
    gateway)    build_gateway ;;
    openclaw)   build_openclaw ;;
    all)
        # sandbox before openclaw: the latter builds FROM the former.
        build_sandbox
        build_supervisor
        build_gateway
        build_openclaw
        ;;
esac

echo "==> done"
