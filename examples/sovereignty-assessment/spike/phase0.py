#!/usr/bin/env python3
"""Phase 0 gate for the sovereignty-assessment Blueprint.

Answers one question before any Kubernetes work starts: can a ~1.7B CPU model be
trusted as the declaration classifier, given that the whole design leans on
schema-constrained decoding rather than a tool-calling loop?

Three checks, all against a locally running llama-server:

  A. EOS / stop behaviour. The EuroLLM GGUF conversions ship a ChatML template
     with no generation prompt, so the model has to emit <|im_end|> on its own.
  B. 20 real declaration-classifier calls under response_format: json_schema at
     temperature 0 -- every response must parse and validate, and the assigned
     SEALs must be monotone across declaration strength.
  C. Per-call latency and peak server RSS at --threads 4, CPU only.

Start the server first:

  llama-server -hf mradermacher/EuroLLM-1.7B-Instruct-GGUF:Q4_K_M \
    -a eurollm --host 127.0.0.1 --port 8000 --metrics --threads 4 -c 4096 -ngl 0

Then:  ./phase0.py [--base-url URL] [--model NAME] [--json out.json]

Stdlib only, so the spike needs no virtualenv.
"""

import argparse
import json
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request

# --------------------------------------------------------------------------
# The control under test.
#
# SOV-1.2 is deliberately a declaration-backed control: no cluster collector can
# prove where the humans administering a platform sit, so this is exactly the
# job the model is confined to in the design.
# --------------------------------------------------------------------------

CONTROL_QUESTION = (
    "Is operational control of the platform (administration, support and incident "
    "response) performed exclusively by personnel located within the EU/EEA and "
    "subject to EU jurisdiction?"
)

# llama-server never shows the schema to the model -- it only constrains
# sampling. The shape has to be restated in prose here or a 1.7B model emits
# grammar-valid nonsense.
SYSTEM_PROMPT = f"""You are a compliance assessor for the European Commission's Cloud Sovereignty Framework.

You are given one control question and one declaration written by the organisation being assessed. Assign a SEAL level from 0 to 4 using this rubric:

4 = fully satisfied, and the declaration cites concrete evidence (a named entity, a contract clause, an audit or certification).
3 = satisfied as a documented commitment, but with no independent verification cited.
2 = partially satisfied, or satisfied with material caveats or exceptions.
1 = intent or plan stated only, with no implementation.
0 = not satisfied, or the declaration does not address the control at all.

Judge only what the declaration actually says. Do not assume unstated good practice. An empty or irrelevant declaration is 0.

Reply with a single JSON object and nothing else, with exactly these three fields:
  "seal": an integer from 0 to 4
  "rationale": one sentence, at most 240 characters, quoting or paraphrasing what in the declaration drove the level
  "confidence": a number between 0 and 1

Control under assessment: {CONTROL_QUESTION}"""

# Supported-subset schema. No properties mixed with anyOf/oneOf, no nested $ref,
# maxLength instead of an unbounded string. llama.cpp drops unsupported keywords
# silently, so the confidence range is re-checked in Python rather than trusted
# to the grammar.
RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "seal": {"type": "integer", "minimum": 0, "maximum": 4},
        "rationale": {"type": "string", "maxLength": 240},
        "confidence": {"type": "number"},
    },
    "required": ["seal", "rationale", "confidence"],
    "additionalProperties": False,
}

# --------------------------------------------------------------------------
# Test A -- does generation stop?
# --------------------------------------------------------------------------

STOP_PROMPTS = [
    "In one sentence, what is the capital of Portugal?",
    "List three EU member states. Answer with the names only.",
    "Explain in two sentences why data residency matters for a public-sector cloud tender.",
]

TEMPLATE_MARKERS = ["<|im_start|>", "<|im_end|>", "<s>", "</s>"]

# --------------------------------------------------------------------------
# Test B -- 20 declarations spanning the strength range.
#
# Bands carry the expected SEAL window. They are not asserted per-row (a 1.7B
# model is allowed to be one level off on a judgement call); what is asserted is
# that the bands stay ordered. Row-level output goes in RESULTS.md so the
# semantic call is auditable rather than asserted away.
# --------------------------------------------------------------------------

