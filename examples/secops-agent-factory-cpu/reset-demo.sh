#!/bin/sh
# Put the Sovereign Agentic SecOps demo back to its pre-run state, then open the
# two port-forwards you need to record it.
#
#   sh reset-demo.sh                 # asks before deleting anything
#   GITEA_AUTH='gitea:…' sh reset-demo.sh -y     # no prompt, for a recording take
#
# WHY A SCRIPT AND NOT A CHECKLIST. A successful run consumes its own starting
# state: the storefront ends up on the remediated image, the manifest repository
# has the merged change, and the forge carries the issues and the pull request
# the run produced. Reproducing the twenty-seven-criticals-to-zero story needs
# all of that undone, and a reset done by hand is a reset done differently every
# time — which is the one thing a demo cannot afford.
#
# THE CREDENTIAL. The forge half needs a HUMAN account. `secops-bot` is refused
# by branch protection on `main`, and that refusal is not an obstacle to work
# around: it IS human gate #2, the reason the pipeline cannot merge its own
# change. So this script takes your credential from the environment, hands it to
# curl on stdin, and never prints it or passes it on a command line where `ps`
# would see it:
#
#   GITEA_AUTH='<user>:<password>'   or   GITEA_TOKEN='<personal access token>'
#
# WHAT IT DELIBERATELY DOES NOT DO
#
#   It does not delete `storefront-canary`. The canary is seeded by hand at
#   replicas: 0 precisely because the validation agent may only PATCH it — the
#   deploy policy denies POST on /k8s/clusters/**, so an agent cannot create a
#   workload. Deleting the canary would leave the next run unable to recreate
#   it. The reset re-applies 40-canary-storefront.yaml instead, which restores
#   both the image and the replica count to the seeded values.
#
#   It does not touch SUSE Security. NeuVector here has no PVC: restarting the
#   controller loses its key, its EULA acceptance and its whole scan history,
#   and the scan history is what the demo measures.
#
#   It does not delete sandboxes. The orchestrator removes its own at the end of
#   each step; a leftover one means a run is still going, which is why the
#   preflight below refuses rather than cleans.
set -eu

CTX=kind-downstream-1
OWNER=secops
REPO=cluster-manifests
GITEA_PORT=3000
ORCH_PORT=8088
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
API="http://127.0.0.1:${GITEA_PORT}/api/v1"
YES=no
if [ "${1:-}" = "-y" ]; then YES=yes; fi

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die()  { printf '\n\033[31mstopped: %s\033[0m\n' "$*" >&2; exit 1; }

# curl with the credential fed through a config file on stdin. Every forge call
# in this script goes through here so there is exactly one place the credential
# is handled.
gt() {
  _m=$1; _p=$2; shift 2
  printf '%s\n' "$AUTHLINE" |
    curl -sS -K - -X "$_m" "${API}${_p}" -H 'Content-Type: application/json' \
         -w '\n%{http_code}' "$@"
}

# ---------------------------------------------------------------------------
# 0. Preflight
# ---------------------------------------------------------------------------
say "preflight"

if [ -n "${GITEA_TOKEN:-}" ]; then
  AUTHLINE="header = \"Authorization: token ${GITEA_TOKEN}\""
  note "credential: GITEA_TOKEN"
elif [ -n "${GITEA_AUTH:-}" ]; then
  AUTHLINE="user = \"${GITEA_AUTH}\""
  note "credential: GITEA_AUTH (${GITEA_AUTH%%:*})"
else
  die "set GITEA_AUTH='<user>:<password>' or GITEA_TOKEN='<token>' first.
   The bot account cannot do this — main is branch-protected, and that
   protection is human gate #2."
fi

kubectl --context "$CTX" get ns ns-secops-cpu >/dev/null 2>&1 ||
  die "no ns-secops-cpu on $CTX — is the profile deployed?"

RUNNING=$(kubectl --context "$CTX" -n ns-secops-sandboxes get pods \
            --field-selector=status.phase=Running -o name 2>/dev/null |
          grep -v 'pullsecret' || true)
if [ -n "$RUNNING" ]; then
  printf '   %s\n' $RUNNING
  die "a sandbox is running — a pipeline run is in progress. Let it finish."
fi
note "no sandbox running"

