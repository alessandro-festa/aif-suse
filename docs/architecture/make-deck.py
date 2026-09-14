#!/usr/bin/env python3
"""Build the Sovereign Agentic SecOps deck from the figures and the walkthrough.

The six figures are 2560x1600 (16:10) and already carry their own titles, so the
figure slides are full-bleed images with no chrome. The talk track from
secops-demo-walkthrough.md lives in the speaker notes.

    python3 docs/architecture/make-deck.py

Output: docs/architecture/sovereign-agentic-secops.pptx — upload to Google Drive
and open with Google Slides, which imports it with the speaker notes intact.
"""

from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.util import Emu, Inches, Pt

HERE = Path(__file__).resolve().parent
IMAGES = HERE / "images"
OUT = HERE / "sovereign-agentic-secops.pptx"

# 16:10, to match the figures exactly.
W, H = Inches(13.333), Inches(8.333)

MIDNIGHT = RGBColor(0x0C, 0x32, 0x2C)
NVIDIA_GREEN = RGBColor(0x76, 0xB9, 0x00)
JUNGLE = RGBColor(0x30, 0xBA, 0x78)
PERSIMMON = RGBColor(0xFE, 0x7C, 0x3F)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
MUTED = RGBColor(0xAF, 0xC4, 0xBF)

FONT = "Arial"  # Google Slides has no Segoe UI; Arial is the closest safe match.


def blank(prs):
    return prs.slides.add_slide(prs.slide_layouts[6])


def fill(slide, colour):
    bg = slide.background.fill
    bg.solid()
    bg.fore_color.rgb = colour


def notes(slide, text):
    slide.notes_slide.notes_text_frame.text = text.strip()


def textbox(slide, x, y, w, h, blocks):
    """blocks: list of (text, size, bold, colour, space_after_pt)."""
    tb = slide.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    for i, (text, size, bold, colour, after) in enumerate(blocks):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = text
        p.space_after = Pt(after)
        for r in p.runs:
            r.font.size = Pt(size)
            r.font.bold = bold
            r.font.color.rgb = colour
            r.font.name = FONT
    return tb


def rule(slide, x, y, w, colour, thick=Pt(3)):
    from pptx.enum.shapes import MSO_SHAPE

    s = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, thick)
    s.fill.solid()
    s.fill.fore_color.rgb = colour
    s.line.fill.background()
    s.shadow.inherit = False
    return s


def figure_slide(prs, filename, speaker_notes):
    slide = blank(prs)
    path = IMAGES / filename
    if not path.exists():
        raise SystemExit(f"missing figure: {path}")
    slide.shapes.add_picture(str(path), Emu(0), Emu(0), width=W, height=H)
    notes(slide, speaker_notes)
    return slide