DECLARATIONS = [
    # Band A -- strong, evidence cited. Expect 3-4.
    ("A1", "A", "All platform administration and 24/7 incident response is delivered by SUSE Software Solutions Germany GmbH from Nuremberg and Prague. This is fixed in clause 8.3 of the framework contract, which prohibits support access from outside the EEA, and was verified in our ISO/IEC 27001 surveillance audit of March 2026."),
    ("A2", "A", "Operational control sits entirely with our in-house SRE team, all of whom are employed in Ireland and France. Third-party vendor access is brokered through a jump host with EU-only IP allowlisting; the 2025 external penetration test report confirms no out-of-region administrative paths exist."),
    ("A3", "A", "Administration is performed by personnel in the EEA only. Our processor agreement (Annex II, section 4) names every sub-processor and their location, all within Germany, Spain and the Netherlands, and is audited annually under SOC 2 Type II."),
    ("A4", "A", "Platform operations are run from our datacentre in Milan by staff on Italian employment contracts. Support tooling enforces geofencing at the identity provider, and quarterly access reviews evidencing this are retained for seven years."),
    ("A5", "A", "Yes. Our managed service provider is EU-incorporated, all named administrators are EEA residents subject to EU jurisdiction, and the contract's clause 12 grants us audit rights that we exercised in November 2025 with no findings."),

    # Band B -- documented commitment, nothing verifying it. Expect 2-3.
    ("B1", "B", "Our internal policy requires that all platform administration be carried out by EU-based staff. The policy is approved by the CISO and communicated to all engineering teams."),
    ("B2", "B", "We have contractually committed to EEA-only operational control in our master services agreement. No independent audit of this commitment has been carried out yet."),
    ("B3", "B", "All support personnel are located in the European Union. This is documented in our operations handbook."),
    ("B4", "B", "The service is operated by our subsidiary in Poland. Staff are Polish nationals working under Polish employment law."),
    ("B5", "B", "Incident response is handled exclusively by the EU operations team according to our documented runbook. We have not commissioned external verification."),

    # Band C -- hedged, partial, or caveated. Expect 1-2.
    ("C1", "C", "Operational control is primarily EU-based, though our follow-the-sun support model routes tickets raised outside European business hours to a partner team in Bangalore."),
    ("C2", "C", "Most administration is performed from Amsterdam. A small number of escalation engineers in the United States retain break-glass access for severity-1 incidents."),
    ("C3", "C", "We intend to migrate all operational control to EU personnel during 2026. Today the platform is administered from our global operations centre."),
    ("C4", "C", "Our staff are in the EU, but the underlying infrastructure is managed by a hyperscaler whose support organisation we do not control and whose engineers may be located anywhere."),
    ("C5", "C", "We are working towards EEA-only operations. A project has been funded and a target architecture agreed, but no controls are in place yet."),

    # Band D -- non-compliant, irrelevant or empty. Expect 0-1.
    ("D1", "D", "Platform administration is performed by our operations team in Seattle, Washington. Support follows US business hours."),
    ("D2", "D", "No. Operational control is outsourced to a provider headquartered in the United States and subject to the CLOUD Act."),
    ("D3", "D", "Our datacentre uses free cooling and we have reduced PUE to 1.15 across the estate, exceeding our 2026 sustainability target."),
    ("D4", "D", "The platform is written in Go and deployed with Helm onto a Kubernetes cluster running SUSE Linux Enterprise."),
    ("D5", "D", ""),
]

BAND_EXPECTATION = {"A": (3, 4), "B": (2, 3), "C": (1, 2), "D": (0, 1)}