if [ "$YES" != yes ]; then
  printf '\n   This deletes every issue, pull request and non-main branch in\n'
  printf '   %s/%s, and rewrites its workload manifests.\n' "$OWNER" "$REPO"
  printf '   Type yes to continue: '
  read -r reply
  [ "$reply" = yes ] || die "cancelled"
fi

# ---------------------------------------------------------------------------
# 1. Port-forwards — stop, then recreate
# ---------------------------------------------------------------------------
# Recreated rather than reused because a port-forward whose pod has been
# replaced stays open and answers nothing, which during a recording looks
# exactly like a broken cluster.
say "port-forwards"

pkill -f "port-forward.*gitea-http" 2>/dev/null || true
pkill -f "port-forward.*secops-cpu-orchestrator" 2>/dev/null || true
sleep 1

# Gitea's ROOT_URL is http://localhost:3000/, so this local port is not a
# preference — clone URLs and issue links in the UI are built from it.
nohup kubectl --context "$CTX" -n ns-secops-forge \
  port-forward svc/gitea-http "${GITEA_PORT}:3000" >/tmp/pf-gitea.log 2>&1 &
# 8088, not 8080: the local port is what the browser uses, and 8080 is held by
# something on most laptops. The remote port stays 8080.
nohup kubectl --context "$CTX" -n ns-secops-cpu \
  port-forward svc/secops-cpu-orchestrator "${ORCH_PORT}:8080" >/tmp/pf-orch.log 2>&1 &

for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -sf -m 2 "${API}/version" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf -m 2 "${API}/version" >/dev/null 2>&1 ||
  die "Gitea did not come up on ${GITEA_PORT} — see /tmp/pf-gitea.log"
note "Gitea            http://localhost:${GITEA_PORT}"
note "Orchestrator     http://localhost:${ORCH_PORT}"

# ---------------------------------------------------------------------------
# 2. Forge: restore the workload manifests from the seed files
# ---------------------------------------------------------------------------
# The seed files in ./workloads are the pristine state by definition — the same
# files the repository was created from. Diffing against them rather than
# hard-coding an image string means this keeps working when the demo target
# changes.
say "forge: manifests"

BODY=/tmp/reset-body.json

