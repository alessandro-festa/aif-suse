#!/bin/sh
# DeepSpeed Distributed Test: N processes, one per pod, set up torch.distributed from the
# chart's rendezvous (rank 0's stable name, RDZV_ENDPOINT) and train a small model with DeepSpeed
# ZeRO stage 1: over gloo on DeepSpeed's CPU accelerator by default, over NCCL on one GPU per pod with
# DEVICE=gpu (the CUDA build of torch). No MPI or Kubeflow runtime: the
# Indexed Job gives each pod its rank (JOB_COMPLETION_INDEX) and the world size (NNODES).
set -e
AIF_TEST="DeepSpeed Distributed Test"
DEVICE="${DEVICE:-cpu}"
# DEVICE=gpu: the run asked for a GPU; without an NVIDIA device in the pod nothing below can use one
if [ "$DEVICE" = gpu ] && ! ls /dev/nvidia[0-9]* >/dev/null 2>&1; then
  echo "FAIL  DEVICE=gpu but no NVIDIA device in the pod (/dev/nvidia*): no driver on the node, or a simulated GPU"
  [ "${JOB_COMPLETION_INDEX:-0}" = 0 ] && echo "AIF_RESULT {\"test\":\"$AIF_TEST\",\"status\":\"fail\",\"checks\":[{\"name\":\"GPU visible\",\"ok\":false,\"detail\":\"no /dev/nvidia* in the pod\"}]}"
  exit 3
fi
WHEELS=cpu; [ "$DEVICE" = gpu ] && WHEELS=cu128
pip install --quiet --no-cache-dir --disable-pip-version-check "torch==${TORCH_VERSION:-2.8.0}" --index-url "https://download.pytorch.org/whl/$WHEELS" >/tmp/pip.log 2>&1 || { tail -20 /tmp/pip.log; exit 3; }
# DeepSpeed ships source only: it builds against the torch above, its ops compiled on use (none here)
pip install --quiet --no-cache-dir --disable-pip-version-check --no-build-isolation "deepspeed==${DEEPSPEED_VERSION:-0.17.6}" >>/tmp/pip.log 2>&1 || { tail -20 /tmp/pip.log; exit 3; }
cat > /tmp/test.py <<'PY'
import json, os, sys, time
rank, world = int(os.environ["JOB_COMPLETION_INDEX"]), int(os.environ["NNODES"])
host, port = os.environ["RDZV_ENDPOINT"].rsplit(":", 1)
os.environ.update({"MASTER_ADDR": host, "MASTER_PORT": port, "RANK": str(rank), "WORLD_SIZE": str(world),
                   "LOCAL_RANK": "0", "DS_ACCELERATOR": "cuda" if os.environ.get("DEVICE", "cpu") == "gpu" else "cpu"})
gpu = os.environ["DS_ACCELERATOR"] == "cuda"
import platform
import torch
import deepspeed
# DeepSpeed's CPU accelerator builds a shared-memory all-reduce op on first use; its source is
# x86_64 only (immintrin.h). Elsewhere (arm64) skip it: collectives go through gloo instead.
if not gpu and platform.machine() != "x86_64":
    import importlib
    # by its module path: the package attribute deepspeed.comm.torch is the torch module itself
    importlib.import_module("deepspeed.comm.torch").build_shm_op = lambda: None

checks = []
def add(name, ok, detail):
    checks.append({"name": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + f" {name}  {detail}", flush=True)

t0 = time.time()
deepspeed.init_distributed(dist_backend="nccl" if gpu else "gloo")
add("Processes joined", torch.distributed.get_world_size() == world, f"{torch.distributed.get_world_size()} of {world} through {host.split('.')[0]}")
dev = torch.device("cuda", 0) if gpu else torch.device("cpu")
t = torch.tensor([float(rank)], device=dev)
torch.distributed.all_reduce(t)
add("All-reduce across processes", t.item() == sum(range(world)), f"sum of ranks {t.item():.0f}")

# one model and one target for every rank (as a real run would have); each rank draws its own batches
torch.manual_seed(0)
w = torch.randn(16, 1).to(dev)
model = torch.nn.Sequential(torch.nn.Linear(16, 64), torch.nn.ReLU(), torch.nn.Linear(64, 1))
config = {"train_micro_batch_size_per_gpu": 32, "gradient_accumulation_steps": 1,
          "optimizer": {"type": "AdamW", "params": {"lr": 0.01, "torch_adam": True}},
          "zero_optimization": {"stage": 1}, "steps_per_print": 1000}
engine, _, _, _ = deepspeed.initialize(model=model, model_parameters=model.parameters(), config=config)
data = torch.Generator().manual_seed(1000 + rank)
losses = []
for _ in range(120):
    x = torch.randn(32, 16, generator=data).to(dev)
    loss = torch.nn.functional.mse_loss(engine(x), x @ w)
    engine.backward(loss)
    engine.step()
    losses.append(loss.item())
first, last = sum(losses[:5]) / 5, sum(losses[-5:]) / 5
add("Trains with ZeRO stage 1", last < first * 0.3, f"loss {first:.3f} -> {last:.3f}")

ok = all(c["ok"] for c in checks)
if rank == 0:
    print("AIF_RESULT " + json.dumps({"test": "DeepSpeed Distributed Test", "status": "pass" if ok else "fail", "checks": checks,
          "metrics": {"processes": str(world), "seconds": f"{time.time() - t0:.1f}", "zero stage": "1"},
          "env": {"deepspeed": deepspeed.__version__, "torch": torch.__version__, "accelerator": "cuda" if gpu else "cpu", "arch": platform.machine(),
                  "collectives": "nccl" if gpu else "gloo" if platform.machine() != "x86_64" else "gloo + shared memory", "node": os.environ.get("NODE_NAME", "")}}), flush=True)
torch.distributed.barrier()
sys.exit(0 if ok else 1)
PY
exec python3 /tmp/test.py
