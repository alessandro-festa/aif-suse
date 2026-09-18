#!/usr/bin/env python3
"""SecOps CPU orchestrator — drives one OpenShell sandbox per agent.

Mounted from a ConfigMap, not baked into the image, so the workflow and its
prompts can be iterated without a rebuild. The image supplies the `openshell`
CLI binary; everything here is Python's standard library.

WHAT THIS PROCESS IS FOR

The zero-GPU profile inverts the GPU design's sandbox split. There, eight of
ten agents share one AI-Q pod behind a single NetworkPolicy. Here every agent
gets its own sandbox and its own policy file, so the claim "the researcher
cannot reach SUSE Security" is a property of the running system rather than a
diagram. Something has to create those sandboxes, sequence them, and carry
results between them. That is this.

WHAT IT DELIBERATELY IS NOT

It is not an agent. It does no inference, holds no prompt reasoning, and makes
no decision about the vulnerability. It creates sandboxes, runs one command in
each, collects stdout, and polls a git forge for a human's answer. Every
judgement in the pipeline is made either by a model inside a sandbox or by a
person in the Gitea UI.

There are three of those human points, and they are load-bearing in different
ways. First a person CHOOSES which container the run is about, out of a ranked
list the scanner produced — the machine deliberately declines to recommend one.
Then a person APPROVES the plan. Then a person MERGES the pull request, which
this process cannot do and the remediation agent's forge account is not
permitted to do either.

It is also the only component holding credentials — the gateway mTLS material,
the git forge token. The agents hold none of them; their credentials are
injected by the gateway at the egress boundary, so an agent that dumps its own
environment learns nothing. Keeping the credential holder outside every sandbox
is what makes §3's "the agents have no access to the plane that governs them"
true rather than aspirational.

HANDOFF: A DEVIATION FROM THE PLAN, AND WHY

The plan pointed at OpenShell's `examples/multi-agent-notepad/`, where several
sandboxes collaborate over a shared filesystem, and said "do not invent a bus".
That pattern needs ReadWriteMany storage. downstream-1 has exactly one
StorageClass — `standard`, `rancher.io/local-path` — which is RWO and
WaitForFirstConsumer, so two sandboxes on two nodes cannot share a volume. The
notepad pattern is not available here.

So handoff goes through the orchestrator: each phase's output is recorded and
spliced into the next phase's prompt. This is not a bus — it is the component
that was already sequencing the agents also carrying their results. It has one
genuine advantage over the shared notepad: every handoff is a recorded
transition, which is what the status page renders and what makes the run
auditable after the fact.
"""

from __future__ import annotations

import base64
import json
import os
import re
import secrets
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, NoReturn

# --------------------------------------------------------------------- config


def _env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None:
        sys.exit(f"orchestrator: required environment variable {name} is not set")
    return value


def _read_secret(path: str) -> str:
    """Read a credential from a projected Secret file, not from the environment.

    A value in the environment shows up in `kubectl describe pod`, in crash
    dumps and in any child process's /proc/<pid>/environ. The git forge token
    is the credential that can merge code, so it is mounted as a file with mode
    0400 and read once, here.
    """
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError as exc:
        sys.exit(f"orchestrator: cannot read credential at {path}: {exc}")


GATEWAY_NAME = _env("OPENSHELL_GATEWAY_NAME", "aif-cluster")
GATEWAY_ENDPOINT = _env("OPENSHELL_GATEWAY_ENDPOINT")
WORKSPACE = _env("OPENSHELL_WORKSPACE")
CLIENT_TLS_DIR = _env("OPENSHELL_CLIENT_TLS_DIR", "/var/run/openshell-client-tls")
CONFIG_HOME = _env("XDG_CONFIG_HOME", "/var/lib/openshell/.config")

SANDBOX_IMAGE = _env("SANDBOX_IMAGE")
POLICY_DIR = _env("POLICY_DIR", "/policies")
AGENTS_FILE = _env("AGENTS_FILE", "/workflow/agents.json")
STATUS_HTML = _env("STATUS_HTML", "/workflow/status.html")
STATUS_PORT = int(_env("STATUS_PORT", "8080"))

GITEA_URL = _env("GITEA_URL").rstrip("/")
GITEA_OWNER = _env("GITEA_OWNER")
GITEA_REPO = _env("GITEA_REPO")
GITEA_TOKEN = _read_secret(_env("GITEA_TOKEN_FILE", "/var/run/gitea/token"))

APPROVE_LABEL = _env("APPROVE_LABEL", "approved")
REJECT_LABEL = _env("REJECT_LABEL", "rejected")
# Whether the approval gate accepts a bare `approved` comment as well as the
# label. Default false — see wait_for_human for why the weaker path exists, and
# set this true for a deployment where the gate has to be an authorisation
# rather than an affordance.
GATE_REQUIRE_LABEL = _env("GATE_REQUIRE_LABEL", "false").lower() == "true"
# The account the survey issue is posted as. The selection gate skips comments
# by this user, so the orchestrator's own trailer can never be read back as the
# human's answer to the question the orchestrator asked.
GITEA_BOT_USER = _env("GITEA_BOT_USER", "secops-bot")
# Only ever printed, never acted on: the handover comment names the namespace a
# human applies the merged manifest to, and the Deployment they restart to
# re-measure. The orchestrator has no kubectl and no RBAC to run either.
WORKLOAD_NAMESPACE = _env("WORKLOAD_NAMESPACE", "ns-demo-web")
# The handover comment has to say that the replacement image is ALREADY running
# here as a canary when the reviewer reads it — "nothing has touched the
# cluster" stopped being true in 0.3.1 and a gate that misdescribes the state of
# the cluster is worse than no gate. Since 0.3.5 this is also acted on: the
# orchestrator creates this Deployment for the canary step and deletes it
# afterwards, which is the only Kubernetes call it makes. See _canary_create.
CANARY_WORKLOAD = _env("CANARY_WORKLOAD", "ns-demo-web/storefront-canary")
# The object to create, rendered from .Values.deploy.canary.template into the
# workflow ConfigMap. A value rather than Python so the pod spec it twins — the
# probe, the capabilities, the pull secret — stays next to the rest of the
# configuration and shows up in `helm template`.
CANARY_SPEC_FILE = _env("CANARY_SPEC_FILE", "/workflow/canary.json")
NAMESPACE = _env("NAMESPACE", "ns-secops-cpu")
ORCHESTRATOR_NAME = _env("ORCHESTRATOR_NAME", "secops-cpu-orchestrator")
# 30 minutes, same reasoning as the approval gate below: a person reading a
# ranked list of twelve images and deciding which one matters.
SELECT_PROMPT_SECONDS = int(_env("SELECT_PROMPT_SECONDS", "1800"))
# 30 minutes. The gate is a person reading an advisory, so this is a
# "something has gone wrong" bound, not a service-level expectation.
GATE_TIMEOUT_SECONDS = int(_env("GATE_TIMEOUT_SECONDS", "1800"))
GATE_POLL_SECONDS = int(_env("GATE_POLL_SECONDS", "10"))

# Two hours, and it is a different number from GATE_TIMEOUT_SECONDS on purpose.
# The first two gates ask a reviewer to answer a question the pipeline has just
# put in front of them, so thirty minutes means "nobody is watching". This one
# asks them to review a diff and merge it, which is a normal piece of work that
# waits for a free moment. Sharing the 30-minute bound would park perfectly
# healthy runs, and a parked run looks like a failure.
MERGE_TIMEOUT_SECONDS = int(_env("MERGE_TIMEOUT_SECONDS", "7200"))

# Per-agent wall clock. Measured on this hardware: p50 2.07s per tool call,
# max 7.80s (spike/RESULTS.md), and an agent turn is several calls plus model
# load. 900s is generous on purpose — a timeout here is indistinguishable from
# a hung sandbox in the status page, so it should only fire when something is
# genuinely stuck.
AGENT_TIMEOUT_SECONDS = int(_env("AGENT_TIMEOUT_SECONDS", "900"))

# The CLI version this code was written against. Asserted at start-up because
# the whole orchestrator is flag-parsing against a binary it does not build:
# a silently bumped image would fail later, inside a phase, with an error that
# reads like an agent problem.
EXPECTED_CLI_VERSION = _env("EXPECTED_OPENSHELL_VERSION", "0.0.116")

# NOTHING IS SEEDED. There used to be a SEED_FINDING here — a CVE id from
# values.yaml that the first prompt asked triage to "confirm" — and it was the
# single worst thing in this file. The scanner had auto-scan off and was
# returning an empty finding set, and triage reported the seeded CVE as
# "confirmed in the cluster, critical severity" anyway, because the question
# graded the model on agreeing with its own prompt.
#
# The run now starts at the survey agent, which asks the scanner what is
# actually there. If the scanner has nothing to say, the run says so.


# ------------------------------------------------------------------ run state


@dataclass
class Step:
    name: str
    agent: str
    state: str = "pending"  # pending | running | done | failed | waiting
    started: float | None = None
    ended: float | None = None
    detail: str = ""
    output: str = ""


@dataclass
class Run:
    steps: list[Step] = field(default_factory=list)
    finding: str = ""
    # The container image a human chose out of the survey. Empty until the
    # selection gate returns, and every phase after it is about this one image.
    target: str = ""
    # The issue the survey posted, which is also where the human replies with a
    # number. Kept separately from `issue` (the plan issue) because the status
    # page links both and they are two different conversations.
    surveyIssue: int | None = None
    issue: int | None = None
    pull: int | None = None
    # What actually landed on the cluster, as the deploy agent reported it.
    # Empty for every run that stops at an open pull request, which is most of
    # them and is not a failure. The status page shows it only when set,
    # because "applied: nothing" and "not yet merged" are the same state and
    # the second is the honest wording.
    applied: str = ""
    verdict: str = ""
    lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "finding": self.finding,
                "target": self.target,
                "surveyIssue": self.surveyIssue,
                "issue": self.issue,
                "pull": self.pull,
                "applied": self.applied,
                "verdict": self.verdict,
                "giteaUrl": f"{GITEA_URL}/{GITEA_OWNER}/{GITEA_REPO}",
                "steps": [
                    {
                        "name": s.name,
                        "agent": s.agent,
                        "state": s.state,
                        "seconds": round((s.ended or time.time()) - s.started, 1)
                        if s.started
                        else None,
                        "detail": s.detail,
                        "output": s.output,
                    }
                    for s in self.steps
                ],
            }


RUN = Run()


def _log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


# ------------------------------------------------------- gateway registration


