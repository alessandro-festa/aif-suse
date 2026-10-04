"""LoRA fine-tune of Qwen2.5-1.5B-Instruct on an instruction dataset, sized for a 6 GiB GPU share: bf16
weights (or 4-bit NF4 with QUANT=nf4), gradient checkpointing, short sequences. Model and dataset
downloads go to $HF_HOME; the adapter, a checkpoint per epoch and training.json go to
$CHECKPOINT_DIR/$RUN_NAME (the run's kept checkpoint volume).

Every setting is an environment variable, recorded in training.json; the defaults reproduce the
original example (rank 16 on the attention projections, constant learning rate, STEPS steps).

  data      DATASET (a Hugging Face dataset, or a JSON Lines file of {instruction, input, output}),
            TRAIN_FROM, MASK_PROMPT (loss on the answers only), VAL_FRACTION (hold out that share of
            the training phrasings: validation loss each epoch, and the best epoch is kept)
  length    STEPS, or EPOCHS (with a file dataset); BATCH; SEQ_LEN
  adapter   LORA_R, LORA_ALPHA, LORA_DROPOUT, LORA_TARGETS (attention | all-linear), RSLORA, DORA,
            LORA_INIT (gaussian | pissa | eva), EVA_BATCHES (how many batches EVA may read, default 8)
  optimiser LR, LR_SCHEDULE (constant | cosine), WARMUP (fraction of the steps), SEED
  base      MODEL, QUANT (none | nf4)
"""
import contextlib, hashlib, json, math, os, random, shutil, subprocess, sys, threading, time

QUANT = os.environ.get("QUANT", "none")
LIBS = ["transformers==4.51.3", "peft==0.15.2", "datasets==3.5.0", "accelerate==1.6.0"] + (["bitsandbytes==0.45.5"] if QUANT == "nf4" else [])
print(f"INFO | installing {', '.join(LIBS)} (about a minute)", flush=True)
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--no-cache-dir", *LIBS], check=True)

# Under a GPU-memory cap (KAI share + HAMi-core) the cap counts everything the process holds, cached
# blocks included. Expandable segments keep fragmentation down, and a per-process fraction makes
# PyTorch free its cache before the cap would refuse an allocation (logged by HAMi-core as an OOM).
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
import torch
torch.cuda.set_per_process_memory_fraction(float(os.environ.get("CUDA_MEMORY_FRACTION", "0.9")))
from datasets import load_dataset
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer


def env(name, default, cast=str):
    v = os.environ.get(name, "")
    return cast(v) if v != "" else default


flag = lambda name: os.environ.get(name, "0") in ("1", "true", "yes")

MODEL = env("MODEL", "Qwen/Qwen2.5-1.5B-Instruct")
STEPS = env("STEPS", 60, int)
EPOCHS = env("EPOCHS", 0.0, float)
SEQ = env("SEQ_LEN", 256, int)
BATCH = env("BATCH", 2, int)
DATASET = env("DATASET", "yahma/alpaca-cleaned")
TRAIN_FROM = env("TRAIN_FROM", 0, int)
MASK_PROMPT = flag("MASK_PROMPT")
VAL_FRACTION = env("VAL_FRACTION", 0.0, float)
R = env("LORA_R", 16, int)
ALPHA = env("LORA_ALPHA", 2 * R, int)
DROPOUT = env("LORA_DROPOUT", 0.05, float)
TARGETS = env("LORA_TARGETS", "attention")
RSLORA, DORA = flag("RSLORA"), flag("DORA")
INIT = env("LORA_INIT", "gaussian")
LR = env("LR", 2e-4, float)
SCHEDULE = env("LR_SCHEDULE", "constant")
WARMUP = env("WARMUP", 0.0, float)
SEED = env("SEED", 42, int)
RUN = os.environ.get("RUN_NAME", "lora")
out = os.path.join(os.environ.get("CHECKPOINT_DIR", "/tmp/out"), RUN)
random.seed(SEED)
torch.manual_seed(SEED)


