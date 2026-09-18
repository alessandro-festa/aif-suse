#!/usr/bin/env python3
"""Offline stub harness for the `nv-survey` helper itself.

The three harnesses next to it all STUB this helper, which is why none of them
caught what shipped on 2026-09-18: the bug was in the thing being stubbed. The
canary came up Ready on the replacement image, SUSE Security scanned it, found
nothing wrong with it, and the pipeline reported UNSCANNED — because scan state
was inferred from whether the CVE view returned any rows, and a clean image
returns none. The single result this whole profile exists to produce was
unreachable by construction, and three green test suites had nothing to say.

So this one runs the real helper against a fake controller. Two endpoints
matter and they answer different questions:

  GET  /v1/workload?brief=true   per-container `scan_summary`: did a scan run,
                                 did it succeed, when, and how many findings
                                 PER PACKAGE
  POST /v1/vulasset + GET        one row per CVE, deduplicated, joined to the
                                 workloads it was found in

They disagree about the same image on purpose here — 27 critical against 3 —
because they disagree on the live cluster too, for the same reason: one counts
packages and one counts CVEs. 0.3.8 takes critical/high/medium from the scan
summary, which is the number SUSE Security's own UI shows, and `low` from the
CVE view, which is the only place `low` exists at all. The fixtures are chosen
so a regression to either single source fails an assertion.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CHART = os.path.join(REPO_ROOT, "charts", "secops-cpu-agents")
TMP = tempfile.mkdtemp(prefix="nv-survey-test-")

OLD = "docker.io/library/nginx:1.31.6"
NEW = "dp.apps.rancher.io/containers/nginx:1.31.6-6.1"
OTHER = "docker.io/library/redis:7.2"

STATE = {}


def container(cid, name, image, summary):
    return {"id": cid, "name": name, "display_name": name, "domain": "ns-demo-web",
            "image": image, "running": True, "scan_summary": summary}


def finished(critical, high, medium):
    return {"status": "finished", "result": "succeeded",
            "scanned_at": "2026-09-18T16:20:00Z", "scanner_version": "4.280",
            "critical": critical, "high": high, "medium": medium}


# The storefront: scanned, filthy. The canary: scanned, CLEAN — which is the
# case that had no representation before 0.3.8.
STOREFRONT = container("aaa111", "storefront", OLD, finished(27, 107, 94))
CANARY = container("bbb222", "storefront-canary", NEW, finished(0, 0, 0))
# Running, and the scanner has not got to it. Not the same as either.
PENDING = container("ccc333", "redis", OTHER,
                    {"status": "scheduled", "result": ""})


def vulrow(name, severity, image, low_fix=True):
    return {"name": name, "severity": severity,
            "description": "A flaw in %s." % name,
            "packages": ({"libfoo": [{"package_version": "1.0",
                                      "fixed_version": "1.1"}]} if low_fix else {}),
            "workloads": [{"image": image, "domain": "ns-demo-web"}]}


# THREE criticals and TWO lows for the storefront, against a scan summary that
# says 27. A run that reports `critical=3` has regressed to the CVE view; one
# that reports `low=0` has regressed to the scan summary, which has no `low`
# field at all.
VULROWS = [
    vulrow("CVE-2026-0001", "Critical", OLD),
    vulrow("CVE-2026-0002", "Critical", OLD),
    vulrow("CVE-2026-0003", "Critical", OLD),
    vulrow("CVE-2026-0004", "High", OLD),
    vulrow("CVE-2026-0005", "Medium", OLD),
    vulrow("CVE-2026-0006", "Low", OLD),
    vulrow("CVE-2026-0007", "Low", OLD),
]


class Stub(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        pass

    def _send(self, code, obj):
        body = b"" if obj is None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _route(self):
        p = self.path.split("?")[0]
        n = int(self.headers.get("content-length") or 0)
        self.rfile.read(n)
        if STATE.get("http_status"):
            return self._send(STATE["http_status"], {"message": "denied"})
        if p == "/v1/workload":
            return self._send(200, {"workloads": [
                {"id": "pod-" + w["id"], "children": [w]} for w in STATE["containers"]]})
        if p == "/v1/vulasset" and self.command == "POST":
            return self._send(200, {"query_id": "q1",
                                    "total_matched_records": len(STATE["vulrows"])})
        if p == "/v1/vulasset":
            return self._send(200, {"vulnerabilities": STATE["vulrows"]})
        if p.startswith("/v1/scan/workload/"):
            STATE.setdefault("scanned", []).append(p.rsplit("/", 1)[-1])
            return self._send(200, None)
        if p == "/v1/scan/config":
            return self._send(200, {"config": {"enable_auto_scan_workload": True}})
        if p == "/v1/scan/scanner":
            return self._send(200, {"scanners": [{"cvedb_version": "4.280"}]})
        return self._send(404, {"message": "no stub route for " + p})

    def do_GET(self):
        self._route()

    def do_POST(self):
        self._route()


def render_helper(port):
    v = yaml.safe_load(open(os.path.join(CHART, "values.yaml")))
    body = v["sandbox"]["helpers"]["suse-security"]["nv-survey"]
    sub = {"secops-cpu-agents.nvScheme": "http",
           "secops-cpu-agents.nvHost": "127.0.0.1",
           "secops-cpu-agents.nvPort": str(port)}

    def r(m):
        b = m.group(1).strip()
        for k in sub:
            if k in b:
                return sub[k]
        raise SystemExit("unmapped template expression: " + b)

    return re.sub(r"\{\{(.*?)\}\}", r, body)


def field(out, name):
    for line in out.splitlines():
        s = line.strip()
        if s.startswith(name + ": "):
            return s[len(name) + 2:]
    return ""


# ------------------------------------------------------------- the scenarios
# Each is (title, state overrides, argv, check(out, rc)).

def clean_is_a_pass(out, rc):
    assert rc == 0, out
    assert field(out, "status") == "SCANNED", out
    assert field(out, "counts") == "critical=0 high=0 medium=0 low=0", out
    assert "scanned: 2026-09-18T16:20:00Z" in out, out
    return "a finished scan with nothing in it is SCANNED, and says when"


def counts_come_from_both(out, rc):
    assert rc == 0, out
    # 27/107/94 is the scan summary; 3/1/1 is what the CVE view holds. `low=2`
    # is the CVE view, because the summary has no such field.
    assert field(out, "counts") == "critical=27 high=107 medium=94 low=2", out
    return "critical/high/medium off the summary, low off the CVE view"


def running_but_unfinished(out, rc):
    assert rc == 0, out
    assert field(out, "status") == "NOT-SCANNED", out
    assert field(out, "scan_summary") == "status=scheduled result=none", out
    return "a scan that has not finished says so, and quotes the scanner"


def nothing_runs_it(out, rc):
    assert rc == 0, out
    assert field(out, "status") == "NO-WORKLOAD", out
    assert "not a statement about the image" in out, out
    return "no container is NO-WORKLOAD, not NOT-SCANNED and not clean"


def a_403_is_an_error(out, rc):
    assert rc == 3, out
    assert field(out, "status").startswith("ERROR AUTH"), out
    return "a rejected key is an error on stdout, not an empty result"


def registry_dropped_still_matches(out, rc):
    assert rc == 0, out
    assert field(out, "status") == "SCANNED", out
    return "a runtime that drops the registry still resolves to the image"


def not_a_loose_substring(out, rc):
    # `nginx:1.31.6` IS a substring of `nginx:1.31.6-6.1`, and those two are
    # the before and after of this entire demo. Matching loosely here would
    # measure the replacement and report it as the thing it replaced.
    assert rc == 0, out
    assert field(out, "status") == "NO-WORKLOAD", out
    return "the old tag does not match the new image it is a prefix of"


def scan_asks_for_the_right_container(out, rc):
    assert rc == 0, out
    assert field(out, "status") == "TRIGGERED 1", out
    assert STATE.get("scanned") == ["bbb222"], STATE.get("scanned")
    return "--scan queues the canary's container id and only that one"


def the_ranked_table(out, rc):
    assert rc == 0, out
    assert "SUSE Security: http://127.0.0.1" in out, out
    assert "auto-scan (containers): true" in out, out
    # The clean image is known to the helper but is not a thing to fix, so it
    # is not on the menu a human picks a target from.
    assert NEW not in out, out
    assert OLD in out, out
    assert "critical=27 high=107 medium=94 low=2" in out, out
    # The provenance line `survey-issue` lifts onto the issue, so a reader who
    # sees 27 here and 3 in the scanner UI's CVE list is told why.
    assert out.count("counts: critical/high/medium") == 1, out
    return "the table names the controller, the counts and their provenance"


SCENARIOS = [
    ("a scanned, clean image is a pass and not an unscanned one",
     dict(), [NEW], clean_is_a_pass),
    ("the two count systems are merged, not picked between",
     dict(), [OLD], counts_come_from_both),
    ("a running container with an unfinished scan is NOT-SCANNED",
     dict(), [OTHER], running_but_unfinished),
    ("an image nothing runs is NO-WORKLOAD",
     dict(containers=[STOREFRONT], vulrows=[]), [NEW], nothing_runs_it),
    ("a 403 from the controller is ERROR AUTH",
     dict(http_status=403), [NEW], a_403_is_an_error),
    ("an image reported without its registry still matches",
     dict(containers=[container("bbb222", "c", "nginx:1.31.6-6.1", finished(0, 0, 0))],
          vulrows=[]),
     [NEW], registry_dropped_still_matches),
    ("nginx:1.31.6 is not matched against nginx:1.31.6-6.1",
     dict(containers=[CANARY], vulrows=[]), [OLD], not_a_loose_substring),
    ("--scan queues a scan for the container running the image",
     dict(), ["--scan", NEW], scan_asks_for_the_right_container),
    ("the no-arg table ranks what is broken and names where it came from",
     dict(), [], the_ranked_table),
]


def run():
    port = 18803
    srv = HTTPServer(("127.0.0.1", port), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    path = os.path.join(TMP, "nv-survey")
    with open(path, "w") as fh:
        fh.write(render_helper(port))
    os.chmod(path, 0o755)

    env = dict(os.environ, NEUVECTOR_API_KEY="stub-key")
    failures = 0
    for title, over, argv, check in SCENARIOS:
        STATE.clear()
        STATE.update(containers=[STOREFRONT, CANARY, PENDING], vulrows=list(VULROWS))
        STATE.update(over)
        p = subprocess.run([sys.executable, path] + argv,
                           capture_output=True, text=True, timeout=120, env=env)
        out = p.stdout + p.stderr
        try:
            note = check(p.stdout, p.returncode)
            print("  PASS  " + title)
            print("        " + note)
        except AssertionError as exc:
            failures += 1
            print("  FAIL  " + title)
            print("        " + str(exc).strip().replace("\n", "\n        ")[:1200])
        except Exception as exc:  # noqa: BLE001 - a broken check is a failure
            failures += 1
            print("  FAIL  " + title)
            print("        %s: %s" % (type(exc).__name__, exc))
            print("        " + out.strip().replace("\n", "\n        ")[:1200])

    srv.shutdown()
    if failures:
        print("\n%d scenario(s) failed" % failures)
        return 1
    print("\nall scenarios passed")
    return 0


if __name__ == "__main__":
    sys.exit(run())
