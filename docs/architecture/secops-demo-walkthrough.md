# Sovereign Agentic SecOps — presenter's walkthrough

### A narrated demo of the reference architecture, figure by figure

This is a talk track, not a runbook. It walks the six figures in
[`docs/architecture/images/`](images/) in a deliberate order, gives you the line to say at
each beat, names the part of the figure to point at, and tells you what to answer when
someone interrupts. There is nothing to install and no cluster to connect to.

> **Provenance.** Every number, model ID, chart version and policy behaviour quoted in this
> script is traceable to [`sovereign-agentic-secops.md`](sovereign-agentic-secops.md) or to
> the YAML under [`examples/secops-agent-factory/`](../../examples/secops-agent-factory/).
> The architecture is **not** running end to end — OpenShell, NemoClaw and the sandbox
> lifecycle are verified on a live cluster; the SecOps agent layer, the flywheel, the
> sandbox image and the three SUSE portfolio integrations are designed and specified but
> have never been run. Slide 8 exists to say so out loud, and it is not optional.

**Total time:** about 31 minutes of talking, plus 15 for questions. It compresses to 5 —
see [Appendix B](#appendix-b--the-five-minute-version).

---

## Before you start

**Audience.** NVIDIA partner-architecture reviewers, plus whoever they bring. They asked
partners for platform-level diagrams of real agentic AI on the NVIDIA stack, with four
things called out: specialized agents, where NVIDIA technology is embedded, business
outcomes, and long-running feedback loops. Every slide below maps to one of those four,
and [the mapping table](#the-ask-and-where-each-slide-answers-it) is your safety net if the
conversation drifts.

**The deck.** [`sovereign-agentic-secops.pptx`](sovereign-agentic-secops.pptx) is this script
already built: ten slides at 16:10, the six figures full-bleed in the running order below,
and the talk track in the speaker notes. Upload it to Google Drive and open it with Google
Slides — the notes import intact — or use **File → Import slides** to pull it into an
existing deck. Regenerate it after any figure change with
`python3 docs/architecture/make-deck.py`.

**What to have open.**

| What | Where |
|---|---|
| The deck, in presenter view so you can see the notes | [`sovereign-agentic-secops.pptx`](sovereign-agentic-secops.pptx) |
| The six JPGs, if you would rather build your own deck | `docs/architecture/images/figure-*.jpg` — all 2560×1600, 16:10 |
| The document, in a second window, for when someone wants the detail | [`sovereign-agentic-secops.md`](sovereign-agentic-secops.md) |
| The Blueprint directory, in a terminal or editor | [`examples/secops-agent-factory/`](../../examples/secops-agent-factory/) |

Do not screen-share a cluster. Nothing in this story is demonstrable live yet, and reaching
for a terminal invites exactly the question you cannot answer well on the spot.

**The one rule.** Never let a "will" become an "is". The value of this material to an NVIDIA
reviewer is that it is unusually specific *and* unusually honest about its own status; the
moment you blur that, both halves stop being worth anything. Say "this is designed" and
"this runs" as distinct sentences, deliberately, and you will be believed on the second one.

**Running order.** The figures are numbered 0–5 in the document's reading order, but the
deck runs **5 before 4** — the worked example lands far harder before the packaging slide
than after it. Get the audience to "so a CVE closes in four hours" first; then show them
that the thing which does it is a handful of Kubernetes objects.

| Slide | Figure | Time | What it does |
|---|---|---|---|
| 1 | — | 2 min | The problem is a queue, not a question |
| 2 | Figure 0 | 4 min | Where everything runs |
| 3 | Figure 1 | 4 min | Six layers, and who supplies which |
| 4 | Figure 2 | 5 min | Ten specialized agents, and the line they may not cross |
| 5 | Figure 3 | 4 min | Six recurring execution paths |
| 6 | Figure 5 | 5 min | One CVE, end to end — and the outcomes |
| 7 | Figure 4 | 3 min | Blueprint to running stack |
| 8 | — | 2 min | Honest status |
| 9 | — | 1 min | The close |

---

## Slide 1 — The problem is a queue, not a question

**Figure:** none. Title slide, or a black slide. Say this before anything appears.
**Time:** 2 minutes.
**The line they should remember:** *the backlog is not short of answers, it is short of
changes.*

**Say.** A platform team running a few hundred container images gets a continuous stream of
vulnerability findings. A registry scan of a mid-sized estate returns thousands of rows.
Most are irrelevant — unreachable code path, package not installed at runtime, image not
deployed in a year. A handful are urgent, and nobody knows which handful until a person
reads them. So the finding rate exceeds the remediation rate permanently.

That is not a knowledge problem. The team knows what a CVE is and how to bump a package.
What they do not have is the labour to do it several hundred times a month — each time
working out which images share the affected base layer, which of those are actually
running, what the fixed version is called in SUSE's errata, and whether the rebuild broke
anything.

Then the pivot, and land it slowly: **a retrieval chatbot does not move this number.** It
answers questions about the queue. Moving the number requires something that reads the
finding, decides whether it matters, works out the fix, *makes the change*, proves the
change worked, and hands a human a reviewable pull request.

Then the honest part, which is what distinguishes this pitch from every other agent pitch
in the room: that is also exactly why most organisations will not run one. Granting an LLM
write access to source control, in an estate it can also scan, on a cluster it can also
reach, is a straightforward way to turn a vulnerability backlog into an incident.

Close the slide with the thesis of the whole deck: **the interesting engineering here is
not the agents, it is the substrate that makes an agent safe to let loose.** Everything
after this slide is that substrate.

---

## Slide 2 — Where everything runs

**Figure:** `figure-0-platform-dark.jpg`
**Time:** 4 minutes.
**The line they should remember:** *the analyst has no kubeconfig, and neither does the
agent.*

**Say.** This is the whole system on one slide, drawn by *location* rather than by layer.
Everything green is NVIDIA. Everything dark-framed is SUSE. Dashed boxes are SUSE platform
services the customer already owns — integrated, not installed by this architecture.

Start outside the cluster and work in. The analyst is on a laptop, outside the boundary,
and has no kubeconfig. That is a deliberate property, not an omission: the human interacts
with this system through a web UI and a pull request, and nothing else.

Inside RKE2, walk the three separations left to right — the agent plane where reasoning
happens, the OpenShell gateway that mediates every action, and the sandboxes where the two
agents that change things actually run. They are separate namespaces with policy between
them because the agent plane is allowed to *think* about anything and allowed to *do*
almost nothing.

Then the packaging point, which is the one reviewers from NVIDIA care about most. Point at
the `APP` pills. Those components — the NIM Operator and both Nemotron releases — come from
the AI Factory catalog as ordinary apps. Everything else in the picture is carried by one
of three Blueprints. That split is not arbitrary: an operator and a model serving endpoint
are shared cluster infrastructure that many workloads consume, so packaging them inside an
application Blueprint would be wrong. Slide 7 shows what the split buys you.

**Point at.**

- The laptop, outside the cluster boundary — "no kubeconfig, no cluster access, at any
  point in this story."
- SUSE Security and SUSE Observability, dashed — "these are prerequisites. We integrate
  with them; we don't ship them here. The customer already runs them."
- The model plane band — Ultra plans, Lightning executes. Two models, two jobs, two very
  different price tags.
- The three `APP` pills — the catalog/Blueprint split.
- The flywheel panel, bottom right — flag the footnote now so you don't have to defend it
  later: NeMo Microservices is superseded by NeMo Platform from 1 October 2026, and the
  document says so in section 11.

**If asked here.**

- *"Why two models?"* — Because the loops run at periods four orders of magnitude apart,
  and paying planner prices for routine triage is how agent programmes die. Slide 5.
- *"Is the GPU Operator part of this?"* — It comes from the release manifest, with the
  precompiled NVIDIA driver 595 from `registry.suse.com`. That co-engineering predates this
  architecture.

---

## Slide 3 — Six layers, and who supplies which

**Figure:** `figure-1-platform-view.jpg`
**Time:** 4 minutes.
**The line they should remember:** *NVIDIA supplies the intelligence; SUSE supplies the
product around it.*

**Say.** Same system, redrawn as a stack, because the division of labour is the point of
the whole exercise and it is easier to see in layers.

Read it bottom-up in one breath: L0, the operating system, the Kubernetes and the GPU
Operator. L1, the control plane — the AI Factory operator, the Blueprint and AIWorkload
CRDs, Fleet GitOps. L2, the model plane, which is NIM Operator and Nemotron. L3, knowledge
— NVIDIA RAG Blueprint v2.6.0 over a vulnerability corpus. L4, agents — AI-Q 2.2. L5,
action — OpenShell.

Now the sentence to say slowly: **NVIDIA supplies the models, the agent toolkit and the
sandbox runtime. SUSE supplies the operating system, the Kubernetes, the packaging, the
lifecycle, the governance — and one support contract over all of it.**

That last clause is the commercial argument and it deserves its own beat. For a regulated
customer, "who do I call at 3 a.m. when the NIM Operator stops reconciling" is a
procurement question that decides deals. SUSE is first point of contact across the NVIDIA
components as well as its own.

Then the honesty that makes the claim credible: nothing in this architecture is invented by
SUSE. AI-Q 2.2 runs agent skills in provider-neutral sandboxes and names OpenShell as a
supported backend — that seam is NVIDIA's, not ours. What SUSE adds is turning it into
something installable, versioned, air-gappable and multi-tenant.

**Point at.**

- The count of green boxes — "every green box is NVIDIA technology. That is the answer to
  'where is NVIDIA embedded', and it is the reason the figure has a legend rather than two
  adjacent greens you have to squint at."
- The three `APP` pills in L2, again, briefly — consistency with the previous slide is the
  point.
- L5 — "this layer is the one most agent architectures don't have."

**If asked here.**

- *"Why AI-Q 2.2 rather than the 2.1 you ship today?"* — 2.2 is the release with the
  sandbox-backend seam. It is the hinge of the architecture, and switching to it cost us
  the known-good 2.1 workflow config we already had. Section 11 lists what that leaves
  unverified.
- *"Where does Milvus/cuVS fit?"* — L3. `GPU_CAGRA` is a no-application-change acceleration
  insert once you have the VRAM; the minimal profile turns GPU search off.

---

## Slide 4 — Ten specialized agents, and the line they may not cross

**Figure:** `figure-2-specialized-agents.jpg`
**Time:** 5 minutes. This is the centrepiece — do not rush it.
**The line they should remember:** *eight agents read things; two agents change things; the
two are on the other side of a boundary the agents cannot move.*

**Say.** Ten agents, each with a job small enough to name. They are classified Worker,
Service or Support, following the taxonomy in arXiv 2601.13671 — say that once, because it
signals the design is grounded in something, and then never mention it again.

But the classification is not the interesting split. The interesting split is the vertical
line down the middle of the figure. On the left, in AI-Q, everything that *reasons* — and
none of it has side effects. On the right, inside OpenShell sandboxes, the only two agents
that change the world: the remediation engineer that edits a Containerfile, builds, tests
and opens a pull request, and the validation agent that rebuilds and rescans.

Now walk the left column quickly, by cost, because the model assignments *are* the design:
the intent classifier is Lightning, because it runs on every incoming signal and is the
cheapest call in the system. Triage is Lightning, for the same reason — it runs on every
finding, every night, and most findings end there. The plan gate is Ultra, and it is orange
because a human accepts, narrows or rejects the plan before anything with a side effect
runs. Research orchestration is Ultra; the N parallel researcher workers underneath it are
Lightning, and that fan-out is where the token volume lives. The writer is Ultra, with a
citation verifier that fails closed on an unsupported claim.

Then cross the line and slow right down, because this is the part nobody else in the room
has an answer for. Point at the top-right box: the sandbox policy, enforced *out of
process*. The agent runs inside the sandbox; the policy is enforced by the supervisor
outside it. **The agent cannot widen its own policy**, not because we asked it nicely, but
because the enforcement point is somewhere it cannot reach.

Read the concrete constraints straight off the figure, one at a time, and let each one
land: no Kubernetes API access. One sandbox per job, created on demand, destroyed on exit.
Layer-7 egress allowlist — exactly one writable git remote, the SUSE update repositories
and the registry; everything else denied. The git token is injected at the gateway, so the
agent never holds a credential it could leak. The sandbox image is SLE BCI 16, and its only
Python index is the curated one from SUSE Application Collection — `pypi.org` is denied by
policy, which quietly closes the most common agent supply-chain path in the industry.

Finish with the two things the agent is explicitly *not* allowed to do: it may open a pull
request; policy denies merging and denies changing branch protection. Two independent
controls — one owned by the platform team, one by the repository owner.

**Point at.**

- The vertical boundary, and the label on the single arrow crossing it: "the only path to
  side effects."
- The orange boxes — plan gate and human review. Two humans, deliberately placed, at the
  two moments that matter.
- The SUSE Observability band underneath both planes — one topology over models, retrieval,
  agents and sandboxes, with the gateway emitting *every policy decision* rather than the
  agent self-reporting its own behaviour. Say that distinction explicitly; it is the
  difference between telemetry and evidence.
- "AI Assistant deliberately OFF" in that band — it would send tokens to a hosted model,
  which defeats the sovereignty claim. Turning a feature off on purpose is a credibility
  detail; use it.

**If asked here.**

- *"What stops a prompt-injected advisory steering the agents?"* — Two things. NeMo
  Guardrails intercepts every model call on the left. And on the right it doesn't matter
  much what the agent has been persuaded to want, because the egress allowlist is enforced
  out of process and denies everything it doesn't name.
- *"Can the agent scan the cluster it's remediating?"* — No. No kubeconfig in the sandbox.
- *"Ten agents sounds like a lot."* — Eight of them are one model call with a narrow job.
  The alternative is one agent with ten jobs, which is how you get an unauditable system
  and a bill nobody can attribute.

---

## Slide 5 — Six recurring execution paths

**Figure:** `figure-3-feedback-loops.jpg`
**Time:** 4 minutes.
**The line they should remember:** *a long-running agent architecture is defined by its
loops, not its boxes — and these six run on periods four orders of magnitude apart.*

**Say.** NVIDIA asked specifically for feedback loops and recurring execution paths to be
called out, so this slide is the direct answer to that part of the ask. Say so.

The spine across the middle is the happy path: signal, triage, plan gate, research,
remediate, validate, approve, apply. Everything else on this figure is a loop back into
that spine, and each one is labelled with its period.

Walk the six by timescale, one sentence each:

- **L1, agent turn — seconds.** Plan, act, observe, reflect, bounded by
  `max_tool_iterations` and `max_llm_turns`. Bounded is the operative word; an unbounded
  loop is a runaway bill.
- **L2, escalation — minutes.** Shallow research proves insufficient, so the system escalates
  to deep research and from Lightning to Ultra. **This is where the cost model lives.**
  Effort is scaled to complexity rather than paid flat.
- **L3, validation — minutes to hours.** Patch, rebuild, rescan with SUSE Security, and the
  scan *diff* goes back to the remediation agent. It terminates clean or out of budget.
- **L4, human verdict — hours.** The plan gate and the PR review. And here is the line worth
  pausing on: **the verdict is captured as a training signal, not discarded.** Every other
  system in this category throws that away.
- **L5, ingestion — nightly.** New CVEs, SUSE-SU errata, fresh SBOMs and scan exports
  re-enter the corpus. The knowledge base is never stale, which is why triage can rank by
  reachability instead of by CVSS.
- **L6, data flywheel — weekly.** NeMo Relay ATIF trajectories into the Data Store, Evaluator
  grades them against a five-criterion rubric with the merged PR as ground truth, Customizer
  LoRA-tunes Lightning on accepted trajectories only, and NIM Operator serves the new
  adapter.

Then the punchline, which is written across the top of the figure: L6 returns to the model
plane. **That is what makes this a factory rather than a pipeline.** Routine work migrates
from the 550B planner to the 30B executor over time, so the system gets cheaper as it is
used, rather than more expensive.

Mention resume-from-error once, in passing, because it is the difference between a demo and
a production system: these agents are stateful and errors compound, so the architecture
resumes — NemoClaw's resumable lifecycle, OpenShell snapshot and restore, AI-Q's checkpoint
database — rather than restarting.

**Point at.**

- The period labels themselves, in order — the four-orders-of-magnitude spread is the
  argument for two models, and it closes the question someone asked on slide 2.
- The orange L4 loop, which is the only one with a human in it.
- The long blue line from L6 back up to the model plane.
- The flywheel band's header — flag the 1 October 2026 NeMo Platform sunset here, in your
  own words, before anyone spots it.

**If asked here.**

- *"Isn't weekly LoRA tuning on your own output a feedback trap?"* — Customizer trains on
  *accepted* trajectories only, and acceptance is a human merge plus an independent scan
  diff. The ground truth comes from outside the model.
- *"What's the token cost of all this?"* — Slide 6, last panel. Short version: Anthropic
  measured multi-agent systems at roughly fifteen times chat token usage, which is precisely
  the argument for owning the inference rather than renting it.

---

## Slide 6 — One CVE, end to end

**Figure:** `figure-5-cve-end-to-end.jpg`
**Time:** 5 minutes.
**The line they should remember:** *fifty-one minutes of machine work and three hours of
waiting for people — and until now nobody could see the second number.*

**Say.** Open with the caveat, in one sentence, before you say anything else: **this
sequence has not been executed. The identifier is a placeholder and the timings are
illustrative and internally consistent.** Getting that out of the way first is what buys
you the next four minutes.

Then tell it as a story, because it is one. CVE-2026-XXXXX in libexpat, in a shared SLE BCI
16 base layer. Fourteen images affected. Nine of them running.

- **T+0.** SUSE Security flags it. Nine have running workloads, and the enforcer has observed
  the XML parse path actually exercised in three. Stop on that: *that last fact is the whole
  of triage.* Without it the agent is ranking a list; with it the agent is ranking a
  cluster.
- **T+2 min.** Triage on Lightning dedupes against forty-seven open findings and ranks by
  reachability rather than CVSS. Eleven of fourteen fall to the backlog without a person
  reading them.
- **T+20 min.** The plan gate. Bump libexpat in the shared base image, rebuild the three
  downstream images, one pull request per repository. A human accepts, narrows or rejects.
  Nothing with a side effect has run yet — **the blast radius is agreed before the agent
  acts, not audited afterwards.**
- **T+26 min.** Parallel research over the corpus — the SUSE-SU advisory, the upstream
  changelog, each image's SBOM, the team's own runbook. A cited brief, with every reference
  checked. Most of the run's token cost is here.
- **T+38 min.** Remediation, inside the sandbox. Edits the Containerfile, builds, runs the
  test suite, opens the PR. No kubeconfig, no public PyPI, one writable remote, every egress
  call matched at layer 7, git token injected at the gateway.
- **T+51 min.** SUSE Security rescans the rebuilt image. Point at this row and make the
  argument: **the scan diff, not the agent's own account of its work, is the evidence** —
  and sandbox policy denies write access to the scanner's rules, so the agent cannot close a
  finding by changing what counts as a finding.
- **T+4 h.** A maintainer reviews diff, brief and scan diff together, and merges. The agent
  could not have.
- **T+4 h 20.** Fleet rolls the merged change out. The agent proposed; the platform applied.
  Those two verbs stay apart, and that is what makes the whole thing deployable.

Then the outcomes panel, which is the slide NVIDIA actually asked for. Four claims, and be
precise about which are measurable:

- **MTTR** — the queue starts moving. Fifty-one minutes of machine work replaces days of
  analyst scheduling. The human time does not vanish; it moves to the two decisions that
  genuinely need a person, and both become explicit gates instead of a silent backlog.
- **Effort** — eleven of fourteen findings closed without a human reading them. *That* ratio,
  not per-CVE latency, is where the hours come back, and it is the number to measure in a
  pilot because it scales with the size of the backlog.
- **Audit** — the ATIF trajectory, the layer-7 egress log, the scan diff and the Blueprint
  provenance record. The evidence is produced by running the process, not assembled
  afterwards for an auditor. That is what makes it usable as AI Act evidence.
- **Cost** — capacity, not per-token. Anthropic measured multi-agent systems at roughly
  fifteen times chat token usage; owned inference turns that multiplier into a fixed
  capacity bill, and the flywheel keeps moving routine work from the 550B to the 30B.

**Point at.** The two orange rows, and only those: "these are the only two places a person
is required, and they are the two places a person should be."

---

## Slide 7 — From Blueprint to running stack

**Figure:** `figure-4-blueprint-lifecycle.jpg`
**Time:** 3 minutes.
**The line they should remember:** *every box in that architecture is a Kubernetes object,
and that is what makes it a product instead of a project.*

**Say.** The previous six slides described a system. This one is about why it can be
shipped to somebody.

There is no imperative installer. Three apps come from the AI Factory catalog, three
Blueprints carry everything else, one AIWorkload set instantiates them, and the operator
turns that into Fleet HelmOps and a running stack. Git is the source of record and the only
place a human edits anything.

Then the three properties, which is really the whole slide:

**Immutability.** A Blueprint version is a contract. `AIWorkload.spec.componentValues` is
ignored on the Blueprint path, so every knob is baked into the version. Changing a value
means cutting 1.0.0 to 1.0.1 — not editing a running system. What runs can always be traced
back to one YAML document.

**Air gap.** `chartRepo` is a name, not a URL. No Blueprint in the set encodes a public
hostname. Three hosts to mirror: NGC, `registry.suse.com` and the SUSE Application
Collection. Mirror those, repoint the ClusterRepos, and the Blueprints do not change.

**Drift.** Fleet compares live objects against the rendered manifest every cycle. A
hand-edited NIMService or a loosened NetworkPolicy — *including the OpenShell policy that
bounds the agent* — is reported and reverted from git. Say the consequence out loud:
**the agents cannot reach the plane that governs them.** That closes the loop opened on
slide 4.

**Point at.** The install-order strip along the bottom: three catalog apps, then blueprint
10 (the gateway), then 11 (the workspace), then 20 (the SecOps stack). Note that the strip
says, in the figure itself, that nothing here has been run end to end — you are not
smuggling anything.

---

## Slide 8 — Honest status

**Figure:** none. A text slide, or figure 0 again with the status quote on it.
**Time:** 2 minutes. **This slide is mandatory.**
**The line they should remember:** *here is precisely what runs and precisely what does
not.*

**Say.** Give the ledger in three groups, in this order, without hedging.

**What runs, today, on a live cluster.** The OpenShell gateway and full sandbox lifecycle,
driven from a local `nemoclaw` binary against a cluster gateway. All three Blueprint CRs are
accepted by the API server under `--dry-run=server`, which exercises the semver regex, the
source enum, the chart-name uniqueness constraint and the DNS name-length limits. Every
chart repo, name and version triple resolves against live ClusterRepo indexes. Every AI-Q
`_type` in the workflow config exists upstream at tag v2.2.0. The OpenShell policy grammar
was read out of the Rust source, not out of documentation.

**What is designed and not built.** The SecOps agent layer — the workflow config has never
been loaded by a running AI-Q. The data flywheel, which is also deprecated on arrival. The
sandbox image, which is specified but does not exist. All three SUSE portfolio
integrations. And the CVE walkthrough on slide 6.

**The gap that matters**, and volunteer it rather than waiting to be asked, because a
reviewer who finds it themselves will discount everything else: **AI-Q to OpenShell on
Kubernetes is not a supported path yet.** NVIDIA's own AI-Q 2.2 operator guide certifies
OpenShell 0.0.88 and the Docker runtime. The stock aiq-agent image ships no OpenShell client
SDK and no gateway-registration step. And no single gateway version does both halves — 0.0.88
lacks the workspace keys this multi-tenant topology needs, and those keys only arrive in
later and dev builds, while the companion workspace chart has dev tags only.

Then the turn, which is the actual close of the deck: **that gap is the engineering work
this architecture implies, and it is squarely the kind of work an AI Factory Blueprint
exists to do.** We are showing it to you because closing it is a joint piece of work, and
because the design is specific enough to be argued with.

---

## Slide 9 — The close

**Time:** 1 minute.

Three sentences and stop.

This is a reference architecture for long-running, specialized agents that are allowed to
act — and a description of exactly what stops them acting badly. NVIDIA supplies the models,
the agent toolkit and the sandbox runtime; SUSE makes them installable, versioned,
air-gappable, multi-tenant and supportable under one contract. What we would like from this
conversation is the aiq-agent-plus-OpenShell-SDK path and a gateway release that carries the
workspace keys — after that, this is buildable.

---

## The ask, and where each slide answers it

Keep this table to hand. If the reviewer says "you haven't shown us X", it is on a slide.

| What NVIDIA asked partners for | Slide | Figure |
|---|---|---|
| A platform-level architecture view | 2, 3 | 0, 1 |
| Where NVIDIA technology is embedded | 3 (and every green box everywhere) | 1 |
| Specialized agents called out | 4 | 2 |
| Workflow and data flow | 4, 6 | 2, 5 |
| Long-running feedback loops / recurring execution paths | 5 | 3 |
| Business outcomes | 6 | 5 |
| Real partner implementations and workflows | 7 | 4 |

---

## Appendix A — Questions you will get

**"Has any of this been run?"** Partly, and slide 8 is the exact line. OpenShell, NemoClaw
and the sandbox lifecycle run on a live cluster. The agent layer does not. The authoring
cluster's GPUs are simulated, which is why the agent layer could not be run rather than
merely was not.

**"Why not use a hosted frontier model and skip all this?"** Two reasons, and the second is
the real one. Cost: multi-agent systems burn roughly fifteen times chat tokens, so a
per-token bill on this workload scales badly and gets worse as adoption succeeds. And
sovereignty: this agent reads your SBOMs, your scan exports, your internal runbooks and your
source. That is a map of your estate's weaknesses, and for a regulated customer it does not
leave the boundary.

**"How is this different from NVIDIA's own Vulnerability Analysis blueprint?"** Complementary
rather than competing. That blueprint analyses. This one composes analysis with a governed
execution substrate so something at the end is permitted to write to a repository, plus the
packaging that makes it installable and the loops that make it improve.

**"What if the agent breaks production?"** It cannot reach production. No kubeconfig, no
merge, no branch-protection change; Fleet applies the change after a human merges, and Fleet
reverts anything hand-edited — including the policy that bounds the agent.

**"What's the GPU bill?"** Three profiles, in section 9. Full is 8×H100-class with both
models resident and GPU retrieval on. Reduced is 2×H200 with time-slicing — escalations
queue, wall-clock per remediation rises materially. Minimal is a single 24 GB card, and be
blunt about it: it demonstrates the plumbing, not the outcome. A 30B executor with no
planner above it and no sandbox below it is a chatbot with extra YAML.

**"NeMo Microservices is being sunset."** Yes — 1 October 2026, superseded by NeMo Platform.
Section 11 says so, the flywheel figure says so, and the values file in the examples
directory is a description of the loop rather than an install target. Anyone building this
should start from NeMo Platform.

**"Why isn't the NIM Operator in a Blueprint?"** Because it is shared cluster infrastructure
that many workloads consume, and the same is true of the model endpoints. Both Nemotron
releases are installed from the catalog with release names that the Blueprints and the
workflow config address by DNS. That is the contract between the two halves. The precedent
is in the shipped blueprints — `nvidia-aiq-with-rag` serves a Nemotron model and ships no
LLM and no operator either.

**"Can we see the YAML?"** Yes, and this is a good moment to open
`examples/secops-agent-factory/`. Show the README's verified/unverified ledger first, not
the Blueprints — it sets the frame correctly. If they want one file, show
`policies/remediation-sandbox.yaml`; it is the shortest artefact that carries the actual
argument.

**"What would a pilot look like?"** One repository, one base image, triage only, no write
access — measure the ratio of findings closed without a human reading them. That number is
the business case, and it can be measured before any agent is allowed to act.

---

## Appendix B — The five-minute version

For a hallway, a booth, or the slot that got cut in half. Three figures, three beats.

1. **Figure 0, 90 seconds.** The problem is a queue, not a question, and the queue is short
   of changes rather than answers. Here is the system. The analyst has no kubeconfig; the
   agent has less.
2. **Figure 2, 2 minutes.** Ten specialized agents. Eight reason, two act, and the two that
   act run inside a sandbox whose policy is enforced out of process — no Kubernetes API, one
   writable git remote, no public PyPI, may open a PR, may not merge it.
3. **Figure 5, 90 seconds.** One CVE: fourteen images, eleven closed without a person,
   four hours to a merged fix, and the audit trail falls out of the process rather than
   being assembled for it.

Close: NVIDIA's models, toolkit and sandbox; SUSE's packaging, lifecycle and support. Add
the status caveat even here — *the sandbox layer runs today, the agent layer is designed* —
because it is one sentence and leaving it out is the one thing that would make the rest
worthless.

---

## Appendix C — Do not say

- **"Customers are running this."** Nobody is. There is no deployment.
- **"Benchmarked", "measured", "tested".** The timings on figure 5 are illustrative and
  internally consistent. The only measured number in the whole deck is Anthropic's ~15×
  token multiplier, and it is theirs, not ours.
- **Specific MTTR percentages or ROI figures.** The arXiv paper's enterprise ROI numbers are
  secondhand; cite them as claims if you must, never as results. Better: don't.
- **"Nemotron-H".** That is the older research line. The models here are Nemotron 3 Ultra,
  Nemotron 3.5 Lightning and Nemotron 3 Embed 1B.
- **A parameter count for Nemotron 3 Super.** It is reported inconsistently. Ultra is
  550B-A55B and Lightning is 30B-A3B; leave Super unquantified.
- **"RAPIDS".** It is CUDA-X Data Science now.
- **"Supported" about AI-Q on OpenShell on Kubernetes.** It is not, and slide 8 says so
  first.