def no_retry(msg):
    """A run that cannot succeed on a retry: exit 3, and leave the marker the training chart's torchrun
    wrapper turns into exit 3 (job.failFastExitCodes), rather than be re-run as it is."""
    print(f"ERROR | {msg}", flush=True)
    with contextlib.suppress(OSError):
        open(os.environ.get("AIF_NO_RETRY_FILE", "/tmp/tj/no-retry"), "w").close()
    sys.exit(3)


@contextlib.contextmanager
def heartbeat(what, every=30):
    """A line every `every` seconds while `what` runs: a download prints nothing for minutes, and a
    log stream that is quiet that long can be closed by a proxy on the way (the log viewer then shows
    Disconnected)."""
    cache = os.environ.get("HF_HOME") or os.path.expanduser("~/.cache/huggingface")
    done, t0 = threading.Event(), time.time()
    def size():
        n = 0
        for d, _, fs in os.walk(cache):
            for f in fs:
                try:  # a partial download is renamed as it completes: it can be gone by now
                    n += 0 if os.path.islink(os.path.join(d, f)) else os.path.getsize(os.path.join(d, f))
                except OSError:
                    pass
        return n
    def beat():
        while not done.wait(every):
            print(f"INFO | {what}: {time.time() - t0:.0f}s, {size() / 2**30:.2f} GiB in {cache}", flush=True)
    threading.Thread(target=beat, daemon=True).start()
    try:
        yield
    finally:
        done.set()


free, total = torch.cuda.mem_get_info()
print(f"GPU share: {free / 2**30:.2f} GiB free of {total / 2**30:.2f} GiB visible ({torch.cuda.get_device_name(0)})", flush=True)

# ---- data
source = {"dataset": DATASET, "split": "train"}
if os.path.isfile(DATASET):
    raw = open(DATASET, "rb").read()
    rows = [json.loads(l) for l in raw.decode().splitlines() if l.strip()]
    source.update({"file": os.path.basename(DATASET), "sha256": hashlib.sha256(raw).hexdigest(), "examples": [0, len(rows)]})
    print(f"INFO | {len(rows)} examples from {DATASET} (sha256 {source['sha256'][:12]})", flush=True)
else:
    n = STEPS * BATCH
    source["examples"] = [TRAIN_FROM, TRAIN_FROM + n]
    print(f"INFO | loading examples [{TRAIN_FROM}, {TRAIN_FROM + n}) of {DATASET}", flush=True)
    with heartbeat("loading the dataset"):
        rows = list(load_dataset(DATASET, split=f"train[{TRAIN_FROM}:{TRAIN_FROM + n}]"))

# validation: one phrasing of a fact that has several (its other phrasings stay in training), so the
# validation loss measures learning the fact, not memorising the example; random rows without fact ids
val_rows = []
if VAL_FRACTION > 0:
    want = max(1, round(len(rows) * VAL_FRACTION))
    by_fact = {}
    for i, r in enumerate(rows):
        if r.get("fact"):
            by_fact.setdefault(r["fact"], []).append(i)
    pool = [random.choice(ix) for ix in by_fact.values() if len(ix) >= 3] or list(range(len(rows)))
    random.shuffle(pool)
    held = set(pool[:want])
    val_rows = [r for i, r in enumerate(rows) if i in held]
    rows = [r for i, r in enumerate(rows) if i not in held]
    source["validation"] = {"examples": len(val_rows), "from": "training phrasings of facts with 3 or more"}
    print(f"INFO | {len(val_rows)} examples held out for validation, {len(rows)} to train on", flush=True)

steps_per_epoch = math.ceil(len(rows) / BATCH)
total_steps = math.ceil(steps_per_epoch * EPOCHS) if EPOCHS else STEPS
epochs = EPOCHS or round(total_steps * BATCH / len(rows), 2)

# ---- model and adapter
print(f"INFO | loading {MODEL}{' in 4-bit NF4' if QUANT == 'nf4' else ''} (first run downloads it to {os.environ.get('HF_HOME', 'the cache')})", flush=True)
with heartbeat(f"loading {MODEL}"):
    tok = AutoTokenizer.from_pretrained(MODEL)
    if QUANT == "nf4":
        from peft import prepare_model_for_kbit_training
        from transformers import BitsAndBytesConfig
        model = AutoModelForCausalLM.from_pretrained(MODEL, device_map={"": 0}, torch_dtype=torch.bfloat16, quantization_config=BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True))
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    else:
        model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.bfloat16).cuda()
        model.gradient_checkpointing_enable()
        model.enable_input_require_grads()


