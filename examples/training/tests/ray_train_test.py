# Ray Train Distributed Test (CPU): the Ray driver, run by KubeRay on the head. A TorchTrainer starts
# one training worker per Ray worker pod (job.nodes), each fits a small model with gradients
# synchronised by Ray Train's PyTorch integration, and the driver checks the result. torch comes from
# the job's Ray runtime environment (ray.runtimeEnv), installed by Ray on every node.
import json, os, sys, time
import ray

t0 = time.time()
ray.init()
checks = []
def add(name, ok, detail):
    checks.append({"name": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + f" {name}  {detail}", flush=True)

workers = int(os.environ.get("NNODES") or 0) or sum(1 for n in ray.nodes() if n["Alive"] and n["Resources"].get("CPU", 0) > 0)
nodes = [n for n in ray.nodes() if n["Alive"]]
add("Ray cluster up", len(nodes) >= workers + 1, f"{len(nodes)} nodes (head + {len(nodes) - 1} workers), Ray {ray.__version__}")

from ray.train import RunConfig, ScalingConfig
from ray.train.torch import TorchTrainer

def train_loop(config):
    import torch
    import ray.train
    import ray.train.torch as rtt
    ctx = ray.train.get_context()
    torch.manual_seed(0)  # one model and one target everywhere; each worker its own batches
    model = rtt.prepare_model(torch.nn.Linear(4, 1))
    opt = torch.optim.SGD(model.parameters(), lr=0.1)
    w = torch.tensor([[1.0], [-2.0], [0.5], [3.0]])
    data = torch.Generator().manual_seed(1000 + ctx.get_world_rank())
    first = None
    for _ in range(80):
        x = torch.randn(64, 4, generator=data)
        loss = torch.nn.functional.mse_loss(model(x), x @ w)
        opt.zero_grad(); loss.backward(); opt.step()
        first = first if first is not None else loss.item()
    ray.train.report({"first": first, "last": loss.item(), "world_size": ctx.get_world_size(), "node": os.environ.get("NODE_NAME", "")})

result = TorchTrainer(train_loop, scaling_config=ScalingConfig(num_workers=workers, use_gpu=False),
                      run_config=RunConfig(name="aif-ray-train-test", storage_path="/tmp/ray-results")).fit()
m = result.metrics
add("Training workers", m.get("world_size") == workers, f"{m.get('world_size')} of {workers} in one process group")
add("Trains with synchronised gradients", m["last"] < m["first"] * 0.05, f"loss {m['first']:.3f} -> {m['last']:.5f}")

ok = all(c["ok"] for c in checks)
print("AIF_RESULT " + json.dumps({"test": "Ray Train Distributed Test", "status": "pass" if ok else "fail", "checks": checks,
      "metrics": {"workers": str(workers), "seconds": f"{time.time() - t0:.1f}"},
      "env": {"ray": ray.__version__, "nodes": str(len(nodes))}}), flush=True)
sys.exit(0 if ok else 1)
