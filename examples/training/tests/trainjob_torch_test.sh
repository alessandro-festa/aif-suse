#!/bin/sh
# Kubeflow Trainer v2 Test (CPU): a TrainJob of N pods, one process each. Trainer's torch policy
# hands torchrun the world (PET_NNODES, PET_NODE_RANK, PET_MASTER_ADDR, PET_MASTER_PORT); torchrun
# reads it by itself, and the script checks the world it got, all-reduces across the pods and trains
# with DistributedDataParallel over gloo. No GPU. Needs Kubeflow Trainer v2 on the cluster.
set -e
for v in PET_NNODES PET_NODE_RANK PET_MASTER_ADDR PET_MASTER_PORT; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || { echo "FAIL  $v is not set: not a Kubeflow Trainer TrainJob with the torch policy"; exit 3; }
done
pip install --quiet --no-cache-dir --disable-pip-version-check "torch==${TORCH_VERSION:-2.8.0}" --index-url https://download.pytorch.org/whl/cpu >/tmp/pip.log 2>&1 || { tail -20 /tmp/pip.log; exit 3; }
cat > /tmp/test.py <<'PY'
import json, os, platform, sys, time
import torch
import torch.distributed as dist

t0 = time.time()
dist.init_process_group("gloo")  # torchrun set RANK, WORLD_SIZE, MASTER_ADDR and MASTER_PORT from Trainer's PET_*
rank, world = dist.get_rank(), dist.get_world_size()
checks = []
def add(name, ok, detail):
    checks.append({"name": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + f" {name}  {detail}", flush=True)

nodes = int(os.environ["PET_NNODES"])
add("Trainer gave torchrun the world", world == nodes, f"{world} processes, PET_NNODES={nodes}, master {os.environ['PET_MASTER_ADDR']}:{os.environ['PET_MASTER_PORT']}")
x = torch.tensor([float(rank + 1)])
dist.all_reduce(x)
want = world * (world + 1) / 2
add("All-reduce across the pods", x.item() == want, f"sum {x.item():.0f}, expected {want:.0f}")

torch.manual_seed(0)  # the same target and starting weights on every rank
w = torch.randn(16, 1)
model = torch.nn.parallel.DistributedDataParallel(torch.nn.Sequential(torch.nn.Linear(16, 64), torch.nn.ReLU(), torch.nn.Linear(64, 1)))
opt = torch.optim.AdamW(model.parameters(), lr=0.01)
data = torch.Generator().manual_seed(1000 + rank)  # each rank its own shard
losses = []
for _ in range(120):
    xb = torch.randn(32, 16, generator=data)
    loss = torch.nn.functional.mse_loss(model(xb), xb @ w)
    opt.zero_grad()
    loss.backward()
    opt.step()
    losses.append(loss.item())
first, last = sum(losses[:5]) / 5, sum(losses[-5:]) / 5
add("Trains with DDP", last < first * 0.3, f"loss {first:.3f} -> {last:.3f}")
p = torch.cat([q.detach().flatten() for q in model.parameters()])
ps = [torch.zeros_like(p) for _ in range(world)]
dist.all_gather(ps, p)
add("Ranks hold the same weights", all(torch.allclose(ps[0], q) for q in ps), f"{p.numel()} parameters compared across {world} ranks")

ok = all(c["ok"] for c in checks)
if rank == 0:
    print("AIF_RESULT " + json.dumps({"test": "Kubeflow Trainer v2 Test", "status": "pass" if ok else "fail", "checks": checks,
          "metrics": {"processes": str(world), "seconds": f"{time.time() - t0:.1f}"},
          "env": {"torch": torch.__version__, "runtime": "TrainJob (torch policy)", "arch": platform.machine(), "node": os.environ.get("NODE_NAME", "")}}), flush=True)
dist.barrier()
dist.destroy_process_group()
sys.exit(0 if ok else 1)
PY
exec torchrun /tmp/test.py
