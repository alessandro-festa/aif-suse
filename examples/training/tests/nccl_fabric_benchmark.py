"""NCCL Fabric Benchmark: how fast do the workers' GPUs exchange data?

Times NCCL all-reduce over message sizes from 1 MiB to 1 GiB, as nccl-tests' all_reduce_perf does,
and reports algorithm and bus bandwidth (bus = algorithm x 2(n-1)/n). Rank 0 prints the table and
one AIF_RESULT line. Needs one GPU per rank."""
import datetime
import json
import os
import time

import torch
import torch.distributed as dist

rank, world = int(os.environ.get("RANK", 0)), int(os.environ.get("WORLD_SIZE", 1))
local = int(os.environ.get("LOCAL_RANK", 0))
torch.cuda.set_device(local)
dev = torch.device("cuda", local)
dist.init_process_group("nccl", timeout=datetime.timedelta(minutes=5))

rows, errors = [], 0
for mib in [1, 4, 16, 64, 256, 1024]:
    n = mib * 2**20 // 4
    x = torch.ones(n, device=dev)
    for _ in range(3):
        dist.all_reduce(x)
    x.fill_(1.0)
    dist.barrier()
    torch.cuda.synchronize(dev)
    iters = 20 if mib <= 64 else 5
    t = time.time()
    for _ in range(iters):
        dist.all_reduce(x)
        x.div_(world)  # keep values at 1 so the result can be checked
    torch.cuda.synchronize(dev)
    dt = (time.time() - t) / iters
    errors += int(not torch.allclose(x, torch.ones_like(x)))
    algbw = mib * 2**20 / dt / 1e9
    busbw = algbw * 2 * (world - 1) / world if world > 1 else 0.0
    rows.append((mib, dt * 1e6, algbw, busbw))
    if rank == 0:
        print(f"{mib:>6} MiB  {dt * 1e6:>10.0f} us  algbw {algbw:7.2f} GB/s  busbw {busbw:7.2f} GB/s", flush=True)

errs = [0] * world
dist.all_gather_object(errs, errors)
dist.destroy_process_group()
if rank == 0:
    peak = max(rows, key=lambda r: r[3])
    checks = [
        {"name": "AllReduce results correct", "ok": sum(errs) == 0, "detail": f"{sum(errs)} wrong result(s)"},
        {"name": "More than one rank", "ok": world > 1, "detail": f"{world} rank(s); bus bandwidth needs at least 2"},
    ]
    metrics = {"Peak algorithm bandwidth": f"{max(r[2] for r in rows):.1f} GB/s", "Peak bus bandwidth": f"{peak[3]:.1f} GB/s",
               "At message size": f"{peak[0]} MiB", "Errors": sum(errs)}
    env = {"world size": world, "nodes": os.environ.get("NNODES", "?"), "gpu": torch.cuda.get_device_name(dev),
           "nccl": ".".join(map(str, torch.cuda.nccl.version()))}
    result = {"test": "NCCL Fabric Benchmark", "status": "pass" if all(c["ok"] for c in checks) else "fail", "checks": checks, "metrics": metrics, "env": env}
    print("AIF_RESULT " + json.dumps(result), flush=True)
    raise SystemExit(0 if result["status"] == "pass" else 1)
