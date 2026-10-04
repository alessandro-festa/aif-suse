"""Evaluate a LoRA adapter that lora_train.py saved: its loss on held-out examples against the base
model's, and both models' answers to a few prompts side by side. Run it with the training run's kept
checkpoint volume mounted as the checkpoint volume (Deploy: Checkpoints, SDK: checkpoints=<volume>);
the adapter is found under $CHECKPOINT_DIR. One model load serves both: the adapter is switched off
for the base model's turn. The held-out range is checked against the training range the adapter's
training.json records, and both are reported. Ends with an AIF_RESULT line, so the run's detail
shows the comparison."""
import contextlib, hashlib, json, math, os, subprocess, sys, threading, time

print("INFO | installing transformers, peft, datasets (about a minute)", flush=True)
# the same versions lora_train.py trains with: an adapter loads with the PEFT version that wrote it
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--no-cache-dir", "transformers==4.51.3", "peft==0.15.2", "datasets==3.5.0", "accelerate==1.6.0"], check=True)

os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
import torch
torch.cuda.set_per_process_memory_fraction(float(os.environ.get("CUDA_MEMORY_FRACTION", "0.9")))
from datasets import load_dataset
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL = os.environ.get("MODEL", "Qwen/Qwen2.5-1.5B-Instruct")
CKPT = os.environ.get("CHECKPOINT_DIR", "/mnt/checkpoints")
EXAMPLES = int(os.environ.get("EVAL_EXAMPLES", "64"))
# held-out examples [EVAL_FROM, EVAL_FROM + EVAL_EXAMPLES) of the dataset's train split; checked
# against the training range the adapter's training.json records
EVAL_FROM = int(os.environ.get("EVAL_FROM", os.environ.get("HOLDOUT_FROM", "5000")))
SEQ = int(os.environ.get("SEQ_LEN", "512"))
NEW_TOKENS = int(os.environ.get("MAX_NEW_TOKENS", "120"))
PROMPTS = json.loads(os.environ["PROMPTS"]) if os.environ.get("PROMPTS") else [
    "Give three tips for staying healthy.",
    "Rewrite this sentence in the passive voice: The committee approved the new budget.",
    "Explain what a hash table is to a beginner, in two sentences.",
]
checks, metrics = [], {}
# the run cannot succeed on a retry (no adapter, an overlapping range): the training chart fails the
# Job at once on this exit code (job.failFastExitCodes) instead of re-running it
EXIT_NO_RETRY = 3


def no_retry():
    """Exit 3, and leave the marker the chart's torchrun wrapper turns into exit 3 (torchrun itself
    reports any worker failure as exit 1)."""
    with contextlib.suppress(OSError):
        open(os.environ.get("AIF_NO_RETRY_FILE", "/tmp/tj/no-retry"), "w").close()
    sys.exit(EXIT_NO_RETRY)


def check(name, ok, detail, warn=False):
    checks.append({"name": name, "ok": ok, **({"warn": True} if warn else {}), "detail": detail})
    print(f"{'PASS' if ok and not warn else 'WARN' if ok else 'FAIL'}  {name}  {detail}", flush=True)


def report(status):
    env = {"model": MODEL, "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none",
           "node": os.environ.get("NODE_NAME", "")}
    print("AIF_RESULT " + json.dumps({"test": "LoRA Evaluation", "status": status, "checks": checks,
                                      "metrics": metrics, "env": env}), flush=True)


@contextlib.contextmanager
def heartbeat(what, every=30):
    """A line every `every` seconds while `what` runs, so a quiet download does not let a proxy close
    the log stream (see lora_train.py)."""
    done, t0 = threading.Event(), time.time()
    def beat():
        while not done.wait(every):
            print(f"INFO | {what}: {time.time() - t0:.0f}s", flush=True)
    threading.Thread(target=beat, daemon=True).start()
    try:
        yield
    finally:
        done.set()


# 1. the adapter: ADAPTER (a directory), else the one directory under $CHECKPOINT_DIR with an adapter in it
adapter = os.environ.get("ADAPTER", "")
if not adapter:
    found = sorted(d for d, _, fs in os.walk(CKPT) if "adapter_config.json" in fs)
    # a run's own adapter (beside its training.json: the best epoch) over its per-epoch checkpoints
    top = [d for d in found if os.path.exists(os.path.join(d, "training.json"))] or [d for d in found if "/epoch-" not in d] or found
    adapter = top[-1] if top else ""
    if len(found) > 1:
        print(f"INFO | {len(found)} adapters under {CKPT}; evaluating {adapter} (set ADAPTER to choose)", flush=True)