def main():
    prs = Presentation()
    prs.slide_width, prs.slide_height = W, H

    # ---------------------------------------------------------------- 1. title
    s = blank(prs)
    fill(s, MIDNIGHT)
    rule(s, Inches(1.0), Inches(2.35), Inches(1.6), NVIDIA_GREEN, Pt(4))
    textbox(
        s, Inches(1.0), Inches(2.6), Inches(11.3), Inches(4.0),
        [
            ("Sovereign Agentic SecOps", 46, True, WHITE, 10),
            ("Autonomous vulnerability remediation on SUSE AI Factory with NVIDIA",
             22, False, JUNGLE, 26),
            ("A reference architecture for long-running, specialized agents that are "
             "allowed to act — and a description of exactly what stops them acting badly.",
             17, False, MUTED, 0),
        ],
    )
    textbox(
        s, Inches(1.0), Inches(6.6), Inches(11.3), Inches(1.2),
        [
            ("STATUS — reference architecture, not a shipped product and not a "
             "customer deployment.", 12, True, PERSIMMON, 4),
            ("OpenShell, NemoClaw and the sandbox lifecycle are verified running on a "
             "live SUSE cluster. The SecOps agent layer, the data flywheel, the sandbox "
             "image and the three SUSE portfolio integrations are designed and specified, "
             "but have never been run.", 12, False, MUTED, 0),
        ],
    )
    notes(s, """
Set the frame before the first figure. This is a reference architecture, and the status
caveat goes on the title slide on purpose so nobody has to wonder about it for the next
half hour.

THE ONE RULE for the whole deck: never let a "will" become an "is". Say "this is designed"
and "this runs" as separate, deliberate sentences. That is what makes you believed on the
second one.

Running order note: the deck runs figure 5 BEFORE figure 4. The worked example lands harder
before the packaging slide than after it.

Total: ~31 minutes of talking plus 15 for questions. Full script:
docs/architecture/secops-demo-walkthrough.md
""")

    # ------------------------------------------------------------- 2. problem
    s = blank(prs)
    fill(s, MIDNIGHT)
    rule(s, Inches(1.0), Inches(1.1), Inches(1.6), NVIDIA_GREEN, Pt(4))
    textbox(
        s, Inches(1.0), Inches(1.35), Inches(11.3), Inches(1.2),
        [("The problem is a queue, not a question", 38, True, WHITE, 0)],
    )
    textbox(
        s, Inches(1.0), Inches(2.9), Inches(11.3), Inches(4.6),
        [
            ("A registry scan of a mid-sized estate returns thousands of rows. Most are "
             "irrelevant. A handful are urgent — and nobody knows which handful until "
             "a person reads them.", 19, False, WHITE, 18),
            ("The finding rate exceeds the remediation rate. Permanently.", 19, True, WHITE, 24),
            ("A retrieval chatbot does not move this number. It answers questions about "
             "the queue. The queue is not short of answers; it is short of changes.",
             19, False, JUNGLE, 24),
            ("Which is also why most organisations will not run one. Granting an LLM write "
             "access to source control, in an estate it can also scan, on a cluster it can "
             "also reach, is a straightforward way to turn a vulnerability backlog into an "
             "incident.", 17, False, MUTED, 22),
            ("The interesting engineering is not the agents. It is the substrate that makes "
             "an agent safe to let loose.", 19, True, NVIDIA_GREEN, 0),
        ],
    )
    notes(s, """
2 minutes. No figure — say this before anything appears.

A platform team running a few hundred container images gets a continuous stream of findings.
Most are irrelevant: unreachable code path, package not installed at runtime, image not
deployed in a year. So the finding rate exceeds the remediation rate permanently.

That is not a knowledge problem. The team knows what a CVE is and how to bump a package.
What they do not have is the labour to do it several hundred times a month — each time
working out which images share the affected base layer, which are actually running, what the
fixed version is called in SUSE's errata, and whether the rebuild broke anything.

PIVOT, slowly: a retrieval chatbot does not move this number. Moving it requires something
that reads the finding, decides whether it matters, works out the fix, MAKES THE CHANGE,
proves the change worked, and hands a human a reviewable pull request.

Then the honest part, which distinguishes this from every other agent pitch in the room:
that is exactly why most organisations will not run one.

Close on the thesis: the interesting engineering is the substrate, not the agents.
Everything after this slide is that substrate.
""")

    # ------------------------------------------------------- 3. figure 0
    figure_slide(prs, "figure-0-platform-dark.jpg", """
4 minutes. THE LINE: the analyst has no kubeconfig, and neither does the agent.

The whole system on one slide, drawn by LOCATION rather than by layer. Green is NVIDIA,
dark frames are SUSE, dashed boxes are SUSE platform services the customer already owns —
integrated, not installed by this architecture.

Start outside and work in. The analyst is on a laptop outside the boundary with no
kubeconfig. Deliberate, not an omission: the human interacts through a web UI and a pull
request, and nothing else.

Inside RKE2, walk the three separations left to right — the agent plane where reasoning
happens, the OpenShell gateway that mediates every action, the sandboxes where the two
agents that change things run. Separate namespaces with policy between them, because the
agent plane may THINK about anything and may DO almost nothing.

Then the packaging point, which NVIDIA reviewers care about most. Point at the APP pills:
the NIM Operator and both Nemotron releases come from the AI Factory catalog as ordinary
apps. Everything else is carried by one of three Blueprints. Not arbitrary — an operator
and a model endpoint are shared cluster infrastructure many workloads consume. Slide 7
shows what the split buys you.

POINT AT
• the laptop outside the boundary — "no kubeconfig at any point in this story"
• SUSE Security and SUSE Observability, dashed — prerequisites, the customer already runs them
• the model plane band — Ultra plans, Lightning executes; two jobs, two very different price tags
• the three APP pills
• the flywheel panel — flag the 1 October 2026 NeMo Platform sunset NOW, before anyone spots it

IF ASKED
• "Why two models?" — the loops run at periods four orders of magnitude apart; paying
  planner prices for routine triage is how agent programmes die. Slide 5.
• "Is the GPU Operator part of this?" — it comes from the release manifest, with the
  precompiled NVIDIA driver 595 from registry.suse.com. That co-engineering predates this.
""")

    # ------------------------------------------------------- 4. figure 1
    figure_slide(prs, "figure-1-platform-view.jpg", """
4 minutes. THE LINE: NVIDIA supplies the intelligence; SUSE supplies the product around it.

Same system as a stack, because the division of labour is easier to see in layers.

Read it bottom-up in one breath: L0 OS, Kubernetes, GPU Operator. L1 control plane — AI
Factory operator, Blueprint and AIWorkload CRDs, Fleet GitOps. L2 model plane — NIM
Operator and Nemotron. L3 knowledge — NVIDIA RAG Blueprint v2.6.0 over a vulnerability
corpus. L4 agents — AI-Q 2.2. L5 action — OpenShell.

SAY SLOWLY: NVIDIA supplies the models, the agent toolkit and the sandbox runtime. SUSE
supplies the operating system, the Kubernetes, the packaging, the lifecycle, the governance
— and one support contract over all of it.

That last clause is the commercial argument; give it its own beat. For a regulated customer,
"who do I call at 3 a.m. when the NIM Operator stops reconciling" is a procurement question
that decides deals.

Then the honesty that makes it credible: nothing here is invented by SUSE. AI-Q 2.2 runs
agent skills in provider-neutral sandboxes and names OpenShell as a supported backend —
that seam is NVIDIA's. What SUSE adds is making it installable, versioned, air-gappable and
multi-tenant.

POINT AT
• the count of green boxes — "that is the answer to 'where is NVIDIA embedded'"
• the three APP pills in L2 again, briefly — consistency with the previous slide is the point
• L5 — "this layer is the one most agent architectures don't have"

IF ASKED
• "Why AI-Q 2.2 rather than the 2.1 you ship?" — 2.2 has the sandbox-backend seam. It is
  the hinge. Switching cost us the known-good 2.1 workflow config; section 11 lists what
  that leaves unverified.
• "Where does Milvus/cuVS fit?" — L3. GPU_CAGRA is a no-app-change acceleration insert
  once you have the VRAM; the minimal profile turns GPU search off.
""")

    # ------------------------------------------------------- 5. figure 2
    figure_slide(prs, "figure-2-specialized-agents.jpg", """
5 minutes. THE CENTREPIECE — do not rush it.
THE LINE: eight agents read things; two agents change things; the two are on the other side
of a boundary the agents cannot move.

Ten agents, each with a job small enough to name, classified Worker / Service / Support
after arXiv 2601.13671. Say that once — it signals the design is grounded — then never
mention it again.

The interesting split is the vertical line. Left, in AI-Q, everything that REASONS, with no
side effects. Right, inside OpenShell sandboxes, the only two agents that change the world:
the remediation engineer that edits a Containerfile, builds, tests and opens a PR, and the
validation agent that rebuilds and rescans.

Walk the left column BY COST, because the model assignments are the design. Intent
classifier: Lightning — runs on every signal, cheapest call in the system. Triage:
Lightning — runs on every finding every night, and most findings end there. Plan gate:
Ultra, and orange, because a human accepts, narrows or rejects before anything with a side
effect runs. Research orchestrator: Ultra; the N parallel researcher workers under it are
Lightning, and that fan-out is where the token volume lives. Writer: Ultra, with a citation
verifier that fails closed on an unsupported claim.

CROSS THE LINE AND SLOW DOWN — this is the part nobody else in the room has an answer for.
Sandbox policy is enforced OUT OF PROCESS. The agent runs inside; the supervisor enforces
outside. The agent cannot widen its own policy, not because we asked nicely, but because the
enforcement point is somewhere it cannot reach.

Read the constraints one at a time and let each land: no Kubernetes API access. One sandbox
per job, created on demand, destroyed on exit. Layer-7 egress allowlist — exactly one
writable git remote, the SUSE update repos, the registry; everything else denied. The git
token is injected at the gateway, so the agent never holds a credential it could leak. The
image is SLE BCI 16 and its only Python index is the curated SUSE Application Collection one
— pypi.org denied by policy, which closes the commonest agent supply-chain path.

Finish on what it may NOT do: it may open a pull request; policy denies merging and denies
changing branch protection. Two independent controls — one owned by the platform team, one
by the repository owner.

POINT AT
• the vertical boundary and the single arrow crossing it: "the only path to side effects"
• the two orange boxes — plan gate and human review
• the SUSE Observability band under both planes — the gateway emits EVERY POLICY DECISION
  rather than the agent self-reporting. That is the difference between telemetry and evidence.
• "AI Assistant deliberately OFF" — it would send tokens to a hosted model. Turning a
  feature off on purpose is a credibility detail; use it.

IF ASKED
• "What stops a prompt-injected advisory?" — NeMo Guardrails intercepts every model call on
  the left; on the right it barely matters what the agent has been persuaded to want,
  because the egress allowlist is enforced out of process.
• "Can the agent scan the cluster it's remediating?" — No. No kubeconfig in the sandbox.
• "Ten agents sounds like a lot." — Eight are one model call with a narrow job. The
  alternative is one agent with ten jobs: unauditable, and a bill nobody can attribute.
""")

    # ------------------------------------------------------- 6. figure 3
    figure_slide(prs, "figure-3-feedback-loops.jpg", """
4 minutes. THE LINE: a long-running agent architecture is defined by its loops, not its
boxes — and these six run on periods four orders of magnitude apart.

NVIDIA asked specifically for feedback loops and recurring execution paths. Say that this
slide is the direct answer to that part of the ask.

The spine across the middle is the happy path: signal, triage, plan gate, research,
remediate, validate, approve, apply. Everything else loops back into it, labelled with its
period. One sentence each:

L1 agent turn — seconds. Plan, act, observe, reflect, bounded by max_tool_iterations and
max_llm_turns. Bounded is the operative word; an unbounded loop is a runaway bill.

L2 escalation — minutes. Shallow research insufficient, so escalate to deep research and
Lightning to Ultra. THIS IS WHERE THE COST MODEL LIVES. Effort scaled to complexity rather
than paid flat.

L3 validation — minutes to hours. Patch, rebuild, rescan with SUSE Security, scan DIFF back
to the remediation agent. Terminates clean or out of budget.

L4 human verdict — hours. The plan gate and the PR review. Pause here: the verdict is
captured as a TRAINING SIGNAL, not discarded. Every other system in this category throws
that away.

L5 ingestion — nightly. New CVEs, SUSE-SU errata, fresh SBOMs and scan exports re-enter the
corpus. Never stale, which is why triage can rank by reachability instead of CVSS.

L6 data flywheel — weekly. NeMo Relay ATIF trajectories to Data Store; Evaluator grades on
a five-criterion rubric with the merged PR as ground truth; Customizer LoRA-tunes Lightning
on accepted trajectories only; NIM Operator serves the new adapter.

PUNCHLINE, written across the top: L6 returns to the model plane. That is what makes this a
factory rather than a pipeline. Routine work migrates from the 550B planner to the 30B
executor, so the system gets CHEAPER as it is used.

Mention resume-from-error once in passing — the difference between a demo and a production
system. NemoClaw's resumable lifecycle, OpenShell snapshot/restore, AI-Q's checkpoint DB.

POINT AT
• the period labels in order — the four-orders-of-magnitude spread is the argument for two
  models, and it closes the question someone asked on slide 3
• the orange L4 loop — the only one with a human in it
• the long blue line from L6 back up to the model plane
• the flywheel band header — flag the 1 Oct 2026 NeMo Platform sunset in your own words

IF ASKED
• "Isn't weekly tuning on your own output a feedback trap?" — Customizer trains on ACCEPTED
  trajectories only, and acceptance is a human merge plus an independent scan diff. Ground
  truth comes from outside the model.
• "What's the token cost?" — next slide, last panel. Anthropic measured multi-agent systems
  at roughly 15x chat token usage, which is precisely the argument for owning inference.
""")

    # ------------------------------------------------------- 7. figure 5
    figure_slide(prs, "figure-5-cve-end-to-end.jpg", """
5 minutes. THE LINE: fifty-one minutes of machine work and three hours of waiting for
people — and until now nobody could see the second number.

OPEN WITH THE CAVEAT, one sentence, before anything else: this sequence has not been
executed, the identifier is a placeholder, the timings are illustrative and internally
consistent. Getting that out of the way first buys you the next four minutes.

Then tell it as a story. CVE-2026-XXXXX in libexpat, in a shared SLE BCI 16 base layer.
Fourteen images affected. Nine running.

T+0 — SUSE Security flags it. Nine have running workloads, and the enforcer has observed
the XML parse path actually exercised in three. STOP THERE: that last fact is the whole of
triage. Without it the agent ranks a list; with it the agent ranks a cluster.

T+2 min — Triage on Lightning dedupes against forty-seven open findings and ranks by
reachability rather than CVSS. Eleven of fourteen fall to the backlog without a person
reading them.

T+20 min — The plan gate. Bump libexpat in the shared base image, rebuild three downstream
images, one PR per repository. A human accepts, narrows or rejects. Nothing with a side
effect has run yet — the blast radius is AGREED BEFORE the agent acts, not audited
afterwards.

T+26 min — Parallel research over the corpus: the SUSE-SU advisory, the upstream changelog,
each image's SBOM, the team's own runbook. A cited brief, every reference checked. Most of
the run's token cost is here.

T+38 min — Remediation inside the sandbox. Edits the Containerfile, builds, runs the test
suite, opens the PR. No kubeconfig, no public PyPI, one writable remote, every egress call
matched at layer 7, git token injected at the gateway.

T+51 min — SUSE Security rescans. MAKE THE ARGUMENT HERE: the scan diff, not the agent's own
account of its work, is the evidence — and sandbox policy denies write access to the
scanner's rules, so the agent cannot close a finding by changing what counts as a finding.

T+4 h — A maintainer reviews diff, brief and scan diff together, and merges. The agent
could not have.

T+4 h 20 — Fleet rolls the merged change out. The agent proposed; the platform applied.
Keeping those two verbs apart is what makes the whole thing deployable.

THE OUTCOMES PANEL — the slide NVIDIA actually asked for. Be precise about what is measurable.
• MTTR — the queue starts moving. Fifty-one minutes of machine work replaces days of analyst
  scheduling. Human time does not vanish; it moves to the two decisions that need a person,
  and both become explicit gates instead of a silent backlog.
• EFFORT — eleven of fourteen closed without a human reading them. THAT ratio, not per-CVE
  latency, is where the hours come back, and it is the number to measure in a pilot.
• AUDIT — ATIF trajectory, layer-7 egress log, scan diff, Blueprint provenance. Produced by
  running the process, not assembled afterwards for an auditor. That is what makes it usable
  as AI Act evidence.
• COST — capacity, not per-token. Anthropic measured ~15x chat token usage; owned inference
  turns that multiplier into a fixed capacity bill, and the flywheel keeps moving routine
  work from the 550B to the 30B.

POINT AT the two orange rows, and only those: "these are the only two places a person is
required, and they are the two places a person should be."
""")

    # ------------------------------------------------------- 8. figure 4
    figure_slide(prs, "figure-4-blueprint-lifecycle.jpg", """
3 minutes. THE LINE: every box in that architecture is a Kubernetes object, and that is what
makes it a product instead of a project.

The previous slides described a system. This one is about why it can be shipped to somebody.

No imperative installer. Three apps from the AI Factory catalog, three Blueprints carrying
everything else, one AIWorkload set, and the operator turns that into Fleet HelmOps and a
running stack. Git is the source of record and the only place a human edits anything.

Then the three properties, which are really the whole slide:

IMMUTABILITY — a Blueprint version is a contract. AIWorkload.spec.componentValues is ignored
on the Blueprint path, so every knob is baked into the version. Changing a value means
cutting 1.0.0 to 1.0.1, not editing a running system. What runs traces back to one YAML
document.

AIR GAP — chartRepo is a name, not a URL. No Blueprint in the set encodes a public hostname.
Three hosts to mirror: NGC, registry.suse.com, SUSE Application Collection. Mirror those,
repoint the ClusterRepos, and the Blueprints do not change.

DRIFT — Fleet compares live objects against the rendered manifest every cycle. A hand-edited
NIMService or a loosened NetworkPolicy — INCLUDING the OpenShell policy that bounds the
agent — is reported and reverted from git. Say the consequence out loud: the agents cannot
reach the plane that governs them. That closes the loop opened on slide 5.

POINT AT the install-order strip along the bottom: three catalog apps, then blueprint 10 (the
gateway), 11 (the workspace), 20 (the SecOps stack). Note that the strip says, in the figure
itself, that nothing here has been run end to end — you are not smuggling anything.
""")

    # ------------------------------------------------------ 9. honest status
    s = blank(prs)
    fill(s, MIDNIGHT)
    rule(s, Inches(1.0), Inches(0.85), Inches(1.6), PERSIMMON, Pt(4))
    textbox(
        s, Inches(1.0), Inches(1.1), Inches(11.3), Inches(1.0),
        [("Honest status", 38, True, WHITE, 0)],
    )
    textbox(
        s, Inches(1.0), Inches(2.25), Inches(5.4), Inches(5.4),
        [
            ("RUNS TODAY, ON A LIVE CLUSTER", 13, True, JUNGLE, 12),
            ("OpenShell gateway and full sandbox lifecycle, driven from a local nemoclaw "
             "binary against a cluster gateway", 14, False, WHITE, 9),
            ("All three Blueprint CRs accepted by the API server under --dry-run=server",
             14, False, WHITE, 9),
            ("Every chart repo / name / version triple resolves against live ClusterRepo "
             "indexes", 14, False, WHITE, 9),
            ("Every AI-Q _type in the workflow config exists upstream at tag v2.2.0",
             14, False, WHITE, 9),
            ("The OpenShell policy grammar, read from the Rust source", 14, False, WHITE, 0),
        ],
    )
    textbox(
        s, Inches(6.95), Inches(2.25), Inches(5.4), Inches(5.4),
        [
            ("DESIGNED, NOT BUILT", 13, True, PERSIMMON, 12),
            ("The SecOps agent layer — the workflow config has never been loaded by a "
             "running AI-Q", 14, False, WHITE, 9),
            ("The data flywheel — and deprecated on arrival", 14, False, WHITE, 9),
            ("The sandbox image — specified, does not exist", 14, False, WHITE, 9),
            ("All three SUSE portfolio integrations", 14, False, WHITE, 9),
            ("The CVE walkthrough", 14, False, WHITE, 18),
            ("THE GAP THAT MATTERS", 13, True, PERSIMMON, 8),
            ("AI-Q to OpenShell on Kubernetes is not a supported path yet — and closing "
             "it is squarely the kind of work an AI Factory Blueprint exists to do.",
             14, False, MUTED, 0),
        ],
    )
    notes(s, """
2 minutes. MANDATORY SLIDE. Give the ledger in three groups, in this order, without hedging.

WHAT RUNS — read the left column. Add: the dry-run test exercises the semver regex, the
source enum, the chart-name uniqueness constraint and the DNS name-length limits. It is a
real test and it passes.

WHAT IS DESIGNED — read the right column. Note the authoring cluster's GPUs are simulated,
which is why the agent layer COULD NOT be run, rather than merely was not.

THE GAP — VOLUNTEER IT. A reviewer who finds it themselves will discount everything else.
NVIDIA's own AI-Q 2.2 operator guide certifies OpenShell 0.0.88 and the Docker runtime. The
stock aiq-agent image ships no OpenShell client SDK and no gateway-registration step. And no
single gateway version does both halves — 0.0.88 lacks the workspace keys this multi-tenant
topology needs; those keys arrive only in later and dev builds, and the companion workspace
chart has dev tags only.

THEN THE TURN, which is the real close of the deck: that gap is the engineering work this
architecture implies, and it is squarely the kind of work an AI Factory Blueprint exists to
do. We are showing it to you because closing it is a joint piece of work, and because the
design is specific enough to be argued with.
""")

    # ----------------------------------------------------------- 10. close
    s = blank(prs)
    fill(s, MIDNIGHT)
    rule(s, Inches(1.0), Inches(2.4), Inches(1.6), NVIDIA_GREEN, Pt(4))
    textbox(
        s, Inches(1.0), Inches(2.65), Inches(11.3), Inches(4.2),
        [
            ("NVIDIA supplies the models, the agent toolkit and the sandbox runtime.",
             26, True, WHITE, 12),
            ("SUSE makes them installable, versioned, air-gappable, multi-tenant and "
             "supportable under one contract.", 26, True, JUNGLE, 34),
            ("What we would like from this conversation: the aiq-agent + OpenShell SDK "
             "path, and a gateway release that carries the workspace keys.",
             19, False, WHITE, 12),
            ("After that, this is buildable.", 19, True, NVIDIA_GREEN, 0),
        ],
    )
    textbox(
        s, Inches(1.0), Inches(7.3), Inches(11.3), Inches(0.6),
        [("docs/architecture/sovereign-agentic-secops.md  ·  "
          "examples/secops-agent-factory/", 12, False, MUTED, 0)],
    )
    notes(s, """
1 minute. Three sentences and stop.

This is a reference architecture for long-running, specialized agents that are allowed to
act — and a description of exactly what stops them acting badly. NVIDIA supplies the
models, the agent toolkit and the sandbox runtime; SUSE makes them installable, versioned,
air-gappable, multi-tenant and supportable under one contract. What we would like from this
conversation is the aiq-agent-plus-OpenShell-SDK path and a gateway release that carries the
workspace keys — after that, this is buildable.

DO NOT SAY, at any point in Q&A:
• "Customers are running this" — nobody is
• "Benchmarked" / "measured" / "tested" — the figure 5 timings are illustrative. The only
  measured number in the deck is Anthropic's ~15x token multiplier, and it is theirs
• Specific MTTR percentages or ROI figures
• "Nemotron-H" — older research line. It is Nemotron 3 Ultra (550B-A55B), Nemotron 3.5
  Lightning (30B-A3B), Nemotron 3 Embed 1B
• A parameter count for Nemotron 3 Super — reported inconsistently; leave it unquantified
• "RAPIDS" — it is CUDA-X Data Science now
• "Supported", about AI-Q on OpenShell on Kubernetes
""")

    prs.save(str(OUT))
    print(f"wrote {OUT}  ({len(prs.slides)} slides)")


if __name__ == "__main__":
    main()