def _bootstrap_gateway() -> None:
    """Write the gateway registration the CLI expects, without `gateway add`.

    `openshell gateway add --local` is the documented path, and it is the wrong
    one here for a specific reason: it seeds the registration's `mtls/`
    directory from a *local* OpenShell daemon's CA, overwriting whatever is
    already there. docs/openshell-demo.md records the resulting failure —
    `invalid peer certificate: BadSignature` — and the register-then-copy
    ordering that avoids it. In a pod there is no local daemon at all, so
    `gateway add` has nothing to seed from and the ordering dance has no
    meaning. Writing the two artefacts it would have produced is both simpler
    and free of the trap.

    The registration is `metadata.json` (crates/openshell-bootstrap/src/
    metadata.rs, `GatewayMetadata`) plus the three PEMs under `mtls/`. The
    Secret is projected read-only and the CLI writes into this tree at runtime,
    so the PEMs are copied into an emptyDir rather than mounted in place.
    """
    gateway_dir = os.path.join(CONFIG_HOME, "openshell", "gateways", GATEWAY_NAME)
    mtls_dir = os.path.join(gateway_dir, "mtls")
    os.makedirs(mtls_dir, mode=0o700, exist_ok=True)

    port = urllib.parse.urlparse(GATEWAY_ENDPOINT).port or 8080
    metadata = {
        "name": GATEWAY_NAME,
        "gateway_endpoint": GATEWAY_ENDPOINT,
        "is_remote": False,
        "gateway_port": port,
        "auth_mode": "mtls",
    }
    with open(os.path.join(gateway_dir, "metadata.json"), "w", encoding="utf-8") as fh:
        json.dump(metadata, fh)

    for name in ("tls.crt", "tls.key", "ca.crt"):
        source = os.path.join(CLIENT_TLS_DIR, name)
        target = os.path.join(mtls_dir, name)
        shutil.copyfile(source, target)
        os.chmod(target, 0o600)

    _log(f"registered gateway {GATEWAY_NAME} -> {GATEWAY_ENDPOINT}")


def _assert_cli_version() -> None:
    reported = subprocess.run(
        ["openshell", "--version"], capture_output=True, text=True, check=True
    ).stdout.strip()
    if EXPECTED_CLI_VERSION and EXPECTED_CLI_VERSION not in reported:
        sys.exit(
            f"orchestrator: expected openshell {EXPECTED_CLI_VERSION}, image has "
            f"{reported!r}. The flags this workflow uses are version-specific; "
            f"bump EXPECTED_OPENSHELL_VERSION deliberately after re-reading "
            f"`openshell sandbox create --help`."
        )
    _log(f"openshell CLI: {reported}")


