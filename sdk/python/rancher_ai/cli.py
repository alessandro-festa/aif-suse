"""rancher-ai: profiles, training runs and inference endpoints from the terminal.

  rancher-ai profiles list
  rancher-ai run create --profile pytorch-distributed --project team-a --name llama-finetune \\
      --image dp.apps.rancher.io/containers/pytorch:2.14.0-nvidia-2.1 --workers 2 --args "--epochs 10"
  rancher-ai run list | status | logs -f | wait | delete NAME
  rancher-ai endpoint create --profile suse-inference-endpoint-qwen --name llama-chat
  rancher-ai endpoint list | status | chat NAME "Hello" | delete NAME
"""

from __future__ import annotations

import argparse
import json
import sys

import yaml

from . import __version__
from .client import Client
from .display import kv, paint, plain
from .profiles import ProfileError


def _env_pairs(items: list[str] | None) -> dict | None:
    if not items:
        return None
    out = {}
    for it in items:
        if "=" not in it:
            raise SystemExit(f"--env {it!r}: expected NAME=VALUE")
        k, v = it.split("=", 1)
        out[k] = v
    return out


def _run_card(ai: Client, r, created: bool = False) -> str:
    rows = [("Run ID", r.id or "-"), ("Project", r.namespace), ("Profile", r.profile), ("Workers", f"{r.workers} ({r.gpus})" if r.gpus else r.workers),
            ("Queue", r.queue or "-"), ("State", paint(r.state, {"Running": "32", "Queued": "33", "Failed": "31"}.get(r.state, "33"))),
            ("Created", r.created or "-")]
    if r.dashboard:
        rows.append(("Dashboard", r.dashboard))
    return kv(f"Training run created: {r.name}" if created else r.name, rows)


