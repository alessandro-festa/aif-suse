# Model gate — zero-GPU SecOps profile

**Verdict: `unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M` PASSES. 8/9 tool calls, p50 2.07 s,
peak RSS 4.95 GB, CPU only.**

Run 2026-09-16. Harness: [`gate.py`](gate.py), raw results in the table below.

## Why there is a gate at all

The six-agent topology only exists if the model emits OpenAI-shaped `tool_calls` reliably. A
model that describes the command it would run, rather than calling the tool, produces an agent
that looks like it is working and is not — and it fails that way silently, at every step, in a
demo. So the model is chosen by measurement.

The bar is **≥8/9 tool calls**, matching the best result in the measured Ollama table in
[`examples/openshell/41-blueprint-openshell-inference-ollama-shared.yaml`](../../openshell/41-blueprint-openshell-inference-ollama-shared.yaml)
(`qwen2.5:7b-instruct` 8/9, `qwen3:1.7b` 5/9, `granite3.1-moe:1b` 0/12). That table sets the bar
but **does not transfer**: it is Ollama, with a different chat template and a different
tool-call parser. It had to be re-measured against llama.cpp.

## Setup

```sh
llama-server -hf unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M -a qwen3-4b \
  --host 127.0.0.1 --port 18080 --jinja --threads 4 --parallel 2 -c 16384 \
  --metrics -ngl 0 --device none

python3 gate.py --model qwen3-4b --out qwen3-4b-cpu.json
```

llama.cpp `b10964` (`b29c606e2`), the same build the chart pins. Nine prompts, each with exactly
one correct shape of response — a `run_command` call — spanning the work the real agents do:
inspect a package, read a manifest, grep for a CVE, checksum, patch, scan.

A `tool_call` with empty or unparseable arguments is scored a **failure**, not a pass. The
orchestrator would break on it exactly as if none had been emitted.

## Results — CPU only

| # | Prompt | Result | Time | Tool call |
|---|---|---|---|---|
| 1 | openssl package version | PASS | 7.80 s | `apt list --installed \| grep openssl` |
| 2 | list `/sandbox/work` | PASS | 1.40 s | `ls /sandbox/work` |
| 3 | show Containerfile | PASS | 1.49 s | `cat Containerfile` |
| 4 | uncommitted changes? | PASS | 1.55 s | `git status --porcelain` |
| 5 | find CVE-2024-3094 | PASS | 2.64 s | `grep -r 'CVE-2024-3094' /sandbox/work/` |
| 6 | sha256 of manifest | PASS | 2.00 s | `sha256sum /sandbox/work/manifest.yaml` |
| 7 | apply `fix.patch` | **FAIL** | 2.14 s | *(prose: "I cannot apply a patch file … without knowing the loc…")* |
| 8 | free disk space | PASS | 2.13 s | `df -h /sandbox \| grep /sandbox \| awk '{print $4}'` |
| 9 | tail the build log | PASS | 2.07 s | `tail -n 20 /sandbox/work/build.log` |

**8/9. p50 2.07 s, max 7.80 s, peak RSS 4.95 GB.**

Prompt 1 is the outlier at 7.80 s because it is the first request and pays cold prompt
processing; every subsequent call sits near 2 s.

### About the one failure

Prompt 7 did not hallucinate — it **declined and asked where the patch should be applied**. That
is defensible behaviour from a model, and in a real agent loop the orchestrator would answer and
the call would succeed on the second turn. It is scored as a failure anyway, because the gate
measures single-turn tool emission and moving the goalposts after seeing the result is how a gate
stops meaning anything. Worth knowing when reading the number: 8/9 is the pessimistic reading.

## Concurrency — does `--parallel 2` actually buy anything?

This decides whether the two researcher agents overlap or run in sequence.

| Concurrent requests | Wall clock | Per-request | Tool calls |
|---|---|---|---|
| 1 | 6.07 s | 6.07 s | 1/1 |
| 2 | 6.78 s | 6.78 s, 6.78 s | 2/2 |
| 3 | 3.26 s | 2.02 s, 2.02 s, 3.26 s | 3/3 |

Two concurrent requests cost **0.7 s over one** while doing twice the work — the second slot is
very nearly free. `--parallel 2` is therefore worth having and the researchers can overlap.

The third row is **not** evidence that 3 works better; it is faster only because the KV cache was
warm by then. With `--parallel 2` there are two slots, so a third request queues — visible as
3.26 s against 2.02 s for the two that got a slot immediately. Raising `--parallel` past 2 would
shrink every agent's usable context (`-c` is split across slots) to buy concurrency the
orchestrator does not use.

## What this measurement is NOT

Read this before quoting the latency anywhere.

- **These numbers are from macOS, not from the cluster.** The first run of this gate accidentally
  measured Metal: Homebrew's `llama-server` on Apple Silicon offloads to the GPU by default
  (`--list-devices` → `MTL0: Apple M3 Pro`), and it scored 8/9 at **p50 0.73 s** — 3× faster and
  completely unrepresentative. The run recorded above disables it with `-ngl 0 --device none`.
  Anyone re-running this must pass those flags or they will measure the wrong machine.
- **CPU cores are comparable, the BLAS is not.** The kind nodes are containers on this same M3
  Pro, so `--threads 4` means the same four cores. But macOS links Accelerate for prompt
  processing and the Linux container image will use whatever BLAS it ships. Expect prompt
  processing to differ; token generation should be close.
- **Tool-call success transfers; latency does not.** 8/9 is a property of the model and its chat
  template, and will hold on the cluster. The seconds column will not, and must be re-measured
  once `secops-cpu-inference` is running on the target cluster.
- **`--jinja` was on for every run.** Without it llama-server does not emit `tool_calls` at all
  and this gate scores 0/9 regardless of model. It is not tuning; it is load-bearing.

## Candidate not tested, and why

`bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M` was the planned second candidate, on the strength of
its 8/9 in the Ollama table. It was **not run**, deliberately: Qwen3-4B already meets the bar at
4.95 GB, and 7B Q4_K_M would land near 6.5 GB against a shared ~23 GiB budget **with no
swap**, where an overcommit is an OOM kill rather than a slowdown. Testing a model that cannot be
deployed would produce a number and no decision.

If Qwen3-4B later proves too weak on the actual remediation task — which this gate does not
measure — 7B is the next rung, and it costs memory elsewhere: NeuVector's manager on the managed
cluster is the first thing to cut.

## Consequence for the chart

`charts/secops-cpu-inference/values.yaml` is set from this run: `ggufRepo`
`unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M`, `servedModelName` `qwen3-4b`, `jinja: true`,
`parallel: 2`, `contextSize: 16384`, limits `cpu: 4` / `memory: 8Gi` (4.95 GB measured, plus KV
cache headroom), `--threads` rendered equal to the CPU limit.
