#!/usr/bin/env bash
# Run a Jupyter notebook with the rancher-ai SDK in a project namespace.
#
#   deploy/notebook.sh <namespace> [--context CTX]      deploy or update
#   deploy/notebook.sh <namespace> --delete [--context CTX]
#
# Creates, in <namespace>: the SDK wheel and the example notebook as ConfigMaps, a random Jupyter
# token Secret, a ServiceAccount with a Role holding the AI Job Submitter rules, and the notebook
# Deployment + Service. Cluster-wide: one ClusterRole with the AI Scheduler Cluster Read rules,
# bound to this ServiceAccount (GPU inventory, blueprints, the chart repo; no workload access).
# The rules are copied from examples/training/rbac.yaml so the notebook gets what a submitter gets.
set -euo pipefail
NS="${1:?usage: $0 <namespace> [--delete] [--context CTX]}"; shift
CTX=(); DELETE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --context) CTX=(--context "$2"); shift 2 ;;
    --delete) DELETE=1; shift ;;
    *) echo "unknown argument $1"; exit 1 ;;
  esac
done
HERE="$(cd "$(dirname "$0")" && pwd)"; SDK="$HERE/.."; RBAC="$SDK/../../examples/training/rbac.yaml"
K() { kubectl "${CTX[@]}" "$@"; }

if [ -n "$DELETE" ]; then
  sed "s/NAMESPACE/$NS/g" "$HERE/notebook.yaml" | K delete --ignore-not-found -f -
  K -n "$NS" delete --ignore-not-found role/rancher-ai-notebook rolebinding/rancher-ai-notebook \
    configmap/rancher-ai-sdk configmap/rancher-ai-examples secret/rancher-ai-notebook
  K delete --ignore-not-found clusterrolebinding "rancher-ai-notebook-$NS"
  exit 0
fi

for c in kubectl yq uv; do command -v "$c" >/dev/null || { echo "missing $c"; exit 1; }; done
K get namespace "$NS" >/dev/null

# the SDK wheel and the example notebook
DIST="$(mktemp -d)"; trap 'rm -rf "$DIST"' EXIT
(cd "$SDK" && uv build --wheel -q -o "$DIST" >/dev/null)
K -n "$NS" create configmap rancher-ai-sdk --from-file="$DIST" --dry-run=client -o yaml | K apply -f -
K -n "$NS" create configmap rancher-ai-examples --from-file="$SDK/examples/rancher-ai-demo.ipynb" --dry-run=client -o yaml | K apply -f -
# a Jupyter token, made once and never printed here
K -n "$NS" get secret rancher-ai-notebook >/dev/null 2>&1 || \
  K -n "$NS" create secret generic rancher-ai-notebook --from-literal=jupyter-token="$(openssl rand -hex 24)"

# RBAC: the same rules as the RoleTemplates the UI's users get
rules() { yq "select(.kind == \"RoleTemplate\" and .metadata.name == \"$1\") | .rules" "$RBAC"; }
{
  echo "apiVersion: rbac.authorization.k8s.io/v1"; echo "kind: Role"
  echo "metadata: { name: rancher-ai-notebook, namespace: $NS }"; echo "rules:"; rules ai-job-submitter
  echo "---"
  echo "apiVersion: rbac.authorization.k8s.io/v1"; echo "kind: RoleBinding"
  echo "metadata: { name: rancher-ai-notebook, namespace: $NS }"
  echo "roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: rancher-ai-notebook }"
  echo "subjects: [{ kind: ServiceAccount, name: rancher-ai-notebook, namespace: $NS }]"
  echo "---"
  echo "apiVersion: rbac.authorization.k8s.io/v1"; echo "kind: ClusterRole"
  echo "metadata: { name: rancher-ai-notebook-cluster-read }"; echo "rules:"; rules ai-scheduler-cluster-read
  echo "---"
  echo "apiVersion: rbac.authorization.k8s.io/v1"; echo "kind: ClusterRoleBinding"
  echo "metadata: { name: rancher-ai-notebook-$NS }"
  echo "roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: rancher-ai-notebook-cluster-read }"
  echo "subjects: [{ kind: ServiceAccount, name: rancher-ai-notebook, namespace: $NS }]"
} | K apply -f -

sed "s/NAMESPACE/$NS/g" "$HERE/notebook.yaml" | K apply -f -
K -n "$NS" rollout restart deploy/rancher-ai-notebook >/dev/null 2>&1 || true
K -n "$NS" rollout status deploy/rancher-ai-notebook --timeout=300s
cat <<MSG

Notebook running in $NS. Open it with:
  kubectl ${CTX[*]} -n $NS port-forward svc/rancher-ai-notebook 8888:8888
  # token: kubectl ${CTX[*]} -n $NS get secret rancher-ai-notebook -o jsonpath='{.data.jupyter-token}' | base64 -d
  open http://localhost:8888/lab/tree/rancher-ai-demo.ipynb
MSG
