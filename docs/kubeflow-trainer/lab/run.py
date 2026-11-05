"""Submit a TrainJob to Dave's aif-training-runtimes as trainer1.
usage: KUBECONFIG=~/.kube/trainer1.yaml python run.py <runtime> [--no-queue] [--ns NS] [--gpus N]"""
import argparse
from kubeflow.common.types import KubernetesBackendConfig
from kubeflow.trainer import CustomTrainer, TrainerClient
from aif_training import namespace_queue


def train():
    import os, torch
    x = torch.randn(256, 8); w_true = torch.randn(8, 1); y = x @ w_true
    model = torch.nn.Linear(8, 1, bias=False)
    opt = torch.optim.SGD(model.parameters(), lr=0.1)
    for step in range(200):
        opt.zero_grad(); loss = ((model(x) - y) ** 2).mean(); loss.backward(); opt.step()
    print(f"final loss {loss.item():.6f} cuda={torch.cuda.is_available()}")
    out = os.environ.get("OUTPUT_DIR")
    if out:
        with open(os.path.join(out, "result.txt"), "w") as f:
            f.write(f"loss={loss.item():.6f}\n")
        print("wrote", os.path.join(out, "result.txt"))


p = argparse.ArgumentParser()
p.add_argument("runtime"); p.add_argument("--ns", default="aif-submit")
p.add_argument("--no-queue", action="store_true"); p.add_argument("--gpus", type=int, default=0)
p.add_argument("--no-wait", action="store_true")
a = p.parse_args()

client = TrainerClient(backend_config=KubernetesBackendConfig(namespace=a.ns))
print("runtimes:", [r.name for r in client.list_runtimes()])
kw = {"func": train, "num_nodes": 1}
if a.gpus:
    kw["resources_per_node"] = {"gpu": a.gpus}
opts = [] if a.no_queue else [namespace_queue(client)]
job = client.train(runtime=client.get_runtime(a.runtime), trainer=CustomTrainer(**kw), options=opts)
print("submitted", job)
if not a.no_wait:
    client.wait_for_job_status(job, timeout=1800)
    print("\n".join(client.get_job_logs(job)))