def _openshell(*args: str, timeout: int = 120, check: bool = True) -> str:
    cmd = ["openshell", "-g", GATEWAY_NAME, "--workspace", WORKSPACE, *args]
    _log("$ " + " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode == 124 and "exec" in args:
        # 124 is `timeout(1)`: the agent was still talking when `--timeout`
        # fired. That is not the same as the agent failing, and this pipeline
        # already refuses to depend on a model's closing token — `_newest_open`
        # asks the forge what was created rather than parsing the answer. The
        # timeout path was simply never extended to match. So hand back what the
        # agent did say and let the forge decide whether real work happened; a
        # run that has posted its issue must not be discarded because a 4B model
        # would not stop talking. Loud in the log, and visible in the ledger.
        _log(f"warning: agent hit the {AGENT_TIMEOUT_SECONDS}s limit; "
             "continuing with its partial output")
        return result.stdout
    if check and result.returncode != 0:
        raise RuntimeError(
            f"{' '.join(cmd)} exited {result.returncode}\n{result.stderr.strip()}"
        )
    return result.stdout


# ----------------------------------------------------------------- the agents


def _openshell_watched(
    *args: str,
    timeout: int,
    watch: "Callable[[], bool] | None" = None,
    grace: int = 20,
) -> str:
    """`_openshell`, but able to stop the agent once its work is visible.

    WHY THIS EXISTS. `opencode run` ends when the model returns a message with
    no tool calls, and a 4B model reliably will not do that: on a live run the
    survey agent posted its issue three minutes in, then went back to the top
    and posted an identical second one, and was starting a third round when the
    900s `--timeout` killed it with exit 124. There is no `--max-turns` in
    `opencode run` to lean on — the flag simply does not exist.

    So the stop signal has to come from here, and the pipeline already knows
    where to look: `_newest_open` asks the forge what was created rather than
    trusting the model's closing token, precisely because that token cannot be
    relied on. This extends the same idea from reading the result to ending the
    turn. When `watch()` first goes true the agent has demonstrably done the
    thing it was asked for; it gets `grace` seconds to finish its sentence and
    is then terminated.

    The agent's stdout is still what the caller gets back, and it is still the
    only place the numbered menu can be recovered from — `nv-survey` prints that
    table long before the POST, so terminating after the POST loses nothing.

    stdout goes to a file rather than a pipe on purpose: nobody is draining the
    pipe during the poll loop, and opencode emits enough to fill a pipe buffer
    and deadlock.
    """
    cmd = ["openshell", "-g", GATEWAY_NAME, "--workspace", WORKSPACE, *args]
    _log("$ " + " ".join(cmd))
    with tempfile.TemporaryFile("w+") as out:
        proc = subprocess.Popen(cmd, stdout=out, stderr=subprocess.PIPE, text=True)
        deadline = time.time() + timeout
        seen_at: float | None = None
        while proc.poll() is None:
            if time.time() > deadline:
                proc.kill()
                proc.wait()
                break
            if watch is not None and seen_at is None:
                try:
                    if watch():
                        seen_at = time.time()
                        _log(f"the agent's work is visible in the forge; "
                             f"stopping it in {grace}s rather than waiting for it to stop itself")
                except Exception as exc:  # noqa: BLE001 - a flaky poll must not kill the run
                    _log(f"warning: watch poll failed: {exc}")
            if seen_at is not None and time.time() - seen_at >= grace:
                proc.terminate()
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                break
            time.sleep(5)
        out.seek(0)
        stdout = out.read()

    if proc.returncode not in (0, None) and seen_at is None and proc.returncode != 124:
        stderr = (proc.stderr.read() if proc.stderr else "") or ""
        raise RuntimeError(f"{' '.join(cmd)} exited {proc.returncode}\n{stderr.strip()}")
    if proc.returncode == 124:
        _log(f"warning: agent hit the {AGENT_TIMEOUT_SECONDS}s limit; "
             "continuing with its partial output")
    if seen_at is not None:
        # SAY THAT THIS TRANSCRIPT WAS CUT OFF, because the status page shows
        # it and a cut-off transcript reads as a failure.
        #
        # Observed: the survey agent lost a turn to a quoting error, said "I
        # will now retry the command", and was stopped right there — because
        # the retry had already succeeded and its issue was in the forge. The
        # step was green, the issue was open, the menu was correct, and the
        # step's output was a sentence announcing a retry. Anyone reading it
        # would conclude the survey had failed.
        #
        # The orchestrator knows better: it stopped the agent precisely because
        # it had confirmed the artefact. That is worth one line at the bottom
        # of the transcript rather than leaving the reader to guess.
        #
        # Two wordings, because the fast path produces no transcript at all.
        # Once the survey became a single command the artefact appeared before
        # the agent had written a word, and the trailer was then the entire
        # output — inviting the reader to interpret a sentence above it that
        # was not there. Text that refers to context it cannot see is its own
        # small bug, and this status page has already cost enough confusion.
        if stdout.strip():
            stdout += (
                "\n\n---\n[The orchestrator stopped this agent here. Its work "
                "was already confirmed in the forge, so anything it was about "
                "to say next was not needed. A sentence that trails off above "
                "— including one announcing a retry — describes a step that "
                "had already succeeded.]"
            )
        else:
            stdout = (
                "[This agent did its work in a single command and was stopped "
                "as soon as the result appeared in the forge, so it never "
                "wrote a closing message. Nothing is missing: the artefact "
                "named in this step's detail is the output.]"
            )
    return stdout


def _write_helpers(sandbox: str, agent: dict) -> None:
    """Write this agent's credential helper scripts into /sandbox/bin.

    Rendered by Helm from .Values.sandbox.helpers, keyed by provider name, so
    an agent gets exactly the helpers for the providers it attaches — the
    researcher attaches none and therefore receives an empty /sandbox/bin.

    These exist because `credential_binding` is substitution, not injection:
    the agent has to put the handle in the header itself, and a 4B model gets
    that quoting wrong. The long version is in values.yaml. Same base64 trick
    as opencode.json below, for the same reason: the scripts contain quotes,
    `$` and braces, and passing them through two layers of argv unencoded is
    the kind of quoting that works until someone edits one.
    """
    helpers = agent.get("helpers") or {}
    if not helpers:
        return
    commands = ["mkdir -p /sandbox/bin"]
    for name, body in sorted(helpers.items()):
        payload = base64.b64encode(body.encode()).decode()
        commands.append(f"echo {payload} | base64 -d > /sandbox/bin/{name}")
        commands.append(f"chmod 0755 /sandbox/bin/{name}")
    # PUT /sandbox/bin ON PATH, and note where this has to go to work.
    #
    # A live validation run reported "the `nv` command is not found in the
    # environment, despite being listed in /sandbox/bin" — the model had read
    # the directory listing and then typed the bare name instead of the
    # absolute path its briefing gave it. Every briefing is absolute, so this
    # is belt and braces, but it is one line against a whole wasted agent turn.
    #
    # `sandbox create --env PATH=…` does NOT work, and was tried: opencode's
    # bash tool spawns a shell that sources /etc/profile, which sets PATH
    # unconditionally and discards whatever the sandbox environment had. What
    # survives is BASH_ENV — non-interactive bash sources it, and nothing in
    # the image's profile touches it. It is set on the sandbox in create_agent;
    # this writes the file it points at.
    commands.append(
        "printf '%s\\n' "
        "'case \":$PATH:\" in *:/sandbox/bin:*) ;; *) PATH=/sandbox/bin:$PATH ;; esac' "
        "'export PATH' > /sandbox/.bashenv"
    )
    # SEND THESE IN BATCHES. The gateway rejects a single command argument over
    # 32768 bytes — `command argument 2 exceeds 32768 byte limit` — and this
    # used to join every helper into one `bash -lc`. Base64 is 4/3 of the
    # source, so the ceiling was about 24 KB of shell, which the helpers passed
    # the moment a few of them grew the comments explaining why they exist.
    #
    # The failure is worth describing because of where it landed: the traceback
    # came out of `_write_helpers`, long before any agent ran, and killed the
    # whole run at the survey step. Nothing was wrong with the survey.
    #
    # Batching rather than trimming the comments: the size of a helper's
    # documentation should never be able to break a run, and a limit this
    # arbitrary will be hit again by whatever gets added next.
    limit = 24000
    batch: list[str] = []
    size = 0
    for command in commands:
        if batch and size + len(command) > limit:
            _openshell(
                "sandbox", "exec", "--name", sandbox, "--no-tty", "--",
                "bash", "-lc", " && ".join(batch),
                timeout=120,
            )
            batch, size = [], 0
        batch.append(command)
        size += len(command) + 4
    if batch:
        _openshell(
            "sandbox", "exec", "--name", sandbox, "--no-tty", "--",
            "bash", "-lc", " && ".join(batch),
            timeout=120,
        )


def _configure_opencode(sandbox: str, agent: dict) -> None:
    """Write opencode.json into a freshly created sandbox.

    opencode ships in the image with no provider configured and no knowledge of
    `https://inference.local`, so without this it fails identically for every
    agent. The config is rendered by Helm into agents.json — see
    templates/workflow.yaml — so the model id and the context ceiling come from
    the same values as the inference chart rather than being restated here.

    Sent base64-encoded through a single `bash -lc`. The JSON contains quotes,
    braces and a `$schema` key, all of which a shell would otherwise mangle,
    and the alternative — a heredoc through two layers of argv — is exactly the
    kind of quoting that works until someone edits the prompt.

    /sandbox/.config/opencode/opencode.json IS `~/.config/opencode` — HOME in
    the sandbox is /sandbox, the workspace volume. Spelling the path out rather
    than relying on ~ means the write does not depend on how the shell that
    runs it was started.
    """
    config = agent.get("opencodeConfig")
    if not config:
        raise RuntimeError(f"agent {agent['name']} has no opencodeConfig")
    payload = base64.b64encode(json.dumps(config).encode()).decode()
    _openshell(
        "sandbox", "exec", "--name", sandbox, "--no-tty", "--",
        "bash", "-lc",
        "mkdir -p /sandbox/.config/opencode && "
        f"echo {payload} | base64 -d > /sandbox/.config/opencode/opencode.json",
        timeout=120,
    )


def run_agent(
    agent: dict,
    prompt: str,
    step: Step,
    watch: "Callable[[], bool] | None" = None,
    shell: str | None = None,
) -> str:
    """Create a sandbox for one agent, run one command in it, destroy it.

    `shell` RUNS A COMMAND INSTEAD OF THE MODEL, in the same sandbox, under the
    same policy, with the same providers. It exists because of a hard limit in
    opencode that no amount of prompting reaches: its bash tool aborts a command
    after 120 seconds —

        ERROR: command timeout after 120000 ms while waiting for scanner report

    — and the timeout is a parameter of the tool call, not a setting. The
    published config schema (opencode.ai/config.json) has no bash timeout; the
    only `timeout` keys are for providers and MCP servers. So the ceiling can
    only be raised by the model choosing to raise it, and a 4B model getting one
    numeric tool argument right on every run is the same bet this profile has
    lost repeatedly and written helpers to avoid.

    `cluster-canary` legitimately runs for up to 780 seconds: 180 waiting for
    the canary to become available, 600 waiting for SUSE Security to report on
    it. It cannot be made to fit in 120.

    WHAT IS AND IS NOT GIVEN UP. The fence is on the sandbox, not on opencode:
    the policy file, the provider credential injection at the egress boundary,
    the one-sandbox-per-phase lifetime and the isolation proof are all
    unchanged. What is removed is a language model from three steps that never
    had a judgement to make — each one runs a single helper with a single
    positional argument and is graded on a sentinel the helper prints. The model
    could only ever transcribe that, or fail to.

    The other nine steps read scanner output, weigh advisories, write a plan and
    a patch. Those are the agents.

    One sandbox per agent per phase, torn down immediately. Not thrift — the
    memory budget for this profile allows at most three concurrent sandboxes
    against a 14.9 GB no-swap VM — but also the correct lifetime: an agent that
    outlives its task is an agent whose granted egress outlives its reason.
    """
    # TWO CONSTRAINTS, and the obvious name satisfies neither. OpenShell caps a
    # sandbox name at 19 characters — `secops-triage-<epoch>` is 24 and is
    # rejected with `name exceeds maximum length (24 > 19)`, which is why there
    # is no `secops-` prefix here; the workspace already scopes the name. And
    # the two researchers start in the same second against the same agent
    # entry, so a timestamp suffix collides between them. Six random hex
    # characters fixes both: `remediation-` is the longest prefix at 12, giving
    # 18, and a collision needs two draws from 16^6 inside one run.
    name = f"{agent['name']}-{secrets.token_hex(3)}"
    policy = os.path.join(POLICY_DIR, agent["policy"])
    if not os.path.exists(policy):
        raise RuntimeError(f"policy file missing for agent {agent['name']}: {policy}")

    create = [
        "sandbox", "create",
        "--name", name,
        "--from", SANDBOX_IMAGE,
        # The whole point of the profile. Each agent gets its own policy file,
        # parsed by the canonical Rust parser with deny_unknown_fields, so a
        # malformed grant fails here and not silently at egress time.
        "--policy", policy,
        "--cpu", agent.get("cpu", "1"),
        "--memory", agent.get("memory", "512Mi"),
        # Start the sandbox without attaching to its main process: this is a
        # headless pipeline and there is no terminal to attach to. `--detach`
        # is also what keeps `create` from blocking until the agent exits.
        "--detach",
        # Auto-detection would see no TTY and do the right thing anyway, but
        # being explicit means the behaviour does not depend on how the
        # orchestrator's own stdio happens to be wired.
        "--no-tty",
        # Makes the bare name of a helper work as well as its absolute path —
        # see the long note in _write_helpers, which writes the file this
        # points at. Setting PATH here directly does not work. Nothing secret
        # goes through --env; providers carry the credentials.
        "--env", "BASH_ENV=/sandbox/.bashenv",
    ]
    for provider in agent.get("providers", []):
        create += ["--provider", provider]

    _openshell(*create, timeout=300)
    step.detail = f"sandbox {name}"
    try:
        # Only a model needs a model config. A `shell` step never starts
        # opencode, so writing its config would be dead bytes in the sandbox.
        if shell is None:
            _configure_opencode(name, agent)
        _write_helpers(name, agent)
        # `sandbox exec` streams the remote command's stdout and exits with its
        # exit code, which is exactly the shape a subprocess wants. Note this
        # is the only place a prompt crosses into a sandbox.
        #
        # --timeout is OpenShell's, not opencode's, and it is the reason a
        # `shell` step can take thirteen minutes: see the note on the `shell`
        # parameter above.
        argv = ["bash", "-lc", shell] if shell else [*agent["command"], prompt]
        return _openshell_watched(
            "sandbox", "exec", "--name", name, "--no-tty",
            "--timeout", str(AGENT_TIMEOUT_SECONDS),
            "--", *argv,
            timeout=AGENT_TIMEOUT_SECONDS + 60,
            watch=watch,
        )
    finally:
        # Always, including on timeout or agent failure. A leaked sandbox holds
        # its memory and, worse, keeps its egress grants live.
        #
        # `sandbox delete` takes the name positionally — there is no --name and
        # no confirmation flag, unlike `create` and `exec`.
        try:
            _openshell("sandbox", "delete", name, check=False)
        except Exception as exc:  # noqa: BLE001 - cleanup must not mask the real error
            _log(f"warning: could not delete sandbox {name}: {exc}")


class PhaseFailed(Exception):
    """A phase ended without the evidence that it did what it was asked to do."""


def phase(
    step: Step,
    agent: dict,
    prompt: str,
    watch: "Callable[[], bool] | None" = None,
    sentinel: str | None = None,
    shell: str | None = None,
) -> str:
    """Run one agent. `done` means done; anything else is `failed`.

    WHY `sentinel` EXISTS, and it is a bug fix rather than a feature.

    Until 0.3.1 a phase was `done` whenever `run_agent` returned without
    raising — and a 4B model that describes a change it did not make returns
    perfectly normally. The first full end-to-end run ended with the status page
    reading "applied to the cluster", `RUN.applied` naming an image swap, and
    the live Deployment still on the old image: `cluster-apply` had failed with
    a 404, the model had narrated a plausible success, and nothing downstream
    disagreed. That is the single worst failure this pipeline can have, because
    every other failure is visible and this one is a lie.

    `watch` does not help — it is an early-exit trigger for the sandbox, not a
    verdict, and the run it could not catch is the run where the model produced
    output without doing anything.

    So a step that has a machine-checkable proof of work names it here. The
    proof is a line the HELPER prints, not a word the model can be asked to
    say: the helper only reaches its last line by completing, so quoting it
    requires having run it. A model that invents the line is inventing a string
    it was never shown, which is a different and much rarer failure than
    reporting a job as finished.

    With `shell` (see `run_agent`) the sentinel is stronger still: stdout IS the
    helper's stdout, with nothing in between that could paraphrase it. `prompt`
    is then only what the status page shows for the step.
    """
    with RUN.lock:
        step.state = "running"
        step.started = time.time()
    try:
        output = run_agent(agent, prompt, step, watch=watch, shell=shell)
    except Exception as exc:  # noqa: BLE001 - surfaced in the status page
        with RUN.lock:
            step.state = "failed"
            step.ended = time.time()
            step.output = str(exc)
        raise
    output = output.strip()
    failed = sentinel is not None and sentinel not in output
    with RUN.lock:
        step.state = "failed" if failed else "done"
        step.ended = time.time()
        step.output = output
    if failed:
        raise PhaseFailed(
            f"the {step.name} agent finished without printing {sentinel!r}, so "
            f"there is no evidence it ran the command it was given. Its output "
            f"is on the status page and is the thing to read. What it said:\n"
            f"{output[-1200:]}"
        )
    return output


# -------------------------------------------------------------- the canary fixture


def _kube(method: str, path: str, body: dict | None = None) -> dict:
    """One namespaced call to the apiserver, with the pod's own service account.

    THE ONLY PLACE THIS PROCESS TOUCHES KUBERNETES, and it took until 0.3.5 to
    exist at all. Everything else the pipeline does to a cluster goes through a
    sandbox, under a policy file, via the Rancher API — that is the claim the
    profile is built to demonstrate, and an orchestrator with a kubeconfig
    would quietly weaken it. What is here instead is one Role, over Deployments,
    in one namespace, used for exactly two calls: create the canary, delete the
    canary. See templates/rbac.yaml for why that could not be the agent's job.

    No client library: `python:3-slim` plus urllib is the whole runtime, and a
    dependency for two requests would be a poor trade.
    """
    host = os.environ.get("KUBERNETES_SERVICE_HOST", "kubernetes.default.svc")
    port = os.environ.get("KUBERNETES_SERVICE_PORT", "443")
    root = "/var/run/secrets/kubernetes.io/serviceaccount"
    with open(f"{root}/token", encoding="utf-8") as handle:
        token = handle.read().strip()
    request = urllib.request.Request(f"https://{host}:{port}{path}", method=method)
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Accept", "application/json")
    payload = None
    if body is not None:
        payload = json.dumps(body).encode()
        request.add_header("Content-Type", "application/json")
    context = ssl.create_default_context(cafile=f"{root}/ca.crt")
    with urllib.request.urlopen(request, payload, timeout=30, context=context) as rsp:
        return json.load(rsp)


def _canary_path() -> str:
    namespace, _, name = CANARY_WORKLOAD.partition("/")
    return f"/apis/apps/v1/namespaces/{namespace}/deployments/{name}"


def _canary_create() -> None:
    """Bring the canary Deployment into existence, idle, for this run only.

    It used to be applied by hand and left in the namespace at replicas 0
    between runs. That worked and it read badly: a workload that exists only to
    be measured, sitting in the demo namespace with nothing measuring it, is a
    thing every walkthrough had to stop and explain. Now the step that needs it
    creates it and the same step takes it away.

    Created at replicas 0 deliberately. The agent's first PATCH sets the image
    AND the replica count, so creating it running would start the image it is
    supposed to replace, pull it, and prove nothing.
    """
    namespace, _, name = CANARY_WORKLOAD.partition("/")
    with open(CANARY_SPEC_FILE, encoding="utf-8") as handle:
        spec = json.load(handle)
    # The two keys in values are the single source of truth — canary.yaml pins
    # the agent's PATCH to this exact name, so a spec that disagreed with them
    # would produce an object the agent is not permitted to touch.
    spec.setdefault("metadata", {})["name"] = name
    spec["metadata"]["namespace"] = namespace
    try:
        _kube("POST", f"/apis/apps/v1/namespaces/{namespace}/deployments", spec)
        _log(f"canary: created {CANARY_WORKLOAD} at replicas 0")
    except urllib.error.HTTPError as exc:
        if exc.code != 409:
            raise
        # Left behind by a run that died between create and delete. Reusing it
        # is right: the agent's first act is a PATCH that sets both the image
        # and the replica count, so whatever state it is in is overwritten.
        _log(f"canary: {CANARY_WORKLOAD} already exists, reusing it")


def _canary_delete() -> None:
    """Take it away again, whatever the step decided.

    Never fatal. The canary's whole purpose is over by the time this runs, and
    a run that produced a real verdict must not be turned into a failure by the
    tidying afterwards. A leftover object is visible, harmless and reused by
    the next run's create.
    """
    try:
        _kube("DELETE", _canary_path())
        _log(f"canary: deleted {CANARY_WORKLOAD}")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return
        _log(f"canary: could not delete {CANARY_WORKLOAD}: HTTP {exc.code}")
    except Exception as exc:  # noqa: BLE001 - tidying must not end the run
        _log(f"canary: could not delete {CANARY_WORKLOAD}: {exc}")


# ------------------------------------------------------------- the forge (API)


def _gitea(path: str, method: str = "GET", body: dict | None = None) -> object:
    url = f"{GITEA_URL}/api/v1/repos/{GITEA_OWNER}/{GITEA_REPO}{path}"
    request = urllib.request.Request(url, method=method)
    request.add_header("Authorization", f"token {GITEA_TOKEN}")
    request.add_header("Accept", "application/json")
    payload = None
    if body is not None:
        payload = json.dumps(body).encode()
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, payload, timeout=30) as response:
        return json.load(response)


