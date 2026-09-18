# Offline tests

Tests that run on a laptop with no cluster, no gateway and no credentials.

Four harnesses — one per helper that writes to a running cluster or reports a
verdict on one, plus one for the helper all three of those depend on — and a
contract test that renders nothing. Run them all:

```
python3 cluster-apply-stub-test.py \
  && python3 cluster-canary-stub-test.py \
  && python3 cluster-confirm-stub-test.py \
  && python3 nv-survey-stub-test.py \
  && python3 change-line-contract-test.py
```

## `cluster-apply-stub-test.py`

Exercises the `cluster-apply` helper — what the deploy agent runs once a human
has merged — against a stub Gitea and a stub Rancher.

```
python3 cluster-apply-stub-test.py
```

Takes about 20 seconds; most of that is two real `sleep 5` rollout polls.

**Why this file exists rather than a live smoke test.** `cluster-apply` is
mostly refusals: unmerged pull request, bot-merged pull request, missing
`Change:` line, several changed files, a manifest with no explicit namespace, a
404 from Kubernetes, a denial from the sandbox policy, a cluster that has
drifted from what was reviewed. Every one of those is a path that must never
run on the demo cluster, so the only place they can be checked is here. The
harness renders the helper out of `values.yaml` exactly as Helm does, so it
tests the shipped text and not a copy of it.

It also asserts the two things a live run would show but not prove:

- the PATCH body is exactly a strategic-merge image swap naming the container
  discovered from the **live object** — the fixture deliberately puts an
  `initContainers` entry on the same image, and the patch must not name it;
- the comment posted on a failed rollout is **valid JSON**. It was not, before
  2026-09-17: `esc()` escaped quotes and backslashes but not newlines, and a
  Deployment in real trouble reports several conditions. Gitea answers 400 and
  the POST is fire-and-forget, so the failure report vanished silently — the
  one output that step exists to produce. Confirm the test still has teeth by
  reverting the `perl` in `esc()` to the old `sed`; the last scenario must fail
  with `Invalid control character`.

The only things modified in the script under test are the `/sandbox/bin` prefix
and, for the two timeout scenarios, the rollout deadline. The control flow is
untouched.

Since 0.3.1 it also covers stage 9, retiring the canary: the happy path must
send a second PATCH of `{"spec":{"replicas":0}}` to the canary's own path and
say `scaled to 0` on the pull request, and a canary that refuses to scale down
must be reported as `STILL RUNNING` **without** turning a successful deploy into
a failed one. Tidying up is not the job.

## `cluster-canary-stub-test.py`

Exercises `cluster-canary` — the pre-merge measurement, and the only agent in
the pipeline that writes to a running cluster with no human approval behind it.
Three stubs: Gitea, Rancher, and an `nv-survey` that produces the one line the
helper parses.

```
python3 cluster-canary-stub-test.py
```

Takes about 25 seconds; most of that is real rollout and scanner polls.

**Why this file exists.** The two properties that make a pre-merge cluster write
defensible are both invisible on a live run that goes well:

- **An unscanned image is never reported as clean.** SUSE Security takes minutes
  to get to a new pod, and an image it cannot pull, a scanner with auto-scan
  switched off, and a genuinely clean image all look identical from here — zero
  findings. Only the last is a reason to merge. One scenario starves the scanner
  and requires the words `UNSCANNED` and "do not read this as a pass" on the
  pull request; another has the scanner catch up on the third poll and requires
  the helper to have waited for it.
- **A canary that fails is not left running.** It has no Service and nothing in
  front of it, so nobody would notice. The rollout-failure scenario asserts a
  second PATCH back to `replicas: 0` — and the unscanned scenario asserts the
  opposite, that the pod is *left up*, because there the evidence is the pod.

Plus the refusals, for the same reason as the sibling harness: no `Change:` line,
no scanner baseline for the image that is supposedly running, a policy denial, a
canary Deployment that was never seeded, and a canary with more than one
container. And, as above, that every comment body is valid JSON — this helper
interpolates both scanner output and rollout conditions into one.

