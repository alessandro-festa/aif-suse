"""PyTorch GPU Test: can this environment run PyTorch training on its GPU?

Checks PyTorch's view of CUDA, the device and its memory, the floating-point types the GPU
supports, a matrix multiply, and a forward and backward pass. Prints each check, then one
AIF_RESULT line that AI Factory shows as the run's results. Exits non-zero if a check fails."""
import json
import os
import time

import torch

checks, metrics, env = [], {}, {}


def check(name, fn):
    try:
        detail = fn() or ""
        checks.append({"name": name, "ok": True, "detail": detail})
        print(f"PASS  {name}  {detail}", flush=True)
    except Exception as e:  # a failed check is a result, not a crash
        checks.append({"name": name, "ok": False, "detail": str(e)[:300]})
        print(f"FAIL  {name}  {e}", flush=True)


def require(cond, msg):
    if not cond:
        raise RuntimeError(msg)


env["torch"] = torch.__version__
env["cuda (torch)"] = torch.version.cuda or "none"
check("CUDA available", lambda: (require(torch.cuda.is_available(), "torch.cuda.is_available() is False"), f"{torch.cuda.device_count()} device(s)")[1])

if torch.cuda.is_available():
    dev = torch.device("cuda", int(os.environ.get("LOCAL_RANK", 0)))
    props = torch.cuda.get_device_properties(dev)
    env["gpu"] = props.name
    env["compute capability"] = f"{props.major}.{props.minor}"
    free, total = torch.cuda.mem_get_info(dev)
    env["gpu memory"] = f"{total / 2**30:.1f} GiB"
    check("GPU identified", lambda: f"{props.name}, {total / 2**30:.1f} GiB, {props.multi_processor_count} SMs")

    def alloc():
        x = torch.empty(int(min(1, free / 2**30 * 0.5) * 2**30), dtype=torch.uint8, device=dev)
        del x
        torch.cuda.synchronize(dev)
        return f"{free / 2**30:.1f} GiB free"
    check("GPU memory allocation", alloc)

    for dtype, label in [(torch.float32, "FP32"), (torch.float16, "FP16"), (torch.bfloat16, "BF16")]:
        def matmul(dtype=dtype, label=label):
            if dtype is torch.bfloat16:
                require(torch.cuda.is_bf16_supported(), "BF16 not supported on this GPU")
            n = 4096
            a, b = torch.randn(n, n, device=dev, dtype=dtype), torch.randn(n, n, device=dev, dtype=dtype)
            for _ in range(3):
                a @ b
            torch.cuda.synchronize(dev)
            t, iters = time.time(), 10
            for _ in range(iters):
                a @ b
            torch.cuda.synchronize(dev)
            tflops = 2 * n**3 * iters / (time.time() - t) / 1e12
            metrics[f"{label} matmul"] = f"{tflops:.1f} TFLOPS"
            return f"{tflops:.1f} TFLOPS"
        check(f"{label} matrix multiply", matmul)

    def train_step():
        model = torch.nn.Sequential(torch.nn.Linear(1024, 4096), torch.nn.GELU(), torch.nn.Linear(4096, 1024)).to(dev)
        opt = torch.optim.AdamW(model.parameters(), lr=1e-3)
        x, y = torch.randn(256, 1024, device=dev), torch.randn(256, 1024, device=dev)
        first = None
        for _ in range(20):
            loss = torch.nn.functional.mse_loss(model(x), y)
            opt.zero_grad()
            loss.backward()
            opt.step()
            first = first if first is not None else loss.item()
        require(loss.item() < first, f"loss did not fall ({first:.3f} -> {loss.item():.3f})")
        return f"loss {first:.3f} -> {loss.item():.3f} in 20 steps"
    check("Forward and backward pass", train_step)

result = {"test": "PyTorch GPU Test", "status": "pass" if all(c["ok"] for c in checks) else "fail", "checks": checks, "metrics": metrics, "env": env}
print("AIF_RESULT " + json.dumps(result), flush=True)
raise SystemExit(0 if result["status"] == "pass" else 1)
