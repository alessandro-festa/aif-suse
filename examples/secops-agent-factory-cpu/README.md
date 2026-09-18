# SecOps Agent Factory — the zero-GPU profile

A CPU-only sibling of [`../secops-agent-factory/`](../secops-agent-factory/), sized for a cluster
that has no GPUs at all. Same architecture
([`docs/architecture/sovereign-agentic-secops.md`](../../docs/architecture/sovereign-agentic-secops.md)),
every model replaced, and the agent topology **inverted rather than collapsed**: instead of eight
agents sharing one pod and two in sandboxes, every agent runs in its own sandbox under its own
policy.

The GPU profile's floor is ~12 GPUs and ~1.3 TB of PVC. This one is **0 GPUs, ~9 GB of RAM and
21 Gi of PVC**, and it was authored against `downstream-1` — three arm64 kind nodes on a 22.8 GiB
podman VM with no swap.

Unlike the parent, **this one has been installed and run.** Triage, both researchers and the
clarifier have executed on the cluster, against the live corpus, and the run reaches human gate #1
with a plan issue waiting in Gitea. The ledger below says exactly how far each claim got — including
the five bugs the live runs found, which are the most useful thing in this file.

---

## Why a whole second profile, rather than smaller numbers

Not because the models are too big. **No NVIDIA image in the GPU blueprints can execute on this
cluster at all**: `nvcr.io/nvidia/blueprint/aiq-agent:2.2.1` is a single `linux/amd64` manifest, and
so is every NIM. On arm64 those pods do not run slowly, they do not run. Substitution was forced,
not chosen.

| | GPU profile | here |
|---|---|---|
| Orchestrator model | Nemotron Ultra 550B-A55B, `nvidia.com/gpu: 8`, 900Gi | Qwen3-4B-Instruct Q4_K_M on llama.cpp, ~5.0 GB RSS |
| Worker model | Nemotron Lightning ×2, 1 GPU each | the same server, `--parallel 2` |
| Embeddings | Nemotron 3 Embed NIM, 1 GPU, 50Gi | `nomic-embed-text-v1.5` GGUF, 768-dim, ~85 MB |
| Retrieval | NVIDIA RAG v2.6.0 + Elasticsearch + a reranker NIM | Qdrant + one ingest Job over a committed seed corpus |
| Agent plane | AI-Q: 8 agents in one pod + 2 sandboxes | 5 agent roles, **one sandbox and one policy each** |
| Guardrails | NeMo Guardrails | dropped — no arm64 CPU path |
| Human gates | `aiq2-web`, SUSE Observability | an in-cluster Gitea issue + PR, Qdrant's dashboard, a status page |
| Flywheel | NeMo Data Store / Evaluator / Customizer | dropped |
| SUSE Security | assumed present, never run | **installed on both clusters and actually called** |

The one thing this profile has that the parent does not is a live oracle: SUSE Security is
installed here, its REST API is real, and the validation agent's rescan is a genuine second opinion
rather than a described one.

---

## Six agents, six policies

| Agent | Class (§3) | Its sandbox policy grants | Provider injected at the egress boundary |
|---|---|---|---|
| **survey** | Support | SUSE Security `POST`+`GET /v1/vulasset`, forge: **one** issue, no git | `suse-security`, `git-forge` |
| **triage** | Support / Worker | SUSE Security read, **Application Collection `tags/list`**, corpus read | `suse-security`, `app-collection` |
| **researcher** (run twice, in parallel) | Worker | corpus read, CVE record read — **nothing else** | none |
| **clarifier** — the plan gate | Service | forge: open an issue, read its labels, CVE record read. **Cannot touch a branch** | `git-forge` |
| **remediation** | Worker | forge write, corpus read | `git-forge` |
| **validation** | Service | SUSE Security `POST /v1/scan/repository`, registry read, forge comment | `suse-security`, `git-forge` |

