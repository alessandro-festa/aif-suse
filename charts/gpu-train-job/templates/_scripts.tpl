{{/* Scripts are delivered via environment variables and written to /tmp at start-up, so the
chart creates no ConfigMap and submitters need no ConfigMap permissions. */}}
{{- define "gpu-train-job.smokeScript" -}}
#!/bin/sh
set -u
echo "== gpu-train-job smoke: ${HOSTNAME:-$(cat /proc/sys/kernel/hostname)} index=${JOB_COMPLETION_INDEX:-?} nodes=${NNODES} gpus/node=${NPROC_PER_NODE}"
echo "== rendezvous endpoint (unused in smoke): ${RDZV_ENDPOINT}"
if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi -L; nvidia-smi --query-gpu=name,memory.total --format=csv; else echo "nvidia-smi not in image"; fi
# ip and awk are not in every image (BCI base has neither): fall back to the kernel's list
if command -v ip >/dev/null 2>&1 && command -v awk >/dev/null 2>&1; then ip -o -4 addr show | awk '{print "   iface", $2, $4}'; else for i in /sys/class/net/*; do [ -d "$i" ] && echo "   iface ${i##*/}"; done; fi
if python3 -c "import torch" 2>/dev/null; then python3 -c "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), 'devices', torch.cuda.device_count())"; fi
echo "== holding ${SMOKE_HOLD_SECONDS}s"; sleep "${SMOKE_HOLD_SECONDS}"; echo "== done"
{{- end -}}

{{- define "gpu-train-job.trainScript" -}}
{{- if .Values.job.script -}}
{{ .Values.job.script }}
{{- else -}}
# Built-in demo: init the process group, then loop until the budget runs out -- all-reducing a
# tensor across the ranks, or, on a single GPU, multiplying a matrix by itself.
#
# The knobs are read from the environment as well as argv because the torchrun form has an
# Environment variables box and no args box: env is the only way a manifest pasted into Submit can
# reach them. RUN_SECONDS is the one that matters for a demo -- 20 steps is over in seconds, which
# is not long enough to talk over.
import argparse, os, time
import torch, torch.distributed as dist
def envint(name, default):
    v = os.environ.get(name, "").strip()
    return int(v) if v else default
secs = envint("RUN_SECONDS", 0)
p = argparse.ArgumentParser()
# A wall-clock budget replaces the step count rather than capping it, so RUN_SECONDS alone is
# enough; set MAX_STEPS too and whichever runs out first ends the run.
p.add_argument("--max-steps", type=int, default=envint("MAX_STEPS", 0 if secs else 20))
p.add_argument("--size-mb", type=int, default=envint("SIZE_MB", 256))
p.add_argument("--run-seconds", type=int, default=secs)
p.add_argument("--report-seconds", type=int, default=envint("REPORT_SECONDS", 15))
p.add_argument("--matmul-n", type=int, default=envint("MATMUL_N", 4096))
a, _ = p.parse_known_args()
if not a.max_steps and not a.run_seconds: a.max_steps = 20   # MAX_STEPS=0 with no budget is not "forever"
dist.init_process_group("nccl")
rank, world, local = dist.get_rank(), dist.get_world_size(), int(os.environ["LOCAL_RANK"])
torch.cuda.set_device(local)
# Several ranks: the interesting number is what the fabric does between them. One rank: there is no
# peer, an all-reduce moves nothing and reports 0 GB/s, so measure the GPU itself instead. Same
# budget, same progress lines, a number a single-card demo can show.
if world > 1:
    x = torch.ones(a.size_mb * 1024 * 1024 // 4, device="cuda")
    step = lambda: dist.all_reduce(x)
    per_step, unit, what = 2 * (world - 1) / world * a.size_mb / 1024, "GB/s busbw", f"all-reduce {a.size_mb}MB"
else:
    m = torch.randn(a.matmul_n, a.matmul_n, device="cuda"); out = torch.empty_like(m)
    step = lambda: torch.mm(m, m, out=out)
    per_step, unit, what = 2 * a.matmul_n ** 3 / 1e12, "TFLOP/s", f"matmul {a.matmul_n}x{a.matmul_n}"
step(); torch.cuda.synchronize()   # warm-up: NCCL builds its rings, cuBLAS picks its kernel
if rank == 0: print(f"world={world} {what} steps={a.max_steps or 'unbounded'} budget={str(a.run_seconds) + 's' if a.run_seconds else 'none'}", flush=True)
t0 = last = time.time(); steps = last_steps = 0
stop = torch.zeros(1, device="cuda")
while True:
    # One clock, broadcast. NCCL matches collectives by call order, so if each rank decided for
    # itself when the budget was up, the first one out would leave the others in an all-reduce that
    # never completes -- a hang that ends as a watchdog abort ten minutes later.
    if rank == 0:
        stop.fill_(float(bool((a.max_steps and steps >= a.max_steps) or (a.run_seconds and time.time() - t0 >= a.run_seconds))))
    if world > 1: dist.broadcast(stop, 0)
    if stop.item(): break
    step()
    # Synchronise every step, so the CPU cannot run ahead of the GPU. Without it the loop enqueues
    # work far faster than a slow fabric drains it: the budget then times the enqueue rather than
    # the run, and once the backlog is deeper than NCCL's 10-minute watchdog timeout the queued
    # collective is declared hung and the job is killed. Seen on three A2s over TCP, where a 512 MB
    # all-reduce takes over a second and a 600 s budget queued 1000 of them.
    torch.cuda.synchronize(); steps += 1
    if rank == 0 and a.report_seconds and time.time() - last >= a.report_seconds:
        now = time.time()
        print(f"  step {steps} elapsed {now - t0:.0f}s {per_step * (steps - last_steps) / (now - last):.2f} {unit}", flush=True)
        last, last_steps = now, steps
dt = max(time.time() - t0, 1e-9)
if rank == 0: print(f"world={world} {what} steps={steps} time={dt:.2f}s {per_step * steps / dt:.2f} {unit} average", flush=True)
dist.barrier(); dist.destroy_process_group()
{{- end -}}
{{- end -}}