def _issue_from(
    output: str, agent: str, fallback_title: str, context: str = ""
) -> dict:
    """Turn whatever an agent said into an issue the human can read.

    There are two shapes, because there are two ways the agent misses. It can
    describe the plan in prose, in which case the prose is the issue body. Or —
    observed, and the more common one — it assembles exactly the JSON its
    briefing asked for and then prints it instead of calling curl with it,
    having treated "produce the request" as the whole job. Posting that
    verbatim would put a `{"title":…}` blob in front of the reviewer, which is
    the machine's draft rather than the thing it was a draft of.

    So: if the output parses as an object carrying a title and a body, it is
    that request, and it is sent as intended. Otherwise it is prose. Either way
    the trailer names the agent AND says the orchestrator posted it, because a
    reader comparing this issue to that agent's policy should not be misled
    into thinking the `POST /issues` grant was exercised.

    There is a third shape, and it is the dangerous one: output that is not a
    plan at all. A live run produced the four characters `4258` — the model had
    read its briefing's closing "report the issue number" and reported a number
    without making the request. Posted verbatim, that became a plan issue whose
    entire body was an integer, sitting behind an approval gate as though a
    human could meaningfully approve it. So anything too short to carry an
    image, an advisory and a version change is not treated as content: the
    `context` the orchestrator already holds is posted instead, under a heading
    that says the clarifier produced nothing usable. A reviewer then sees the
    triage and research the run actually did, and can reject on an informed
    basis rather than on a number.

    A fourth shape then walked straight through all three: the `plan-issue`
    command line, quoted, with every argument correct. Nine hundred characters
    of it, so the length guard let it past, and it reads to a person like a
    plan. The lesson is that enumerating shapes does not converge — there is
    always another way to be wrong. So this function is no longer the only
    thing standing between a missed tool call and an approved plan:
    `_plan_is_executable` checks the posted issue against the contract the
    remediation step will hold it to, whatever shape produced it.
    """
    trailer = (
        f"\n\n---\n_Posted by the orchestrator. The {agent} agent produced this "
        "content but did not call the forge API itself._"
    )
    if context and len(output.strip()) < 80:
        return {
            "title": fallback_title[:255],
            "body": (
                f"**The {agent} agent did not produce a usable plan.** Its entire "
                f"output was:\n\n```\n{output.strip() or '(empty)'}\n```\n\n"
                "What follows is what the run established before that step, posted "
                "so the work is not lost. There is no proposed change here to "
                "approve — reject this issue unless you are writing the plan "
                f"yourself.\n\n---\n\n{context}" + trailer
            ),
        }
    candidate = output.strip()
    if candidate.startswith("```"):  # a fenced block, which opencode often emits
        candidate = candidate.strip("`").split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        candidate = candidate.removeprefix("json").strip()
    try:
        parsed = json.loads(candidate)
    except (ValueError, TypeError):
        parsed = None
    if isinstance(parsed, dict) and parsed.get("title") and parsed.get("body"):
        return {"title": str(parsed["title"]), "body": str(parsed["body"]) + trailer}
    return {"title": fallback_title[:255], "body": output + trailer}


# The line `forge-remediate` parses the approved plan with, transcribed from
# its perl in values.yaml. Keep them in step: this check exists precisely to
# fail in the same place, and a copy that is laxer than the original is worse
# than no copy, because it promises the reviewer an execution that will not
# happen. There are four perl copies of this pattern, not one —
# forge-remediate, cluster-apply, cluster-canary and cluster-confirm — and
# tests/change-line-contract-test.py runs all five against the same bodies and
# fails if any of them disagrees.
_PLAN_CHANGE = re.compile(r"^[ \t]*Change:[ \t]*(\S+)[ \t]+->[ \t]+(\S+)[ \t]*$", re.M)


def _plan_is_executable(number: int) -> bool:
    """Can the remediation step actually read a change out of this issue?

    THE GATE USED TO BE ABLE TO APPROVE SOMETHING THAT COULD NOT BE DONE, and
    on 2026-09-18 it did. The clarifier answered with the `plan-issue` command
    line instead of running it; the orchestrator's soft-failure path posted
    that text as issue #45; a human read a paragraph that described a sensible
    change, applied the label, and the remediation agent then refused in ten
    seconds because there was no `Change: <old> -> <new>` line to parse. Every
    component behaved correctly and the run still died, because the contract
    between the plan and its consumer was only tested AFTER the one step that
    cannot be retried cheaply — the one that needs a person.

    So the contract is tested here, against the issue as the forge stores it
    rather than against the agent's output, which covers the path where the
    clarifier posted the issue itself and the orchestrator never saw the body.
    A false answer does not stop the run: the reviewer is told on the issue,
    and can reject it or repair the body by hand, since `forge-remediate` reads
    the body at remediation time and an edit made at the gate is an edit it
    will see.
    """
    try:
        issue = _gitea(f"/issues/{number}")
        return _PLAN_CHANGE.search(str(issue["body"] or "")) is not None  # type: ignore[index]
    except Exception as exc:  # noqa: BLE001 - a failed check must not gate the gate
        _log(f"could not check issue #{number} for a Change: line: {exc}")
        return True


def _newest_open(kind: str, since: float) -> int | None:
    """Find the issue or PR the agent just opened.

    Deliberately NOT parsed out of the agent's own output. Asking a 4B model to
    end its answer with a machine-readable `ISSUE: 12` and then depending on
    that line is a pipeline that breaks on a politeness token. The forge
    already knows what was created and when; ask it.

    `since` guards against picking up an issue left over from a previous run.
    """
    query = "?state=open&sort=created&order=desc&limit=5"
    items = _gitea(f"/{kind}{query}")
    for item in items:  # type: ignore[union-attr]
        created = time.mktime(time.strptime(item["created_at"][:19], "%Y-%m-%dT%H:%M:%S"))
        if created >= since - 60:
            return int(item["number"])
    return None


def _comment_count(number: int) -> int:
    """How many comments are on an issue or pull request right now.

    The validation agent's artefact is a comment rather than a new object, so
    `_newest_open` cannot see it. Counting against a baseline taken before the
    agent starts is enough, and does not need to identify the author — the
    agent's forge credential is the bot's, so author is not a distinguisher.
    """
    try:
        items = _gitea(f"/issues/{number}/comments")
        return len(items)  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001 - a flaky poll must not end the phase early
        return -1


_OPTION_LINE = re.compile(r"^\s*(?:\[|\(|)(\d{1,2})(?:\]|\)|\.|:)\s+(\S+)")


