# What AI-Q components does this architecture actually use?

A component-level inventory of the Sovereign Agentic SecOps reference architecture, written
because "we use AI-Q" is not an answer that survives a product repartition.

Everything below was read out of this repository — `examples/secops-agent-factory/configs/config_secops.yml`
and `examples/secops-agent-factory/20-blueprint-secops-agent-factory.yaml` — not out of a
slide. Nothing here is aspirational: `_type` in an AI-Q config is a plugin-registry key, not
free text, so every row is a component that exists upstream at tag `v2.2.0` or the workflow
fails to start.

---

## The short answer

Twelve component types, from four different upstreams that happen to ship in one chart today.
**Exactly one of them is retrieval.**

| What it is | How many | Upstream that owns it |
|---|---|---|
| Agent orchestration and the workflow graph | 8 | **NeMo Agent Toolkit** |
| Model clients | 5 (one `_type`) | **NIM** |
| Sandboxed execution | 1 | **OpenShell** |
| Retrieval | **1** | **NeMo Retriever / NVIDIA RAG Blueprint** |

So if NeMo Retriever absorbs the retrieval half of AI-Q, the line that changes in this
architecture is `knowledge_search._type: knowledge_retrieval` with `backend: foundational_rag`
— one function, pointed at `rag-server` and `ingestor-server` over HTTP. Nothing else in the
config moves. The agent plane is NeMo Agent Toolkit, the inference is NIM, the execution is
OpenShell, and none of those three are Retriever's to absorb.

That is the useful version of the answer, and it is why the architecture figures now name
components rather than the blueprint brand.

---

## On the premise

The question came with a premise — that AI-Q as a standalone product is going away and NeMo
Retriever will pick up much of it. **We could not confirm that from public sources**, and it
is worth saying so rather than quietly designing around a rumour:

- AI-Q v2.2.0 is current and shipping on NGC (`aiq-agent`, `aiq-frontend`, `aiq2-web` 2.2.1).
- NVIDIA's own architecture documentation still describes NeMo Retriever as one of AI-Q's
  building blocks — AI-Q consumes Retriever, not the reverse.
- The NVIDIA blueprint carrying a 2026 deprecation notice is *AI Virtual Assistant*, not AI-Q.

None of that disproves the premise; roadmap changes are not usually announced before they
happen. It just means the mitigation should be structural rather than a bet either way, and
it is: naming components instead of the blueprint makes this document correct under both
outcomes.

---

## Deployed artifacts

One chart, from `20-blueprint-secops-agent-factory.yaml`:

| Chart | Repo | Version | Namespace |
|---|---|---|---|
| `aiq2-web` | `nvidia-blueprints` | **2.2.1** | `ns-secops-agents` |

It brings the `aiq-agent` backend container, the `aiq-frontend` web container, and a
PostgreSQL job/checkpoint store (`aiq-postgres-init`, secret `aiq-credentials`, ConfigMap
`aiq-secops-config`).

**2.2, not the 2.1 the product ships today.** AI-Q 2.2 is the release that added
`deep_research_sandbox` with `provider: openshell`, which is the hinge of the entire design.
The shipped `nvidia-aiq-with-rag` Blueprint pins `aiq2-web` 2.1.0.

---

## Runtime components, one row per `_type`

This is the literal answer to "what components are being used".

| Line | Key | `_type` | Role here | Upstream owner after a repartition |
|---|---|---|---|---|
| 36 | `general.telemetry.logging.console` | `console` | stdout logging; OTLP goes to SUSE Observability via env | NeMo Agent Toolkit |
| 40 | `general.front_end` | `aiq_api` | REST API and the **async Job API** — what makes a remediation survive the HTTP connection that submitted it | NeMo Agent Toolkit |
| 72, 87, 102, 114, 133 | five `llms:` entries | `nim` | Ultra for intent/planner/orchestrator/writer, Lightning for the agent and researcher tiers | **NIM** |
| 151 | `data_sources` | `data_source_registry` | one source: the vulnerability knowledge base | NeMo Agent Toolkit |
| 163 | `knowledge_search` | `knowledge_retrieval` | `backend: foundational_rag`, `top_k: 10`, pointed at `rag-server` / `ingestor-server` | **NeMo Retriever / RAG Blueprint** — *the only retrieval seam* |
| 184 | `intent_classifier` | `intent_classifier` | routes the incoming signal cheaply, on Lightning | NeMo Agent Toolkit |
| 194 | `clarifier_agent` | `clarifier_agent` | **the human plan gate**; `max_turns: 3`, on Ultra | NeMo Agent Toolkit |
| 206 | `shallow_research_agent` | `shallow_research_agent` | triage; `max_llm_turns: 10`, `max_tool_iterations: 5` | NeMo Agent Toolkit |
| 224 | `deep_research_skills` | `deep_research_skills` | role→skill grants; **`require_sandbox: [research]`** | NeMo Agent Toolkit |
| 235 | `deep_research_sandbox` | `deep_research_sandbox` | `provider: openshell`, `network: allowlist`, hard Landlock | **OpenShell** |
| 328 | `deep_research_agent` | `deep_research_agent` | instantiates orchestrator / source_router / planner / researcher ×N / writer, each bound to its own LLM; `enable_citation_verification: true`; `domain_catalog_path` | NeMo Agent Toolkit (LangChain DeepAgents) |
| 354 | `workflow` | `chat_deepresearcher_agent` | intent → clarifier → shallow → escalate → deep; `use_async_deep_research`, `checkpoint_db` | NeMo Agent Toolkit |