def post(base_url, path, payload, timeout=300):
    req = urllib.request.Request(
        base_url.rstrip("/") + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def server_pid(port):
    try:
        out = subprocess.run(
            ["lsof", "-t", f"-iTCP:{port}", "-sTCP:LISTEN"],
            capture_output=True, text=True, check=True,
        ).stdout.split()
        return int(out[0]) if out else None
    except Exception:
        return None


def rss_mb(pid):
    if pid is None:
        return None
    try:
        out = subprocess.run(
            ["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True, check=True
        ).stdout.strip()
        return round(int(out) / 1024, 1)
    except Exception:
        return None


def validate(obj):
    """Return a list of schema violations. Empty list means valid."""
    errs = []
    if not isinstance(obj, dict):
        return ["not an object"]
    extra = set(obj) - {"seal", "rationale", "confidence"}
    if extra:
        errs.append(f"extra keys {sorted(extra)}")
    for k in ("seal", "rationale", "confidence"):
        if k not in obj:
            errs.append(f"missing {k}")
    if "seal" in obj:
        if not isinstance(obj["seal"], int) or isinstance(obj["seal"], bool):
            errs.append("seal not an integer")
        elif not 0 <= obj["seal"] <= 4:
            errs.append(f"seal {obj['seal']} out of range")
    if "rationale" in obj:
        if not isinstance(obj["rationale"], str):
            errs.append("rationale not a string")
        elif len(obj["rationale"]) > 240:
            errs.append(f"rationale {len(obj['rationale'])} chars > 240")
    if "confidence" in obj:
        if not isinstance(obj["confidence"], (int, float)) or isinstance(obj["confidence"], bool):
            errs.append("confidence not a number")
        elif not 0.0 <= obj["confidence"] <= 1.0:
            errs.append(f"confidence {obj['confidence']} out of [0,1]")
    return errs


def test_stop(base_url, model):
    print("\n=== Test A: EOS / stop behaviour ===")
    rows = []
    for prompt in STOP_PROMPTS:
        r = post(base_url, "/v1/chat/completions", {
            "model": model, "temperature": 0, "max_tokens": 300,
            "messages": [
                {"role": "system", "content": "You are a concise assistant."},
                {"role": "user", "content": prompt},
            ],
        })
        choice = r["choices"][0]
        content = choice["message"]["content"]
        leaked = [m for m in TEMPLATE_MARKERS if m in content]
        ok = choice["finish_reason"] == "stop" and not leaked
        rows.append({
            "prompt": prompt,
            "finish_reason": choice["finish_reason"],
            "completion_tokens": r["usage"]["completion_tokens"],
            "leaked_markers": leaked,
            "content": content,
            "ok": ok,
        })
        print(f"  [{'ok' if ok else 'FAIL'}] finish_reason={choice['finish_reason']} "
              f"tokens={r['usage']['completion_tokens']} leaked={leaked or 'none'}")
        print(f"        {content.strip()[:160]!r}")
    return rows


def classify_chat(base_url, model, messages):
    """The OpenAI-shaped path. Kept because it is what the design wants, but in
    llama.cpp b10964 `response_format: json_schema` throws 'Failed to initialize
    samplers' for most templates -- see RESULTS.md."""
    r = post(base_url, "/v1/chat/completions", {
        "model": model, "temperature": 0, "max_tokens": 300, "messages": messages,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "declaration_assessment", "schema": RESPONSE_SCHEMA},
        },
    })
    return (r["choices"][0]["message"]["content"], r["choices"][0]["finish_reason"],
            r["usage"]["completion_tokens"])


def classify_completion(base_url, _model, messages):
    """/apply-template + /completion. Model-agnostic (the server renders the
    prompt with its own template, including the generation prompt) and the only
    route where schema constraint actually works in this build. Takes _model for
    signature parity with classify_chat; /completion serves the loaded model."""
    prompt = post(base_url, "/apply-template", {"messages": messages})["prompt"]
    r = post(base_url, "/completion", {
        "prompt": prompt, "temperature": 0, "n_predict": 300,
        "json_schema": RESPONSE_SCHEMA, "cache_prompt": True,
    })
    finish = "stop" if r.get("stop_type") in ("eos", "word") else r.get("stop_type", "?")
    return r["content"], finish, r.get("tokens_predicted", 0)


def test_classify(base_url, model, pid, transport):
    print(f"\n=== Test B: declaration classifier, 20x at temperature 0 (transport={transport}) ===")
    call = classify_chat if transport == "chat" else classify_completion
    rows, peak_rss = [], rss_mb(pid) or 0
    for cid, band, text in DECLARATIONS:
        user = f"Declaration:\n{text}" if text else "Declaration:\n(the organisation provided no declaration for this control)"
        messages = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}]
        t0 = time.perf_counter()
        try:
            raw, finish, tokens = call(base_url, model, messages)
            latency = time.perf_counter() - t0
        except (urllib.error.URLError, KeyError) as e:
            rows.append({"id": cid, "band": band, "declaration": text, "errors": [f"request failed: {e}"],
                         "latency_s": round(time.perf_counter() - t0, 2), "raw": None, "parsed": None})
            print(f"  [FAIL] {cid} request failed: {e}")
            continue

        errs, parsed = [], None
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as e:
            errs.append(f"not valid JSON: {e}")
        if parsed is not None:
            errs.extend(validate(parsed))
        if finish != "stop":
            errs.append(f"finish_reason={finish}")

        peak_rss = max(peak_rss, rss_mb(pid) or 0)
        rows.append({
            "id": cid, "band": band, "declaration": text, "raw": raw, "parsed": parsed,
            "errors": errs, "latency_s": round(latency, 2), "completion_tokens": tokens,
        })
        seal = parsed.get("seal") if isinstance(parsed, dict) else "?"
        print(f"  [{'ok  ' if not errs else 'FAIL'}] {cid} band={band} seal={seal} "
              f"{latency:5.2f}s {tokens:3d}tok {('errors=' + str(errs)) if errs else ''}")
    return rows, peak_rss