Six sandboxes and six policies, but since 0.3.4 only **five of them run a model**. Remediation,
canary, deploy and post-apply rescan run their helper directly in the sandbox instead — same image,
same policy, same injected credential, just `bash -lc` where `opencode` used to be. The first three
of those changed for a mechanical reason (opencode's bash tool kills any command at 120s and the
setting is not exposed); remediation changed because it was caught lying. See
[the note on step 7](#step-7-runs-the-helper-not-the-model) below.

Dropped from §3, and worth saying plainly: the **source router**, the **writer / citation
verifier** (folded into the researchers) and the **guardrail agent**.

Splitting one policy into six is the entire point. On GPU, eight agents share one pod and one
NetworkPolicy, so "least privilege per agent" is an assertion. Here the researcher *physically
cannot* reach SUSE Security, the validation agent *physically cannot* push to the forge, and the
clarifier *cannot* create a branch — and each of those is provable in a live terminal. See
[Isolation proof](#isolation-proof) below.

**The survey/triage split is the newest of these and the most deliberate.** Survey can read the
whole finding set and publish one issue; it holds no catalogue credential, so it cannot propose a
replacement image. Triage holds the catalogue credential but runs only after a human has narrowed
the question to one image, and it cannot write to the forge at all. Remediation, which does write,
holds neither — it is handed a target version, quoted, rather than being in a position to invent
one. Three agents, three different partial views, and no single sandbox from which the whole
"find a CVE → pick a replacement → push it" chain can be driven.

**The CVE record lookup, and what it costs.** Added in 0.3.3. The researcher's corpus is a
handful of seeded advisories, so a CVE it has never heard of leaves a 4B model with nothing —
and what it does with nothing is invent a citation, which it did on a live run (`Cites:
doc-123,doc-456`, resolving to nothing). In a demo whose entire premise is that you can check
what the agent claims, that is the worst defect available. So the researcher and the clarifier
may now `GET https://cveawg.mitre.org/api/cve/<id>` through the `cve` helper, which prints the
record and the `https://www.cve.org/CVERecord?id=<id>` URL the reviewer opens.

Be clear about the trade: **this is the second public host in the profile** (the first is
`dp.apps.rancher.io`, in `triage.yaml` alone), and every claim here about the demo needing no
internet is now conditional on it. Unlike the catalogue it carries **no credential** — GET-only,
one path, no `credential_binding`, so there is no secret to spend against it. Set
`cveLookup.enabled: false` in the agents chart to remove the endpoint from both policies; the
helper still ships and reports the refusal as a configuration decision rather than an outage,
which is the "gate the fence, not the packaging" pattern used for the deploy agent. It is also
not a substitute for the scanner: SUSE Security carries the per-distro `fixed_version` that
decides the remediation, and cve.org does not.

Three implementation notes that deviate from the obvious design, all deliberate:

- **Handoff goes through the orchestrator, not a shared filesystem.** Upstream's
  `multi-agent-notepad` pattern needs RWX; `downstream-1` has one StorageClass, `standard`
  (`rancher.io/local-path`), and it is **RWO**. The orchestrator collects each agent's stdout and
  passes it into the next agent's prompt. That is strictly tighter — no two agents ever see the same
  mutable surface.
- **Six agents does not mean six concurrent pods.** The orchestrator creates a sandbox, runs its
  agent, collects the result and deletes it. Only the two researchers overlap. That is what makes
  the memory budget fit.
- **The orchestrator holds every credential and sits outside every sandbox.** It is the one
  component with the gateway mTLS material and the forge token, which is what preserves §3's "the
  agents have no access to the plane that governs them".

**The one Kubernetes permission the orchestrator has, and why it is not the agent's.** Since 0.3.5
the canary Deployment is not furniture: the orchestrator creates it in `ns-demo-web` when the
canary step starts, and deletes it when the run ends. It holds exactly one Role for this
(`charts/secops-cpu-agents/templates/rbac.yaml`) — `create`, `delete`, `get`, `list`, `watch` on
Deployments, in that one namespace, with **no `patch` and no `update`**.

The split is the point. A `POST` to `/namespaces/<ns>/deployments` carries no name: the name is in
the body, and the L7 proxy allow-lists methods and paths, so it cannot see it. "The agent may
create the canary" is therefore unavoidably "the agent may create any pod here, with any image" —
an escape by a route no egress rule watches. So the harness brings the object into existence and
takes it away again; setting the image and the replica count stays with the agent, under the
agent's policy, pinned to one object by name. Neither side can do the other's half, which is what
makes the canary verdict worth reading.

It used to be seeded by hand at `replicas: 0` and left between runs, which avoided the same
problem by never creating anything. It also meant the demo's starting state included a stale
Deployment nobody looked at, and a killed run left it running. The correct starting state is now
that it does not exist; `reset-demo.sh` deletes any leftover.

**Which CLI runs inside the sandbox:** `opencode`, from the five the `openclaw-suse` image ships.
It is OpenAI-shaped — matching both llama.cpp and the OpenShell router, which speaks
`openai_chat_completions` only — and has a headless `run` mode. `claude` is ruled out by protocol:
there is no Anthropic `/v1/messages` route in the router.

---

## The three human gates

§7 of the architecture document says changes reach the cluster "through a reviewed pull request and
GitOps, never through an agent holding a kubeconfig", and that "a policy that lets the agent approve
its own change quietly deletes the reviewer". This profile is the first place in the repository
where that is executable rather than described, because the forge runs **in the cluster**:

0. **Selection gate — and it is the only one that is not a yes/no.** The survey agent posts the
   ranked list of every vulnerable image in the cluster as a Gitea issue, numbered, and is
   explicitly forbidden from recommending one. A person replies with a comment containing just a
   number (or a full image reference, for something off the list) and that is what the rest of the
   run is about. Nothing before this point knows the subject of the run.

   Why the machine declines to choose: ranking by severity count is arithmetic, and `nv-survey`
   does that honestly. Deciding that 17 criticals on `kube-proxy` matter less than 4 on the image
   your customers actually touch is judgement about *this* cluster, and the model does not have it.
   Offering a recommendation anyway would be the most consequential unearned assertion in the whole
   pipeline, because it is the one a busy reviewer would rubber-stamp.

   The orchestrator reads the first comment that is a bare integer **and is not authored by
   `secops-bot`**. That exclusion is load-bearing: the orchestrator posts into the same issue when
   the agent fails to, and a bot reading back its own message would turn the gate into a rubber
   stamp with no outward sign — the run would simply proceed, which is exactly what a broken gate
   looks like from outside.
1. **Plan gate.** The clarifier opens a Gitea **issue** with the proposed remediation and its
   citations, then stops. The orchestrator polls for the label `approved` or `rejected` and creates
   **no remediation sandbox** until a person applies one. Timeout 30 minutes — a "something is
   wrong" bound, not a service level.

   **A gate can only approve what the next step can execute, and until 0.3.6 nothing checked
   that.** `forge-remediate` reads the change out of the approved issue by matching a line of
   exactly the form `Change: <old-image> -> <new-image>`; `plan-issue` writes one. But the
   orchestrator will post the issue itself when the clarifier produces the plan without filing it,
   and on 2026-09-18 what it posted was the clarifier's answer — the `plan-issue` command line,
   quoted, with every argument correct and no `Change:` line anywhere in it. It read like a plan.
   A person approved it. The remediation agent then refused in ten seconds, correctly, and the run
   was over. Every component did its job and the run still died, because the contract between the
   plan and its consumer was first tested *after* the one step that cannot be retried cheaply.

   So the orchestrator now runs that same match against the issue as the forge stores it, before it
   posts the gate instructions, and folds a warning into the same comment when it fails: this plan
   cannot be executed, here is the line it needs, reject it or add the line and then approve. The
   body is read when the remediation agent runs, so a repair made at the gate is one it will see.
   The check is deliberately not a veto — it does not stop the run or discard twenty minutes of CPU
   inference. It just refuses to let a person approve something on the quiet understanding that it
   will work.
2. **Change gate.** The remediation step opens a **pull request**; the canary comments the pre/post
   scan diff. A person merges or closes. **The agent cannot merge its own PR** — enforced by a
   branch-protection rule created during the seed, not by anything of ours.

   **The pull request opens before the canary runs, and says so.** For the minutes in between, the
   artefact in front of the reviewer is complete, plausible and entirely unmeasured — every argument
   for the change is on it and no evidence is. So `forge-remediate` writes **DO NOT MERGE YET** at the
   top of every pull request it opens, and `cluster-canary` lifts it by name when it appends the
   comparison. Branch protection cannot express "not yet" — it knows *who* may merge, not *when* — so
   the hold lives where the reviewer is actually looking. If the canary reports `ERROR` or
   `UNSCANNED`, or never comments at all, the hold simply stands.

Running the forge in-cluster is also what makes the sovereignty claim literal: there is nowhere
outside the cluster for the token to go, and the whole demo runs with no internet.

### Step 7 runs the helper, not the model

Remediation is the one step that was demoted from an agent to a command, and the reason is worth
keeping because it is the failure this whole profile is built to make impossible.

The step's task had already been reduced as far as a task goes: four commands — clone, find, swap,
open the PR — collapsed into `forge-remediate <issue>`, a single helper taking a single integer. The
orchestrator already knows that integer. The model's entire contribution was to retype it.

On 2026-09-18 it did not do that either. It returned `PULL REQUEST #41 OPENED` — the exact line
`forge-remediate` prints on success — for a pull request that had never existed. Index 41 was never
allocated; no branch was ever pushed. The `sentinel` mechanism exists precisely to catch a model that
reports work it did not do, and it cannot catch this one: the string the sentinel checks for is the
string that was invented.

What caught it was the forge. The orchestrator asks the repository for a pull request opened since the
step began, got nothing, and parked. That was always correct — the gap was that the park message did
not say *what the agent had claimed*, leaving an operator to reconcile "PULL REQUEST #41 OPENED" on the
status page against "no pull request" in the log on their own.

Since 0.3.4 the step runs `bash -lc /sandbox/bin/forge-remediate <issue>` in the same sandbox, under the
same policy, with the same credential injected at the same egress boundary. stdout becomes the helper's
own stdout with nothing in between that could paraphrase or invent it, so the success line can only
appear if the helper reached its last line — and it only reaches its last line after the forge has
answered the POST. **Fabrication stops being something to detect and becomes something that cannot
happen.** The cost is one fewer model-driven agent on screen; the isolation claim is untouched, because
the fence was always on the sandbox rather than on opencode.

The same run produced the smaller version of the same defect: the plan issue cited
`https://corpus.suse.com/corpus/base-image-distro-cves`, a host that does not exist. Nothing in the
chart contains that string — the model had copied the `cve` helper's `cite this URL:` format onto the
one source that has no URL. `corpus` now prints its own citation form, and says in as many words that
the corpus has none. Making the honest form the one on screen beats explaining the distinction in a
briefing, which is the third time that lesson has been learned here.

| Question the human is asking | Surface |
|---|---|
| *What did SUSE Security find, and did the rescan clear it?* | Rancher → SUSE Security (`neuvector-ui-ext`, installed) |
| *Which SUSE-SU did the agent actually cite?* | Qdrant's built-in `/dashboard` — open the cited point, read the advisory |
| *Which container should we work on?* | Gitea: reply with a number on the survey issue |
| *Do I approve this plan? Do I accept this patch?* | Gitea: the issue, then the PR |
| *Which agent is where, and what did it decide?* | the orchestrator's read-only status page on `:8080` |

---

## What is verified, and what is not

| Claim | Status | How it was checked |
|---|---|---|
| Both Blueprint CRs are accepted by the API server | **verified** | `kubectl --context=kind-sims-datacenter apply --dry-run=server` — exercises the semver regex, the `source` enum, the `listMapKey=chartName` uniqueness constraint and the DNS-1123 limits |
| Both follow the operator's naming convention | **verified** | the `slug(displayName)-version` checks from `charts/aif-operator/tests/default-blueprints-convention.sh`, applied to this directory |
| The three AIWorkload CRs are schema-valid | **verified** | dry-run clean once their namespaces exist; against the real namespaces they fail only on `namespaces … not found`, which is a missing prerequisite |
| The three ClusterRepos are accepted | **verified** | same dry run |
| `charts/secops-cpu-inference`, `-knowledge`, `-agents` lint and render | **verified** | `helm lint` clean; 5 objects from the agents chart, no `nvidia.com/gpu` anywhere in any of them |
| The orchestrator's mounted payloads survive the ConfigMap round trip | **verified** | rendered `orchestrator.py` (23819 B), `status.html` (4370 B) and the policies are byte-identical to the chart files; the rendered Python compiles under `py_compile`; `agents.json` parses with all five agents |
| Every policy renders to valid YAML with no residual `{{` | **verified** | `helm template \| yq`, all hostnames resolved |
| Qwen3-4B-Instruct Q4_K_M clears the tool-calling gate on CPU | **verified** | **8/9 calls, p50 2.07 s, peak RSS 4.95 GB**, `-ngl 0 --device none`. Harness and raw JSON in [`spike/`](spike/RESULTS.md) |
| `--parallel 2` is nearly free | **verified** | 2 concurrent requests 6.78 s wall vs 6.07 s for one |
| `ghcr.io/ggml-org/llama.cpp:server` and `qdrant/qdrant` are arm64 | **verified** | registry manifest indexes |
| Gitea 12.7.0 renders on this profile's values, arm64 included | **verified** | `helm template` → 8 documents, no GPU references; image pinned to the multi-arch **index** digest `sha256:414ba5b2…` (`gitea:1.27.0-rootless`: arm64 + amd64 + riscv64) |
| SUSE Application Collection has no Gitea and no Forgejo | **verified** | a real absence, not an auth failure: `postgresql` and `milvus` resolve anonymously from `oci://dp.apps.rancher.io/charts` in the same session, while both forges return "unable to locate any tags" |
| The Gitea seed API shapes below | **verified against source, NOT RUN** | `CreateUserOption`, `AddCollaboratorOption`, `CreateAccessTokenOption` and `CreateBranchProtectionOption` read from go-gitea at tag `v1.27.0`; the token route is guarded by `reqSelfOrAdmin() + reqBasicOrRevProxyAuth()`, so admin basic auth can mint a token for another user |
| SUSE Security is installed on **both** clusters | **verified** | `neuvector` + `neuvector-crd` `110.0.1+up2.11.1` (core 5.6.1) on `sims-datacenter` and `downstream-1`; `neuvector-ui-ext` 2.2.1 on the primary |
| The REST API Service name is `neuvector-svc-controller-`**`api`** | **verified the hard way** | `neuvector-svc-controller` is the headless gossip Service on 18300/18301. The GPU profile's policy pointed at it; fixed there too |
| `openshell.openshell.svc.cluster.local` needs no extra SAN | **verified** | `DEFAULT_SERVER_SANS`, `OpenShell/crates/openshell-bootstrap/src/pki.rs:32` — provided the release is named `openshell` in namespace `openshell` |
| `sandboxImagePullPolicy` is driver-level, not per-image | **verified** | `crates/openshell-driver-kubernetes/src/main.rs:45,100`. This is the **only** delta between gateway blueprint 0.2.1 and 0.2.2 |
| The federation join between the two SUSE Security installs | **NOT DONE** | a UI handshake: promote the primary, copy the token, join from downstream-1. See [`integrations/suse-security/README.md`](integrations/suse-security/README.md) |
| The three charts exist in `oci://ghcr.io/alessandro-festa/charts` | **verified** | all three pushed at 0.1.0 — `secops-cpu-inference` `sha256:300f7bc3…`, `-knowledge` `sha256:46e81976…`, `-agents` `sha256:5c6c7f33…` |
| The orchestrator image | **verified** | built and pushed as `ghcr.io/alessandro-festa/secops-cpu-orchestrator:0.1.0`, digest `sha256:df1c3bf4…`, linux/arm64, and pinned by that digest in the chart. Inside it, as uid 65532: `openshell --version` is 0.0.116 (the version `orchestrator.py` asserts at runtime), `ldd` says "not a dynamic executable" — the musl-static claim checked rather than trusted — `XDG_CONFIG_HOME` is writable, the mounted `orchestrator.py` compiles, and it imports **nothing outside the standard library** |
| The chart and orchestrator ghcr packages are publicly pullable | **verified** | all four made public by hand in the package settings — GitHub exposes no API for this. The HelmOp pulls the charts and the kubelet pulls the image with no `clientSecretName` and no pull secret |
| `openclaw-suse` is `linux/arm64` and its CLIs run | **verified** | built natively on an Apple Silicon host — **not** by the fork's workflow, which sets no `platforms:` and no QEMU — and pushed to `ghcr.io/alessandro-festa/openshell-community/sandboxes/openclaw-suse` as `v0.1.0` and `latest`, digest `sha256:2d817c37…`. Inside it: `uname -m` = aarch64, `opencode` 1.2.18, `openclaw` 2026.5.18, `codex` 0.117.0, `copilot` 1.0.16, `claude` 2.1.145, node 22.22.0, Python 3.13.12 |
| The ghcr sandbox package is publicly pullable | **verified** | the package was made public; an anonymous `ghcr.io/token` bearer fetches the manifest with HTTP 200. So `server.sandboxImagePullSecrets` stays commented out in blueprint 10 |
| The `sandboxes/suse` base it is built on is arm64 | **verified** | the `latest` already on ghcr is an OCI index carrying exactly one platform, `linux/arm64` |
| Agent-sandbox CRDs on downstream-1 | **verified** | applied from the v1.0.0 release; the controller is Running and the gateway creates sandboxes through it |
| The whole stack installs from the Blueprints | **verified** | three AIWorkloads → HelmOps in `fleet-default` → llama.cpp, the embedding server, Qdrant, the ingest Job, Gitea and the orchestrator all Ready on downstream-1 |
| Agents actually call their tools and answer from real data | **verified, after a prompt fix** | triage and both researchers return corpus-derived content — `log4j`, fixed version `2.17.1`, and the shaded-JAR caveat from the runbook. See "What the first live run broke" |
| The clarifier opens the plan issue in Gitea | **verified** | issue #2, then #3 on the re-run, each with the citations and the proposed change |
| The run reaches human gate #1 and stops there | **verified** | the orchestrator parks on the unlabelled issue and creates no remediation sandbox |
| Remediation and validation | **NOT RUN** | never reached in a run yet. The git push they depend on is verified separately, one row down |
| Git-over-HTTP push works with the header the proxy injects | **verified** | the `git-forge` provider uses `auth_style: bearer`, and git HTTP conventionally wants Basic. Gitea accepts both: `GET /secops/cluster-manifests/info/refs?service=git-receive-pack` returns **200** with `Authorization: Bearer <token>` and with `token <token>`, and **401** with neither |
| Sandboxes reach SUSE Security | **verified via the TLS shim** | not directly — see "SUSE Security and the TLS shim" below. The direct path is blocked by certificate verification in OpenShell's L7 proxy, with no escape hatch |

---

## What the first live run broke

Five defects, none of which any amount of `helm template` would have found. They are recorded
because each one is a property of running a **4B** model in a **sandbox** under a **policy**, and
anyone porting this profile to another small model will meet all four.

**1. The agents refused to act.** Every one of the five answered some variant of *"I cannot confirm
that information"* without calling a single tool. The cause was one clause in the shared system
prompt: *"use the bash tool when you need to"*. A frontier model reads that as an instruction; a 4B
model reads it as permission, and declining is always the cheaper branch. The fix is in
`charts/secops-cpu-agents/values.yaml`: the prompt now says the tools **are** the answer — *"Always
run those commands first and answer only from their output. Never answer that data is unavailable
before you have run them and seen them fail"* — and each agent carries a `briefing` with the literal
`curl` and `git` command lines its policy permits. The briefings are not convenience. **A model this
size will not derive a working request from an API description**, and the set of commands that a
policy allows is knowable at template time, so it is stated rather than discovered.

**2. The clarifier printed its issue instead of posting it.** It produced correct JSON and put it on
stdout. Fixed on both sides, deliberately: the briefing now opens with *"RUN THE COMMAND BELOW WITH
YOUR BASH TOOL"* and uses a single-line `-d` rather than a heredoc (which the model mangled), **and**
the orchestrator now parses an issue out of the agent's output and posts it itself, adding a trailer
saying it did so. Belt and braces, because the alternative is a run that does 20 minutes of correct
work and then loses it at the last step.

**3. …and losing it is exactly what used to happen.** When no issue appeared, `main()` did `return 1`.
The container exited, Kubernetes restarted it, the new process found an empty `RUN` and started over
— so a transient failure at minute 20 became a crash loop that also destroyed the record of the
nineteen minutes that worked. `orchestrator.py` now obeys one rule, written at the top of `_park()`:
*once the status page is up, nothing below it may exit.* Every terminal path — a rejected plan, a
completed run, an unhandled exception — calls `_park(reason)`, which records the reason, logs it and
sleeps forever. `serve_status()` is started before `main()`, and `main()` runs inside a bare
`except Exception` that parks with the last traceback line as the verdict. Re-running is a
`kubectl rollout restart`, which is explicit.

**4. `credential_binding` is substitution, not injection — and every briefing had it backwards.**
The clarifier's `POST /issues` came back `401 token is required`, and its issue body is a small
essay about how the network boundary must be misconfigured. It was not. The mental model in the
briefings — *"your token is added by the network boundary, so send no auth header"* — is wrong.
What actually happens is:

```
$ echo $GITEA_TOKEN
openshell:resolve:env:v72440861617211144_GITEA_TOKEN
```

The sandbox environment holds an opaque **handle**. The agent must put that handle in the header
itself, and the L7 proxy swaps in the real secret on the way out, only for the endpoint the binding
names. Send no header and there is nothing to substitute, so the request goes out unauthenticated.
The sovereignty property is unchanged — the sandbox never holds the secret, and a handle used
against any other destination is rejected with `credential_endpoint_mismatch` — but the briefings
had to be inverted. They now say, explicitly, `-H "Authorization: Bearer ${GITEA_TOKEN}"` and
`-H "X-Auth-Apikey: ${NEUVECTOR_API_KEY}"`.

Measured, in a sandbox running the clarifier's own policy:

| Request | Result |
|---|---|
| `POST /api/v1/.../issues`, no auth header | **401** `token is required` |
| the same, `-H "Authorization: Bearer ${GITEA_TOKEN}"` | **201** Created |
| `git -c http.extraHeader="Authorization: Bearer ${GITEA_TOKEN}" clone` | **clone OK** |

The `GET` that misled us early: `GET /api/v1/repos/secops/cluster-manifests` returns 200 with no
credential at all, because the repository is public. **Do not test credential injection against a
readable endpoint.** The remediation briefing now uses `git config http.extraHeader` rather than a
credential in the URL, which also keeps the handle out of `.git/config` remotes and out of reflog.

**5. llama.cpp was OOMKilled mid-run, three times.** `-c 16384 --parallel 2` against a 8Gi limit:
Qwen3-4B needs ~144 KiB per token of KV cache, `-c` is the **total** budget split across slots, and
the measured peak was `memory.peak 8540913664` — 8.54 GB against an 8.0 GB ceiling, anonymous
alone 6.49 GB. The chart now defaults to `-c 8192 --parallel 1`. Raising the limit instead is the
worse trade on this host: the VM has 22.8 GiB and no swap shared between two kind clusters, so the
kill simply moves to whichever pod asks next. Losing the parallel researcher slot costs wall-clock
only — they now queue, at roughly 260 s each.

**6. Every run reported zero SUSE Security findings, and the scanner was right.** Two independent
causes, hours apart, both of which present identically as "the cluster is clean":

- **NeuVector auto-scan defaults to OFF.** `GET /v1/scan/config` returned `{"config":{"auto_scan":
  false}}` and `scanned_containers: 0`. Nothing had ever been scanned, so every finding query was
  correctly empty. One PATCH fixed it — see Prerequisites — and the scanner then produced **610
  records, 40 critical, across 22 images** on an idle laptop cluster.
- **`/v1/vulasset` is two calls, not one.** `POST /v1/vulasset {}` registers a server-side query and
  returns `query_id`, `total_matched_records` and a severity histogram — **and zero rows**. The rows
  come from `GET /v1/vulasset?token=<query_id>&start=0&row=200`, and a bare GET without the token is
  answered `400 no query token provided`. Grant one half and you get a plausible, empty answer. Both
  halves are now allowed in `survey.yaml` and `triage.yaml`, each with a comment saying why.

**7. The seeded finding was the worst thing in the pipeline, and it flattered us for weeks.** The
run used to begin with a CVE id from `values.yaml` and a prompt asking triage to *confirm* it. On
the scanner above — the one returning nothing at all — triage answered *"CVE-2021-44228 is confirmed
in the cluster… critical severity."* It was not lying about a lookup; it was answering the question
it was asked, which was "agree with this." `SEED_FINDING` is deleted. The run now opens with a
**survey** agent that asks the scanner what is actually there, and if the scanner has nothing, the
run says so.

**8. The agent said a tool was missing, and the tool was there.** *"The command `forge` is not
available in the environment"* — while the orchestrator log showed `/sandbox/bin/forge` written and
`chmod 0755`'d in that sandbox, seconds earlier. The model had tried the bare word, not the path.
Two changes, both cheap: every briefing now names tools as `/sandbox/bin/forge`, absolute, and the
shared system prompt says that if a command looks missing the agent must run `ls -l /sandbox/bin`
and quote the output before concluding anything. A 4B model asserting an absence is not evidence of
one.

---

## SUSE Security and the TLS shim

**The agents do not reach the SUSE Security controller directly, and on this cluster they cannot.**

NeuVector serves its REST API over TLS with a self-signed certificate carrying no service SANs.
OpenShell's L7 proxy verifies every upstream certificate against webpki-roots plus whatever CA
bundle it finds in the sandbox image (`crates/openshell-sandbox/src/l7/tls.rs`,
`build_upstream_client_config`), and there is **no escape hatch**: no `insecure` or `ca_cert` field
exists on a policy endpoint in `crates/openshell-policy/src/lib.rs`, and a CA cannot be mounted in
either, because sandbox volumes support only `persistent_volume_claim`. From inside a sandbox the
symptom is misleading: `NET:OPEN ALLOWED` immediately followed by `NET:FAIL` and
`curl: (35) Connection reset by peer` — a TLS failure that reads exactly like a policy denial.

Three ways out, and the one we did not take is the interesting one:

| | |
|---|---|
| Bake the CA into the sandbox image | works, and makes a published image specific to one cluster's PKI |
| `tls: skip` + `allow_uninspected_credentials: true` | **refused.** It stops the proxy inspecting the stream, so the proxy can no longer inject the API key, so the real key has to be handed to the sandbox — destroying the one property this whole profile exists to demonstrate |
| A TLS terminator shim | taken |

`secops-cpu-nv-shim` is ~110 lines of stdlib asyncio (`charts/secops-cpu-agents/files/tls-shim.py`)
on the orchestrator image. Plain HTTP in on 10443 — deliberately the same port number as the
controller's, so the policies and briefings read like the real endpoint — TLS out to NeuVector with
verification off. It is a **byte relay**: it parses nothing, so there is nothing in it to get wrong
about a request, and keep-alive and chunked encoding work because neither is understood.

What is preserved: the L7 proxy still parses every request, still enforces the method and path allow
list — including the `POST /v1/policy/rule` denial that is the demo — and still injects the API key
at the egress boundary. **The shim never sees a credential it holds**; the key is added on the
sandbox side and passes straight through, which is why there is no Secret anywhere in
`templates/tls-shim.yaml`.

What is given up, stated rather than buried: the hop from the shim to the controller is encrypted
but **unauthenticated**. A man in the middle inside the cluster network could impersonate the
controller to the shim. On a cluster whose NeuVector presents a certificate the sandbox image can
verify, set `suseSecurity.tlsShim.enabled: false` — every consumer goes through the `nvHost` /
`nvPort` / `nvScheme` helpers, so that one value is the only change needed.

---

## Layout

| File | What it is |
|---|---|
| `00-clusterrepos.yaml` | Three ClusterRepos: our charts on ghcr, OpenShell, Gitea. Applied to **sims-datacenter** — see its header |
| `10-blueprint-openshell-gateway.yaml` | OpenShell gateway **0.2.2** — `examples/openshell/`'s 0.2.1 with a registry sandbox image |
| `20-blueprint-secops-cpu.yaml` | The stack: CPU inference, the corpus, the agent plane, and Gitea. Four components |
| `30-aiworkloads.yaml` | The install set, `targetClusters: ["c-jhrj6"]`. Do not apply as one unit |
| `policies/README.md` | A pointer. **The five policies live in `charts/secops-cpu-agents/files/policies/`**, because they must reach the pod as a ConfigMap and two of their hostnames are Helm-templated |
| `integrations/gitea/values.yaml` | A **reference copy** of the Gitea values, annotated. The installing values are inline in blueprint 20, because a Blueprint component cannot point at a file |
| `integrations/suse-security/` | The two-cluster federation: primary and managed values, install, join, verify — and why `admin`/`admin` does not work |
| `orchestrator-image/Containerfile` | Specification for the orchestrator image. **Not built** |
| `spike/` | The model gate from step 1a: harness, raw JSON, `RESULTS.md` |

There is deliberately **no workspace blueprint here**. `examples/openshell/20-blueprint-openshell-workspace.yaml`
pins nothing namespace-specific — the tenant namespace comes from the AIWorkload — so a copy would
be byte-identical, and the copy that drifts is the one somebody reads. The gateway blueprint *is*
copied, for the one delta named in the ledger.

The three charts are in [`charts/`](../../charts/), not here: `secops-cpu-inference`,
`secops-cpu-knowledge`, `secops-cpu-agents`.

---

## Prerequisites

### On the host

MemAvailable is ~14.9 GB with **no swap**, so overcommit is an OOM kill rather than a slowdown. The
budget is llama.cpp ~6 GB, embeddings ~0.5, Qdrant ~0.5, Gitea ~0.4, gateway ~0.3, orchestrator ~0.2
and at most three sandboxes alive at once ~1.2 → **~9.1 GB**. Thin, and it now carries two SUSE
Security installs rather than one, so measure rather than assume:

```sh
podman machine ssh 'grep MemAvailable /proc/meminfo'      # want >= 12 GB
```

If it is short: drop the stale empty namespaces `ollama-system` and
`simple-chatbot-with-rag-system`, or grow the VM —
`podman machine stop && podman machine set --memory 28672 && podman machine start`, then restart
both kind clusters.

### On downstream-1

```sh
# Agent-sandbox CRDs and controller. NOT a Blueprint component: agent-sandbox
# ships raw YAML, and Blueprint components are chart-only.
kubectl --context=kind-downstream-1 apply -f \
  https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.0/sandbox-with-extensions.yaml

# Namespaces. The sandbox namespace MUST carry the label the gateway watches --
# a missing label surfaces as "sandbox create failed" with no mention of labels.
for ns in openshell ns-secops-sandboxes ns-secops-cpu ns-secops-forge; do
  kubectl --context=kind-downstream-1 create namespace $ns
done
kubectl --context=kind-downstream-1 label namespace ns-secops-sandboxes \
  ai-factory.suse.com/openshell-workspace=true

# Gitea's admin credentials. Created BEFORE the chart installs; the chart
# otherwise ships `password: r8sA8CPHD9!bt6d` in plain text. It reads exactly
# two keys.
kubectl --context=kind-downstream-1 -n ns-secops-forge create secret generic gitea-admin-secret \
  --from-literal=username=gitea_admin \
  --from-literal=password="$(openssl rand -base64 24)"
```

Two more Secrets are created later, because they do not exist yet at this point:

- **`openshell-client-tls`** in `ns-secops-cpu` — copied from the gateway's namespace once the
  gateway's PKI job has run.
- **`secops-gitea-token`** in `ns-secops-cpu` — the `secops-bot` token, which cannot be minted until
  Gitea is up and seeded.

The orchestrator **CrashLoopBackOffs until both exist**. That is expected and is not a symptom of
anything else.

### Turn the scanner on — this is not optional, and it used to fail silently

**NeuVector's auto-scan defaults to OFF**, and there are two independent NeuVector installs
here, one per kind cluster, never federated. Only `downstream-1`'s is in the pipeline's path,
so any statement about scanner settings has to name a cluster.

With auto-scan off, every finding query returns an empty set and the API answers 200 while it
does it. The survey agent then reports a flawless estate and the run ends with "no
vulnerabilities found" — the most convincing wrong answer in this whole profile.

**Since 0.3.3 you do not pre-flight this with curl. Step 1 reports it.** `nv-survey` opens its
ranked table with the three lines that settle it:

```
SUSE Security: https://secops-cpu-nv-shim.ns-secops-cpu.svc.cluster.local:10443
auto-scan (containers): true
registered scanners: 1  CVEDB 2026.09.14
```

If `auto-scan (containers)` reads `false`, the helper says so in a banner and every count below
it is meaningless. If the first line names a controller you did not expect, that is the answer
to a different question you were about to waste an afternoon on.

**And in 0.3.5 that banner lied, because it read the wrong field.** NeuVector 5.4.3 split the
single `auto_scan` boolean into `enable_auto_scan_workload` and `enable_auto_scan_host`, and
kept the old key for backward compatibility as a plain bool that the new settings do not write
(`neuvector/controller/api/apis.go`, `RESTScanConfig`). On the 5.6.1 controller here it
marshals as `false` while workload auto-scan is on in the UI — so the survey issue carried a
bold instruction to stop, about a scanner that was working. Since 0.3.6 `nv-survey` prefers
`enable_auto_scan_workload` and falls back to `auto_scan` only for a pre-5.4.3 controller. If
you are reading the API by hand, read the same field: a deprecated key that still returns 200
is the most expensive kind of wrong.

**Since 0.3.5 you read those three lines on the survey issue itself, above the menu** — and this
is the part that was broken for two releases. The survey agent is stopped the instant the issue
appears in the forge, so its stdout is thrown away and the status page shows a placeholder in
its place; the header was being printed into a transcript nobody reads. `survey-issue` now
copies it into the issue body as a short bullet list, so the provenance arrives on the same
screen as the choice it qualifies, at the moment a human is being asked to trust the counts. The
auto-scan-off banner comes with it, in bold, above the menu.

The menu parse is unaffected: `_survey_options` only accepts a line whose number is followed by
something carrying a `/` or a `:`, and no line in that header begins with a number.

That header is also why a **rescan that fails no longer looks like a clean image.** Every
single-image call ends in exactly one `status:` line — `SCANNED`, `NOT-SCANNED`, or
`ERROR <kind>` where kind is one of `AUTH`, `POLICY-DENIED`, `UNREACHABLE`, `NOT-JSON`,
`HTTP-<code>` or `NO-QUERY-ID`. Before that contract existed all six collapsed into one empty
string, and the canary and post-apply steps rendered every one of them as "unscanned". That is
fail-safe in outcome and undiagnosable in practice, and it cost a full live run on 2026-09-17.

To set auto-scan, if it is off, use the NeuVector UI on `downstream-1` (reach it through
Rancher) or `PATCH /v1/scan/config` **from your own workstation** — not from a sandbox. Give it
a few minutes, then confirm there is something to survey:

```sh
curl -sX POST "$NV/v1/vulasset" -H "X-Auth-Apikey: $KEY" \
     -H 'content-type: application/json' -d '{}' | head -c 300
#   {"query_id":"…","total_matched_records":610,"summary":{…}}
```

On this cluster that produced **610 records, 40 critical, across 22 images**, ranked
kube-proxy (17 critical) → coredns (13) → kube-apiserver / controller-manager / scheduler (12 each)
→ etcd (12) → local-path-provisioner (11) → qdrant (10).

The agents may now **read** this setting — `GET /v1/scan/config` is allowed in `survey.yaml`,
`triage.yaml`, `validation.yaml` and `canary.yaml`, which is what lets the header above exist.
No agent may change it: `PATCH /v1/scan/config` is in the deny list of all four, because an
agent that can switch the scanner off can make any finding disappear.

**Auto-scan being on is not a promise that it will get there in time — so since 0.3.5 the scan is
asked for.** On 2026-09-18 the canary came up Ready on the AppCo image, polled the full 600s, and
SUSE Security reported nothing for it. Key working, shim up, auto-scan on, and the status contract
above said so: `NOT-SCANNED`, not `AUTH`, not `UNREACHABLE`. Auto-scan simply never reached the new
container, and nothing in the pipeline had ever asked it to.

`nv-survey --scan <image>` now does the asking. It resolves the image to the **running containers**
serving it (`GET /v1/workload?brief=true`, whose pods carry their containers under `children`) and
queues a scan for each (`POST /v1/scan/workload/<container-id>`). Both the canary step and the
post-apply rescan call it before their poll, and again every two minutes while polling — a pod that
restarts comes back with a new container id, and a request naming the old one is discarded without
a word.

The request is not a result. It is asynchronous, the poll is unchanged, and an empty answer is
still refused as `UNSCANNED`. What it buys is on the pull request: the comment now quotes the
trigger's own reply, so a timeout reads either `TRIGGERED` — asked, accepted, did not finish, check
`GET /v1/scan/status` for a queue — or `NO-WORKLOAD`, meaning the scanner can see no running
container for that image at all, which is a cluster problem and not an image one.

Two verbs were added to `canary.yaml` and `validation.yaml` for it, `GET /v1/workload` and
`POST /v1/scan/workload/**`. Both are additive and neither is a write to the scanner's
configuration: an agent may ask for a scan and may not change what scanning means.
`PATCH /v1/scan/config` stays denied.

### On sims-datacenter

Nothing new: the Rancher local cluster already runs the aif-operator and SUSE Security. The
ClusterRepos, Blueprints and AIWorkloads all go **here**, not downstream — the operator resolves a
ClusterRepo with its own client (`resolveClusterRepo`,
`operator/internal/controller/aiworkload/blueprint.go:1099` → `r.Get`), and `targetClusters` is what
sends the HelmOp to `downstream-1`.

---

## Install order

Apply one document at a time and wait for Ready. The ordering is not cosmetic: sandbox
configuration is validated at first use, not at startup, so installing the agent plane before the
gateway gives you a system that looks healthy and fails on the first sandbox.

1. **The charts and images are already published** — step 1 is only needed after a change:
   ```sh
   for c in secops-cpu-inference secops-cpu-knowledge secops-cpu-agents; do
     v=$(yq '.version' charts/$c/Chart.yaml)
     helm package charts/$c -d /tmp/charts
     helm push /tmp/charts/$c-$v.tgz oci://ghcr.io/alessandro-festa/charts
   done
   ```
   Read the version out of `Chart.yaml` rather than hard-coding it — the three charts drift apart
   (they are at `-inference` 0.1.1, `-knowledge` 0.1.3, `-agents` 0.1.4 today), and a `sed` over the
   Blueprint that is not scoped to one line will happily bump all three to whichever one you meant.
   **Bump the chart version on every push.** `perHelmOpRenderDigest` hashes the `chartVersion`, not
   the content, so re-pushing `0.1.0` with a fix is a silent no-op: Fleet sees the same digest and
   never re-renders.

   Both images are built **locally on an arm64 host and pushed by hand**, not by a CI workflow.
   That is deliberate: the fork's GitHub workflow builds amd64 only, and adding QEMU to it to
   cross-build five native npm CLIs is a larger and less reliable change than a native build on the
   machine that is already arm64.
2. Make the four ghcr packages public, or the pull fails — see the ledger row. The sandbox and base
   images are already public.
3. `kubectl --context=kind-sims-datacenter apply -f 00-clusterrepos.yaml`
4. The prerequisites above, on downstream-1.
5. `10-blueprint-openshell-gateway.yaml`, then `../openshell/20-blueprint-openshell-workspace.yaml`,
   then document 1 and document 2 of `30-aiworkloads.yaml`. Wait for the gateway to be Ready before
   the workspace.
6. Copy `openshell-client-tls` into `ns-secops-cpu`.
7. Register the provider and the inference route. **Both are workspace-scoped** — omit
   `--workspace` and the sandboxes see nothing:
   ```sh
   openshell -g <gw> --workspace ns-secops-sandboxes provider create \
     --name llamacpp-shared --type openai \
     --credential OPENAI_API_KEY=unused \
     --config OPENAI_BASE_URL=http://secops-cpu-llm.ns-secops-cpu.svc.cluster.local:8000/v1
   openshell -g <gw> --workspace ns-secops-sandboxes inference set \
     --provider llamacpp-shared --model qwen3-4b --no-verify
   ```
   Then the **three custom providers**. OpenShell has no builtin profile for any of them, so each
   needs `provider profile import` before `provider create`, and both are workspace-scoped:
   ```sh
   cd integrations/openshell-profiles
   for p in suse-security git-forge app-collection; do
     openshell -g <gw> --workspace ns-secops-sandboxes provider profile import --file $p.yaml
   done
   openshell -g <gw> --workspace ns-secops-sandboxes provider create \
     --name suse-security --type suse-security --credential NEUVECTOR_API_KEY="<name>:<secret>"
   openshell -g <gw> --workspace ns-secops-sandboxes provider create \
     --name git-forge --type git-forge --credential GITEA_TOKEN="<token>"
   ```
   The third one's credential already exists in the cluster — AI Factory holds the Application
   Collection service account as the `application-collection` Secret in `aif-operator` on
   sims-datacenter — so **move it, do not retype it**, and do not let it reach your terminal:
   ```sh
   APPCO_BASIC=$(kubectl --context=kind-sims-datacenter -n aif-operator \
     get secret application-collection -o jsonpath='{.data.user} {.data.token}' |
     { read -r u t; printf '%s:%s' "$(printf %s "$u" | base64 -d)" \
                                   "$(printf %s "$t" | base64 -d)" | base64 | tr -d '\n'; })
   openshell -g <gw> --workspace ns-secops-sandboxes provider create \
     --name app-collection --type app-collection --credential APPCO_BASIC="$APPCO_BASIC"
   unset APPCO_BASIC
   ```
   The profile wants base64(`user:token`) because `auth_style: basic` validates in OpenShell but the
   L7 proxy implements nothing for it — a credential that parses and does not authenticate. The
   `appco` helper writes the literal `Basic` prefix. See `openshell-profiles/app-collection.yaml`.

   One honest caveat about all three: `--credential` puts the secret in the CLI's argv, where it is
   visible in `ps` for the life of the command. That is the interface OpenShell offers. It is a
   one-time setup step on an operator's workstation, and the credentials never appear in a manifest,
   in the chart, or in any sandbox — but it is not nothing, and a shared jump host is the wrong
   place to run it.
8. `20-blueprint-secops-cpu.yaml`, then document 3 of `30-aiworkloads.yaml`. The first llama.cpp
   start pulls ~2.4 GB of GGUF; the startup probe allows 20 minutes for it, and the PVC means it
   happens once rather than on every restart.
9. Seed Gitea (below), create `secops-gitea-token`, and let the orchestrator restart.

**After every Blueprint install, `Running` is not sufficient.** Fleet can silently drop the chart
version pin — check `Bundle.spec.helm.version` and `helm list`, and patch `forceSyncGeneration` if
it is absent. For a downstream target the HelmOp lands in **`fleet-default`**, not `fleet-local`,
and the operator appends the Fleet cluster ID to the instance name.

### Traps the install actually hit

- **`http://inference.local` is DENIED. `https://inference.local` works.** The supervisor route is
  short-circuited before `network_policies` are consulted, but only on the TLS listener; the plain
  port falls through to the policy, which of course does not name it. The failure is a policy denial
  for a hostname the docs say needs no policy — so it reads as a bug in the gateway. It is a scheme
  typo. Every `baseUrl` in `sandbox.opencode` uses `https`.
- **opencode's context ceiling must be declared, and it must match the server.** The model entry in
  the generated `opencode.json` sets `limit.context` explicitly. With `--parallel 1 -c 8192` the
  server gives one slot the whole 8192; opencode defaulting to something larger means requests that
  are silently truncated by llama.cpp rather than rejected, which surfaces as an agent that forgets
  its briefing halfway through.
- **All fourteen opencode built-in tools together cost more context than this server has.** The
  agent config sets `"tools": {"*": false}` and switches on only `bash`, and `"instructions": []`
  suppresses opencode's own preamble. Both are load-bearing at 8192 tokens, not tidiness.
- **Three provider profiles, and none of them declares an endpoint.** `suse-security` substitutes
  into `X-Auth-Apikey: <key name>:<key secret>`, `git-forge` into `Authorization: Bearer <token>`,
  and `app-collection` into `Authorization: Basic <base64 user:token>`.
  A provider whose profile declares no endpoints is bound to a *policy* endpoint via
  `credential_binding`, which is what puts the injection at the egress boundary — the sandbox never
  holds either credential. Gitea accepts the bearer form for `git-receive-pack`, so the remediation
  agent's `git push` works without Basic auth; see the ledger.
- **Sandbox names are capped at 19 characters**, `sandbox exec` requires `--name`, and
  `sandbox delete` takes the name positionally. The orchestrator suffixes a 6-hex-character nonce
  for that reason.
- **Git needs an author identity inside the sandbox.** The remediation policy sets
  `secops-bot@secops.invalid` — a deliberately undeliverable domain, so nothing in the demo can mail
  a real address.

---

## Seeding Gitea

One-time, and scripted here rather than done by hand twice. The `secops-bot` account must end up
with **write but not merge** on the repository — that permission is what makes the change gate real
rather than decorative.

Port-forward Gitea first (`ROOT_URL` is `http://localhost:3000/`, so the port-forward *is* the
canonical URL for this profile):

```sh
kubectl --context=kind-downstream-1 -n ns-secops-forge port-forward svc/gitea-http 3000:3000 &

GITEA=http://localhost:3000/api/v1
ADMIN=gitea_admin
ADMIN_PW=$(kubectl --context=kind-downstream-1 -n ns-secops-forge \
  get secret gitea-admin-secret -o jsonpath='{.data.password}' | base64 -d)
BOT_PW=$(openssl rand -base64 24)

# 1. The org and the repo the agents will patch. `secops/cluster-manifests` is
#    compiled into the orchestrator's config and into three sandbox policies.
curl -sf -u "$ADMIN:$ADMIN_PW" -H 'Content-Type: application/json' \
  -X POST "$GITEA/orgs" -d '{"username":"secops"}'
curl -sf -u "$ADMIN:$ADMIN_PW" -H 'Content-Type: application/json' \
  -X POST "$GITEA/orgs/secops/repos" \
  -d '{"name":"cluster-manifests","auto_init":true,"default_branch":"main",
       "description":"Workload manifests the remediation agent proposes patches against"}'

# 2. The bot. Registration is disabled in the chart values, so this is the admin
#    API, not a signup.
curl -sf -u "$ADMIN:$ADMIN_PW" -H 'Content-Type: application/json' \
  -X POST "$GITEA/admin/users" \
  -d "{\"username\":\"secops-bot\",\"email\":\"secops-bot@localhost\",
       \"password\":\"$BOT_PW\",\"must_change_password\":false}"

# 3. Write access on that one repository. Note: in Gitea, "write" DOES include
#    merging pull requests -- step 4 is what actually withholds it.
curl -sf -u "$ADMIN:$ADMIN_PW" -H 'Content-Type: application/json' \
  -X PUT "$GITEA/repos/secops/cluster-manifests/collaborators/secops-bot" \
  -d '{"permission":"write"}'

# 4. THE GATE. Protect `main` with a merge whitelist containing only the admin.
#    Without this the bot can merge its own pull request and human gate #2 is
#    decorative. The push whitelist is the same idea one level down: the bot
#    cannot push to main at all, so its only route is a feature branch and a PR.
#
#    `enable_push: false` -- which is what this script said first -- is NOT the
#    same thing and is a trap. It locks out EVERYONE, the admin included, so the
#    next step fails with `user cannot commit to repo [user: gitea_admin]` and
#    the repository can never be seeded or corrected without turning the rule
#    off again. Use the whitelist form.
curl -sf -u "$ADMIN:$ADMIN_PW" -H 'Content-Type: application/json' \
  -X POST "$GITEA/repos/secops/cluster-manifests/branch_protections" \
  -d "{\"rule_name\":\"main\",
       \"enable_push\":true,\"enable_push_whitelist\":true,
       \"push_whitelist_usernames\":[\"$ADMIN\"],
       \"enable_merge_whitelist\":true,\"merge_whitelist_usernames\":[\"$ADMIN\"],
       \"required_approvals\":1,\"block_admin_merge_override\":false}"

# 5. THE OTHER GATE, and the step whose absence is invisible. Gitea offers a
#    reviewer only the labels the repository already has, and a new repository
#    has none -- so without this, human gate #1 is a plan issue with no way to
#    approve it, the orchestrator polls until its 30-minute timeout, and
#    nothing anywhere says "the label does not exist". Create them up front.
for L in '{"name":"approved","color":"1a7f37","description":"Release human gate 1: the orchestrator may create the remediation sandbox"}' \
         '{"name":"rejected","color":"cf222e","description":"Stop the run at human gate 1"}'; do
  curl -sf -u "$ADMIN:$ADMIN_PW" -H 'Content-Type: application/json' \
    -X POST "$GITEA/repos/secops/cluster-manifests/labels" -d "$L"
done

# 6. A token for the bot, scoped to repositories and issues. Admin basic auth
#    may mint a token for another user (reqSelfOrAdmin + reqBasicOrRevProxyAuth).
TOKEN=$(curl -sf -u "$ADMIN:$ADMIN_PW" -H 'Content-Type: application/json' \
  -X POST "$GITEA/users/secops-bot/tokens" \
  -d '{"name":"orchestrator","scopes":["write:repository","write:issue"]}' \
  | jq -r .sha1)

# 7. Hand it to the orchestrator. A FILE, never an environment variable.
kubectl --context=kind-downstream-1 -n ns-secops-cpu create secret generic secops-gitea-token \
  --from-literal=token="$TOKEN"
kubectl --context=kind-downstream-1 -n ns-secops-cpu rollout restart deploy/secops-cpu-orchestrator
```

Then commit something for the agents to patch — **this is a step, not a footnote**: with an empty
repository the remediation agent has nothing to change, and it will invent a file rather than say
so. `workloads/payments-api.yaml` here is a Deployment carrying `LOG4J_VERSION: "2.14.1"`, which the
corpus advisory `cve-2021-44228` names as affected and whose `fixed_version` is `2.17.1`. One line,
one advisory, one provable change:

```sh
CONTENT=$(base64 < workloads/payments-api.yaml | tr -d '\n')
curl -sf -u "$ADMIN:$ADMIN_PW" -H 'Content-Type: application/json' \
  -X POST "$GITEA/repos/secops/cluster-manifests/contents/workloads/payments-api.yaml" \
  -d "{\"content\":\"$CONTENT\",\"branch\":\"main\",
       \"message\":\"Add the payments-api workload the agents operate on\"}"
```

If the admin is not on the push whitelist from step 4, this returns
`403 user cannot commit to repo [user: gitea_admin]`.

Verify the gate before trusting it:

```sh
# As the bot, merging must 403.
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: token $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$GITEA/repos/secops/cluster-manifests/pulls/1/merge" -d '{"do":"merge"}'
```

---

## Resetting between runs

A successful run consumes its own starting state. The storefront ends up on the remediated image,
the manifest repository has the merged change, and the forge carries the issues and the pull request
the run produced — so a second run has nothing to find, and the twenty-seven-criticals-to-zero story
does not reproduce. [`reset-demo.sh`](reset-demo.sh) undoes all of it and leaves the two UIs
forwarded:

```sh
GITEA_AUTH='<user>:<password>' sh reset-demo.sh        # prompts before deleting
GITEA_AUTH='<user>:<password>' sh reset-demo.sh -y     # no prompt, for a recording take
```

It restores `workloads/*.yaml` in the forge from the seed files in this directory, deletes every
issue, pull request and non-`main` branch, re-applies `workloads/nginx.yaml`, deletes any leftover
canary, and reopens the Gitea (3000) and orchestrator (8088) port-forwards after
killing any stale ones. It ends by printing the starting state, which is the thing to read before
you hit record.

**It needs a human credential, and that is not an oversight.** `secops-bot` is refused by branch
protection on `main`, which is human gate #2 — the reason the pipeline cannot merge its own change.
A reset script that could authenticate as the bot would be a reset script that had quietly removed
the gate. Note that protection applies to admins too unless the account is on main's push whitelist
(see step 4 above); the script says so if the write is refused.

**What it deliberately leaves alone.** It does not touch SUSE Security, which has no PVC here and loses its key, its EULA
acceptance and its entire scan history on a restart. And it refuses to run at all while a sandbox is
up, because a live sandbox means a run is still in progress.

One cosmetic thing it cannot undo: deleting issues does not reset Gitea's index counter, so the next
run opens `#41` rather than `#1`. Recreating the repository would fix the numbering and drop the
branch protection and push whitelist with it, which is a worse trade than a large number on screen.

---

## Reaching the UIs

The podman network `10.89.0.0/24` lives inside the VM and is not routable from macOS, and
`downstream-1` has no ingress controller. Everything on downstream-1 is reached with
`kubectl port-forward`, exactly as `docs/openshell-demo.md` already does for Rancher.

The two you need in front of an audience — Gitea and the orchestrator status page — are opened for
you by [`reset-demo.sh`](#resetting-between-runs), which also stops any stale forwards first. The
table below is the manual form, and the rest of the surfaces.

| Surface | Command | Then open |
|---|---|---|
| **Gitea** — both gates | `kubectl --context=kind-downstream-1 -n ns-secops-forge port-forward svc/gitea-http 3000:3000` | <http://localhost:3000> |
| **Qdrant dashboard** — read the cited advisory | `kubectl --context=kind-downstream-1 -n ns-secops-cpu port-forward svc/secops-cpu-qdrant 6333:6333` | <http://localhost:6333/dashboard> |
| **Orchestrator status** — which agent is where | `kubectl --context=kind-downstream-1 -n ns-secops-cpu port-forward svc/secops-cpu-orchestrator 8088:8080` | <http://localhost:8088> (`/api/state` for JSON) |
| **llama.cpp** — debugging only | `kubectl --context=kind-downstream-1 -n ns-secops-cpu port-forward svc/secops-cpu-llm 8000:8000` | `curl localhost:8000/v1/models` |

**8088, not 8080, and the reason generalises.** A `port-forward` whose local port is already held by
something else on the host does not fail — it binds `[::1]` only, and `curl 127.0.0.1:8080` then
reaches the *other* process. On this machine that returned an unrelated single-page app, which looks
like the orchestrator serving the wrong thing. If a forwarded UI shows you something you do not
recognise, check `lsof -nP -iTCP:<port> -sTCP:LISTEN` before debugging the pod.

| **SUSE Security** | no port-forward — the Rancher ingress at `rancher-192-168-1-74.sslip.io`, then the SUSE Security extension | |

Rancher's own SUSE Security manager is reachable per
[`integrations/suse-security/README.md`](integrations/suse-security/README.md), which also explains
why the console does **not** accept `admin`/`admin` on this install.

---

## Isolation proof

This is the part worth running in front of people, because it is the claim the whole architecture
rests on. From inside each sandbox:

```sh
openshell -g <gw> --workspace ns-secops-sandboxes sandbox connect <name>
```

| From | Expect success | Expect **denied by the sandbox policy** |
|---|---|---|
| researcher | Qdrant search | SUSE Security, the forge |
| clarifier | open an issue | create a branch, push |
| remediation | push a branch, open a PR | `POST /v1/policy/rule` |
| validation | `POST /v1/scan/repository` | `POST /v1/policy/rule`, any push |
| all five | `inference.local` | — |

`inference.local` needs no rule in any policy: it is a built-in supervisor route, short-circuited
before `network_policies` is consulted.

The denial that matters most is `POST /v1/policy/rule`. An agent that can rewrite SUSE Security's
own policy can make any finding disappear, and it must be **the sandbox** that refuses, not
NeuVector — the point is that the execution boundary holds even when the credential is valid.

There is no `openshell policy lint`. To parse-check a policy against the canonical Rust parser
(which has `#[serde(deny_unknown_fields)]` on every struct):

```sh
openshell -g <gw> policy set __nonexistent__ --policy /tmp/researcher.yaml
```

A schema error fails before the sandbox lookup does.

---

## Out of scope — stated plainly

No NIM Operator, no Nemotron tier, no NVIDIA RAG Blueprint, no AI-Q, no NeMo Guardrails, no
flywheel, no SUSE Observability. Ten agents become five. The in-cluster Gitea is a **demo forge**,
not a proposal that customers replace theirs — in a real deployment the `git_forge` policy group
points back at their own, which is exactly the one-hostname change the policy files are shaped to
allow.

What this profile demonstrates is the **execution boundary**, per-agent least privilege, two real
human gates, and the sovereignty property: no token and no source code leaves the cluster. It does
**not** demonstrate frontier-model reasoning. A 4B model at Q4_K_M answers in seconds rather than
sub-second, reasons shallowly, and will occasionally decline a task the GPU tier would complete —
the recorded gate run has exactly one such failure out of nine, and it is scored as a failure.

The GPU blueprints in [`../secops-agent-factory/`](../secops-agent-factory/) are **not modified** by
this profile, with one exception: `policies/remediation-sandbox.yaml` there pointed `suse_security`
at the headless gossip Service. Installing SUSE Security for real is what caught it, and the
one-token fix was applied in both places.
