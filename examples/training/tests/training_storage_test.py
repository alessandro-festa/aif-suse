"""Training + Storage Test: the whole path a training run takes, storage to GPU to checkpoint.

Writes a synthetic dataset to scratch (or reads $DATASET_DIR when one is mounted), reads it
through a DataLoader, trains a small model on the GPU(s) with DDP when there is more than one
rank, writes a checkpoint to $CHECKPOINT_DIR, reads it back and checks it is the same. Reports
throughput at each step. Rank 0 prints the checks and one AIF_RESULT line."""
import datetime
import glob
import json
import os
import time

import torch
import torch.distributed as dist

rank, world = int(os.environ.get("RANK", 0)), int(os.environ.get("WORLD_SIZE", 1))
local = int(os.environ.get("LOCAL_RANK", 0))
torch.cuda.set_device(local)
dev = torch.device("cuda", local)
if world > 1:
    dist.init_process_group("nccl", timeout=datetime.timedelta(minutes=5))
checks, metrics, env = [], {}, {}
SHARD_MIB, SHARDS = 64, int(os.environ.get("SHARDS", "16"))


def check(name, fn):
    try:
        detail = fn() or ""
        checks.append({"name": name, "ok": True, "detail": detail})
        if rank == 0:
            print(f"PASS  {name}  {detail}", flush=True)
    except Exception as e:
        checks.append({"name": name, "ok": False, "detail": str(e)[:300]})
        print(f"FAIL  [rank {rank}] {name}  {e}", flush=True)


def require(cond, msg):
    if not cond:
        raise RuntimeError(msg)


data_dir = os.environ.get("DATASET_DIR", "")
mounted = bool(data_dir) and os.path.isdir(data_dir) and bool(os.listdir(data_dir))
work = os.path.join(os.environ.get("SCRATCH_DIR", "/tmp"), f"aif-storage-test-{rank}")
ckpt_dir = os.environ.get("CHECKPOINT_DIR", "")
env.update({"dataset": data_dir if mounted else f"synthetic, {SHARDS * SHARD_MIB} MiB per rank on scratch", "checkpoints": ckpt_dir or "none", "ranks": world})
files = []


def write_dataset():
    os.makedirs(work, exist_ok=True)
    t = time.time()
    for i in range(SHARDS):
        torch.save(torch.randn(SHARD_MIB * 2**20 // 4 // 1024, 1024), os.path.join(work, f"shard-{i:03d}.pt"))
    os.sync()
    gbps = SHARDS * SHARD_MIB / 1024 / (time.time() - t)
    metrics["Scratch write"] = f"{gbps:.2f} GiB/s"
    files.extend(sorted(glob.glob(os.path.join(work, "shard-*.pt"))))
    return f"{SHARDS * SHARD_MIB} MiB at {gbps:.2f} GiB/s"


if mounted:
    files.extend(sorted(glob.glob(os.path.join(data_dir, "**", "*.pt"), recursive=True))[rank::world])
    check("Dataset found", lambda: (require(files, f"no .pt shards under {data_dir}"), f"{len(files)} shard(s)")[1])
else:
    check("Write a synthetic dataset to scratch", write_dataset)


class Shards(torch.utils.data.Dataset):
    def __len__(self):
        return len(files)

    def __getitem__(self, i):
        return torch.load(files[i])


model = torch.nn.Sequential(torch.nn.Linear(1024, 2048), torch.nn.GELU(), torch.nn.Linear(2048, 1024)).to(dev)
if world > 1:
    model = torch.nn.parallel.DistributedDataParallel(model, device_ids=[local])
opt = torch.optim.AdamW(model.parameters(), lr=1e-4)


def read_and_train():
    loader = torch.utils.data.DataLoader(Shards(), batch_size=None, num_workers=2, pin_memory=True)
    t, read, samples, busy = time.time(), 0, 0, 0.0
    for shard in loader:
        read += shard.numel() * 4
        shard = shard.to(dev, non_blocking=True)
        s = time.time()
        for batch in shard.split(4096):
            loss = torch.nn.functional.mse_loss(model(batch), batch)
            opt.zero_grad()
            loss.backward()
            opt.step()
            samples += batch.shape[0]
        torch.cuda.synchronize(dev)
        busy += time.time() - s
    wall = time.time() - t
    metrics["Dataset read"] = f"{read / 2**30 / wall:.2f} GiB/s"
    metrics["Samples/sec"] = f"{samples * world / wall:,.0f}"
    metrics["GPU busy"] = f"{100 * busy / wall:.0f}%"
    return f"{read / 2**30:.1f} GiB read, {samples:,} samples, loss {loss.item():.3f}"


check("DataLoader and training on the GPU", read_and_train)

state = (model.module if world > 1 else model).state_dict()


def save():
    require(ckpt_dir, "no checkpoint volume: the profile should create one")
    path = os.path.join(ckpt_dir, f"storage-test-rank{rank}.pt")
    blob = {"model": state, "pad": torch.randn(256 * 2**20 // 4)}  # 256 MiB beyond the model, for a measurable write
    t = time.time()
    torch.save(blob, path)
    os.sync()
    size = os.path.getsize(path)
    metrics["Checkpoint write"] = f"{size / 2**30 / (time.time() - t):.2f} GiB/s"
    return f"{size / 2**20:.0f} MiB to {path}"


def restore():
    path = os.path.join(ckpt_dir, f"storage-test-rank{rank}.pt")
    t = time.time()
    blob = torch.load(path)
    metrics["Checkpoint restore"] = f"{os.path.getsize(path) / 2**30 / (time.time() - t):.2f} GiB/s"
    require(all(torch.equal(blob["model"][k].cpu(), v.cpu()) for k, v in state.items()), "restored weights differ from the saved ones")
    return "weights identical after restore"


check("Checkpoint write", save)
check("Checkpoint restore", restore)

if world > 1:
    allc = [None] * world
    dist.all_gather_object(allc, checks)
    dist.destroy_process_group()
else:
    allc = [checks]
if rank == 0:
    merged = [{**c, "ok": all(i < len(cs) and cs[i]["ok"] for cs in allc)} for i, c in enumerate(checks)]
    result = {"test": "Training + Storage Test", "status": "pass" if all(c["ok"] for c in merged) else "fail", "checks": merged, "metrics": metrics, "env": env}
    print("AIF_RESULT " + json.dumps(result), flush=True)
    raise SystemExit(0 if result["status"] == "pass" else 1)
