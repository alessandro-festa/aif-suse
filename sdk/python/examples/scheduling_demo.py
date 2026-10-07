"""AI Factory scheduling, from a data scientist's laptop.

Connects to Rancher with your API key, looks at what you may use (AI projects, compute pools,
profiles), then submits your own code twice -- a plain Python program over two pods, and a Ray
program on a Ray cluster -- and lets AI Factory's queue place them. It follows each run, prints its
logs and result, and cleans up.

    export RANCHER_URL=https://rancher.example.com
    export RANCHER_TOKEN=token-xxxxx:yyyy          # Rancher → Account & API Keys
    export RANCHER_INSECURE=1                      # only for a self-signed lab certificate
    python examples/scheduling_demo.py --project vision

Your code is ordinary Python: it reads its rank, the world size and rank 0's address from the
environment (JOB_COMPLETION_INDEX, NNODES, RDZV_ENDPOINT) and prints its result as one AIF_RESULT
line, which AI Factory keeps on the run.
"""

from __future__ import annotations

import argparse
import sys
import textwrap

from rancher_ai import Client

# --- your code ---------------------------------------------------------------------------------

# A plain Python program: each pod fits y = 2x + 1 by gradient descent on its own shard of the data,
# and rank 0 reports. No framework to install, so it starts in seconds.
MY_TRAINING = textwrap.dedent('''
    import json, os, random
    rank, world = int(os.environ["JOB_COMPLETION_INDEX"]), int(os.environ["NNODES"])
    random.seed(rank)
    data = [(x, 2 * x + 1 + random.gauss(0, 0.1)) for x in (random.uniform(-1, 1) for _ in range(500))]
    w = b = 0.0
    for epoch in range(200):
        gw = sum((w * x + b - y) * x for x, y in data) * 2 / len(data)
        gb = sum((w * x + b - y) for x, y in data) * 2 / len(data)
        w, b = w - 0.1 * gw, b - 0.1 * gb
    print(f"rank {rank}/{world}: w={w:.3f} b={b:.3f}", flush=True)
    if rank == 0:
        ok = abs(w - 2) < 0.05 and abs(b - 1) < 0.05
        print("AIF_RESULT " + json.dumps({"test": "My training", "status": "pass" if ok else "fail",
              "checks": [{"name": "Learned y = 2x + 1", "ok": ok, "detail": f"w={w:.3f} b={b:.3f}"}],
              "metrics": {"pods": str(world)}, "env": {"node": os.environ.get("NODE_NAME", "")}}))
''')

# A Ray program: the driver runs on the Ray head, and Ray spreads 200 tasks over the workers.
MY_RAY_PROGRAM = textwrap.dedent('''
    import json, random, socket
    import ray
    ray.init()

    @ray.remote
    def sample(n):
        inside = sum(1 for _ in range(n) if random.random() ** 2 + random.random() ** 2 <= 1)
        return inside, socket.gethostname()

    results = ray.get([sample.remote(100_000) for _ in range(200)])
    pi = 4 * sum(i for i, _ in results) / (200 * 100_000)
    hosts = sorted({h for _, h in results})
    print(f"pi ~ {pi:.4f} from {len(hosts)} Ray workers: {hosts}", flush=True)
    ok = abs(pi - 3.1416) < 0.01
    print("AIF_RESULT " + json.dumps({"test": "My Ray program", "status": "pass" if ok else "fail",
          "checks": [{"name": "Estimated pi", "ok": ok, "detail": f"{pi:.4f}"},
                     {"name": "Spread over the workers", "ok": len(hosts) > 1, "detail": ", ".join(hosts)}],
          "metrics": {"tasks": "200"}, "env": {"ray": ray.__version__}}))
''')


def show(title: str, what) -> None:
    print(f"\n== {title}")
    print(what if isinstance(what, str) else getattr(what, "text", lambda: str(what))())


def follow(run, timeout: float) -> None:
    print(f"submitted {run.name}")
    seen = ""
    while True:
        run.refresh()
        where = f"placed in pool {run.placement['pool']} ({run.placement['clusterId']})" if run.placement else \
            (f"waiting: {run.waiting}" if run.waiting else "")
        line = f"  {run.state:<10} {where}"
        if line != seen:
            print(line)
            seen = line
        if run.state in ("Completed", "Failed", "Cancelled", "Reclaimed"):
            break
        timeout -= 5
        if timeout <= 0:
            print("  (still running; follow it with `rancher-ai run status`)")
            return
        import time
        time.sleep(5)
    print(repr(run.status()))
    print("-- logs")
    try:
        run.logs(tail=15)
    except LookupError as e:
        print(f"  {e}")
    print("-- result:", run.result())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--project", required=True, help="your AI project")
    ap.add_argument("--pool", help="a compute pool instead of AI Factory's choice")
    ap.add_argument("--skip-ray", action="store_true", help="skip the Ray program (no KubeRay on the project's clusters)")
    ap.add_argument("--keep", action="store_true", help="keep the runs instead of deleting them at the end")
    a = ap.parse_args()

    ai = Client(project=a.project)
    w = ai.whoami()
    show("who am I", f"{w['user']} through {w['rancher'] or w['cluster']}")
    show("my AI projects", ai.projects.table())
    show(f"compute pools of {a.project}", ai.pools.table(a.project))
    show("profiles I can use", ai.profiles.table("training"))

    runs = []
    show("1. my own Python program on two pods", "")
    run = ai.runs.create("python-cpu-dev", code=MY_TRAINING, workers=2, pool=a.pool)
    runs.append(run)
    follow(run, timeout=300)

    if not a.skip_ray:
        show("2. my own Ray program on a Ray cluster", "")
        run = ai.runs.create("ray-cpu-dev", code=MY_RAY_PROGRAM, workers=2, pool=a.pool)
        runs.append(run)
        follow(run, timeout=600)

    if not a.keep:
        for r in runs:
            r.delete()
        print(f"\ndeleted {', '.join(r.name for r in runs)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
