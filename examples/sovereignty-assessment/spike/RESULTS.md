# Phase 0 — model gate results

Run 2026-09-15 on an Apple Silicon Mac, `llama.cpp` 0.4.1 (build `b10964`, commit
`b29c606e2`, Homebrew bottle). Every run used `--threads 4 -c 4096 -ngl 0` — CPU only,
because the target is a CPU-only cluster Deployment and Metal-offloaded numbers would not
transfer.

Reproduce with `./phase0.py --model <alias> --json out.json` against a running
`llama-server`. Raw per-call records are in `results-*.json`.

## Verdict

**Gate PASSES on `Qwen3-4B-Instruct-2507` Q4_K_M. EuroLLM-1.7B and Salamandra-2b both
FAIL.** The fallback ladder in the plan ran to its last rung.

| | EuroLLM-1.7B-Instruct | Salamandra-2b-instruct | **Qwen3-4B-Instruct-2507** |
|---|---|---|---|
| GGUF repo | `mradermacher/EuroLLM-1.7B-Instruct-GGUF` | `mradermacher/salamandra-2b-instruct-GGUF` | `unsloth/Qwen3-4B-Instruct-2507-GGUF` |
| License | Apache-2.0 | Apache-2.0 | Apache-2.0 |
| On-disk (Q4_K_M) | 1.0 GB | 1.4 GB | 2.3 GB |
| A: stops cleanly | pass 3/3 | pass 3/3 | pass 3/3 |
| B: schema-valid | **20/20** | **20/20** | **20/20** |
| C: seals monotone | **fail** | **fail** | **pass** |
| Band means A/B/C/D | 4.00 / 4.00 / 3.20 / 3.00 | 4.00 / 4.00 / 3.20 / 2.40 | **4.00 / 2.20 / 1.40 / 0.00** |
| In expected window | 6/20 | 7/20 | **19/20** |
| Latency p50 | 1.75 s | 2.04 s | 3.71–4.75 s |
| Latency max | 3.64 s | 4.84 s | 6.17–14.39 s (first call cold) |
| Peak server RSS | 1.88 GB | 2.43 GB | **5.02 GB** |

Qwen3 latency and RSS are given as ranges over three separate runs; band means and the
19/20 window count were **identical across all three**, so the result is not sampling noise.

## The one thing that matters: constrained decoding is not the problem, judgement is

All three models produced **20/20 schema-valid** responses at `temperature 0`. The design
property the plan rests on — that a small model can be made to emit a well-formed
`{seal, rationale, confidence}` every time — holds even at 1.7B. What does not hold at 1.7B
or 2B is the judgement inside the JSON.

EuroLLM and Salamandra both **parrot the rubric back instead of applying it**. Representative
EuroLLM rationales, verbatim:

| Declaration | Seal | Rationale |
|---|---|---|
| D1 "administration performed by our operations team in Seattle, Washington" | **4** | "The declaration cites concrete evidence (a named entity, a contract clause, an audit or certification)." |
| D3 "our datacentre uses free cooling and we have reduced PUE to 1.15…" | **4** | "…This demonstrates our commitment to sustainability and our ability to operate efficiently…" |
| D4 "the platform is written in Go and deployed with Helm onto Kubernetes…" | **4** | "The platform is operationally controlled by personnel located within the EU/EEA and subject to EU jurisdiction." |

D4 is the disqualifying one: the model **invented the compliance claim outright**. Salamandra
behaves the same way (D1, D3, D4 all score 4). Both models scored the empty declaration 0 —
that is the only discrimination either of them showed.

Qwen3-4B, on the same inputs, grounds every rationale in the actual text:

| Declaration | Seal | Rationale (truncated) |
|---|---|---|
| D1 Seattle | **0** | "…performed in Seattle, Washington, which is outside the EU/EEA and not subject to EU jurisdiction…" |
| D2 US provider, CLOUD Act | **0** | "…outsourced to a U.S.-based provider subject to the CLOUD Act, which contradicts the requirement…" |
| D3 PUE / cooling | **0** | "The declaration addresses energy efficiency and sustainability, not operational control or personnel location…" |
| D4 Go / Helm / Kubernetes | **0** | "The declaration does not address operational control, personnel location, or jurisdictional compliance…" |
| C2 Amsterdam + US break-glass | **2** | "…acknowledges U.S.-based engineers have break-glass access for severity-1 incidents, indicating a caveat…" |
| A1 SUSE DE, clause 8.3, ISO audit | **4** | "…by SUSE Software Solutions Germany GmbH from Nuremberg and Prague, with contractual and audit-based verification…" |

The single row outside its expected window is **B4** (Polish subsidiary, Polish employment
law), scored **1** where 2–3 was expected. Reading the rationale — "does not confirm that
operational control is exercised *exclusively* within the EU/EEA" — this is a defensibly
strict reading of the control, not a misfire. Recorded as a pass.