Two of those rows carry most of the architectural weight:

**`deep_research_agent` is not one agent.** It is the declaration that instantiates seven
roles, and the specialization lives in which LLM each role is bound to plus
`domain_catalog_path: configs/secops_domain_catalog.yml`. The domain catalog is upstream's
supported mechanism for domain specialization — data, not code — which is how a SecOps system
is built without inventing agent types that would fail at startup.

**`require_sandbox: [research]`** is the research/action separation expressed as
configuration rather than as a diagram convention. It declares that the `research` skill may
only execute inside an OpenShell sandbox, so the agent that edits files and runs builds
cannot run anywhere else.

---

## Consumed, but outside the AI-Q chart

These are separate charts in the same Blueprint, or catalog apps. They matter to the question
because a reader looking at the old figure would reasonably have assumed some of them were
AI-Q:

| Component | Chart | Version | Actually owned by |
|---|---|---|---|
| RAG server, ingestor server, `nv-ingest` (table structure + page elements on, OCR off), Elasticsearch vector store | `nvidia-blueprint-rag` | v2.6.0 | **NeMo Retriever / RAG Blueprint** |
| Llama Nemotron Rerank VL 1B v2 | subchart of the above | — | NIM |
| Nemotron 3 Embed 1B | `nvidia-nim-nemotron-3-embed-1b` | 2.2.2 | NIM |
| NeMo Guardrails | `nemo-guardrails` | 25.6.0 | NeMo Microservices *(sunset 1 Oct 2026)* |
| Nemotron 3 Ultra, Nemotron 3.5 Lightning | `nim-llm` × 2 | 2.0.4-pb6.6 | NIM, installed as catalog apps |
| NIM Operator | `k8s-nim-operator` | 3.1.2 | NIM, installed as a catalog app |
| OpenShell gateway and workspace | `helm-chart`, `openshell-workspace` | dev tags | **OpenShell** |
| NeMo Data Store / Evaluator / Customizer | `nemo-*` | 25.6.0 | NeMo Microservices *(sunset 1 Oct 2026)* |

---

## Deliberately not used

Worth listing, because the absences are where the sovereignty argument actually lives — each
one is an upstream default that was turned off on purpose.

- **No web search.** Upstream registers Tavily and Serper. Both send the query text to a third
  party, and here the query text is *"which of our images is exposed to CVE-2026-xxxxx"* —
  precisely the information a sovereignty-motivated customer deployed this stack to keep
  inside. The vulnerability corpus is ingested instead.
- **No `llamaindex` / Chroma retrieval backend.** That is upstream's laptop convenience; it
  cannot serve a shared, continuously-ingested corpus.
- **No Modal sandbox provider.** `provider: openshell` only.
- **No `integrate.api.nvidia.com`.** Denied by the sandbox egress policy, so no second,
  uninstrumented path to a model exists outside the cluster.
- **No public PyPI, npm or HuggingFace egress** from the sandbox. A sandbox that can fetch and
  execute an arbitrary public package *and then commit to a source repository* is a supply
  chain attack with extra steps.
- **No Kubernetes API access** from the sandbox, in any form.

---

## What breaks if the premise is right

Suppose AI-Q is repartitioned tomorrow and Retriever absorbs its retrieval half.

| What has to change | Blast radius |
|---|---|
| `knowledge_search` — `_type`, `backend`, and the two URLs | one function block, ~8 lines |
| The chart that provides `rag-server` / `ingestor-server` | one Blueprint component |
| Nothing else | — |

The agent plane keeps working because it is NeMo Agent Toolkit and always was. The models keep
working because they are NIM Services addressed by in-cluster DNS. The sandbox keeps working
because it is OpenShell. What would change is the *packaging* — which chart carries which
component — and the AI Factory Blueprint is the layer that exists to absorb exactly that kind
of change: `chartRepo` is a ClusterRepo name, `chartVersion` is a pinned string, and swapping
one for another is a new Blueprint version, not a redesign.

---

## Related

- [`sovereign-agentic-secops.md`](sovereign-agentic-secops.md) — the full reference
  architecture, including the honest verified/designed/unverified ledger in section 11.
- [`figure-0-platform.pptx`](figure-0-platform.pptx) — the platform figure as a native
  one-slide deck, with these components named individually rather than hidden inside an
  "AI-Q Blueprint" box. Rebuild with `make-figure0-slide.py`; `verify-figure0-slide.py`
  re-checks that every name on it still greps out of the config.
- `examples/secops-agent-factory/configs/config_secops.yml` — the source of truth for
  everything in the runtime table above.
