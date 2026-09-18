#!/usr/bin/env python3
"""Offline stub harness for the `cluster-apply` helper.

Renders the helper out of values.yaml exactly as Helm would, points it at a
stub Gitea and a stub Rancher, and asserts on each refusal path and the happy
path. Nothing here talks to a cluster.

The only thing modified in the script under test is the `/sandbox/bin` prefix
(there is no /sandbox on this machine) and, for the timeout case only, the
rollout deadline — so that the test costs 10s instead of 180s. The control flow
being tested is untouched; in particular the `sleep 5` in the poll loop is real.
"""
import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CHART = os.path.join(REPO_ROOT, "charts", "secops-cpu-agents")
WORKLOADS = os.path.join(
    REPO_ROOT, "examples", "secops-agent-factory-cpu", "workloads")
OWNER, REPO, BOT = "secops", "cluster-manifests", "secops-bot"
CLUSTER = "c-jhrj6"
CANARY_NS, CANARY_NAME = "ns-demo-web", "storefront-canary"
OLD = "docker.io/library/nginx:1.31.6"
NEW = "dp.apps.rancher.io/containers/nginx:1.31.6-5.16"

TMP = tempfile.mkdtemp(prefix="cluster-apply-test-")
BIN = os.path.join(TMP, "bin")

# --------------------------------------------------------------- the stubs

STATE = {}
RECORDED = []


def _manifest(path):
    with open(os.path.join(WORKLOADS, path)) as fh:
        return fh.read()


class Stub(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        pass

    def _send(self, code, obj):
        body = (obj if isinstance(obj, str) else json.dumps(obj)).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _route(self, method):
        p = self.path.split("?")[0]
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n).decode() if n else ""
        RECORDED.append((method, p, raw))
        base = f"/api/v1/repos/{OWNER}/{REPO}"

        if p == f"{base}/pulls/1":
            return self._send(200, STATE["pr"])
        if p == f"{base}/pulls/1/files":
            return self._send(200, [{"filename": f} for f in STATE["files"]])
        if p.startswith(f"{base}/contents/"):
            rel = p[len(f"{base}/contents/"):]
            text = STATE["manifests"].get(rel)
            if text is None:
                return self._send(404, {"message": "not found"})
            return self._send(200, {"content": base64.b64encode(text.encode()).decode()})
        if p.startswith(f"{base}/issues/1/comments"):
            # Gitea parses this body. If the helper built invalid JSON the real
            # forge answers 400 and the comment is lost, so the stub must be
            # just as strict rather than papering over it.
            try:
                STATE.setdefault("comments", []).append(json.loads(raw)["body"])
            except Exception as exc:
                STATE["bad_json"] = f"{exc}: {raw[:400]}"
                return self._send(400, {"message": "invalid JSON"})
            return self._send(201, {"id": 1})

        k8s = f"/k8s/clusters/{CLUSTER}/apis/apps/v1/namespaces/"
        if p.startswith(k8s):
            parts = (p[len(k8s):].split("/") + ["", "", ""])[:3]
            if (parts[0], parts[2]) == (CANARY_NS, CANARY_NAME):
                # Stage 9 — retiring the twin. A branch of its own on purpose:
                # the canary patch must not be mistaken for the workload patch
                # the rest of this test asserts on, and "the canary would not
                # scale down" has to be reportable without being fatal.
                if STATE.get("canary_denied"):
                    return self._send(403, {"error": "policy_denied",
                                            "detail": "not permitted"})
                if method == "PATCH":
                    STATE["canary_patch"] = raw
                    STATE["canary_ctype"] = self.headers.get("content-type")
                return self._send(200, {
                    "kind": "Deployment",
                    "metadata": {"name": CANARY_NAME, "namespace": CANARY_NS},
                    "spec": {"replicas": 0}, "status": {}})
            if STATE.get("denied"):
                return self._send(403, {"error": "policy_denied", "detail": "not permitted"})
            obj = STATE.get("live")
            if obj is None:
                return self._send(404, {
                    "kind": "Status", "status": "Failure", "reason": "NotFound",
                    "message": 'deployments.apps "storefront" not found', "code": 404})
            if method == "PATCH":
                STATE["patch"] = raw
                STATE["patch_ctype"] = self.headers.get("content-type")
                return self._send(200, obj)
            STATE["polls"] = STATE.get("polls", 0) + 1
            out = json.loads(json.dumps(obj))
            out["status"] = STATE["status_fn"](STATE["polls"])
            return self._send(200, out)
        return self._send(404, {"message": "no stub route for " + p})

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PATCH(self):
        self._route("PATCH")