def _ep_card(e, created: bool = False) -> str:
    rows = [("Endpoint ID", e.id or "-"), ("URL", e.url or "-"), ("Profile", e.profile), ("Blueprint", e.blueprint),
            ("Model", e.model or "-"), ("Replicas", e.replicas), ("State", e.state)]
    return kv(f"Inference endpoint created: {e.name}" if created else e.name, rows)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="rancher-ai", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--context", help="kubeconfig context (default: current)")
    ap.add_argument("--kubeconfig", help="kubeconfig file (default: $KUBECONFIG or ~/.kube/config)")
    ap.add_argument("-p", "--project", help="AI project (its runs go to AI Factory's queue), or a namespace "
                    "(default: the context's namespace, or $RANCHER_AI_PROJECT)")
    ap.add_argument("--chart", help="gpu-train-job OCI reference: install with helm instead of through Rancher")
    ap.add_argument("-o", "--output", choices=["table", "json", "yaml"], default="table")
    ap.add_argument("--version", action="version", version=f"rancher-ai {__version__}")
    sub = ap.add_subparsers(dest="noun", required=True)

    sub.add_parser("whoami", help="user, cluster and project this connects as")

    pp = sub.add_parser("profiles", aliases=["profile"], help="profiles you can deploy").add_subparsers(dest="verb", required=True)
    pl = pp.add_parser("list")
    pl.add_argument("--type", choices=["training", "inference"])
    ps = pp.add_parser("show", help="a profile: what it fixes and what you may set")
    ps.add_argument("name")

    sub.add_parser("projects", aliases=["project"], help="AI projects you can see").add_subparsers(dest="verb", required=True).add_parser("list")
    op = sub.add_parser("pools", aliases=["pool"], help="compute pools: where runs go").add_subparsers(dest="verb", required=True)
    op.add_parser("list").add_argument("--for-project", dest="for_project", help="only the pools of this AI project's clusters")

    rp = sub.add_parser("run", aliases=["runs"], help="training runs").add_subparsers(dest="verb", required=True)
    rc = rp.add_parser("create", help="start a training run from a training profile")
    rc.add_argument("--profile", required=True)
    rc.add_argument("--name", help="run name (default: <prefix or profile>-xxxxx)")
    rc.add_argument("--image", help="image, repo[:tag]")
    rc.add_argument("--workers", type=int)
    rc.add_argument("--gpus-per-worker", type=int, dest="gpus_per_worker")
    rc.add_argument("--command", help="command to run instead of the profile's (custom mode)")
    rc.add_argument("--args", help="arguments for the profile's command (torchrun script args)")
    rc.add_argument("--script", help="inline script file to run (its contents are sent)")
    rc.add_argument("--code", help="your Python program (a .py file), run as the command, or the Ray driver, or the torchrun script")
    rc.add_argument("--pool", help="compute pool to run in (default: AI Factory's queue picks one of the project's)")
    rc.add_argument("--reclaim-policy", dest="reclaim_policy", choices=["Suspend", "Terminate", "Never"],
                    help="when idle in a pool that reclaims (default: the profile's)")
    rc.add_argument("--idle-timeout", dest="idle_timeout", help="e.g. 30m, 2h, 1d (up to the pool's ceiling)")
    rc.add_argument("--config-map", dest="config_map", help="ConfigMap with the training code")
    rc.add_argument("--env", action="append", metavar="NAME=VALUE")
    rc.add_argument("--dataset", help="dataset PVC")
    rc.add_argument("--checkpoints", help="checkpoint PVC")
    rc.add_argument("--gpu-type", dest="gpu_type")
    rc.add_argument("--gpu-memory", type=float, dest="gpu_memory", help="GiB per pod on a shared GPU")
    rc.add_argument("--runtime-hours", type=float, dest="runtime_hours")
    rc.add_argument("--demo", action="store_true", help="run the chart's built-in all-reduce check instead of your code")
    rc.add_argument("--dry-run", action="store_true", help="print the Helm values and stop")
    rc.add_argument("--wait", action="store_true", help="wait until the run completes or fails")
    rl = rp.add_parser("list")
    rl.add_argument("-A", "--all-projects", action="store_true")
    for verb in ("status", "delete", "wait"):
        rp.add_parser(verb).add_argument("name")
    rp.add_parser("result", help="what a test or benchmark run reported (its AIF_RESULT)").add_argument("name")
    rg = rp.add_parser("logs")
    rg.add_argument("name")
    rg.add_argument("-f", "--follow", action="store_true")
    rg.add_argument("--tail", type=int, default=100)
    rg.add_argument("--rank", type=int, default=0)

    ep = sub.add_parser("endpoint", aliases=["endpoints"], help="inference endpoints").add_subparsers(dest="verb", required=True)
    ec = ep.add_parser("create", help="deploy an inference profile")
    ec.add_argument("--profile", required=True)
    ec.add_argument("--name")
    ec.add_argument("--model", help="must match the blueprint (aif-operator 2.2.0 cannot override it)")
    ec.add_argument("--gpu-count", type=int, dest="gpu_count")
    ec.add_argument("--replicas", type=int)
    ec.add_argument("--dry-run", action="store_true", help="print the AIWorkload and stop")
    ec.add_argument("--wait", action="store_true", help="wait until Ready")
    el = ep.add_parser("list")
    el.add_argument("-A", "--all-projects", action="store_true")
    for verb in ("status", "delete", "wait"):
        ep.add_parser(verb).add_argument("name")
    ex = ep.add_parser("chat", help="one chat completion")
    ex.add_argument("name")
    ex.add_argument("message")
    ex.add_argument("--api-key", help="LiteLLM key (default $RANCHER_AI_API_KEY; none = the vLLM router directly)")
    ex.add_argument("--max-tokens", type=int, default=256)

    kp = sub.add_parser("checkpoints", aliases=["checkpoint"], help="checkpoint volumes runs created and kept").add_subparsers(dest="verb", required=True)
    kl = kp.add_parser("list")
    kl.add_argument("-A", "--all-projects", action="store_true")
    ks = kp.add_parser("ls", help="list a volume's files (a short-lived read-only pod)")
    ks.add_argument("name")
    ks.add_argument("path", nargs="?", default="")
    kg = kp.add_parser("get", help="copy a file off a run's checkpoint volume (e.g. a diagnostics bundle)")
    kg.add_argument("name")
    kg.add_argument("path", help="file on the volume, as checkpoints ls shows it")
    kg.add_argument("dest", nargs="?", default=".", help="directory or file name (default: here)")
    kd = kp.add_parser("delete", help="delete a run's checkpoint volume (and its data)")
    kd.add_argument("name")
    kd.add_argument("--yes", action="store_true", help="do not ask")
    kr = kp.add_parser("prune", help="delete run checkpoint volumes older than N days that nothing uses")
    kr.add_argument("--older-than", type=float, required=True, metavar="DAYS")
    kr.add_argument("--yes", action="store_true", help="delete without asking (default: show what would go)")

    a = ap.parse_args(argv)
    noun = {"profile": "profiles", "runs": "run", "endpoints": "endpoint", "checkpoint": "checkpoints"}.get(a.noun, a.noun)

    def emit(obj) -> None:
        if a.output == "json":
            print(json.dumps(obj, indent=2, default=str))
        elif a.output == "yaml":
            print(yaml.safe_dump(obj, sort_keys=False, allow_unicode=True), end="")

    try:
        ai = Client(context=a.context, project=a.project, kubeconfig=a.kubeconfig, chart=a.chart)

        if noun == "whoami":
            w = ai.whoami()
            emit(w) if a.output != "table" else print("\n".join(f"{k}: {v}" for k, v in w.items() if k != "groups"))

        elif noun in ("projects", "project"):
            t = ai.projects.table()
            emit(t.rows) if a.output != "table" else print(t.text())

        elif noun in ("pools", "pool"):
            t = ai.pools.table(a.for_project)
            emit(t.rows) if a.output != "table" else print(t.text())

        elif noun == "profiles" and a.verb == "list":
            t = ai.profiles.table(a.type)
            emit(t.rows) if a.output != "table" else print(t.text())

        elif noun == "profiles" and a.verb == "show":
            p = ai.profiles.get(a.name)
            doc = {"name": p.name, "type": p.type, "displayName": p.display_name, "description": p.description,
                   "framework": p.framework, "status": p.status, "namePrefix": p.name_prefix or None,
                   "youSet": p.editable if p.type == "training" else ["project", "name"], "limits": p.limits or None,
                   "blueprint": p.blueprint, "requiredSecrets": [s["name"] for s in p.required_secrets] or None,
                   "fixed": p.values or None, "problems": p.problems or None}
            out = {k: v for k, v in doc.items() if v not in (None, "", [])}
            emit(out) if a.output != "table" else print(yaml.safe_dump(out, sort_keys=False, allow_unicode=True), end="")

        elif noun == "run" and a.verb == "create":
            fields = {k: getattr(a, k) for k in ("image", "workers", "gpus_per_worker", "command", "args", "config_map",
                                                 "dataset", "checkpoints", "gpu_type", "gpu_memory", "runtime_hours")}
            fields["env"] = _env_pairs(a.env)
            if a.script:
                fields["script"] = open(a.script).read()
            reclaim = {k: v for k, v in (("policy", a.reclaim_policy), ("idleTimeout", a.idle_timeout)) if v} or None
            r = ai.runs.create(a.profile, name=a.name, dry_run=a.dry_run, demo=a.demo, pool=a.pool, code=a.code,
                               reclaim=reclaim, **fields)
            if a.dry_run:
                print(yaml.safe_dump(r, sort_keys=False, allow_unicode=True), end="")
                return 0
            print(_run_card(ai, r, created=True))
            if a.wait:
                print(f"waiting for {r.name}...", file=sys.stderr)
                state = r.wait()
                print(f"{r.name}: {state}")
                return 0 if state == "Completed" else 1

        elif noun == "run" and a.verb == "list":
            t = ai.runs.table(all_projects=a.all_projects)
            emit(t.rows) if a.output != "table" else print(t.text())

        elif noun == "run" and a.verb == "status":
            r = ai.runs.get(a.name)
            emit({k: v for k, v in r.__dict__.items() if k != "client"}) if a.output != "table" else print(repr(r.status()))

        elif noun == "run" and a.verb == "logs":
            ai.runs.get(a.name).logs(tail=a.tail, rank=a.rank, follow=a.follow)

        elif noun == "run" and a.verb == "result":
            res = ai.runs.get(a.name).result()
            if res is None:
                print(f"{a.name} reported no result (not a test run, or its pods are gone)", file=sys.stderr)
                return 1
            if a.output != "table":
                emit(res)
            else:
                print(f"{plain(res.get('test') or a.name)}: {plain(res.get('status', '?')).upper()}")
                for c in res.get("checks", []):
                    print(f"  {'FAIL' if not c.get('ok') else 'WARN' if c.get('warn') else 'PASS'}  {plain(c.get('name'))}  {plain(c.get('detail', ''))}")
                for k, v in {**res.get("metrics", {}), **res.get("env", {})}.items():
                    print(f"  {plain(k):<28} {plain(v)}")
            return 0 if res.get("status") == "pass" else 1

        elif noun == "run" and a.verb == "wait":
            state = ai.runs.get(a.name).wait()
            print(f"{a.name}: {state}")
            return 0 if state == "Completed" else 1

        elif noun == "run" and a.verb == "delete":
            ai.runs.get(a.name).delete()
            how = "the AIJob; the operator uninstalls its release" if type(ai.installer).__name__ == "AIJobInstaller" else "helm uninstall"
            print(f"deleted {a.name} ({how})")

        elif noun == "endpoint" and a.verb == "create":
            e = ai.endpoints.create(a.profile, name=a.name, model=a.model, gpu_count=a.gpu_count, replicas=a.replicas, dry_run=a.dry_run)
            if a.dry_run:
                print(yaml.safe_dump(e, sort_keys=False, allow_unicode=True), end="")
                return 0
            print(_ep_card(e, created=True))
            if a.wait:
                print(f"waiting for {e.name} (the first start downloads the model)...", file=sys.stderr)
                print(f"{e.name}: {e.wait()}")

        elif noun == "endpoint" and a.verb == "list":
            t = ai.endpoints.table(all_projects=a.all_projects)
            emit(t.rows) if a.output != "table" else print(t.text())

        elif noun == "endpoint" and a.verb == "status":
            e = ai.endpoints.get(a.name)
            emit({k: v for k, v in e.__dict__.items() if not k.startswith("_") and k != "client"}) if a.output != "table" else print(_ep_card(e))

        elif noun == "endpoint" and a.verb == "wait":
            print(f"{a.name}: {ai.endpoints.get(a.name).wait()}")

        elif noun == "endpoint" and a.verb == "chat":
            ai.endpoints.get(a.name).chat(a.message, api_key=a.api_key, max_tokens=a.max_tokens)

        elif noun == "endpoint" and a.verb == "delete":
            ai.endpoints.get(a.name).delete()
            print(f"deleted {a.name} (AIWorkload; the operator removes what it installed)")

        elif noun == "checkpoints" and a.verb == "get":
            print(ai.checkpoints.get(a.name).get(a.path, a.dest))

        elif noun == "checkpoints" and a.verb == "list":
            t = ai.checkpoints.table(all_projects=a.all_projects)
            emit(t.rows) if a.output != "table" else print(t.text())

        elif noun == "checkpoints" and a.verb == "ls":
            t = ai.checkpoints.get(a.name).ls(a.path)
            emit(t.rows) if a.output != "table" else print(t.text())

        elif noun == "checkpoints" and a.verb == "delete":
            k = ai.checkpoints.get(a.name)
            if not a.yes:
                ans = input(f"Delete {k.name} ({k.size}, run {k.run})? Its data is deleted permanently. Type the name to confirm: ")
                if ans.strip() != k.name:
                    print("not deleted")
                    return 1
            k.delete(confirm=True)
            print(f"deleted {k.name}")

        elif noun == "checkpoints" and a.verb == "prune":
            names = ai.checkpoints.delete_older_than(a.older_than, dry_run=not a.yes, confirm=a.yes)
            if not names:
                print(f"no unused run checkpoint volumes older than {a.older_than:g} days")
            elif a.yes:
                print("deleted: " + ", ".join(names))
            else:
                print("would delete (run again with --yes): " + ", ".join(names))

    except (ProfileError, LookupError, PermissionError, RuntimeError, TimeoutError) as e:
        print(f"{paint('error:', '31')} {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