def check_monotonic(rows):
    """Band means must be strictly ordered A > B >= C > D, and no A may fall
    below any D. Per-row exactness is not required; ordering is."""
    seals = {b: [] for b in "ABCD"}
    for r in rows:
        if isinstance(r.get("parsed"), dict) and isinstance(r["parsed"].get("seal"), int):
            seals[r["band"]].append(r["parsed"]["seal"])
    problems = []
    if any(not seals[b] for b in "ABCD"):
        means = {b: (statistics.mean(v) if v else None) for b, v in seals.items()}
        problems.append("a band produced no parseable seals")
    else:
        means = {b: statistics.mean(seals[b]) for b in "ABCD"}
        a, b_, c, d = means["A"], means["B"], means["C"], means["D"]
        if not a > b_:
            problems.append(f"mean(A)={a:.2f} not > mean(B)={b_:.2f}")
        if not b_ >= c:
            problems.append(f"mean(B)={b_:.2f} not >= mean(C)={c:.2f}")
        if not c > d:
            problems.append(f"mean(C)={c:.2f} not > mean(D)={d:.2f}")
        if min(seals["A"]) <= max(seals["D"]):
            problems.append(f"min(A)={min(seals['A'])} <= max(D)={max(seals['D'])}")

    in_window = sum(
        1 for b in "ABCD" for s in seals[b]
        if BAND_EXPECTATION[b][0] <= s <= BAND_EXPECTATION[b][1]
    )
    return {"seals": seals, "means": means, "problems": problems,
            "in_expected_window": in_window, "total": sum(len(v) for v in seals.values())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")
    ap.add_argument("--model", default="eurollm")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--transport", choices=("completion", "chat"), default="completion",
                    help="completion = /apply-template + /completion (works); "
                         "chat = OpenAI response_format (throws in b10964)")
    ap.add_argument("--json", default=None, help="write the full result record here")
    args = ap.parse_args()

    pid = server_pid(args.port)
    props = json.load(urllib.request.urlopen(args.base_url.rstrip("/") + "/props", timeout=30))

    stop_rows = test_stop(args.base_url, args.model)
    cls_rows, peak_rss = test_classify(args.base_url, args.model, pid, args.transport)
    mono = check_monotonic(cls_rows)

    lat = [r["latency_s"] for r in cls_rows if "latency_s" in r]
    valid = sum(1 for r in cls_rows if not r["errors"])

    gates = {
        "A_stops_cleanly": all(r["ok"] for r in stop_rows),
        "B_schema_valid_20_of_20": valid == len(DECLARATIONS),
        "C_seals_monotone": not mono["problems"],
    }
    passed = all(gates.values())

    print("\n=== Test C: measurements (threads=4, -ngl 0) ===")
    print(f"  latency p50 {statistics.median(lat):.2f}s  max {max(lat):.2f}s  "
          f"mean {statistics.mean(lat):.2f}s  over {len(lat)} calls")
    print(f"  peak llama-server RSS {peak_rss} MB")
    print(f"  band means: " + "  ".join(
        f"{b}={mono['means'][b]:.2f}" if mono["means"][b] is not None else f"{b}=n/a" for b in "ABCD"))
    print(f"  seals inside expected window: {mono['in_expected_window']}/{mono['total']}")

    print("\n=== GATE ===")
    for k, v in gates.items():
        print(f"  [{'PASS' if v else 'FAIL'}] {k}")
    for p in mono["problems"]:
        print(f"         monotonicity: {p}")
    print(f"  => {'PASS' if passed else 'FAIL'}")

    if args.json:
        with open(args.json, "w") as f:
            json.dump({
                "model_path": props.get("model_path"),
                "build_info": props.get("build_info"),
                "eos_token": props.get("eos_token"),
                "chat_template": props.get("chat_template"),
                "transport": args.transport,
                "stop_tests": stop_rows,
                "classification": cls_rows,
                "monotonicity": mono,
                "latency_s": {"p50": statistics.median(lat), "max": max(lat),
                              "mean": statistics.mean(lat), "n": len(lat)},
                "peak_rss_mb": peak_rss,
                "gates": gates,
                "passed": passed,
            }, f, indent=2)
        print(f"\nwrote {args.json}")

    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