def user_turn(r):
    return (r["instruction"] + "\n" + (r.get("input") or "")).strip()


def encode(r, mask=MASK_PROMPT):
    """An example's ids, and its labels: the same ids, with the question masked out under MASK_PROMPT."""
    msgs = [{"role": "user", "content": user_turn(r)}, {"role": "assistant", "content": r.get("output") or r.get("reference") or ""}]
    ids = tok(tok.apply_chat_template(msgs, tokenize=False), truncation=True, max_length=SEQ, return_tensors="pt")["input_ids"]
    labels = ids.clone()
    if mask:
        asked = len(tok(tok.apply_chat_template(msgs[:1], tokenize=False, add_generation_prompt=True))["input_ids"])
        labels[:, :asked] = -100
    return ids, labels


targets = "all-linear" if TARGETS == "all-linear" else ["q_proj", "k_proj", "v_proj", "o_proj"]
init = {"gaussian": True, "pissa": "pissa_niter_4", "eva": "eva"}.get(INIT)
if init is None:
    no_retry(f"LORA_INIT={INIT} is not one of gaussian, pissa, eva")
kw = {}
if INIT == "eva":
    from peft import EvaConfig
    kw["eva_config"] = EvaConfig(rho=2.0)
cfg = LoraConfig(r=R, lora_alpha=ALPHA, lora_dropout=DROPOUT, task_type="CAUSAL_LM", target_modules=targets,
                 use_rslora=RSLORA, use_dora=DORA, init_lora_weights=init, **kw)
model = get_peft_model(model, cfg, low_cpu_mem_usage=INIT == "eva")
if INIT == "eva":
    # EVA starts each adapter in the directions that explain the layer's inputs on this data
    from peft import initialize_lora_eva_weights
    tok.padding_side = "right"
    # EVA reads batches until every layer's directions settle, or the batches run out: on a small GPU
    # share with all-linear and a high rank that can take far longer than training, so it is capped
    eva_batches, eva_size = env("EVA_BATCHES", 8, int), max(BATCH, 8)
    pool = random.sample(rows, min(len(rows), eva_batches * eva_size))
    texts = [tok.apply_chat_template([{"role": "user", "content": user_turn(r)}, {"role": "assistant", "content": r.get("output") or ""}],
                                     tokenize=False) for r in pool]
    batches = [tok(texts[i:i + eva_size], padding=True, truncation=True, max_length=SEQ, return_tensors="pt").to("cuda")
               for i in range(0, len(texts), eva_size)]
    t_eva = time.time()

    class Logged:
        """The batches EVA reads, with a line per batch: EVA itself reports nothing while it works."""
        def __init__(self, items):
            self.items = items
        def __len__(self):
            return len(self.items)
        def __iter__(self):
            for i, b in enumerate(self.items, 1):
                print(f"INFO | EVA initialisation: batch {i} of {len(self.items)}, {time.time() - t_eva:.0f}s", flush=True)
                yield b

    initialize_lora_eva_weights(model, dataloader=Logged([dict(b) for b in batches]), show_progress_bar=False)
    source["eva"] = {"batches": len(batches), "batch_size": eva_size, "seconds": round(time.time() - t_eva)}
    print(f"INFO | EVA initialisation: {len(batches)} batches of {eva_size} in {time.time() - t_eva:.0f}s", flush=True)
model.print_trainable_parameters()

enc = [encode(r) for r in rows]
val_enc = [encode(r, mask=True) for r in val_rows]

opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=LR)
warm = int(total_steps * WARMUP)


def lr_at(step):
    if step < warm:
        return (step + 1) / warm
    if SCHEDULE == "cosine":
        return 0.5 * (1 + math.cos(math.pi * (step - warm) / max(1, total_steps - warm)))
    return 1.0


