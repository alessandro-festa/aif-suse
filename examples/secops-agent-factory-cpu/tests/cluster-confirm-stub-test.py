#!/usr/bin/env python3
"""Offline stub harness for the `cluster-confirm` helper.

Same shape as the two harnesses next to it — render the helper out of
values.yaml as Helm would, point it at stubs, assert on every arm. Read
cluster-apply-stub-test.py first; only what differs is explained here.

What differs is that this step runs LAST, after the merge, and its only
product is a sentence on the pull request. Nothing it does can be undone by
noticing later that it was wrong, so the sentence has to be true. There are
four ways for it to be wrong and this suite holds all four apart:

  * the new image is scanned and clean            -> CONFIRMED
  * the new image is not scanned                  -> Unverified
  * the scanner would not answer about the new one -> Could not verify
  * the scanner would not answer about the OLD one -> Could not verify

The last is the one worth a harness. This step reads the absence of findings
for the old image as "the old image is gone from the cluster" — which is the
correct reading after a merge, and a false pass if the reason there are no
findings is that the query failed. Before the `status:` contract the two were
the same empty string. Scenario six is that regression, pinned.
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
OWNER, REPO = "secops", "cluster-manifests"
OLD = "docker.io/library/nginx:1.31.6"
NEW = "dp.apps.rancher.io/containers/nginx:1.31.6-5.16"
BEFORE = "critical=27 high=107 medium=94 low=31"
AFTER = "critical=0 high=0 medium=0 low=2"

TMP = tempfile.mkdtemp(prefix="cluster-confirm-test-")
BIN = os.path.join(TMP, "bin")
NV_STATE = os.path.join(TMP, "nv.json")
NV_SCANS = os.path.join(TMP, "nv.scans")

STATE = {}


class Stub(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _route(self):
        p = self.path.split("?")[0]
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n).decode() if n else ""
        base = f"/api/v1/repos/{OWNER}/{REPO}"

        if p == f"{base}/pulls/1":
            return self._send(200, STATE["pr"])
        if p.startswith(f"{base}/issues/1/comments"):
            # Strict, as in the sibling harnesses: every comment here
            # interpolates scanner text into a JSON body, and the real forge
            # answers 400 and drops the comment on a malformed one.
            try:
                STATE.setdefault("comments", []).append(json.loads(raw)["body"])
            except Exception as exc:
                STATE["bad_json"] = f"{exc}: {raw[:400]}"
                return self._send(400, {"message": "invalid JSON"})
            return self._send(201, {"id": 1})
        return self._send(404, {"message": "no stub route for " + p})

    def do_GET(self):
        self._route()

    def do_POST(self):
        self._route()


def render_helper():
    v = yaml.safe_load(open(os.path.join(CHART, "values.yaml")))
    body = v["sandbox"]["helpers"]["suse-security"]["cluster-confirm"]
    # Short, unlike the chart's 600: every scenario here answers immediately or
    # never, and the never cases would otherwise sit out the real deadline.
    sub = {".Values.forge.owner": OWNER, ".Values.forge.repo": REPO,
           ".Values.deploy.canary.scanTimeoutSeconds": "2"}

    def r(m):
        b = m.group(1).strip()
        for k in sub:
            if k in b:
                return sub[k]
        raise SystemExit("unmapped template expression: " + b)

    return re.sub(r"\{\{(.*?)\}\}", r, body).replace("/sandbox/bin", BIN)


def write_shims(port):
    os.makedirs(BIN, exist_ok=True)
    p = os.path.join(BIN, "forge")
    with open(p, "w") as fh:
        fh.write(
            "#!/bin/sh\n"
            'method="$1"; path="$2"; body="$3"\n'
            'set -- -s -X "$method"\n'
            '[ -n "$body" ] && set -- "$@" -H "content-type: application/json" -d "$body"\n'
            f'exec curl "$@" "http://127.0.0.1:{port}${{path}}"\n'
        )
    os.chmod(p, 0o755)

    # nv-survey, reduced to the three outcomes this helper branches on. It
    # ends every single-image run in exactly one `  status: ` line — SCANNED
    # (with `  counts: `), NOT-SCANNED, or ERROR <kind>. `_error` fails every
    # call; `_error_for` narrows it to one image, which is how the old-image
    # regression is reproduced without also breaking the new-image query.
    #
    # `--scan <image>` is the fourth behaviour: the request that asks SUSE
    # Security to look at the running container rather than waiting for
    # auto-scan to reach it. `_reveal_on_scan` keeps an image invisible until
    # that request names it — the only way a test can tell "the step asked"
    # from "the step waited and got lucky" — and `_no_workload` is the other
    # answer, where the scanner can see no running container for the image at
    # all. The old image is deliberately never re-triggered by the step, so
    # nothing here should ever log a scan for it.
    p = os.path.join(BIN, "nv-survey")
    with open(p, "w") as fh:
        fh.write(f'''#!/usr/bin/env python3
import json, os, sys
state = json.load(open({NV_STATE!r}))
want = sys.argv[1] if len(sys.argv) > 1 else None
err, only = state.get("_error"), state.get("_error_for")


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
on_scan = state.get("_reveal_on_scan", [])
if err and (only is None or (want and only in want)):
    refuse(want)
hits = [k for k in state if not k.startswith("_") and want and want in k
        and (k not in on_scan or k in scanned)]
if not hits:
    # WHICH OF THE TWO EMPTY ANSWERS THIS IS, the distinction 0.3.8 added.
    # After the merge nothing on the cluster runs the old image, so an empty
    # answer about it is an absence — NO-WORKLOAD. The new image IS serving,
    # so an empty answer about that one is an unfinished scan — NOT-SCANNED.
    # The helper's "is the old image gone" sentence branches on exactly this,
    # and before the distinction existed it read an unfinished scan as gone.
    if want in state.get("_running_unscanned", []):
        kind = "NOT-SCANNED"
    elif state.get("_no_workload") or want == {OLD!r}:
        kind = "NO-WORKLOAD"
    else:
        kind = "NOT-SCANNED"
    if kind == "NO-WORKLOAD":
        print("No running container on this cluster uses %r." % want)
        print("  status: NO-WORKLOAD")
    else:
        print("%r is running, and the scanner has not finished with it." % want)
        print("  status: NOT-SCANNED")
        print("  scan_summary: status=scanning result=none")
    sys.exit(0)
for img in hits:
    print(img)
    print("  namespaces: ns-demo-web")
    print("  status: SCANNED")
    print("  counts: " + state[img])
    print("  [critical] CVE-2025-0001  fix: libfoo 1.0->1.1")
''')
    os.chmod(p, 0o755)


MERGED_PR = {"state": "closed", "merged": True,
             "body": f"Closes #9.\nChange: {OLD} -> {NEW}\n\nMERGE IS THE AUTHORISATION."}

SCENARIOS = [
    ("a PR body with no Change: line leaves nothing to confirm",
     dict(pr={**MERGED_PR, "body": "Closes #9. Bumps the image."}),
     "nothing to confirm", 1),
    ("the happy path: the new image is scanned and the old one is gone",
     dict(nv={NEW: AFTER}), "CONFIRMED", 0),
    ("the old image still being reported is said so, not hidden",
     dict(nv={OLD: BEFORE, NEW: AFTER}), "CONFIRMED", 0),
    ("a new image the scanner has nothing on is UNSCANNED, not clean",
     dict(nv={}), "UNSCANNED, not clean", 1),
    ("a scanner that will not answer about the NEW image is a broken rescan",
     dict(nv={NEW: AFTER, "_error": "AUTH", "_error_for": NEW}), "broken rescan", 1),
    # THE REGRESSION. Both these scenarios leave the old image with no counts;
    # only one of them means the image is gone.
    ("a scanner that will not answer about the OLD image is not 'the old image is gone'",
     dict(nv={NEW: AFTER, "_error": "POLICY-DENIED", "_error_for": OLD}),
     "broken rescan", 1),
    # The post-apply half of the 2026-09-18 failure. Auto-scan reached the new
    # container at neither step, so this step no longer waits to be noticed: it
    # asks. Here the image is invisible until it has been asked for, which makes
    # the scenario unpassable without the trigger.
    ("a scanner that only looks when it is asked is asked",
     dict(nv={NEW: AFTER, "_reveal_on_scan": [NEW]}), "CONFIRMED", 0),
    ("a workload the scanner cannot see is reported as NO-WORKLOAD, not as clean",
     dict(nv={"_no_workload": True}), "UNSCANNED, not clean", 1),
    # THE THIRD ARM, added with the 0.3.8 status contract. "Not SCANNED" used
    # to mean "gone", and here the old image is still running with a scan that
    # has not completed — the one case where calling it gone would be this
    # step's own false pass.
    # `expect` is matched against the transcript; the "Unclear" wording this
    # scenario is really about is asserted on the comment body further down.
    ("an old image still running with an unfinished scan is not called gone",
     dict(nv={NEW: AFTER, "_running_unscanned": [OLD]}), "CONFIRMED", 0),
    # The result the whole profile exists to produce, pinned at the consumer:
    # a finished scan that finds nothing is a pass, not an unverified run.
    ("a finished scan that finds nothing is CONFIRMED, not UNSCANNED",
     dict(nv={NEW: "critical=0 high=0 medium=0 low=0"}), "CONFIRMED", 0),
]

SEEN = {}


def run():
    port = 18802
    srv = HTTPServer(("127.0.0.1", port), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    write_shims(port)
    script = render_helper()
    path = os.path.join(TMP, "cluster-confirm")
    with open(path, "w") as fh:
        fh.write(script)
    os.chmod(path, 0o755)

    failures = 0
    for title, over, expect, want_rc in SCENARIOS:
        STATE.clear()
        STATE.update(pr=MERGED_PR, nv={NEW: AFTER}, comments=[])
        STATE.update(over)
        with open(NV_STATE, "w") as fh:
            json.dump(STATE["nv"], fh)
        with open(NV_SCANS, "w") as fh:
            fh.write("")

        p = subprocess.run([path, "1"], capture_output=True, text=True, timeout=120)
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
            c = STATE["comments"][0]
            assert STATE["nv"].get(NEW, AFTER) in c, c
            # The step's own question, answered three ways since 0.3.8 and
            # never skipped. "Not SCANNED" is no longer a synonym for gone.
            if OLD in STATE["nv"]:
                assert "No — " in c and "still reported" in c, c
                assert BEFORE in c, c
                print("        old image still present, and the comment says so")
            elif OLD in STATE["nv"].get("_running_unscanned", []):
                assert "Unclear — " in c and "has not completed" in c, c
                print("        old image running but unscanned, and not called gone")
            else:
                assert "Yes — " in c and "no running container" in c, c
                print("        old image gone, on a measurement and not an absence")

        if expect == "UNSCANNED, not clean":
            c = STATE["comments"][0]
            # setdefault: the NO-WORKLOAD scenario is also an unverified
            # verdict, and the error arms compare against the FIRST one.
            SEEN.setdefault("unscanned", c)
            assert "**Unverified.**" in c, c
            # The wording that keeps an unfinished scan apart from a clean
            # one, now that the second is a reportable pass and not a silence.
            assert "not the same thing as a clean image" in c, c
            # The rescan was requested outright. A timeout now means the
            # scanner was asked and did not deliver, which is a fault, rather
            # than that nobody ever asked, which is what shipped until 0.3.5.
            assert NEW in open(NV_SCANS).read(), "the rescan was never requested"
            # And the OLD image is not re-triggered: this step reads its
            # absence as "it is gone from the cluster", and asking the scanner
            # to go and look at it again is the one thing that could put it
            # back in the answer.
            assert OLD not in open(NV_SCANS).read(), "the old image was re-triggered"
            print("        reported as unverified, not as zero findings")

        if "NO-WORKLOAD" in title:
            c = STATE["comments"][0]
            # The trigger's own answer, on the pull request. NO-WORKLOAD means
            # the scanner sees no running container for the merged image at
            # all — after an apply, that is a deployment problem, and it reads
            # nothing like "the scan has not finished yet".
            assert "returned `NO-WORKLOAD`" in c, c
            print("        the trigger's refusal is quoted, not swallowed")

        if "only looks when it is asked" in title:
            assert NEW in open(NV_SCANS).read(), "the rescan was never requested"
            print("        measured only because the rescan was asked for")

        if expect == "broken rescan":
            c = STATE["comments"][0]
            # THE DELIVERABLE, same as in the canary suite: an unanswered
            # query and an unscanned image must not read alike, because the
            # reviewer has a different thing to go and fix.
            assert "Could not verify" in c, c
            assert "**Unverified.**" not in c, c
            assert SEEN["unscanned"] != c
            assert "nothing below should be read as a measurement" in c, c
            # And in neither direction does it reach the "old image gone"
            # sentence, which is what an empty counts string used to buy.
            assert "no longer reports" not in c, c
            assert "CONFIRMED" not in out, out
            print("        no verdict claimed in either direction")

    srv.shutdown()
    print()
    print("all scenarios passed" if not failures else f"{failures} FAILED")
    return 1 if failures else 0


if __name__ == "__main__":
    shutil.rmtree(BIN, ignore_errors=True)
    sys.exit(run())