def _survey_options(output: str) -> dict[int, str]:
    """Recover the numbered menu from the survey agent's answer.

    The orchestrator cannot produce this list itself, and that is by design: it
    holds no SUSE Security credential, because the moment it does, the argument
    that the agents' egress is the security boundary stops being true for the
    one component that could bypass it. So the ranking is the agent's output and
    this function reads it back.

    `nv-survey` prints `[3] docker.io/library/coredns:v1.11.1`, and the model is
    told to reproduce the list verbatim, but a 4B model renumbers things as
    `3.` or `3)` often enough to be worth three extra characters of regex. What
    is NOT tolerated is inventing an entry: the value kept is the second token
    on the line, which is the image reference or nothing at all.
    """
    options: dict[int, str] = {}
    for line in output.splitlines():
        match = _OPTION_LINE.match(line)
        if not match:
            continue
        index, image = int(match.group(1)), match.group(2)
        # An image reference has a registry path or a tag. This rejects prose
        # that happens to start with a number, which is most prose.
        if "/" not in image and ":" not in image:
            continue
        options.setdefault(index, image.rstrip(".,;"))
    return options


def wait_for_selection(issue: int, step: Step, options: dict[int, str]) -> str | None:
    """Block until a person says which image this run is about. Human gate #0.

    THE ONE GATE IN THIS PIPELINE THAT IS NOT A YES/NO. The other two ask a
    reviewer to approve something the machine chose; this one asks them to
    choose, and the machine deliberately declined to recommend — the survey
    agent's briefing forbids it. Ranking by severity count is arithmetic, and
    the survey does that honestly; deciding that the CVE count on a control-
    plane image matters less than the one on the workload your customers touch
    is judgement about this cluster, and the model does not have it.

    The answer is a comment on the survey issue. Two forms are accepted, and
    both were chosen because a person typing into a Gitea comment box should not
    have to think about parsing:

      * a bare number, matched against the menu the survey printed;
      * an image reference, used as-is — which is also the escape hatch for the
        case where the menu came back unparseable, or the human wants an image
        that did not make the top twelve.

    Comments by GITEA_BOT_USER are skipped. The orchestrator posts into this
    same issue when the agent fails to, and a bot reading its own message as the
    human's answer would turn the gate into a rubber stamp without anyone
    noticing — the run would simply proceed, which is exactly what a broken gate
    looks like from the outside.
    """
    with RUN.lock:
        step.state = "waiting"
        step.started = time.time()
        step.detail = f"awaiting a choice on issue #{issue}"
    _log(f"selection gate: waiting for a number on issue #{issue}")
    _log(f"menu: {options or 'unparsed — reply with an image reference'}")

    deadline = time.time() + SELECT_PROMPT_SECONDS
    seen: set[int] = set()
    while time.time() < deadline:
        comments = _gitea(f"/issues/{issue}/comments")
        for comment in comments:  # type: ignore[union-attr]
            if int(comment["id"]) in seen:
                continue
            seen.add(int(comment["id"]))
            if (comment.get("user") or {}).get("login") == GITEA_BOT_USER:
                continue
            answer = (comment.get("body") or "").strip().split("\n", 1)[0].strip()
            chosen = None
            if answer.isdigit():
                chosen = options.get(int(answer))
                if chosen is None:
                    # Say so ON THE ISSUE. Logging it put the refusal in a pod
                    # log the reviewer is not reading, so from their side a
                    # valid-looking answer simply did nothing and the run
                    # appeared to hang. Whatever the disagreement about what
                    # the menu is, the person who answered should be told.
                    _log(f"selection gate: '{answer}' is not on the menu; ignoring")
                    valid = ", ".join(str(k) for k in sorted(options)) or "none"
                    try:
                        _gitea(
                            f"/issues/{issue}/comments",
                            method="POST",
                            body={"body": (
                                f"`{answer}` is not a row this gate can see, so the run "
                                f"is still waiting.\n\nNumbers it will accept: {valid}. "
                                "You can also paste a full image reference "
                                "(`registry/name:tag`) to choose anything at all."
                            )},
                        )
                    except Exception as exc:  # noqa: BLE001
                        _log(f"warning: could not reply on the issue: {exc}")
                    continue
            elif "/" in answer or ":" in answer:
                chosen = answer.split()[0]
            if chosen:
                with RUN.lock:
                    step.state = "done"
                    step.ended = time.time()
                    step.output = f"a human chose {chosen}"
                _log(f"selection gate: {chosen}")
                return chosen
        time.sleep(GATE_POLL_SECONDS)

    with RUN.lock:
        step.state = "failed"
        step.ended = time.time()
        step.output = f"no choice within {SELECT_PROMPT_SECONDS}s"
    return None


def wait_for_human(issue: int, step: Step) -> str:
    """Block until a person labels the plan issue. This is human gate #1.

    Nothing about this loop is decorative: no remediation sandbox is created
    until it returns "approved". §7 of the architecture doc puts it plainly —
    "a policy that lets the agent approve its own change quietly deletes the
    reviewer" — so the gate has to be a place where the pipeline genuinely
    stops, and the only way past it is a decision made by someone who is not
    this process.

    TWO WAYS TO DECIDE, AND THEY ARE NOT EQUALLY STRONG. The label is the real
    gate: in Gitea, applying a label requires write permission on the
    repository, so a label is an authorisation that a reader cannot forge. A
    comment requires only read access, so accepting one widens the gate to
    anyone who can type in the issue.

    The comment path is here because the label-only gate silently swallowed a
    reviewer. Gate #0 — the survey menu — is driven by a comment, so a human
    who has just answered one gate by commenting answers this one the same way,
    and the pipeline sits there saying "waiting" while a comment reading
    `approved` is on the issue. A gate whose mechanism the reviewer cannot
    guess is not a safety property, it is a bug that looks like one.

    Which mechanism was used is recorded on the Step rather than flattened to
    "approved", because the distinction belongs in the demo's own account of
    itself. Set `GATE_REQUIRE_LABEL=true` to refuse comments.
    """
    with RUN.lock:
        step.state = "waiting"
        step.started = time.time()
        step.detail = (
            f"awaiting the '{APPROVE_LABEL}' label on issue #{issue}"
            + ("" if GATE_REQUIRE_LABEL else f", or a comment reading {APPROVE_LABEL}")
        )
    _log(f"human gate: {step.detail}")

    def _finish(decision: str, how: str) -> str:
        with RUN.lock:
            step.state = "done"
            step.ended = time.time()
            step.output = f"{decision} by a human, via {how}"
        _log(f"human gate: {decision} via {how}")
        return decision

    deadline = time.time() + GATE_TIMEOUT_SECONDS
    seen: set[int] = set()
    while time.time() < deadline:
        labels = {lbl["name"] for lbl in _gitea(f"/issues/{issue}/labels")}  # type: ignore[union-attr]
        if REJECT_LABEL in labels:
            return _finish("rejected", "the label")
        if APPROVE_LABEL in labels:
            return _finish("approved", "the label")

        if not GATE_REQUIRE_LABEL:
            for comment in _gitea(f"/issues/{issue}/comments"):  # type: ignore[union-attr]
                if int(comment["id"]) in seen:
                    continue
                seen.add(int(comment["id"]))
                # The agents all write as the bot, so the bot is never the
                # reviewer — the same filter the selection gate uses.
                if (comment.get("user") or {}).get("login") == GITEA_BOT_USER:
                    continue
                word = (comment.get("body") or "").strip().lower().strip(".!")
                if word == REJECT_LABEL:
                    return _finish("rejected", "a comment (weaker than the label)")
                if word == APPROVE_LABEL:
                    return _finish("approved", "a comment (weaker than the label)")
        time.sleep(GATE_POLL_SECONDS)

    with RUN.lock:
        step.state = "failed"
        step.ended = time.time()
        step.output = f"no decision within {GATE_TIMEOUT_SECONDS}s"
    return "timeout"


def wait_for_merge(pull: int, step: Step) -> str:
    """Block until a person merges the pull request. This is human gate #2.

    THE MERGE IS THE AUTHORISATION, and this function is where that sentence
    stops being a slogan. Gate #1 approves a *plan*; this one approves the
    actual diff, and it is the last point at which a human can decline. No
    deploy sandbox exists until this returns a username.

    Why a merge rather than a third label. A label is a side-channel: it says
    "I approve" next to a change that remains unmade. Merging *is* the change
    to the repository, so the reviewer's act and the thing being authorised are
    the same act. There is nothing to keep in sync and nothing to forge, and
    the reviewer does not have to learn a convention — they do the obvious
    thing and the pipeline continues.

    THE SELF-MERGE CHECK IS NOT PARANOIA. Gitea protects `main` and both agent
    policies deny the merge endpoint, so `secops-bot` genuinely cannot merge
    today. But "the merge is a human act" is the single load-bearing claim in
    this whole design, and a claim that is only true because of configuration
    two layers away should be checked by the process that depends on it. If the
    branch protection is ever relaxed, this run must fail loudly rather than
    quietly apply a change no person ever saw. That is why a bot merge returns
    a distinct verdict instead of a username: it is a finding, not a green
    light.

    Returns the merging username, or one of "timeout", "closed", "self-merged".
    """
    with RUN.lock:
        step.state = "waiting"
        step.started = time.time()
        step.detail = (
            f"awaiting a human merge of PR #{pull} — merging it is what "
            f"authorises the change to the cluster"
        )
    _log(f"human gate: {step.detail}")

    def _finish(state: str, output: str, verdict: str) -> str:
        with RUN.lock:
            step.state = state
            step.ended = time.time()
            step.output = output
        _log(f"merge gate: {output}")
        return verdict

    deadline = time.time() + MERGE_TIMEOUT_SECONDS
    while time.time() < deadline:
        pr = _gitea(f"/pulls/{pull}")
        if pr.get("merged"):  # type: ignore[union-attr]
            who = ((pr.get("merged_by") or {}).get("login")) or "(unknown)"  # type: ignore[union-attr]
            if who == GITEA_BOT_USER:
                return _finish(
                    "failed",
                    f"PR #{pull} was merged by the bot account {GITEA_BOT_USER}. "
                    "The gate did not hold, so nothing will be applied.",
                    "self-merged",
                )
            return _finish("done", f"merged by {who}", who)
        if (pr.get("state") or "") == "closed":  # type: ignore[union-attr]
            return _finish(
                "done",
                f"PR #{pull} was closed without merging — the reviewer declined",
                "closed",
            )
        time.sleep(GATE_POLL_SECONDS)

    return _finish(
        "failed", f"no merge within {MERGE_TIMEOUT_SECONDS}s", "timeout"
    )


