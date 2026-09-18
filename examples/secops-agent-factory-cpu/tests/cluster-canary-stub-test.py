#!/usr/bin/env python3
"""Offline stub harness for the `cluster-canary` helper.

Deliberately the same shape as cluster-apply-stub-test.py next to it: render
the helper out of values.yaml exactly as Helm would, point it at stubs, assert
on every refusal path and on the happy path. Read that file first; only what
differs is explained here.

What differs is what is at stake. `cluster-apply` runs after a human has
merged. This one runs BEFORE, and it is the only agent in the pipeline that
writes to a running cluster without an approval behind it. Two of its
properties are therefore not niceties:

  * it must never call an image clean that it did not see scanned — an image
    the scanner cannot pull, a scanner with auto-scan off, and a genuinely
    clean image are indistinguishable from here, and only the last one is a
    reason to merge;
  * it must never leave the canary running when it failed.

Both are asserted below, and neither is observable on the live cluster without
waiting for a scanner that takes minutes.

Three stubs, not two: the forge and Rancher as in the sibling harness, plus a
`nv-survey` that reproduces the one line the helper actually parses
(`  counts: critical=N …`) and, for one scenario, reports on the new image only
after a few polls — which is what NeuVector really does.

The rollout and scan deadlines are shortened per scenario so the suite costs
seconds instead of 13 minutes. The control flow, both `sleep`s included, is the
shipped text.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CHART = os.path.join(REPO_ROOT, "charts", "secops-cpu-agents")
OWNER, REPO, BOT = "secops", "cluster-manifests", "secops-bot"
CLUSTER = "c-jhrj6"
CANARY_NS, CANARY_NAME = "ns-demo-web", "storefront-canary"
OLD = "docker.io/library/nginx:1.31.6"
NEW = "dp.apps.rancher.io/containers/nginx:1.31.6-5.16"
BEFORE = "critical=27 high=107 medium=94 low=31"
AFTER = "critical=0 high=0 medium=0 low=2"

TMP = tempfile.mkdtemp(prefix="cluster-canary-test-")
BIN = os.path.join(TMP, "bin")
NV_STATE = os.path.join(TMP, "nv.json")
NV_CALLS = os.path.join(TMP, "nv.calls")
NV_SCANS = os.path.join(TMP, "nv.scans")

# --------------------------------------------------------------- the stubs

STATE = {}


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
        base = f"/api/v1/repos/{OWNER}/{REPO}"

        if p == f"{base}/pulls/1":
            return self._send(200, STATE["pr"])
        if p.startswith(f"{base}/issues/1/comments"):
            # Strict on purpose: the real forge answers 400 on a malformed body
            # and the comment is lost, and every comment this helper posts
            # interpolates scanner text or rollout conditions into JSON.
            try:
                STATE.setdefault("comments", []).append(json.loads(raw)["body"])
            except Exception as exc:
                STATE["bad_json"] = f"{exc}: {raw[:400]}"
                return self._send(400, {"message": "invalid JSON"})
            return self._send(201, {"id": 1})

        cpath = (f"/k8s/clusters/{CLUSTER}/apis/apps/v1/namespaces/"
                 f"{CANARY_NS}/deployments/{CANARY_NAME}")
        if p == cpath:
            if STATE.get("denied"):
                return self._send(403, {"error": "policy_denied",
                                        "detail": "not permitted by policy"})
            obj = STATE.get("canary")
            if obj is None:
                return self._send(404, {
                    "kind": "Status", "status": "Failure", "reason": "NotFound",
                    "message": f'deployments.apps "{CANARY_NAME}" not found',
                    "code": 404})
            if method == "PATCH":
                STATE.setdefault("patches", []).append(raw)
                STATE.setdefault("ctypes", []).append(self.headers.get("content-type"))
                return self._send(200, obj)
            STATE["polls"] = STATE.get("polls", 0) + 1
            out = json.loads(json.dumps(obj))
            out["status"] = STATE["status_fn"](STATE["polls"])
            return self._send(200, out)
        # Anything else is the helper reaching somewhere it was never meant to.
        # The live boundary answers that with a policy denial; here it is a 404
        # with the path in it, so a stray call is visible rather than absorbed.
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
    body = v["sandbox"]["helpers"]["rancher"]["cluster-canary"]
    sub = {
        ".Values.forge.owner": OWNER, ".Values.forge.repo": REPO,
        ".Values.rancher.clusterId": CLUSTER,
        ".Values.deploy.rolloutTimeoutSeconds": "180",
        ".Values.deploy.canary.scanTimeoutSeconds": "600",
        ".Values.deploy.canary.namespace": CANARY_NS,
        ".Values.deploy.canary.name": CANARY_NAME,
    }
    # Longest first. `.Values.deploy.canary.name` is a prefix of
    # `.Values.deploy.canary.namespace`, and a substring match in dict order
    # would render the namespace as "storefront-canary" — the canary would then
    # be patched somewhere that does not exist and this suite would be
    # asserting on the wrong object.
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

    # nv-survey, reduced to the three behaviours cluster-canary depends on. It
    # ends every single-image run in exactly one `  status: ` line — SCANNED
    # (with `  counts: `), NOT-SCANNED, or ERROR <kind>.
    #
    # THE THIRD ONE IS WHY THIS STUB CHANGED. It used to model two: a counts
    # line, or nothing at all, because the helper inferred "unscanned" from an
    # empty result. That made a rejected API key, a dead shim and a policy
    # refusal indistinguishable from an image the scanner had not reached — so
    # the tests could not tell them apart either, and the gap shipped.
    # `_error` in the state file makes every call fail that way, and
    # `_error_for` narrows it to images whose name contains that substring —
    # needed because the two sides of the comparison fail for different
    # reasons and the helper has to say which side it was.
    #
    # It also models `--scan <image>`, the request that asks SUSE Security to
    # look at the running container instead of waiting for auto-scan to reach
    # it. Every request is appended to a log the scenarios read back, and
    # `_reveal_on_scan` keeps an image invisible until its name appears in that
    # log — which is the only way a test can tell "the helper asked" from "the
    # helper waited and got lucky". `_no_workload` is the other outcome: the
    # scanner has no running container for the image and the request is a
    # no-op, which the helper has to report as a cluster fault rather than a
    # clean bill of health.
    #
    # NOTE the ordering: `--scan` returns before the call counter is touched.
    # A trigger is not a query, and counting it would shift every
    # `_reveal_after` scenario by one and make the "broke out of the poll"
    # assertion at the bottom of run() mean something else.
    p = os.path.join(BIN, "nv-survey")
    with open(p, "w") as fh:
        fh.write(f'''#!/usr/bin/env python3
import json, os, sys
state = json.load(open({NV_STATE!r}))
want = sys.argv[1] if len(sys.argv) > 1 else None
err = state.get("_error")
only = state.get("_error_for")


def refuse(arg):
    print("  status: ERROR %s - %s" % (err, "stub failure for " + str(arg)))
    sys.stderr.write("nv-survey:  status: ERROR %s\\n" % err)
    sys.exit(3)


if want == "--scan":
    img = sys.argv[2] if len(sys.argv) > 2 else ""
    if not img:
        sys.stderr.write("usage: nv-survey --scan <image>\\n")
        sys.exit(2)
    if err and (only is None or only in img):
        refuse(img)
    with open({NV_SCANS!r}, "a") as fh:
        fh.write(img + "\\n")
    if state.get("_no_workload"):
        print("  status: NO-WORKLOAD")
        sys.exit(4)
    print("  queued: %s  deadbeefcafe" % img)
    print("  status: TRIGGERED 1")
    sys.exit(0)
scanned = ""
if os.path.exists({NV_SCANS!r}):
    scanned = open({NV_SCANS!r}).read()
n = 0
if os.path.exists({NV_CALLS!r}):
    n = int(open({NV_CALLS!r}).read() or 0)
open({NV_CALLS!r}, "w").write(str(n + 1))
# "the scanner has not got to it yet": an image is invisible until the Nth call.
after = state.get("_reveal_after", {{}})
# "the scanner never looks unasked": invisible until something requested it.
on_scan = state.get("_reveal_on_scan", [])
images = {{k: v for k, v in state.items()
           if not k.startswith("_") and n + 1 >= after.get(k, 0)
           and (k not in on_scan or k in scanned)}}
if err and (only is None or (want and only in want)):
    refuse(want)
hits = [k for k in images if want and want in k]
if not hits:
    print("No scanner findings for an image matching %r." % want)
    print("  status: NOT-SCANNED")
    sys.exit(0)
for img in hits:
    print(img)
    print("  namespaces: {CANARY_NS}")
    print("  status: SCANNED")
    print("  counts: " + images[img])
    print("  [critical] CVE-2025-0001  fix: libfoo 1.0->1.1")
''')
    os.chmod(p, 0o755)


# ------------------------------------------------------------- the scenarios

def canary_obj(containers=None):
    return {
        "kind": "Deployment",
        "metadata": {"name": CANARY_NAME, "namespace": CANARY_NS, "generation": 2},
        "spec": {"replicas": 0, "template": {"spec": {
            "containers": containers or [{"name": "nginx", "image": OLD}],
        }}},
        "status": {},
    }


READY = lambda _n: {"observedGeneration": 3, "replicas": 1, "updatedReplicas": 1,
                    "availableReplicas": 1}
# The pod-spec mismatch this whole step exists to catch: a non-root image on a
# port the inherited spec binds as root. It never goes available.
NEVER = lambda _n: {"observedGeneration": 3, "replicas": 1, "updatedReplicas": 1,
                    "availableReplicas": 0,
                    "conditions": [
                        {"type": "Available", "status": "False",
                         "reason": "MinimumReplicasUnavailable",
                         "message": "Deployment does not have minimum availability."},
                        {"type": "Progressing", "status": "False",
                         "reason": "ProgressDeadlineExceeded",
                         "message": 'ReplicaSet "storefront-canary-x" has timed out'}]}

OPEN_PR = {"state": "open", "merged": False,
           "body": f"Closes #9.\nChange: {OLD} -> {NEW}\n\nMERGE IS THE AUTHORISATION."}

SCENARIOS = [
    ("PR body with no Change: line is refused",
     dict(pr={**OPEN_PR, "body": "Closes #9. Bumps the image."}),
     "no parsable", 1),
    ("an old image the scanner has nothing on is refused as no baseline",
     dict(nv={}), "no 'before'", 1),
    ("a policy denial is quoted, not worked around",
     dict(denied=True), "policy refuses", 1),
    ("a missing canary Deployment is refused",
     dict(canary=None), "could not read the canary", 1),
    ("a canary with two containers is refused as ambiguous",
     dict(canary=canary_obj([{"name": "nginx", "image": OLD},
                             {"name": "sidecar", "image": "busybox:1.36"}])),
     "does not have exactly one container", 1),
    ("a canary that never becomes available is the finding, and is scaled back",
     dict(status_fn=NEVER, deadline=10), "DID NOT BECOME AVAILABLE", 1),
    ("a Ready canary the scanner never reports on is UNSCANNED, not clean",
     dict(nv={OLD: BEFORE}, scandeadline=3, scansleep=1), "UNSCANNED", 1),
    # The three below are the contract this harness exists to hold. Each one
    # used to be indistinguishable from the scenario above it: the helper read
    # an empty `counts:` line and had one word for all of them.
    ("a scanner that will not answer for the OLD image is an error, not a missing baseline",
     dict(nv={OLD: BEFORE, NEW: AFTER, "_error": "AUTH"}), "broken scanner", 1),
    ("a scanner that will not answer for the NEW image is an error, not an unscanned image",
     dict(nv={OLD: BEFORE, NEW: AFTER, "_error": "POLICY-DENIED", "_error_for": NEW},
          scandeadline=60, scansleep=1), "NOT an unscanned image", 1),
    ("an unreachable scanner breaks the poll instead of burning the scan budget",
     dict(nv={OLD: BEFORE, NEW: AFTER, "_error": "UNREACHABLE", "_error_for": NEW},
          scandeadline=60, scansleep=1), "ERROR UNREACHABLE", 1),
    ("the scanner catching up mid-poll is waited for",
     dict(nv={OLD: BEFORE, NEW: AFTER, "_reveal_after": {NEW: 3}},
          scandeadline=60, scansleep=1), "VALIDATED", 0),
    # THE 2026-09-18 FAILURE, pinned. The live canary ran Ready for the full
    # 600s and the scanner reported nothing, with the key working and auto-scan
    # on: auto-scan simply never reached the new container. Here the image is
    # invisible until something asks for it, so this scenario passes only if
    # the helper sends `--scan` — take the trigger out and it times out
    # UNSCANNED instead.
    ("a scanner that only looks when it is asked is asked",
     dict(nv={OLD: BEFORE, NEW: AFTER, "_reveal_on_scan": [NEW]},
          scandeadline=60, scansleep=1), "VALIDATED", 0),
    ("a canary the scanner cannot see is reported as NO-WORKLOAD, not as clean",
     dict(nv={OLD: BEFORE, "_no_workload": True}, scandeadline=3, scansleep=1),
     "UNSCANNED", 1),
    ("the happy path starts the canary, measures both sides and reports",
     dict(), "VALIDATED", 0),
]


# Comment bodies kept across scenarios, so the error arms can assert they do
# not read like the unscanned arm. Ordering matters: the UNSCANNED scenario is
# listed before the three ERROR ones for that reason.
SEEN = {}


def run():
    port = 18801
    srv = HTTPServer(("127.0.0.1", port), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    write_shims(port)
    script = render_helper()

    failures = 0
    for title, over, expect, want_rc in SCENARIOS:
        STATE.clear()
        STATE.update(pr=OPEN_PR, canary=canary_obj(), status_fn=READY,
                     nv={OLD: BEFORE, NEW: AFTER}, comments=[])
        deadline = over.pop("deadline", None)
        scandeadline = over.pop("scandeadline", None)
        scansleep = over.pop("scansleep", None)
        STATE.update(over)
        if "canary" in over and over["canary"] is None:
            STATE["canary"] = None

        with open(NV_STATE, "w") as fh:
            json.dump(STATE["nv"], fh)
        with open(NV_CALLS, "w") as fh:
            fh.write("0")
        with open(NV_SCANS, "w") as fh:
            fh.write("")

        body = script
        if deadline:
            body = body.replace("deadline=180", f"deadline={deadline}")
        if scandeadline:
            body = body.replace("scandeadline=600", f"scandeadline={scandeadline}")
        if scansleep:
            body = body.replace("sleep 20", f"sleep {scansleep}")
        path = os.path.join(TMP, "cluster-canary")
        with open(path, "w") as fh:
            fh.write(body)
        os.chmod(path, 0o755)

        p = subprocess.run([path, "1"], capture_output=True, text=True, timeout=300)
        out = p.stdout + p.stderr
        ok = (p.returncode == want_rc) and (expect in out)
        print(("  PASS  " if ok else "  FAIL  ") + title)
        if not ok:
            failures += 1
            print(f"        wanted rc={want_rc} and {expect!r}; got rc={p.returncode}")
            print("        " + out.strip().replace("\n", "\n        ")[:1500])
            continue
        if STATE.get("bad_json"):
            failures += 1
            print("  FAIL  ^ the comment body was not valid JSON")
            print("        " + STATE["bad_json"])
            continue

        if want_rc == 0:
            # One PATCH, and it both starts the pod and sets the image. The
            # container name is read off the live object, never assumed.
            assert len(STATE["patches"]) == 1, STATE["patches"]
            assert json.loads(STATE["patches"][0]) == {"spec": {
                "replicas": 1, "template": {"spec": {"containers": [
                    {"name": "nginx", "image": NEW}]}}}}, STATE["patches"][0]
            assert STATE["ctypes"][0] == "application/strategic-merge-patch+json", \
                STATE["ctypes"][0]
            # Both numbers on the pull request, and the word that says they are
            # numbers rather than a prediction.
            c = STATE["comments"][0]
            assert BEFORE in c and AFTER in c, c
            assert "were measured" in c, c
            print(f"        patch: {STATE['patches'][0]}")
            print(f"        final line: {out.strip().splitlines()[-1]}")

        if "only looks when it is asked" in title:
            # Belt and braces. The scenario is already unpassable without the
            # trigger — the image is hidden until the log names it — but say so
            # out loud, because a future edit to the stub could make the
            # scenario pass for the wrong reason and nothing would complain.
            assert NEW in open(NV_SCANS).read(), "the scan was never requested"
            print("        measured only because the scan was asked for")

        if expect == "DID NOT BECOME AVAILABLE":
            # A failed canary must not be left running: the next run seeds from
            # replicas 0 and a human is not going to notice a pod with no
            # Service in front of it.
            assert len(STATE["patches"]) == 2, STATE["patches"]
            assert json.loads(STATE["patches"][1]) == {"spec": {"replicas": 0}}, \
                STATE["patches"][1]
            c = STATE["comments"][0]
            assert "Do not merge this yet" in c, c
            for reason in ("MinimumReplicasUnavailable", "ProgressDeadlineExceeded"):
                assert reason in c, reason
            print("        both conditions quoted as valid JSON; canary scaled back to 0")

        if expect == "UNSCANNED":
            c = STATE["comments"][0]
            assert "do not read this as a pass" in c, c
            assert BEFORE in c, c
            # The canary is deliberately LEFT RUNNING here: nobody knows yet
            # whether the image is clean, and killing the evidence is the wrong
            # move. Only the start patch was sent.
            assert len(STATE["patches"]) == 1, STATE["patches"]
            # setdefault, not assignment: the NO-WORKLOAD scenario further down
            # is also an UNSCANNED verdict, and the three ERROR arms compare
            # themselves against the FIRST one — the plain timeout.
            SEEN.setdefault("unscanned", c)
            # Whatever the outcome, the scan was requested. The verdict is
            # "we asked and got nothing back", which is a fault; before the
            # trigger existed it was "nobody ever asked", which was a bug.
            assert NEW in open(NV_SCANS).read(), "the scan was never requested"
            print("        reported as unverified, not as zero findings")

        if "NO-WORKLOAD" in title:
            c = STATE["comments"][0]
            # The trigger's own answer is on the pull request, because it is
            # the thing that narrows the timeout. NO-WORKLOAD means the scanner
            # can see no running container for this image at all — a cluster
            # fault, nothing to do with the image — and a reviewer who reads
            # only "unscanned" goes and looks in the wrong place.
            assert "returned `NO-WORKLOAD`" in c, c
            assert "do not read this as a pass" in c, c
            print("        the trigger's refusal is quoted, not swallowed")

        if expect == "broken scanner":
            # Not the no-baseline wording. An image the scanner has no record
            # of and a query the scanner refused to answer are different
            # faults with different fixes, and the run before this contract
            # existed reported them in the same sentence.
            assert "no 'before'" not in out, out
            assert "ERROR AUTH" in out, out
            # And nothing was started. A scanner that cannot be read is a
            # reason not to touch the cluster at all, so there is no canary
            # left running and no comment claiming there is.
            assert not STATE.get("patches"), STATE["patches"]
            assert not STATE["comments"], STATE["comments"]
            print("        refused before the canary was ever started")

        if expect in ("NOT an unscanned image", "ERROR UNREACHABLE"):
            c = STATE["comments"][0]
            # THE DELIVERABLE. Same canary, same Ready pod, same absence of
            # counts — and a visibly different comment, because the reviewer
            # has a different thing to go and fix.
            assert "Could not verify" in c, c
            assert "do not read this as a pass" not in c, c
            assert SEEN["unscanned"] != c
            assert "ERROR " + expect.split()[-1] in c or "POLICY-DENIED" in c, c
            # The baseline is still quoted — it was measured, and it is the
            # one number on the page that is real.
            assert BEFORE in c, c
            # The canary is left running, as in the unscanned arm: nobody
            # knows yet whether the image is clean.
            assert len(STATE["patches"]) == 1, STATE["patches"]
            # An error is not something that finishes if you wait. One
            # baseline call plus one poll; the 60s budget is not spent
            # re-asking a question that has already been answered.
            calls = int(open(NV_CALLS).read())
            assert calls <= 3, f"{calls} nv-survey calls; the poll did not break"
            print(f"        distinct from UNSCANNED; broke after {calls} scanner calls")

    srv.shutdown()
    print()
    print("all scenarios passed" if not failures else f"{failures} FAILED")
    return 1 if failures else 0


if __name__ == "__main__":
    shutil.rmtree(BIN, ignore_errors=True)
    sys.exit(run())