Since 0.3.3, three more: a scanner that refuses the **baseline** query, one that
refuses the **rescan**, and one that is unreachable. All three used to be the
same empty string as an unscanned image, so the helper had one wording for
five different faults. Each scenario now asserts the posted comment differs
from the `UNSCANNED` one, and the unreachable case additionally asserts the
poll **broke** rather than spending its whole 600-second budget re-asking a
question that had already been answered.

Modified in the script under test: the `/sandbox/bin` prefix, and per scenario
the rollout deadline, the scan deadline and the scan poll interval.

## `cluster-confirm-stub-test.py`

Exercises `cluster-confirm` — the post-apply rescan, the last step in the
pipeline. Two stubs: Gitea and `nv-survey`. Runs in about a second; it has no
polls.

```
python3 cluster-confirm-stub-test.py
```

**Why this file exists.** This step's only product is a sentence on the pull
request, and by the time anyone could notice it is wrong the merge is long
done. There are four outcomes and they have to stay apart: the new image
scanned (`CONFIRMED`), the new image unscanned (`Unverified`), and the scanner
declining to answer about either image (`Could not verify`).

The last one is the reason for the harness. Unlike the canary, this step reads
an absence of findings for the **old** image as *the old image is gone from the
cluster* — which is the right reading after a merge, and a false pass when the
real reason is that the query failed. Scenario six pins exactly that: the new
image scans fine, the old one's query is refused, and the run must not reach
its verdict. Under the pre-0.3.3 contract it exited 0 with `CONFIRMED` and told
the reviewer the old image was gone.

Since 0.3.8 there is a third reading of an empty answer about the old image,
and the harness holds all three apart: `NO-WORKLOAD` (nothing runs it — gone),
`NOT-SCANNED` (something runs it and the scan has not finished — emphatically
not gone), `ERROR` (the query failed — no verdict either way).

## `nv-survey-stub-test.py`

Exercises `nv-survey` against a fake NeuVector controller. About a second.

```
python3 nv-survey-stub-test.py
```

**Why this file exists.** The three harnesses above all stub `nv-survey`, so
when the bug was in `nv-survey` they were three green suites with nothing to
say. That happened on 2026-09-18: the canary came up Ready on the replacement,
SUSE Security scanned it, found nothing wrong with it, and the pipeline
reported `UNSCANNED` — because scan state was inferred from whether the CVE
view returned rows, and a clean image returns none. **The one result this
profile exists to produce could not be produced.**

The fix reads `scan_summary` off `GET /v1/workload?brief=true`, which carries
the scanner's own `status` and `result` per container alongside its counts. So
the fixtures here have a filthy image, a **clean scanned** image and a running
image whose scan has not finished, and the suite asserts those are three
different answers.

It also pins two things that are easy to get wrong and invisible when you do:

- **The two count systems.** The scan summary counts findings per package; the
  CVE view counts distinct CVEs. On the demo's own nginx that is 27 critical
  against 17, and for two revisions the documentation quoted one while the
  issues quoted the other. `critical`/`high`/`medium` come from the summary
  and `low` from the CVE view, because the summary has no `low` field. The
  fixture says 27 in one place and 3 in the other, so a regression to either
  single source fails.
- **Image matching is not a substring match.** `nginx:1.31.6` is a prefix of
  `nginx:1.31.6-6.1`, and those two are the before and after of this entire
  demo. The fallback for a runtime that drops the registry compares the
  `repository:tag` tail for equality; a loose match would measure the
  replacement and report it as the thing it replaced.

## `change-line-contract-test.py`

Renders nothing and runs no helper. The `Change: <old> -> <new>` line has five
parsers — four perl one-liners in `values.yaml` and one Python regex in
`orchestrator.py` — and this runs all five against the same bodies and fails if
any of them disagrees. The corpus ends with the literal bodies of the two
issues that each cost a live run.

```
python3 change-line-contract-test.py
```