reset_file() {
  _local=$1; _path=$2
  rm -f "$BODY"
  # Unauthenticated read: the repository is readable without a credential, and
  # keeping the read out of `gt` keeps the token off every call that does not
  # need it.
  _remote=$(curl -sf -m 10 "${API}/repos/${OWNER}/${REPO}/contents/${_path}?ref=main" || true)
  # Exit 7 means "already identical". Anything else nonzero is a real failure.
  set +e
  RESET_LOCAL=$_local RESET_BODY=$BODY RESET_REMOTE=$_remote python3 - <<'PY'
import base64, json, os, sys
local = open(os.environ["RESET_LOCAL"], "rb").read()
raw   = os.environ["RESET_REMOTE"]
sha   = None
if raw:
    try:
        d   = json.loads(raw)
        sha = d.get("sha")
        if sha and base64.b64decode(d.get("content", "")) == local:
            sys.exit(7)
    except ValueError:
        pass
body = {"branch": "main",
        "message": "Reset the demo to its pre-run state",
        "content": base64.b64encode(local).decode()}
if sha:
    body["sha"] = sha          # absent sha means create, present means replace
with open(os.environ["RESET_BODY"], "w") as fh:
    json.dump(body, fh)
PY
  _rc=$?
  set -e
  if [ "$_rc" -eq 7 ]; then
    note "unchanged  ${_path}"
    return 0
  fi
  [ "$_rc" -eq 0 ] || die "could not compare ${_path}"
  _r=$(gt PUT "/repos/${OWNER}/${REPO}/contents/${_path}" --data @"$BODY")
  case "$(printf '%s' "$_r" | tail -1)" in
    2*) note "restored   ${_path}" ;;
    *)  printf '%s\n' "$_r" | head -3
        die "could not write ${_path}.
   \`user cannot commit to repo\` means the account is not on main's push
   whitelist — branch protection applies to admins too. Add it under
   Settings > Branches > main, or use the account that seeded the repo." ;;
  esac
}

for f in "$HERE"/workloads/*.yaml; do
  reset_file "$f" "workloads/$(basename "$f")"
done
if [ -f "$HERE/workloads/_repo-README.md" ]; then
  reset_file "$HERE/workloads/_repo-README.md" "README.md"
fi

# ---------------------------------------------------------------------------
# 3. Forge: branches
# ---------------------------------------------------------------------------
# Gitea usually deletes the head branch on merge, so this is normally a no-op.
# It is here for the runs that stop at gate 3 and leave the branch behind.
say "forge: branches"

curl -sf "${API}/repos/${OWNER}/${REPO}/branches" |
  python3 -c "import json,sys;[print(b['name']) for b in json.load(sys.stdin) if b['name']!='main']" |
while read -r b; do
  [ -z "$b" ] && continue
  _r=$(gt DELETE "/repos/${OWNER}/${REPO}/branches/${b}")
  case "$(printf '%s' "$_r" | tail -1)" in
    2*) note "deleted    ${b}" ;;
    *)  note "kept       ${b} (HTTP $(printf '%s' "$_r" | tail -1))" ;;
  esac
done
note "main left alone — its protection is gate #2"

# ---------------------------------------------------------------------------
# 4. Forge: issues and pull requests
# ---------------------------------------------------------------------------
# In Gitea a pull request IS an issue with a branch attached, so both come back
# from /issues and both delete through the same index.
#
# Deleting does not reset the index counter: after this the next run opens #41,
# not #1. Only recreating the repository would restore the numbering, and that
# would also drop the branch protection and the push whitelist that gate #2 is
# made of — a worse trade than a large issue number on screen.
say "forge: issues and pull requests"

curl -sf "${API}/repos/${OWNER}/${REPO}/issues?state=all&limit=100" |
  python3 -c "import json,sys;[print(i['number']) for i in json.load(sys.stdin)]" |
while read -r n; do
  [ -z "$n" ] && continue
  _r=$(gt DELETE "/repos/${OWNER}/${REPO}/issues/${n}")
  case "$(printf '%s' "$_r" | tail -1)" in
    2*) note "deleted    #${n}" ;;
    *)  # Older Gitea has no issue-delete endpoint. Closing is the fallback:
        # a closed issue is out of the way even if the number is still used.
        gt PATCH "/repos/${OWNER}/${REPO}/issues/${n}" \
           --data '{"state":"closed"}' >/dev/null
        note "closed     #${n} (delete unsupported or refused)" ;;
  esac
done

# ---------------------------------------------------------------------------
# 5. Cluster
# ---------------------------------------------------------------------------
say "cluster"

kubectl --context "$CTX" apply -f "$HERE/workloads/nginx.yaml" |
  sed 's/^/   /'
kubectl --context "$CTX" apply -f "$HERE/40-canary-storefront.yaml" |
  sed 's/^/   /'
kubectl --context "$CTX" -n ns-demo-web rollout status deploy/storefront --timeout=90s |
  sed 's/^/   /'

# ---------------------------------------------------------------------------
# 6. State
# ---------------------------------------------------------------------------
say "starting state"

printf '   storefront        %s\n' \
  "$(kubectl --context "$CTX" -n ns-demo-web get deploy storefront \
       -o jsonpath='{.spec.template.spec.containers[0].image}')"
printf '   storefront-canary %s  replicas=%s\n' \
  "$(kubectl --context "$CTX" -n ns-demo-web get deploy storefront-canary \
       -o jsonpath='{.spec.template.spec.containers[0].image}')" \
  "$(kubectl --context "$CTX" -n ns-demo-web get deploy storefront-canary \
       -o jsonpath='{.spec.replicas}')"
printf '   forge nginx.yaml  %s\n' \
  "$(curl -sf "${API}/repos/${OWNER}/${REPO}/contents/workloads/nginx.yaml?ref=main" |
     python3 -c "import json,sys,base64;print([l.strip() for l in base64.b64decode(json.load(sys.stdin)['content']).decode().splitlines() if 'image:' in l][0])")"
printf '   open issues       %s\n' \
  "$(curl -sf "${API}/repos/${OWNER}/${REPO}/issues?state=all&limit=100" |
     python3 -c "import json,sys;print(len(json.load(sys.stdin)))")"
printf '   agents chart      %s\n' \
  "$(kubectl --context "$CTX" -n ns-secops-cpu get deploy secops-cpu-orchestrator \
       -o jsonpath='{.metadata.labels.helm\.sh/chart}')"

printf '\n   Gitea         http://localhost:%s/%s/%s\n' "$GITEA_PORT" "$OWNER" "$REPO"
printf '   Orchestrator  http://localhost:%s\n\n' "$ORCH_PORT"