def handover(issue: int, pull: int, target: str) -> None:
    """Close the plan issue and tell the human what is theirs to do.

    The pipeline stops at an open pull request, which is the correct place for
    it to stop — but from the reviewer's side the run just goes quiet, with a
    plan issue still open next to a pull request that supersedes it and no
    statement of what happens next. Two open objects for one piece of work
    reads as unfinished, and re-measuring afterwards means reconstructing a
    command nobody wrote down.

    So: say what remains, name the commands, then close the issue. The plan has
    been carried out — the pull request is the live object now.

    REWRITTEN IN 0.3.0, AND THE OLD TEXT WAS THE BUG. It used to walk the
    reviewer through `git pull` and `kubectl apply`, because at the time there
    was genuinely nothing else. Now the pipeline is still running when this is
    posted: it is sitting in `wait_for_merge`, and merging is all that is
    required. Telling a reviewer to apply the manifest by hand would have them
    race an agent about to do the same thing. The merge is the only ask.

    The manual commands stay, explicitly labelled as the fallback, because the
    deploy step can legitimately refuse — a workload outside `deploy.targets`
    is a refusal by design, not a malfunction — and a reviewer who reads this
    comment two hours later should not have to reconstruct what to do instead.
    """
    files: list[str] = []
    try:
        changed = _gitea(f"/pulls/{pull}/files")
        files = [str(f["filename"]) for f in changed]  # type: ignore[union-attr,index]
    except Exception as exc:  # noqa: BLE001 - cosmetic; the comment still posts
        _log(f"warning: could not read the files in PR #{pull}: {exc}")

    applies = "\n".join(
        f"kubectl -n {WORKLOAD_NAMESPACE} apply -f {f}" for f in files
    ) or f"kubectl -n {WORKLOAD_NAMESPACE} apply -f <the file changed by PR #{pull}>"

    body = (
        f"**Carried out in PR #{pull}.** Closing this issue — the pull request is "
        f"the live object now.\n\n"
        f"**There is exactly one thing left for you to do: review PR #{pull}, and "
        f"merge it if you agree.**\n\n"
        f"Merging is the authorisation. This pipeline is still running and is "
        f"waiting for it. When the merge lands, a separate sandboxed agent — one "
        f"that has never been able to write to this repository — replaces "
        f"`{target}` on the running workload through the Rancher API, waits for "
        f"the rollout, and comments the result on the pull request. It can change "
        f"that one image on the workloads this deployment is configured to allow, "
        f"and nothing else.\n\n"
        f"**What is already running, so that you are not deciding blind.** The "
        f"replacement image is live on this cluster right now, as "
        f"`{CANARY_WORKLOAD}` — a copy of the workload's pod spec under a "
        f"different name, with no Service and no traffic. That is what the scan "
        f"comment on the pull request measured: both images running, both "
        f"counted, minutes apart. It is also how a replacement that does not "
        f"start under this pod spec is caught before you merge rather than "
        f"after.\n\n"
        f"If you do not want the change, close PR #{pull} instead. Nothing that "
        f"serves traffic has been touched, and closing it ends the run cleanly. "
        f"The canary is removed when the run ends, either way — it exists for "
        f"the measurement above and for nothing else.\n\n"
        f"The bot cannot merge for you: `main` is protected and the sandbox policy "
        f"denies the merge endpoint. That is the point, not an obstacle.\n\n"
        f"<details><summary>Manual fallback — only if the deploy step reports that "
        f"it refused</summary>\n\n"
        f"The deploy agent is allowed to change a specific set of workloads. If "
        f"this change is outside that set it will say so and stop, which is "
        f"correct behaviour rather than a fault. In that case the apply is yours:\n\n"
        f"```\ngit -C <your clone> pull\n{applies}\nkubectl -n {WORKLOAD_NAMESPACE} "
        f"get pods -w\n```\n\n"
        f"and to re-measure afterwards:\n\n"
        f"```\nkubectl -n {NAMESPACE} rollout restart deploy/{ORCHESTRATOR_NAME}\n```\n"
        f"</details>\n\n"
        f"Until the merge, `{target}` is still what serves this workload. An open "
        f"pull request has remediated nothing."
    )
    try:
        _gitea(f"/issues/{issue}/comments", method="POST", body={"body": body})
        _gitea(f"/issues/{issue}", method="PATCH", body={"state": "closed"})
        _log(f"closed issue #{issue}; PR #{pull} is now the open object")
    except Exception as exc:  # noqa: BLE001 - the run succeeded either way
        _log(f"warning: could not close issue #{issue}: {exc}")


# ---------------------------------------------------------------- status page


class StatusHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path.startswith("/api/state"):
            body = json.dumps(RUN.snapshot(), indent=2).encode()
            content_type = "application/json"
        elif self.path in ("/healthz", "/readyz"):
            body, content_type = b"ok", "text/plain"
        else:
            with open(STATUS_HTML, "rb") as handle:
                body = handle.read()
            content_type = "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - base API
        """Silence per-request logging; the page polls every two seconds."""


def serve_status() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", STATUS_PORT), StatusHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    _log(f"status page on :{STATUS_PORT}")


def _park(reason: str) -> NoReturn:
    """End the pipeline without ending the process. Never returns.

    THE RULE THIS FILE NOW OBEYS: once the status page is up, nothing below it
    may exit. A Deployment's process that exits is restarted by the kubelet, and
    a restart wipes every Step in RUN — so an exit does not merely stop the run,
    it destroys the record of the part that worked. Twenty minutes of CPU
    inference and the text a human was about to read both go with it, and what
    replaces them is a pod that begins the same run again from zero and reaches
    the same failure. That is the crash loop this replaces.

    So every terminal outcome — success, a human rejecting the plan, a gate
    timeout, an unhandled exception — lands here instead: the verdict is
    recorded, the page keeps serving it, and the pod stays Ready. Recovery is a
    deliberate `kubectl rollout restart`, which is the right way for a run to
    start over: because someone decided it should.
    """
    with RUN.lock:
        RUN.verdict = reason
    _log(f"parked: {reason}")
    # THE ONE PIECE OF TIDYING, and this is the right place for it precisely
    # because every terminal outcome funnels through here — success, rejection,
    # a gate that timed out, an unhandled exception. The canary is a fixture
    # created for one step of one run; leaving it behind means the next run
    # starts with a stale Deployment in the demo namespace, which is the state
    # this replaced. A run that never reached the canary step deletes nothing,
    # because there is nothing there, and a delete that fails is logged and
    # ignored: tidying must not rewrite a verdict that has already been decided.
    _canary_delete()
    _log("the run is over; the status page stays up. Restart the Deployment to run again.")
    while True:
        time.sleep(3600)


# ------------------------------------------------------------------- pipeline