if not adapter or not os.path.exists(os.path.join(adapter, "adapter_config.json")):
    check("Adapter found", False, f"no adapter_config.json under {adapter or CKPT}: mount the training run's checkpoint volume, or set ADAPTER")
    report("fail")
    no_retry()
cfg = json.load(open(os.path.join(adapter, "adapter_config.json")))
check("Adapter found", True, f"{adapter} (rank {cfg.get('r')}, base {cfg.get('base_model_name_or_path', '?')})")
metrics["Adapter"] = adapter

# provenance: what the adapter was trained on (training.json, written by lora_train.py)
trained = {}
if os.path.exists(os.path.join(adapter, "training.json")):
    trained = json.load(open(os.path.join(adapter, "training.json")))
if trained.get("run"):
    metrics["Training run"] = trained["run"]
# EVAL_DATASET: a JSON Lines file of held-out questions ({instruction, input, reference, expect_*});
# without it, examples [EVAL_FROM, EVAL_FROM + EVAL_EXAMPLES) of a Hugging Face dataset's train split
EVAL_DATASET = os.environ.get("EVAL_DATASET", "")


def norm(q):
    return " ".join(str(q).lower().split())


if EVAL_DATASET:
    raw = open(EVAL_DATASET, "rb").read()
    rows = [json.loads(l) for l in raw.decode().splitlines() if l.strip()]
    metrics["Evaluated on"] = f"{os.path.basename(EVAL_DATASET)} ({len(rows)} questions, sha256 {hashlib.sha256(raw).hexdigest()[:12]})"
    # held out: no evaluation question may be a training question. The training file is found where the
    # adapter's run read it (the same ConfigMap or volume), or at TRAIN_DATASET.
    train_file = os.environ.get("TRAIN_DATASET") or trained.get("dataset", "")
    if trained.get("file"):
        metrics["Trained on"] = f"{trained['file']} ({trained['examples'][1]} examples, sha256 {trained.get('sha256', '')[:12]})"
    if train_file and os.path.isfile(train_file):
        train_raw = open(train_file, "rb").read()
        seen = {norm((json.loads(l).get("instruction", "") + " " + (json.loads(l).get("input") or ""))) for l in train_raw.decode().splitlines() if l.strip()}
        same = sum(norm(r.get("instruction", "") + " " + (r.get("input") or "")) in seen for r in rows)
        stale = trained.get("sha256") and hashlib.sha256(train_raw).hexdigest() != trained["sha256"]
        check("Evaluation is held out", same == 0,
              f"{same} of {len(rows)} evaluation questions are training questions" if same else
              f"none of the {len(rows)} questions is in the training file" + (" (which has changed since training)" if stale else ""),
              warn=bool(stale) and same == 0)
        if same:
            report("fail")
            no_retry()
    else:
        check("Evaluation is held out", True, "the training file is not mounted here, so the questions are assumed new to the adapter", warn=True)
else:
    DATASET = os.environ.get("DATASET") or trained.get("dataset") or "yahma/alpaca-cleaned"
    eval_range = [EVAL_FROM, EVAL_FROM + EXAMPLES]
    metrics["Evaluated on"] = f"{DATASET} train[{eval_range[0]}:{eval_range[1]}]"
    if trained:
        lo, hi = trained.get("examples", [0, 0])
        metrics["Trained on"] = f"{trained.get('dataset')} {trained.get('split', 'train')}[{lo}:{hi}]"
        overlap = trained.get("dataset") == DATASET and eval_range[0] < hi and lo < eval_range[1]
        check("Evaluation is held out", not overlap,
              f"examples {eval_range} overlap the training range [{lo}, {hi}): set EVAL_FROM to at least {hi}" if overlap else
              f"{DATASET} [{eval_range[0]}, {eval_range[1]}) is clear of the training range [{lo}, {hi})")
        if overlap:
            report("fail")
            no_retry()
    else:
        check("Evaluation is held out", True, f"the adapter has no training.json (trained before lora_train.py recorded it), "
              f"so [{eval_range[0]}, {eval_range[1]}) is assumed clear of its training data", warn=True)

# 2. base model, with the adapter on top
with heartbeat(f"loading {MODEL}"):
    tok = AutoTokenizer.from_pretrained(MODEL)
    base = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.bfloat16).cuda()
try:
    model = PeftModel.from_pretrained(base, adapter)
except Exception as e:  # e.g. an adapter trained on another base model
    check("Adapter loads", False, f"{type(e).__name__}: {e}"[:400])
    report("fail")
    no_retry()
model.eval()
check("Adapter loads", True, f"on {MODEL}")

# 3. held-out loss on the answers only, one example at a time (no padding, little memory). The
# question is masked out: training saw whole conversations, so scoring the question too would credit
# the adapter for predicting Alpaca-style questions rather than for better answers.
if EVAL_DATASET:
    data = rows