### What this cost

The plan's premise that *"the demo's own model passes SOV-3"* is **dead**. Qwen3 is
Alibaba-developed (China). This needs a decision — see "Open decisions" below.

## Two llama.cpp findings that change the implementation

### 1. `response_format: json_schema` is unusable on the OpenAI endpoint in b10964

`POST /v1/chat/completions` with `response_format: {type: "json_schema", …}` returns:

```
400 {"error":{"code":400,"message":"Failed to initialize samplers: std::exception"}}
```

This is **not** a schema-subset problem. It reproduces with the most trivial schema possible
(`{"type":"object","properties":{"seal":{"type":"integer"}},"required":["seal"]}`) and it is
triggered by the *template*, not the schema:

| Server config | `/v1/chat/completions` + `response_format` |
|---|---|
| EuroLLM, GGUF's own embedded template | works |
| EuroLLM, `--chat-template chatml` | **400** |
| EuroLLM, `--chat-template-file` with corrected ChatML | **400** |
| Salamandra, GGUF's own embedded template | **400** |

`POST /completion` with a top-level `json_schema` field works in **every** one of those
configurations.

**Consequence for the plan.** §3's "keep the request OpenAI-shaped so an Ollama fallback
stays a values change" does not survive contact with this build. The working route is
`POST /apply-template` (server renders the prompt with its own template) → `POST /completion`
with `json_schema`. That is model-agnostic and costs one extra round trip, but it is
llama.cpp-specific — an Ollama fallback becomes a code change, not a values change. Either
accept that, or pin a llama.cpp version where the OpenAI path works and re-test.

### 2. The EuroLLM GGUF template has no generation prompt — and it was not the cause

The embedded template never emits `<|im_start|>assistant\n`; it ignores `add_generation_prompt`
entirely, so the model completes a raw ChatML transcript. `/props` confirms
`generation_prompt: ""`.

This was the plan's headline hazard, so it was tested directly: the same 8 declarations were
re-run through `/completion` with a hand-built prompt carrying the correct assistant opener.
D1 improved 4→3 and D2 4→2, but **D3 and D4 still scored 4 with fabricated rationales**. The
missing generation prompt is real and worth knowing about, but it is not why EuroLLM fails.
The model is simply not able to do this task.

Note the plan's description of this hazard as "an unusual `eos token 4`" was imprecise:
`/props` reports `eos_token = <|im_end|>`, correctly resolved, and generation stops cleanly
(3/3, `finish_reason: stop`). The real defect is the absent generation prompt.

### 3. `llama-gbnf-validator` is not in the Homebrew bottle

Per the plan, static schema validation was dropped rather than building from source. The
empirical substitute holds: 60/60 schema-valid responses across three models, including
prompts (D3, D4) whose natural answer is prose.

## Measurements for chart sizing

At `--threads 4`, CPU only, Qwen3-4B Q4_K_M:

- **p50 3.7–4.8 s per classification call**, ~50–80 completion tokens each.
- **Peak RSS 5.02 GB.**
- A ~40-control catalog implies roughly **3 minutes of wall clock** for a full scan. The
  plan's decision to stream progress over SSE is vindicated.

**This breaks the "4-core / 8 GB laptop cluster" target.** 5 GB for the model server alone
leaves no room for the assessor, k3s and the rest on an 8 GB node. The plan's chart spec
(requests `cpu 2 / mem 4Gi`, limits `cpu 4 / mem 8Gi`) needs revisiting: requests must be
at least `mem 6Gi`, and the documented minimum becomes a **16 GB** node.

It does **not** block the actual test target. The end-to-end cluster is kind
`sims-datacenter` (Rancher + `aif-operator` already installed): 10 CPU and 21.8 GiB
allocatable on a single node, ~11% CPU requested — comfortable headroom. The 8 GB limit is
a documentation-and-claims problem, not a "can we run the demo" problem.

## Open decisions for the next session

1. **Model provenance.** Qwen3-4B is the only model that works, and it is Chinese-developed.
   Options: (a) ship it and have the assessor flag its own inference model as a SOV-3
   finding — consistent with the community-quant decision below, and the more honest demo;
   (b) re-test larger EU models (EuroLLM-9B, Teuken-7B) and accept a bigger footprint;
   (c) keep EuroLLM for narration only and use Qwen3 for classification. Recommendation: (a).
2. **Node size.** Either raise the documented minimum to 16 GB, or drop to a smaller quant
   (Q4_K_S / IQ4_XS) and re-run this gate.
3. **Transport.** Accept the `/completion` route, or pin a llama.cpp build with a working
   OpenAI `response_format` path.

**Settled here, as the plan required:** the GGUF is a **community quant** (`unsloth`), and
therefore a genuine SOV-5 supply-chain weakness in the demo's own stack. Ship it and have
the assessor report it as a finding about itself, rather than self-converting. Deliberate,
not accidental.