def main() -> None:
    with open(AGENTS_FILE, encoding="utf-8") as handle:
        agents = {a["name"]: a for a in json.load(handle)}

    steps = {
        "survey": Step("Survey", "survey"),
        "select": Step("Human selection", "— a person —"),
        "triage": Step("Triage", "triage"),
        "research-a": Step("Research A", "researcher"),
        "research-b": Step("Research B", "researcher"),
        "clarify": Step("Plan", "clarifier"),
        "gate": Step("Human approval", "— a person —"),
        "remediate": Step("Remediation", "remediation"),
        # "Canary", not "Validation", because the name is the honest one: this
        # step runs the replacement image next to the one it replaces and
        # measures both. The version that only asked the scanner about an image
        # nothing ran is what it replaces. See files/policies/canary.yaml.
        "validate": Step("Canary validation", "canary"),
        # The last three, added in 0.3.0. Up to `validate` the run has only
        # ever proposed; these three are how a proposal becomes a change, and
        # the human step in the middle is the whole reason the other two are
        # allowed to exist.
        "merge": Step("Human merge", "— a person —"),
        "deploy": Step("Deploy", "deploy"),
        "confirm": Step("Post-apply rescan", "validation"),
    }
    RUN.steps = list(steps.values())

    _assert_cli_version()
    _bootstrap_gateway()
    _openshell("status", timeout=60)

    # 1. Survey. The run begins by asking the scanner what is wrong, not by
    #    telling it. Nothing before this line knows what this run is about.
    opened_at = time.time()
    survey = phase(
        steps["survey"],
        agents["survey"],
        "Run the cluster vulnerability survey and publish it for a human to "
        f"choose from. Post the ranked list as one issue in {GITEA_OWNER}/"
        f"{GITEA_REPO}, keeping the numbering exactly as the tool printed it, and "
        "ask the reader to reply with a single number. Do not recommend one; "
        "which image matters most is their decision, not yours.",
        watch=lambda: _newest_open("issues", opened_at) is not None,
    )
    RUN.finding = survey

    RUN.surveyIssue = _newest_open("issues", opened_at)
    if RUN.surveyIssue is None:
        # Same soft failure, and the same answer, as the clarifier below: the
        # orchestrator holds the forge token anyway, so it posts what the agent
        # produced rather than discarding a completed scan because the model
        # ended its turn with prose. What is lost is the demonstration that the
        # survey's own policy permits `POST /issues`, and the trailer says so.
        _log("survey opened no issue; posting its output from the orchestrator")
        created = _gitea(
            "/issues",
            method="POST",
            body=_issue_from(survey, "survey", "Cluster vulnerability survey — choose a target"),
        )
        RUN.surveyIssue = int(created["number"])  # type: ignore[index,call-overload]
        steps["survey"].detail = f"issue #{RUN.surveyIssue} (posted by the orchestrator)"
    else:
        steps["survey"].detail = f"issue #{RUN.surveyIssue}"

    # PARSE THE MENU FROM THE ISSUE, NOT FROM THE AGENT'S REPLY.
    #
    # The human is reading the issue body and typing a number that refers to a
    # line in it. Numbering the menu from any other text means the gate and the
    # reviewer can disagree about what "2" is — and they did: the gate logged
    # "'2' is not on the menu; ignoring" while `2.` was plainly on the issue.
    #
    # The other text was the agent's stdout, and two things go wrong with it.
    # The model is asked to reproduce the list in its closing message and does
    # not always bother, having already posted it. And `_openshell_watched`
    # now stops the agent once its issue appears in the forge, so the closing
    # message is exactly the part most likely to be cut off. That watch is what
    # took the survey from 900s to 98s; the cost was hidden in this parse.
    #
    # Same principle as `_newest_open`: the forge holds the artefact, so ask
    # the forge. The stdout parse stays only as a fallback for the soft-failure
    # path, where the orchestrator posted the body itself and already has it.
    body = ""
    try:
        body = str((_gitea(f"/issues/{RUN.surveyIssue}") or {}).get("body") or "")  # type: ignore[union-attr]
    except Exception as exc:  # noqa: BLE001
        _log(f"warning: could not read issue #{RUN.surveyIssue} back: {exc}")
    options = _survey_options(body) or _survey_options(survey)

    # The menu is posted, but the human is answering in a comment box and the
    # issue does not necessarily say how. One comment, from the orchestrator,
    # spelling out the accepted forms — and posted as GITEA_BOT_USER, which is
    # precisely the login the selection gate ignores.
    #
    # TWO DIFFERENT COMMENTS, because there are two different situations and
    # telling them apart is the whole point. When the agent fails to post, the
    # fallback above publishes its raw output as the issue body, and that output
    # may contain no menu at all — on 2026-09-17 it was the survey-issue command
    # line, printed rather than run. The issue then looks like a menu that is
    # simply badly formatted, so the reviewer types a number, the gate silently
    # rejects it, and one upstream failure presents as two unrelated bugs. If
    # there is no menu, say there is no menu.
    if options:
        waiting = (
            "**The run is waiting here.** Reply with the NUMBER of the image to "
            "analyse — a comment containing just `3`, for example — or paste a "
            "full image reference to choose something not on the list.\n\n"
            f"Nothing further happens until then; the gate times out after "
            f"{SELECT_PROMPT_SECONDS // 60} minutes."
        )
    else:
        _log("warning: no numbered menu could be read from the issue; the gate "
             "will only accept a full image reference")
        waiting = (
            "**The run is waiting here, and there is no menu to choose from.** "
            "The survey agent did not post a numbered list, so the body above is "
            "its raw output rather than a set of options — do not reply with a "
            "number, because there is no row for one to refer to and the gate "
            "will ignore it.\n\nTo continue, paste a full image reference "
            "(`registry/name:tag`). To start over instead, restart the run with "
            f"`kubectl -n {NAMESPACE} rollout restart deploy/{ORCHESTRATOR_NAME}`."
            f"\n\nThe gate times out after {SELECT_PROMPT_SECONDS // 60} minutes."
        )
    _gitea(
        f"/issues/{RUN.surveyIssue}/comments",
        method="POST",
        body={"body": waiting},
    )

    # 2. Human gate #0: which container?
    target = wait_for_selection(RUN.surveyIssue, steps["select"], options)
    if target is None:
        _park("stopped at the selection gate: nobody chose a target")
    RUN.target = target

    # 3. Triage. Two questions about ONE image: what is wrong with it, and is
    #    there a supported newer build. It is the only agent holding both the
    #    scanner credential and the Application Collection one.
    triage = phase(
        steps["triage"],
        agents["triage"],
        f"A human has selected this container image for analysis: {target}\n\n"
        "Report what SUSE Security found in it, then check whether SUSE "
        "Application Collection publishes a newer build of the same component. "
        "Quote the exact tag the catalogue returned — do not name a version from "
        "memory. If the catalogue does not carry this component, say so plainly: "
        "that means the fix has to be a package bump inside the image, not an "
        "image swap.",
    )

    # 4. Two researchers, in parallel. `--parallel 2` on the llama.cpp server
    #    was measured as nearly free (6.78s wall for two concurrent requests
    #    against 6.07s for one, spike/RESULTS.md), so this overlap is real
    #    rather than nominal. A third would queue.
    #
    #    Neither researcher can reach SUSE Security or the git forge. Their
    #    policy grants the corpus and nothing else, which is the claim the
    #    README asks you to verify from a live terminal.
    research: dict[str, str] = {}
    threads = []
    for key, question in (
        ("research-a", "Which SUSE security advisory (SUSE-SU) addresses it, and "
                       "what fixed package version does it name?"),
        ("research-b", "What is the documented remediation procedure, and what "
                       "should be re-checked afterwards?"),
    ):
        def work(key: str = key, question: str = question) -> None:
            try:
                research[key] = phase(
                    steps[key],
                    agents["researcher"],
                    f"Findings from triage:\n{triage}\n\n{question} "
                    "Run `corpus list` first and read the titles. Answer only "
                    "about the packages and image named in the triage findings "
                    "above. If no document in the corpus is about them, say "
                    "exactly that, name the closest document and why it does "
                    "not apply, and cite nothing — an answer about a different "
                    "vulnerability is worse than no answer, because the plan "
                    "built on it will propose the wrong change. Do not "
                    "speculate beyond what the corpus says.",
                )
            except Exception as exc:  # noqa: BLE001 - recorded on the Step
                research[key] = f"(failed: {exc})"

        thread = threading.Thread(target=work)
        thread.start()
        threads.append(thread)
    for thread in threads:
        thread.join()

    citations = "\n\n".join(research.values())

    # 5. The clarifier writes the plan into the forge and stops. Its policy is
    #    issues-only: it can open an issue and read labels, and cannot touch a
    #    branch. That asymmetry is what makes the next step a gate rather than
    #    a formality.
    opened_at = time.time()
    phase(
        steps["clarify"],
        agents["clarifier"],
        f"The image under analysis is {target}.\n\nTriage said:\n{triage}\n\n"
        f"Research found:\n{citations}\n\n"
        f"Open one issue in the {GITEA_OWNER}/{GITEA_REPO} repository proposing a "
        "remediation. The issue body must contain: the affected image, the "
        "advisory id, the exact version change proposed, and the corpus document "
        "ids the proposal rests on. Do not open a pull request and do not modify "
        "any branch. Then stop.",
        watch=lambda: _newest_open("issues", opened_at) is not None,
    )
    RUN.issue = _newest_open("issues", opened_at)
    if RUN.issue is None:
        # THE AGENT DID NOT OPEN THE ISSUE, AND THE RUN CONTINUES ANYWAY.
        #
        # This used to `return 1`, which put the pod into CrashLoopBackOff and
        # discarded triage and both researchers along with it — twenty minutes
        # of CPU inference thrown away because a 4B model ended its turn with
        # prose instead of a tool call. The information the human needs is the
        # thing the run produced, so losing it is the worst possible response
        # to a soft failure.
        #
        # The orchestrator holds the forge token anyway — it is the component
        # that polls for the approval label — so it can post the issue itself
        # from the clarifier's output. What is lost is not the gate, which
        # still blocks on a human, but the demonstration that the clarifier's
        # own policy permits `POST /issues`; the step is marked so the status
        # page does not claim otherwise.
        _log("clarifier opened no issue; posting its output from the orchestrator")
        created = _gitea(
            "/issues",
            method="POST",
            body=_issue_from(
                steps["clarify"].output,
                "clarifier",
                f"Proposed remediation: {target}",
                context=(
                    f"Image under analysis: {target}\n\n"
                    f"Triage reported:\n{triage}\n\nResearch reported:\n{citations}"
                ),
            ),
        )
        RUN.issue = int(created["number"])  # type: ignore[index,call-overload]
        steps["clarify"].detail = f"issue #{RUN.issue} (posted by the orchestrator)"
    else:
        steps["clarify"].detail = f"issue #{RUN.issue}"

    # Whether this plan can be carried out at all, asked before the person is
    # asked to approve it and answered on the same comment. See
    # `_plan_is_executable`: the reviewer is the one who can fix this, and the
    # only moment they are looking is now.
    unexecutable = ""
    if not _plan_is_executable(RUN.issue):
        unexecutable = (
            "\n\n> **This plan cannot be executed as written.** The remediation "
            "step reads the change out of the issue body and needs a line of "
            "exactly this form, on its own:\n>\n"
            "> ```\n> Change: <old-image> -> <new-image>\n> ```\n>\n"
            "> There is no such line above, so approving this will start a "
            "remediation agent that refuses immediately. Both image references "
            "must be complete — registry host, repository and tag. Either "
            "reject, or edit the body to add the line and then approve; the "
            "body is read when the agent runs, so an edit made now counts."
        )
        _log(f"issue #{RUN.issue} carries no parsable 'Change:' line; said so at the gate")

    # The gate's mechanism, said on the issue itself. The clarifier writes the
    # plan and has no idea it is about to be gated, so without this the issue
    # arrives with no instructions and the reviewer has to already know that
    # this gate wants a label while the previous one wanted a comment. A run
    # was lost to exactly that. Posted as a comment rather than folded into the
    # body because the body belongs to whoever wrote the plan.
    _gitea(
        f"/issues/{RUN.issue}/comments",
        method="POST",
        body={"body": (
            f"**This is a human gate.** No remediation agent will be started until "
            f"someone who is not this pipeline decides.\n\n"
            f"- To approve: add the `{APPROVE_LABEL}` label"
            + ("" if GATE_REQUIRE_LABEL else f", or comment `{APPROVE_LABEL}`")
            + f"\n- To reject: add the `{REJECT_LABEL}` label"
            + ("" if GATE_REQUIRE_LABEL else f", or comment `{REJECT_LABEL}`")
            + "\n\nThe label is the stronger of the two — applying one needs write "
            "permission on this repository, commenting does not."
            + unexecutable
        )},
    )

    # 6. Human gate #1.
    decision = wait_for_human(RUN.issue, steps["gate"])
    if decision != "approved":
        # Not a failure. A human declining a change is the system working, and
        # the issue they declined is the thing worth keeping on the page.
        _park(f"stopped at the plan gate: {decision}")

    # 7. Remediation opens a pull request. Its forge credential is injected at
    #    the egress boundary and is scoped to write-but-not-merge on this repo,
    #    so human gate #2 is enforced by the forge itself rather than by this
    #    code choosing not to call the merge endpoint.
    # RUN THE HELPER, NOT THE MODEL — and here for a different reason than the
    # three steps below, which run their helper because opencode's bash tool
    # kills any command at 120s.
    #
    # This step ran a model until 0.3.4. The task had already been reduced as
    # far as a task can be reduced: four commands collapsed into one helper
    # taking one argument, and that argument an integer this function already
    # holds. The model's entire contribution was to retype `RUN.issue`.
    #
    # On 2026-09-18 it did not even do that. It returned `PULL REQUEST #41
    # OPENED` — the exact line `forge-remediate` prints on success — for a pull
    # request that had never existed. Index 41 was never allocated and no branch
    # was ever pushed. That is the failure the `sentinel` docstring calls rare,
    # and it is the one failure a sentinel cannot catch: the string it checks
    # for is the string that was invented.
    #
    # `shell` closes it structurally rather than catching it. stdout becomes the
    # helper's own stdout with nothing in between, so the success line can only
    # appear if the helper reached its last line, and the helper only reaches
    # its last line after the forge has answered the pull request POST. The
    # sentinel below is then checking a string that cannot be forged, which is
    # what it was always meant to be checking.
    #
    # What is given up: the demo shows five model-driven agents here, not six.
    # What is not: the sandbox, the policy, and the credential injected at the
    # egress boundary are identical — the fence is on the sandbox, not on
    # opencode. Human gate #2 is still enforced by the forge, which refuses the
    # merge endpoint to this credential.
    opened_at = time.time()
    said = phase(
        steps["remediate"],
        agents["remediation"],
        # Status-page text only now — nothing reads this but a human.
        f"Issue #{RUN.issue} has been approved by a reviewer. It concerns the "
        f"image {target} and proposes:\n{citations}\n\n"
        f"Carrying it out with `/sandbox/bin/forge-remediate {RUN.issue}`, "
        f"which clones, finds the manifest, swaps the image, pushes a branch "
        f"and opens the pull request. It cannot merge.",
        shell=f"/sandbox/bin/forge-remediate {RUN.issue}",
        sentinel="PULL REQUEST #",
    )
    RUN.pull = _newest_open("pulls", opened_at)
    steps["remediate"].detail = f"PR #{RUN.pull}" if RUN.pull else "no PR appeared"

    if not RUN.pull:
        # REACHING HERE NOW MEANS SOMETHING NARROW, so say which thing it is.
        #
        # The sentinel above has already passed, and under `shell` that line
        # came from the helper rather than from a model — so the pull request
        # was opened and this lookup is what failed, not the remediation. The
        # previous wording, "the run finished without a pull request", covered
        # both that and a model inventing the line, and told an operator
        # staring at `PULL REQUEST #41 OPENED` on the status page nothing about
        # which they were looking at.
        claim = next(
            (l.strip() for l in reversed(said.splitlines()) if "PULL REQUEST #" in l),
            "",
        )
        _park(
            "forge-remediate reported "
            + (repr(claim) if claim else "success")
            + ", but no pull request opened after this step began could be found"
            " on the repository. The remediation ran; the lookup disagrees."
            " Check the forge directly before re-running — the branch and the"
            " pull request may both be there."
        )

    # 8. Canary validation. The replacement image is started for real, beside
    #    the workload it would replace, and both are scanned. Until 0.3.1 this
    #    step asked the scanner about an image nothing ran, which cannot
    #    produce an answer: `nv-survey` reads findings SUSE Security indexes by
    #    running workload. The run that proved it spent its full timeout
    #    comparing the old image with itself and reported, correctly, "no
    #    actual remediation took place".
    #
    #    This is also the first step in the pipeline that writes to the
    #    cluster, before any human has approved anything. What makes that
    #    defensible is the shape of the grant, not this comment — canary.yaml
    #    pins it to one workload by literal name, a workload with no Service
    #    that serves nothing.
    #
    #    The fixture is created here and destroyed in the `finally` below, so
    #    it exists only for the length of this step. The agent still cannot
    #    create it: see _canary_create and templates/rbac.yaml for why those
    #    are two different authorities on purpose.
    pull = RUN.pull
    comments_before = _comment_count(pull)
    _canary_create()
    try:
        phase(
            steps["validate"],
            agents["canary"],
            f"Pull request #{pull} proposes replacing the image {target}. Measure "
            f"it by running `/sandbox/bin/cluster-canary {pull}`. The pull request "
            f"number is {pull}.",
            watch=lambda p=pull: _comment_count(p) > comments_before,
            sentinel="VALIDATED ",
            # RUN THE HELPER, NOT THE MODEL — see the `shell` note in
            # run_agent. This step waits up to 780s on a rollout and a scanner;
            # opencode's bash tool kills any command at 120s, and there is no
            # setting for it. The sandbox, its policy and its credentials are
            # identical either way. The prompt above is what the status page
            # shows for this step.
            shell=f"/sandbox/bin/cluster-canary {pull}",
        )
    except PhaseFailed as exc:
        # NOT a park. A canary that will not start, or a replacement the scanner
        # has not looked at, is exactly the evidence the merge gate exists to
        # weigh — so the run continues to that gate with the failure visible on
        # the status page and the reason on the pull request. What must not
        # happen is the run claiming a measurement it does not have.
        _log(f"canary validation failed: {exc}")
        steps["validate"].detail = "no measurement — read this step's output"
    # NOT deleted here, and the temptation to put a `finally` on that `try` is
    # worth naming. The canary has to outlive this step: the merge gate below
    # tells the reviewer that both images are running right now and invites
    # them to go and look, and `cluster-apply` scales the canary to 0 once the
    # real rollout succeeds. It is deleted when the run ends, in _park.
    # Bound once, for the same reason the validation phase above does it: every
    # step from here on is about this one pull request.
    merged_pr: int = RUN.pull

    # The handover comment now says "merge this and I will do the rest", so it
    # has to be posted before the gate it describes, not after the run ends.
    handover(RUN.issue, merged_pr, target)

    # 9. Human gate #2 — the merge. Everything above this line proposed, and
    #    the one thing above it that did touch the cluster — the canary —
    #    serves no traffic. Merging is what changes what is served. See
    #    wait_for_merge.
    merged_by = wait_for_merge(merged_pr, steps["merge"])
    if merged_by == "timeout":
        _park(
            f"PR #{merged_pr} was not merged within {MERGE_TIMEOUT_SECONDS // 60} "
            f"minutes. Nothing was applied. The pull request is still open and "
            f"still correct — merging it later needs a fresh run to apply it."
        )
    if merged_by == "closed":
        _park(
            f"PR #{merged_pr} was closed without merging. The reviewer declined "
            f"the change, which is a complete and successful run: the pipeline "
            f"proposed, a human said no, and nothing that serves traffic "
            f"changed. The canary {CANARY_WORKLOAD} is still running the image "
            f"that was declined — scale it to 0 when you are done looking at it."
        )
    if merged_by == "self-merged":
        _park(
            f"PR #{merged_pr} was merged by {GITEA_BOT_USER}, not by a person. "
            f"Refusing to apply it. The merge is supposed to BE the human "
            f"authorisation, so a bot merge means branch protection or the "
            f"sandbox policy has been relaxed — fix that before running again."
        )

    # 10. Deploy. The step that changes what is served, and it exists only
    #     because step 9 returned a person's name. The agent gets the pull
    #     request number and nothing else: which workload, which container and
    #     which images are all discovered from the merge itself, so this step is
    #     not specific to any one workload. Where it is *permitted* to apply is
    #     `deploy.targets`. It also retires the canary on the way out.
    deploy_before = _comment_count(merged_pr)
    try:
        phase(
            steps["deploy"],
            agents["deploy"],
            f"A human, {merged_by}, merged pull request #{merged_pr}. That merge is "
            f"your authorisation to apply it. Run "
            f"`/sandbox/bin/cluster-apply {merged_pr}`. The pull request number is "
            f"{merged_pr}.",
            watch=lambda n=merged_pr: _comment_count(n) > deploy_before,
            sentinel="APPLIED ",
            # As for the canary step: the helper, directly. This one fits in
            # 120s today, but it polls a rollout for up to 180s by design, so
            # it is one slow image pull away from the same failure.
            shell=f"/sandbox/bin/cluster-apply {merged_pr}",
        )
    except PhaseFailed as exc:
        # THE FAILURE THIS CATCHES IS THE ONE THAT ALMOST SHIPPED. On the first
        # end-to-end run `cluster-apply` died on a 404, the agent wrote a
        # plausible paragraph about having applied the change, and the run
        # finished green: status page "applied to the cluster", RUN.applied
        # naming the swap, live Deployment untouched. Every other failure in
        # this pipeline is loud; only this one lies. So the run stops here, the
        # step stays `failed`, RUN.applied stays empty, and — critically — the
        # post-apply rescan does not run, because a rescan of a change that did
        # not happen is how a false success acquires a second witness.
        _park(
            f"PR #{merged_pr} was merged by {merged_by}, but the deploy step "
            f"produced no proof that it applied anything, so this run makes no "
            f"claim that it did. Read the Deploy step's output on this page, and "
            f"check the workload before re-running. {exc}"
        )
    steps["deploy"].detail = f"PR #{merged_pr}, merged by {merged_by}"

    # 11. Confirm. A different agent and a different policy from step 8, and
    #     that separation is the point rather than an accident of wiring: step 8
    #     started the canary, so step 8 does not get to certify the result. This
    #     one holds no cluster credential at all.
    #
    #     The measurement is also a different one. At step 8 both images were
    #     running and the comparison was between two live workloads. Here only
    #     the replacement is — so the scanner having nothing to say about the
    #     old image is not missing data, it is the finding: that image is gone
    #     from the cluster.
    confirm_before = _comment_count(merged_pr)
    try:
        phase(
            steps["confirm"],
            agents["validation"],
            f"Pull request #{merged_pr} has been merged and applied. Measure the "
            f"result by running `/sandbox/bin/cluster-confirm {merged_pr}`. The "
            f"pull request number is {merged_pr}.",
            watch=lambda n=merged_pr: _comment_count(n) > confirm_before,
            sentinel="CONFIRMED ",
            # Same reasoning again, and here the scanner poll is the whole step.
            shell=f"/sandbox/bin/cluster-confirm {merged_pr}",
        )
    except PhaseFailed as exc:
        # The deploy DID happen — it printed its sentinel — so `RUN.applied` is
        # still true and is set below. What is missing is the independent
        # measurement of it, and saying "applied, unconfirmed" is the accurate
        # report. Parking here rather than in the failure branch keeps the two
        # claims separate.
        _log(f"post-apply rescan failed: {exc}")
        with RUN.lock:
            RUN.applied = f"{target} replaced, PR #{merged_pr} merged by {merged_by}"
        _park(
            f"PR #{merged_pr} was merged by {merged_by} and applied — the deploy "
            f"step's own report is on the pull request — but the post-apply "
            f"rescan produced no measurement, so the result is UNCONFIRMED. Read "
            f"the Post-apply rescan step's output. {exc}"
        )

    with RUN.lock:
        RUN.applied = f"{target} replaced, PR #{merged_pr} merged by {merged_by}"
    _park(
        f"PR #{merged_pr} was merged by {merged_by} and applied to the cluster. "
        f"The post-apply rescan is on the pull request."
    )


if __name__ == "__main__":
    # Order matters: the status page comes up BEFORE anything that can fail, so
    # that a failure has somewhere to be reported. Everything after this line is
    # inside the net — `_park` never returns, so the only way out of this block
    # is a signal.
    serve_status()
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception:  # noqa: BLE001 - the whole point is that nothing escapes
        # An unhandled exception used to take the pod down and the run's output
        # with it. Now the traceback goes to the log, the one-line summary goes
        # to the status page next to whichever steps did complete, and the pod
        # stays up holding both.
        _log(traceback.format_exc())
        last = traceback.format_exc().strip().splitlines()[-1]
        _park(f"the run failed: {last} (full traceback in the pod log)")
