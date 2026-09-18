#!/usr/bin/env python3
"""Model gate for the zero-GPU SecOps profile.

THE QUESTION THIS ANSWERS. The six-agent topology only exists if the model can
emit OpenAI-shaped `tool_calls` reliably. An agent that describes the command it
would run, instead of calling the tool, looks like it is working and is not.
So the model is chosen by measurement, exactly as the sovereignty-assessment
spike chose its own.

WHY THE EXISTING NUMBERS DO NOT TRANSFER.
examples/openshell/41-blueprint-openshell-inference-ollama-shared.yaml carries a
measured table (qwen2.5:7b-instruct 8/9, qwen3:1.7b 5/9, granite3.1-moe:1b 0/12).
That table is Ollama. Different runtime, different chat template, different
tool-call parser. It sets the bar, not the answer.

THE BAR: >= 8/9 tool calls, matching the best Ollama result in that table.

Run against a local llama-server started with --jinja (required — llama-server
only emits tool_calls on the Jinja chat-template path):

    llama-server -hf <repo>:Q4_K_M -a <name> --host 127.0.0.1 --port 18080 \
        --jinja --threads 4 --parallel 2 -c 16384

    python3 gate.py --base-url http://127.0.0.1:18080 --model <name>
"""

import argparse
import json
import statistics
import time
import urllib.error
import urllib.request

# The single tool, shaped like what opencode exposes to an agent. One tool, not
# a suite: the gate measures whether the model reaches for a tool at all and
# fills its arguments, not whether it can choose between many.
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": (
                "Run a shell command inside the sandbox and return its stdout, "
                "stderr and exit code."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute.",
                    },
                },
                "required": ["command"],
            },
        },
    }
]

# USE A SYSTEM PROMPT. Blueprint 41 is emphatic that every number in its table
# depends on one, and omitting it here would measure a different thing than the
# deployed agents will experience.
SYSTEM_PROMPT = (
    "You are a SecOps remediation agent running inside a locked-down sandbox. "
    "You have exactly one tool: run_command. "
    "When the user asks for information about the system, packages, files or "
    "vulnerabilities, you MUST call run_command to obtain it. "
    "Never guess, never describe the command you would run, and never answer "
    "from memory — call the tool. "
    "Only answer in prose once a tool result is available."
)

# Nine tasks, each of which has exactly one correct shape of response: a
# run_command call. They span the work the real agents do — inspecting a
# package, reading a manifest, diffing, scanning — so a model that only handles
# the easy phrasing is caught.
PROMPTS = [
    "What version of the openssl package is installed?",
    "List the files in /sandbox/work.",
    "Show me the contents of Containerfile in the current directory.",
    "Check whether the git working tree has uncommitted changes.",
    "Find every file under /sandbox/work that mentions CVE-2024-3094.",
    "What is the sha256 checksum of /sandbox/work/manifest.yaml?",
    "Apply the patch file fix.patch to the source tree.",
    "How much free disk space is there on /sandbox?",
    "Show the last 20 lines of the build log at /sandbox/work/build.log.",
]


def chat(base_url, model, prompt, timeout):
    body = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            "tools": TOOLS,
            "tool_choice": "auto",
            # Deterministic-ish. The gate is about capability, not sampling luck;
            # a model that only passes at temperature 0.8 has not passed.
            "temperature": 0.1,
            "max_tokens": 512,
        }
    ).encode()
    req = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    started = time.monotonic()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.load(resp)
    return payload, time.monotonic() - started


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:18080")
    ap.add_argument("--model", required=True)
    ap.add_argument("--timeout", type=float, default=300.0)
    ap.add_argument("--out", default=None, help="write raw results as JSON")
    args = ap.parse_args()

    results = []
    for i, prompt in enumerate(PROMPTS, 1):
        try:
            payload, elapsed = chat(args.base_url, args.model, prompt, args.timeout)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            results.append({"prompt": prompt, "ok": False, "error": str(exc), "seconds": None})
            print(f"{i}/{len(PROMPTS)}  ERROR  {exc}")
            continue

        message = payload["choices"][0]["message"]
        calls = message.get("tool_calls") or []
        ok = False
        detail = ""
        if calls:
            fn = calls[0].get("function", {})
            # A tool_call with unparseable or empty arguments is not a pass —
            # the orchestrator would fail on it exactly as if none were emitted.
            try:
                parsed = json.loads(fn.get("arguments") or "{}")
            except json.JSONDecodeError:
                parsed = {}
            ok = fn.get("name") == "run_command" and bool(parsed.get("command"))
            detail = parsed.get("command", fn.get("arguments", ""))[:70]
        else:
            detail = (message.get("content") or "")[:70].replace("\n", " ")

        results.append(
            {
                "prompt": prompt,
                "ok": ok,
                "seconds": round(elapsed, 2),
                "detail": detail,
            }
        )
        print(f"{i}/{len(PROMPTS)}  {'PASS' if ok else 'FAIL'}  {elapsed:6.2f}s  {detail}")

    passed = sum(1 for r in results if r["ok"])
    times = [r["seconds"] for r in results if r["seconds"] is not None]
    summary = {
        "model": args.model,
        "passed": passed,
        "total": len(PROMPTS),
        "p50_seconds": round(statistics.median(times), 2) if times else None,
        "max_seconds": round(max(times), 2) if times else None,
        "gate": "PASS" if passed >= 8 else "FAIL",
        "results": results,
    }
    print(
        f"\n{args.model}: {passed}/{len(PROMPTS)} tool calls, "
        f"p50 {summary['p50_seconds']}s, max {summary['max_seconds']}s "
        f"-> gate {summary['gate']} (bar is >=8/9)"
    )

    if args.out:
        with open(args.out, "w") as fh:
            json.dump(summary, fh, indent=2)
        print(f"wrote {args.out}")

    return 0 if summary["gate"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
