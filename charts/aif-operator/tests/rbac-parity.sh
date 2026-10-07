#!/usr/bin/env bash
# Every permission the operator's code declares (+kubebuilder:rbac markers, generated into
# operator/config/rbac/role.yaml by `make manifests`) must be granted by the chart's ClusterRole,
# which is maintained by hand. A rule added to the markers but not the chart -- or added to the
# chart's namespaced Role by mistake -- only shows up on a real cluster as "forbidden".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

helm template rel "$ROOT/charts/aif-operator" --namespace aif-operator --show-only templates/rbac/manager-role.yaml \
  | python3 -c '
import sys, yaml
want = yaml.safe_load(open(sys.argv[1]))
docs = [d for d in yaml.safe_load_all(sys.stdin) if d and d.get("kind") == "ClusterRole"]
granted = set()
for d in docs:
    for r in d.get("rules", []):
        for g in r.get("apiGroups", [""]):
            for res in r.get("resources", []):
                for v in r.get("verbs", []):
                    granted.add((g, res, v))
missing = sorted({(g, res, v)
                  for r in want.get("rules", [])
                  for g in r.get("apiGroups", [""])
                  for res in r.get("resources", [])
                  for v in r.get("verbs", [])
                  if (g, res, v) not in granted and (g, res, "*") not in granted})
if missing:
    for g, res, v in missing:
        print("FAIL: chart ClusterRole does not grant %s on %s.%s" % (v, res, g or "core"))
    sys.exit(1)
print("PASS: the chart ClusterRole grants every rule in operator/config/rbac/role.yaml")
' "$ROOT/operator/config/rbac/role.yaml"