# --------------------------------------------------- render the real helper

def render_helper():
    v = yaml.safe_load(open(os.path.join(CHART, "values.yaml")))
    body = v["sandbox"]["helpers"]["rancher"]["cluster-apply"]
    sub = {
        ".Values.forge.owner": OWNER, ".Values.forge.repo": REPO,
        ".Values.forge.botUser": BOT, ".Values.rancher.clusterId": CLUSTER,
        ".Values.deploy.rolloutTimeoutSeconds": "180",
        ".Values.deploy.canary.namespace": CANARY_NS,
        ".Values.deploy.canary.name": CANARY_NAME,
    }
    # Longest first. `.Values.deploy.canary.name` is a prefix of
    # `.Values.deploy.canary.namespace`, and a substring match in dict order
    # would silently render the namespace as "storefront-canary" — the canary
    # would then be patched in a namespace that does not exist and the test
    # would be asserting on the wrong object.
    keys = sorted(sub, key=len, reverse=True)

    def r(m):
        b = m.group(1).strip()
        for k in keys:
            if k in b:
                return sub[k]
        raise SystemExit("unmapped template expression: " + b)

    return re.sub(r"\{\{(.*?)\}\}", r, body).replace("/sandbox/bin", BIN)


def write_shims(port):
    os.makedirs(BIN, exist_ok=True)
    for name in ("forge", "rancher"):
        p = os.path.join(BIN, name)
        with open(p, "w") as fh:
            fh.write(
                "#!/bin/sh\n"
                'method="$1"; path="$2"; body="$3"; ctype="${4:-application/json}"\n'
                'set -- -s -X "$method"\n'
                '[ -n "$body" ] && set -- "$@" -H "content-type: ${ctype}" -d "$body"\n'
                f'exec curl "$@" "http://127.0.0.1:{port}${{path}}"\n'
            )
        os.chmod(p, 0o755)


# ------------------------------------------------------------- the scenarios

def live_obj(image=OLD, container="nginx"):
    return {
        "kind": "Deployment",
        "metadata": {"name": "storefront", "namespace": "ns-demo-web", "generation": 2},
        "spec": {"replicas": 1, "template": {"spec": {
            "initContainers": [{"name": "warmup", "image": image}],
            "containers": [{"name": container, "image": image}],
        }}},
        "status": {},
    }


READY = lambda _n: {"observedGeneration": 3, "replicas": 1, "updatedReplicas": 1,
                   "availableReplicas": 1}
NEVER = lambda _n: {"observedGeneration": 3, "replicas": 1, "updatedReplicas": 1,
                   "availableReplicas": 0,
                   "conditions": [{"type": "Progressing", "status": "False",
                                   "reason": "ProgressDeadlineExceeded",
                                   "message": 'ReplicaSet "storefront-x" has timed out'}]}
# A Deployment in real trouble reports more than one condition, and the
# rendered lines then contain both newlines and a double quote — the two
# characters that break a JSON string literal.
NEVER2 = lambda _n: {"observedGeneration": 3, "replicas": 1, "updatedReplicas": 1,
                    "availableReplicas": 0,
                    "conditions": [
                        {"type": "Available", "status": "False",
                         "reason": "MinimumReplicasUnavailable",
                         "message": "Deployment does not have minimum availability."},
                        {"type": "Progressing", "status": "False",
                         "reason": "ProgressDeadlineExceeded",
                         "message": 'ReplicaSet "storefront-x" has timed out'}]}

MERGED = {"merged": True, "state": "closed", "merged_by": {"login": "alessandro"},
          "body": f"Closes #9.\nChange: {OLD} -> {NEW}\n\nMERGING THIS IS THE AUTHORISATION."}

NGINX = _manifest("nginx.yaml").replace(OLD, NEW)
NO_NS = NGINX.replace("  namespace: ns-demo-web\n", "")

