#!/usr/bin/env python3
"""The `Change: <old> -> <new>` line has five parsers. They must agree.

Unlike the three harnesses next to it, this one renders nothing and runs no
helper. It is here because 0.3.6 added another implementation of one contract
and copies drift in silence. Writing this suite is how the count came out: the
guess going in was two perl copies, and there are four — `forge-remediate`,
`cluster-apply`, `cluster-canary` and `cluster-confirm`. Which is the argument
for the suite. Nobody was tracking that number.

The contract is a line of the form `Change: <old-image> -> <new-image>`, which
`plan-issue` writes onto the remediation issue and `forge-swap` repeats onto
the pull request. The four perl one-liners read it back off one or the other,
and what they find decides which image reaches a live workload. Then 0.3.6
transcribed the same pattern into Python, in the orchestrator, to answer a
question the perl could not: *before* a person is asked to approve the plan,
can the remediation step actually execute it?

That question is only worth asking if the answer matches what the perl will do
minutes later. A Python copy that is LAXER than the perl is the dangerous
direction — it tells the reviewer the plan is executable and then the agent
refuses anyway, which is the exact 2026-09-18 failure the check exists to
prevent, reintroduced by the fix for it. A stricter copy is merely annoying: it
warns about a plan that would have worked.

So: extract all three regexes from the sources they actually ship in, run each
against the same bodies, and require identical verdicts. The corpus is real —
the last two entries are the literal bodies of the two issues that broke a run.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
VALUES = os.path.join(ROOT, "charts", "secops-cpu-agents", "values.yaml")
ORCH = os.path.join(ROOT, "charts", "secops-cpu-agents", "files", "orchestrator.py")

# Every body either parser will ever be handed, and what the answer has to be.
# `parses` is True when a `Change:` line is present and complete.
CASES = [
    ("what plan-issue writes",
     "Image: docker.io/library/nginx:1.31.6\n"
     "Advisory: CVE-2026-9079\n"
     "Change: docker.io/library/nginx:1.31.6 -> dp.apps.rancher.io/containers/nginx:1.31.6-6.1\n"
     "Cites: base-image-distro-cves\n\nBecause the base image is unmaintained.",
     True),
    ("what forge-swap writes onto the pull request",
     "Closes #45.\nChange: docker.io/library/nginx:1.31.6 -> "
     "dp.apps.rancher.io/containers/nginx:1.31.6-6.1\n\n**DO NOT MERGE YET.**",
     True),
    ("a human repaired the body at the gate, with leading whitespace",
     "Some prose first.\n\n  Change: a/b:1 -> c/d:2\n\nmore prose",
     True),
    ("trailing whitespace, which a forge editor adds silently",
     "Change: a/b:1 -> c/d:2   \n",
     True),
    ("no arrow, because the model wrote the change as a sentence",
     "Change: from docker.io/library/nginx:1.31.6 to the AppCo build\n",
     False),
    ("the word appears mid-sentence in the rationale",
     "We should Change: nginx -> the AppCo build, as discussed.\n",
     False),
    # THE TWO THAT COST A RUN EACH. Both were posted by the orchestrator's
    # soft-failure path and both sat behind the approval gate looking like
    # plans. Neither is parsable, and no future parser may decide otherwise.
    ("2026-09-17: the clarifier reported an issue number it never created",
     "4258",
     False),
    ("2026-09-18: the clarifier printed the command instead of running it",
     '"/sandbox/bin/plan-issue \\"docker.io/library/nginx:1.31.6\\" '
     '\\"dp.apps.rancher.io/containers/nginx:1.31.6-6.1\\" '
     '\\"CVE-2026-9079,CVE-2026-8927,CVE-2026-6653\\" \\"base-image-distro-cves\\" '
     '\\"The image docker.io/library/nginx:1.31.6 contains critical '
     'vulnerabilities in base libraries.\\""',
     False),
]


def perl_patterns() -> list[tuple[str, str]]:
    """Every `Change:` matcher in values.yaml, with the helper it belongs to.

    Found by scanning rather than by line number, so a helper that grows a
    copy is picked up by this suite without anyone remembering to add it.
    """
    found = []
    helper = "?"
    for line in open(VALUES, encoding="utf-8"):
        named = re.match(r"^      ([a-z][a-z0-9-]*): \|", line)
        if named:
            helper = named.group(1)
        m = re.search(r"if \((/\^.*?Change:.*?\$/)\)", line)
        if m:
            found.append((helper, m.group(1)))
    return found


def python_pattern() -> str:
    for line in open(ORCH, encoding="utf-8"):
        m = re.match(r"^_PLAN_CHANGE = re\.compile\(r\"(.+)\", re\.M\)$", line.strip())
        if m:
            return m.group(1)
    sys.exit("orchestrator.py no longer defines _PLAN_CHANGE on one line")


def perl_says(pattern: str, body: str) -> bool:
    """Run the extracted one-liner exactly as forge-remediate runs it."""
    script = "if (%s) { print \"HIT\\n\"; exit 0 }" % pattern
    out = subprocess.run(
        ["perl", "-ne", script], input=body, capture_output=True, text=True,
    )
    return "HIT" in out.stdout


def main() -> int:
    pats = perl_patterns()
    py = python_pattern()
    print("perl copies found in values.yaml:")
    for helper, pat in pats:
        print("  %-16s %s" % (helper, pat))
    print("python copy in orchestrator.py:\n  %-16s %s" % ("_PLAN_CHANGE", py))

    if len(pats) < 4:
        sys.exit("expected at least four perl copies (forge-remediate, "
                 "cluster-apply, cluster-canary, cluster-confirm); found %d — "
                 "has one been renamed, or the scan broken?" % len(pats))
    distinct = {p for _, p in pats}
    if len(distinct) != 1:
        sys.exit("the perl copies have already drifted from each other: %s"
                 % json.dumps(sorted(distinct), indent=2))

    compiled = re.compile(py, re.M)
    failures = 0
    for title, body, expected in CASES:
        verdicts = {"python": bool(compiled.search(body))}
        for helper, pat in pats:
            verdicts[helper] = perl_says(pat, body)
        agreed = set(verdicts.values())
        ok = len(agreed) == 1 and agreed.pop() == expected
        print("  %-4s %s" % ("PASS" if ok else "FAIL", title))
        if not ok:
            failures += 1
            print("        expected %s, got %s" % (expected, verdicts))

    if failures:
        print("\n%d scenario(s) failed" % failures)
        return 1
    print("\nall scenarios passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