sched = torch.optim.lr_scheduler.LambdaLR(opt, lr_at)
print(f"INFO | training: {total_steps} steps ({epochs} epochs) of batch {BATCH}, sequences up to {SEQ} tokens, loss on "
      f"{'the answers' if MASK_PROMPT else 'whole conversations'}; LoRA r={R} alpha={ALPHA} on {TARGETS}"
      f"{', rsLoRA' if RSLORA else ''}{', DoRA' if DORA else ''}, init {INIT}; lr {LR} {SCHEDULE}, warm-up {warm} steps", flush=True)


@torch.no_grad()
def val_loss():
    model.eval()
    total = tokens = 0
    for ids, labels in val_enc:
        n = int((labels[:, 1:] != -100).sum())
        if n:
            total += model(input_ids=ids.cuda(), labels=labels.cuda()).loss.item() * n
            tokens += n
    model.train()
    return total / tokens if tokens else float("nan")


history = []
model.train()
t0 = time.time()
order = []
step = 0
epoch = 0
epoch_losses = []
while step < total_steps:
    if not order:
        order = list(range(len(enc)))
        random.shuffle(order)
    batch = [enc[order.pop()] for _ in range(min(BATCH, len(order)))]
    try:
        loss = sum(model(input_ids=ids.cuda(), labels=labels.cuda()).loss for ids, labels in batch) / len(batch)
        loss.backward()
    except torch.OutOfMemoryError as e:
        no_retry(f"out of GPU memory at step {step + 1}: {str(e).splitlines()[0][:200]}; lower BATCH or SEQ_LEN, "
                 f"or give the run a larger GPU share")
    opt.step()
    sched.step()
    opt.zero_grad()
    epoch_losses.append(loss.item())
    step += 1
    if step % 10 == 0 or step == total_steps:
        print(f"INFO | step {step}/{total_steps} | loss={loss.item():.3f} | lr {sched.get_last_lr()[0]:.2e} | "
              f"peak {torch.cuda.max_memory_allocated() / 2**30:.2f} GiB | {time.time() - t0:.0f}s", flush=True)
    if step % steps_per_epoch == 0 or step == total_steps:
        epoch += 1
        entry = {"epoch": epoch, "step": step, "train_loss": round(sum(epoch_losses) / len(epoch_losses), 4)}
        epoch_losses = []
        if val_enc:
            entry["val_loss"] = round(val_loss(), 4)
        model.save_pretrained(os.path.join(out, f"epoch-{epoch}"))
        history.append(entry)
        print(f"INFO | epoch {epoch}: train loss {entry['train_loss']}" + (f", validation loss {entry['val_loss']}" if val_enc else ""), flush=True)

# the adapter at the top of the run's directory: the epoch with the lowest validation loss, else the last
best = min(history, key=lambda h: h["val_loss"]) if val_enc else history[-1]
for f in os.listdir(os.path.join(out, f"epoch-{best['epoch']}")):
    shutil.copy(os.path.join(out, f"epoch-{best['epoch']}", f), os.path.join(out, f))
print(f"INFO | adapter: epoch {best['epoch']}" + (f" (lowest validation loss, {best['val_loss']})" if val_enc else " (the last)"), flush=True)

# provenance, beside the adapter: what it was trained on and how, so an evaluation can be held out
import peft, transformers
with open(os.path.join(out, "training.json"), "w") as f:
    json.dump({"base_model": MODEL, "quant": QUANT, **source, "steps": total_steps, "epochs": epochs, "batch": BATCH, "seq_len": SEQ,
               "mask_prompt": MASK_PROMPT,
               "lora": {"r": R, "alpha": ALPHA, "dropout": DROPOUT, "targets": TARGETS, "rslora": RSLORA, "dora": DORA, "init": INIT},
               "optimiser": {"lr": LR, "schedule": SCHEDULE, "warmup_steps": warm, "seed": SEED},
               "history": history, "best_epoch": best["epoch"], "libraries": {"transformers": transformers.__version__, "peft": peft.__version__},
               "run": RUN, "finished": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, f, indent=2)
print(f"adapter saved to {out}: {sorted(os.listdir(out))}", flush=True)