else:
    with heartbeat("loading the dataset"):
        data = list(load_dataset(DATASET, split=f"train[{eval_range[0]}:{eval_range[1]}]"))
    rows = []
if not os.environ.get("PROMPTS") and rows:
    PROMPTS = [r["instruction"] for r in rows[:3]]


def chat(user, assistant=None):
    msgs = [{"role": "user", "content": user}] + ([{"role": "assistant", "content": assistant}] if assistant is not None else [])
    return tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=assistant is None)


@torch.no_grad()
def mean_loss():
    total, tokens = 0.0, 0
    for i, r in enumerate(data, 1):
        if i % 25 == 0:
            print(f"INFO | loss{' (base model)' if base_turn else ''}: {i} of {len(data)} questions", flush=True)
        user = (r["instruction"] + "\n" + (r.get("input") or "")).strip()
        ids = tok(chat(user, r.get("output") or r.get("reference") or ""), truncation=True, max_length=SEQ, return_tensors="pt")["input_ids"].cuda()
        asked = len(tok(chat(user))["input_ids"])  # the question and the assistant turn's opening
        labels = ids.clone()
        labels[:, :asked] = -100
        n = int((labels[:, 1:] != -100).sum())
        if n == 0:
            continue  # truncated to no answer at all
        total += model(input_ids=ids, labels=labels).loss.item() * n
        tokens += n
    return total / tokens


t0 = time.time()
base_turn = True
with model.disable_adapter():
    base_loss = mean_loss()
base_turn = False
lora_loss = mean_loss()
gain = (base_loss - lora_loss) / base_loss * 100
metrics.update({"Held-out examples": str(len(data)), "Loss on": "answers only", "Base model loss": f"{base_loss:.3f}", "Adapter loss": f"{lora_loss:.3f}",
                "Loss reduction": f"{gain:.1f}%", "Base perplexity": f"{math.exp(base_loss):.2f}",
                "Adapter perplexity": f"{math.exp(lora_loss):.2f}", "Evaluation time (s)": f"{time.time() - t0:.0f}"})
print(f"INFO | held-out loss: base {base_loss:.3f}, adapter {lora_loss:.3f} ({gain:+.1f}% lower)", flush=True)
check("Adapter improves held-out loss", lora_loss < base_loss,
      f"{base_loss:.3f} -> {lora_loss:.3f} ({gain:.1f}% lower) on the answers of {len(data)} examples it was not trained on")


# 4. side by side
@torch.no_grad()
def answer(prompt):
    enc = tok(chat(prompt), return_tensors="pt").to("cuda")
    # greedy, so the two answers differ only by the adapter; the model's sampling defaults are unset
    out = model.generate(**enc, max_new_tokens=NEW_TOKENS, do_sample=False, temperature=None, top_p=None, top_k=None,
                         pad_token_id=tok.eos_token_id)
    return tok.decode(out[0, enc["input_ids"].shape[1]:], skip_special_tokens=True).strip()


differ = 0
for p in PROMPTS:
    with model.disable_adapter():
        a = answer(p)
    b = answer(p)
    differ += a != b
    print(f"\n=== {p}\n--- base model:\n{a}\n--- with the adapter:\n{b}", flush=True)
print(flush=True)
check("Adapter changes the answers", differ > 0, f"{differ} of {len(PROMPTS)} answers differ from the base model's",
      warn=differ == 0)

# 5. task scores, for evaluation questions that say what a correct answer contains (expect_any: at
# least one of these terms; expect_none: none of these; expect_command: this command, verbatim)
graded = [r for r in rows if r.get("expect_any") or r.get("expect_none") or r.get("expect_command")]


@torch.no_grad()
def answers(questions, batch=8):
    tok.padding_side = "left"  # generation continues from the right
    out = []
    for i in range(0, len(questions), batch):
        enc = tok([chat(q) for q in questions[i:i + batch]], return_tensors="pt", padding=True).to("cuda")
        gen = model.generate(**enc, max_new_tokens=NEW_TOKENS, do_sample=False, temperature=None, top_p=None, top_k=None,
                             pad_token_id=tok.pad_token_id or tok.eos_token_id)
        out += [tok.decode(g[enc["input_ids"].shape[1]:], skip_special_tokens=True) for g in gen]
        print(f"INFO | answering ({who_answers}): {len(out)} of {len(questions)}, {time.time() - t1:.0f}s", flush=True)
    return out