SCENARIOS = [
    ("unmerged PR is refused",
     dict(pr={**MERGED, "merged": False, "state": "open"}), "is NOT merged", 1),
    ("bot self-merge is refused",
     dict(pr={**MERGED, "merged_by": {"login": BOT}}), "the gate did not hold", 1),
    ("PR body with no Change: line is refused",
     dict(pr={**MERGED, "body": "Closes #9. Bumps the image."}),
     "no parsable", 1),
    ("a PR touching two files is refused",
     dict(files=["workloads/nginx.yaml", "workloads/coredns.yaml"]),
     "changes 2 files", 1),
    ("a manifest with no explicit namespace is refused",
     dict(manifests={"workloads/nginx.yaml": NO_NS}),
     "does not give", 1),
    ("a 404 from Kubernetes is refused",
     dict(live=None), "Kubernetes refused", 1),
    ("a policy denial is reported as the fence working",
     dict(denied=True), "the fence working", 1),
    ("a cluster that has drifted from the review is refused",
     dict(live=live_obj(image="docker.io/library/nginx:1.29.0")),
     "has drifted", 1),
    ("the happy path applies, retires the canary and reports",
     dict(), "APPLIED", 0),
    ("a canary that will not scale down is reported, not treated as a failure",
     dict(canary_denied=True), "APPLIED", 0),
    ("a rollout that never becomes available fails without rolling back",
     dict(status_fn=NEVER, deadline=10), "DID NOT BECOME AVAILABLE", 1),
    ("a multi-condition failure still posts a VALID JSON comment",
     dict(status_fn=NEVER2, deadline=10), "DID NOT BECOME AVAILABLE", 1),
]


def run():
    port = 18799
    srv = HTTPServer(("127.0.0.1", port), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    write_shims(port)
    script = render_helper()

    failures = 0
    for title, over, expect, want_rc in SCENARIOS:
        STATE.clear()
        RECORDED.clear()
        STATE.update(pr=MERGED, files=["workloads/nginx.yaml"],
                     manifests={"workloads/nginx.yaml": NGINX},
                     live=live_obj(), status_fn=READY, comments=[])
        deadline = over.pop("deadline", None)
        STATE.update(over)
        if "live" in over and over["live"] is None:
            STATE["live"] = None

        body = script
        if deadline:
            body = body.replace("deadline=180", f"deadline={deadline}")
        path = os.path.join(TMP, "cluster-apply")
        with open(path, "w") as fh:
            fh.write(body)
        os.chmod(path, 0o755)

        p = subprocess.run([path, "1"], capture_output=True, text=True, timeout=120)
        out = p.stdout + p.stderr
        ok = (p.returncode == want_rc) and (expect in out)
        print(("  PASS  " if ok else "  FAIL  ") + title)
        if not ok:
            failures += 1
            print(f"        wanted rc={want_rc} and {expect!r}; got rc={p.returncode}")
            print("        " + out.strip().replace("\n", "\n        ")[:1500])
            continue

        if want_rc == 0:
            patch = json.loads(STATE["patch"])
            c = patch["spec"]["template"]["spec"]["containers"]
            assert c == [{"name": "nginx", "image": NEW}], c
            assert STATE["patch_ctype"] == "application/strategic-merge-patch+json", \
                STATE["patch_ctype"]
            assert STATE["comments"], "no comment posted"
            # Stage 9. The twin is scaled, never deleted, and the outcome is
            # stated on the pull request whichever way it went — a deploy that
            # worked must not be reported as failed because the tidy-up did not.
            if STATE.get("canary_denied"):
                assert "canary_patch" not in STATE, "the denial did not reach the helper"
                assert "STILL RUNNING" in STATE["comments"][0], STATE["comments"][0]
            else:
                assert json.loads(STATE["canary_patch"]) == {"spec": {"replicas": 0}}, \
                    STATE["canary_patch"]
                assert STATE["canary_ctype"] == \
                    "application/strategic-merge-patch+json", STATE["canary_ctype"]
                assert "scaled to 0" in STATE["comments"][0], STATE["comments"][0]
            print(f"        patch body: {STATE['patch']}")
            print(f"        content-type: {STATE['patch_ctype']}")
            print(f"        canary: {STATE.get('canary_patch', 'refused — reported')}")
            print(f"        final line: {out.strip().splitlines()[-1]}")
        if "DID NOT BECOME AVAILABLE" in expect:
            if STATE.get("bad_json"):
                failures += 1
                print("  FAIL  ^ the comment body was not valid JSON")
                print("        " + STATE["bad_json"])
                continue
            assert STATE["comments"], "no comment posted on the failed rollout"
            assert "ProgressDeadlineExceeded" in STATE["comments"][0]
            assert "patch" in STATE, "the patch should have been sent"
            nconds = STATE["status_fn"](1)["conditions"]
            for c in nconds:
                assert c["reason"] in STATE["comments"][0], c["reason"]
            print(f"        {len(nconds)} condition(s) quoted on the PR as valid "
                  f"JSON; no rollback issued")

    srv.shutdown()
    print()
    print("all scenarios passed" if not failures else f"{failures} FAILED")
    return 1 if failures else 0


if __name__ == "__main__":
    shutil.rmtree(BIN, ignore_errors=True)
    sys.exit(run())