def grade(r, text):
    """(term ok, command ok) for one answer; None where the question does not test it."""
    t = text.lower()
    term = None
    if r.get("expect_any") or r.get("expect_none"):
        term = (not r.get("expect_any") or any(x.lower() in t for x in r["expect_any"])) and \
               not any(x.lower() in t for x in r.get("expect_none") or [])
    cmd = None
    if r.get("expect_command"):
        cmd = " ".join(r["expect_command"].split()) in " ".join(text.split())
    return term, cmd


if graded:
    t1 = time.time()
    qs = [(r["instruction"] + "\n" + (r.get("input") or "")).strip() for r in graded]
    who_answers = "base model"
    with model.disable_adapter():
        base_ans = answers(qs)
    who_answers = "adapter"
    lora_ans = answers(qs)
    score = {}
    for who, ans in (("base", base_ans), ("adapter", lora_ans)):
        g = [grade(r, a) for r, a in zip(graded, ans)]
        terms = [x for x, _ in g if x is not None]
        cmds = [y for _, y in g if y is not None]
        allok = [all(v for v in pair if v is not None) for pair in g]
        score[who] = {"correct": sum(allok) / len(allok), "terms": sum(terms) / len(terms) if terms else None,
                      "commands": sum(cmds) / len(cmds) if cmds else None}
    pct = lambda v: "-" if v is None else f"{v * 100:.0f}%"
    metrics.update({"Graded questions": str(len(graded)),
                    "Correct answers (base / adapter)": f"{pct(score['base']['correct'])} / {pct(score['adapter']['correct'])}",
                    "Expected terms (base / adapter)": f"{pct(score['base']['terms'])} / {pct(score['adapter']['terms'])}",
                    "Commands (base / adapter)": f"{pct(score['base']['commands'])} / {pct(score['adapter']['commands'])}",
                    "Grading time (s)": f"{time.time() - t1:.0f}"})
    gain_pts = (score["adapter"]["correct"] - score["base"]["correct"]) * 100
    check("Adapter answers more questions correctly", gain_pts > 0,
          f"{pct(score['base']['correct'])} -> {pct(score['adapter']['correct'])} of {len(graded)} graded questions ({gain_pts:+.0f} points)")
    # wrong terms: answers naming something a correct answer would not (expect_none)
    has_none = [(r, a, b) for r, a, b in zip(graded, base_ans, lora_ans) if r.get("expect_none")]
    if has_none:
        wrong = lambda r, x: any(t.lower() in x.lower() for t in r["expect_none"])
        metrics["Wrong terms (base / adapter)"] = (f"{sum(wrong(r, a) for r, a, _ in has_none)}/{len(has_none)} / "
                                                   f"{sum(wrong(r, b) for r, _, b in has_none)}/{len(has_none)}")
    # EVAL_GROUPS: record fields to break the score down by (any field the questions carry)
    group_fields = [g.strip() for g in os.environ.get("EVAL_GROUPS", "area,type").split(",") if g.strip()]
    for field, label in ((g, f"Correct by {g}") for g in group_fields):
        groups = {}
        for r, a, b in zip(graded, base_ans, lora_ans):
            ok = lambda x: all(v for v in grade(r, x) if v is not None)
            key = str(r.get(field, "-"))
            n, bo, ao = groups.get(key, (0, 0, 0))
            groups[key] = (n + 1, bo + ok(a), ao + ok(b))
        for k, (n, bo, ao) in sorted(groups.items()):
            metrics[f"{label}: {k} (base / adapter)"] = f"{bo}/{n} / {ao}/{n}"
    # every answer, beside the adapter: eval/<label>-<time>.jsonl (the run's log goes with its pod)
    label = os.environ.get("EVAL_LABEL") or os.path.splitext(os.path.basename(EVAL_DATASET or "heldout"))[0]
    saved = os.path.join(adapter, "eval", f"{label}-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.jsonl")
    with contextlib.suppress(OSError):
        os.makedirs(os.path.dirname(saved), exist_ok=True)
        with open(saved, "w") as f:
            for r, a, b in zip(graded, base_ans, lora_ans):
                gb, ga = grade(r, a), grade(r, b)
                f.write(json.dumps({"instruction": r["instruction"], "area": r.get("area"), "type": r.get("type"), "fact": r.get("fact"),
                                    "reference": r.get("reference"), "base": a, "adapter": b,
                                    "base_correct": all(v for v in gb if v is not None), "adapter_correct": all(v for v in ga if v is not None)},
                                   ensure_ascii=False) + "\n")
        metrics["Answers saved to"] = saved
        print(f"INFO | every answer saved to {saved}", flush=True)
metrics["Peak GPU memory (GiB)"] = f"{torch.cuda.max_memory_allocated() / 2**30:.2f}"

report("pass" if all(c["ok"] for c in checks) else "fail")
