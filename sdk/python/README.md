# rancher-ai: Python SDK and CLI for SUSE AI Factory

`rancher_ai` lets data scientists use AI Factory from Python, Jupyter notebooks and the command
line, without leaving their usual development workflow.

Use it to:

- discover the training and inference profiles offered in the AI Factory Catalog;
- submit, follow and inspect training runs;
- deploy and chat with inference endpoints;
- read the results of tests and benchmarks;
- inspect, download from and clean up kept checkpoint volumes.

The SDK applies the same profile rules and project settings as the UI, and what it starts shows on
the Deployments page, and the other way round. Training runs are AIJobs where the cluster has the
AIJob API, and Helm releases where it does not.

Sample profiles: [../../examples/training/profiles](../../examples/training/profiles).

## Install

```sh
pip install ./sdk/python            # or: uv tool install ./sdk/python   (pandas optional: '.[pandas]')
rancher-ai --help
```

Python 3.10+. Connected through Rancher, runs install through Rancher; otherwise the `helm` CLI must
be on the PATH.

## Quick start

```sh
export RANCHER_URL=https://rancher.example.com
export RANCHER_TOKEN=token-xxxxx:yyyy...       # see Authentication
export RANCHER_CLUSTER=local

rancher-ai -p team-a profiles list
rancher-ai -p team-a run create --profile shared-gpu-dev --name hello-gpu --script train.py
rancher-ai -p team-a run logs hello-gpu -f
```

## CLI

```console
$ rancher-ai -p team-a profiles list
NAME                           TYPE        FRAMEWORK        GPUS    MAX SCALE   STATUS   DESCRIPTION
gpu-smoke                      training    CUDA             any     1-4         Ready    About 30 seconds on one whole GPU per worker: ...
pytorch-distributed            training    PyTorch          any     1-4         Ready    Distributed PyTorch training with torchrun, ...
shared-gpu-dev                 training    PyTorch          any     1           Beta     One worker with 4 GiB of a shared GPU, ...
suse-inference-endpoint-qwen   inference   vLLM + LiteLLM   A2000   1           Beta     LLM gateway with API keys, budgets and ...

$ rancher-ai profiles show shared-gpu-dev          # what it fixes, what you may set, its limits

$ rancher-ai -p team-a run create --profile shared-gpu-dev --name dev-cli-demo --script train.py --runtime-hours 1
✓ Training run created: dev-cli-demo
  Run ID:   run-21dd9319
  Project:  team-a
  Profile:  shared-gpu-dev
  Workers:  1 (shared GPU)
  ...

$ rancher-ai -p team-a run list
NAME           PROFILE          PROJECT   RESOURCES    STATE       AGE
dev-cli-demo   shared-gpu-dev   team-a    shared GPU   Completed   3m

$ rancher-ai -p team-a run status dev-cli-demo        # profile, workers, GPU allocation, queue, image
$ rancher-ai -p team-a run logs dev-cli-demo -f       # --rank N, --tail N
$ rancher-ai -p team-a run wait dev-cli-demo          # exit 0 when Completed, 1 when Failed
$ rancher-ai -p team-a run delete dev-cli-demo        # deletes the AIJob; the operator uninstalls its release

$ rancher-ai -p team-a endpoint create --profile suse-inference-endpoint-qwen --name chat --wait
$ rancher-ai -p team-a endpoint list
NAME   PROFILE                        PROJECT   MODEL                        URL                                 STATE
chat   suse-inference-endpoint-qwen   team-a    Qwen/Qwen2.5-1.5B-Instruct   http://litellm.team-a.svc:4000/v1   Ready
$ rancher-ai -p team-a endpoint chat chat "What is a large language model?"
```

`-o json|yaml` works on lists and status.

### Submitting code

`run create` takes the fields a profile opens: `--image repo[:tag]`, `--workers`,
`--gpus-per-worker`, `--command`, `--args`, `--script FILE`, `--config-map`, `--env NAME=VALUE`,
`--dataset`, `--checkpoints`, `--gpu-type`, `--gpu-memory GiB`, `--runtime-hours`. A field the
profile fixes, or a value outside its limits, is refused before anything is installed, with the
profile's reason. `--dry-run` prints what would be created instead.

A profile that lets you supply code needs it: `--script train.py`, `--config-map <name>` (a
ConfigMap with a `train.py` key), or `--demo` for the chart's built-in all-reduce check (`script=`,
`config_map=`, `demo=True` in Python). On the SUSE Application Collection PyTorch image, which has
torch only and no pip, a script that imports torchvision, transformers and the like gets a warning
before it is submitted.

### Tests and benchmarks

The profiles under *Catalog → Validate your environment* (`gpu-smoke`, `pytorch-gpu-test`,
`nccl-fabric-benchmark`, `gpu-diagnostics-bundle` and others) end with a structured result.
`run result` reads it:

```console
$ rancher-ai -p team-a run create --profile gpu-diagnostics-bundle-shared --name gpu-diag
$ rancher-ai -p team-a run wait gpu-diag
$ rancher-ai -p team-a run result gpu-diag
GPU Diagnostics Bundle: PASS
  PASS  NVIDIA driver answers  580.126.20
  PASS  No uncorrected ECC errors  ECC not reported by this GPU
  PASS  Not throttled  clock reasons 0x0000000000000001 (idle or settings only)
  WARN  Persistence mode  disabled: each job re-initialises the driver; enable the nvidia-persistenced service on the node
  PASS  PCIe link width  x8 of the GPU's x16, behind a virtual PCIe port: ...
  PASS  Bundle written  /mnt/checkpoints/gpu-diagnostics-20261004T014836Z.tar.gz (12K)
  GPU                          NVIDIA RTX A2000 12GB
  PCIe link                    gen 4 of 4, x8 of x16
  ...
```

A warning passes but is worth knowing; any failed check fails the result, and `run result` exits 1.

### Reporting a result from your own script

Any run can report a result the same way: its script prints one line that starts with `AIF_RESULT `
followed by a JSON object. When the run finishes, the operator reads the last such line from the
first worker's log (rank 0) and keeps it in the AIJob's `status.report`, so the result outlives the
pods and their logs. The run's detail on the Deployments page shows it as a results card,
`run result` prints it, and `run.result()` returns it as a dict.

```python
import json

print("AIF_RESULT " + json.dumps({
    "test": "Fine-tune evaluation",
    "status": "pass",
    "checks": [
        {"name": "Loss improves", "ok": True, "detail": "2.85 -> 1.48 on 338 held-out examples"},
        {"name": "Answers changed", "ok": True, "warn": True, "detail": "only 2 of 3 differ from the base model"},
    ],
    "metrics": {"Best validation loss": 1.778, "Training time (s)": 450},
    "env": {"gpu": "NVIDIA RTX A2000 12GB"},
}), flush=True)
```

| Field | Shown as |
|---|---|
| `test` | the card's title |
| `status` | the badge: `pass` or `fail`. Any check with `"ok": false` fails the result, whatever `status` says |
| `checks` | one line per check, in the order given: a check mark, a warning sign (`"ok": true, "warn": true`: passed, but worth knowing) or a cross, then `name` and `detail` |
| `metrics` | a grid of name and value pairs |
| `env` | the same grid, after the metrics: where and on what the run ran |

The card is deliberately simple:

- **Values are plain text**, with no Markdown, HTML, links or line breaks; a nested object or list
  is shown as a single line of text. Format values yourself and pass them as strings ("1.48",
  "33%", "12 of 338"): a bare number is converted with default formatting, so a large one such as
  1000000 shows as `1e+06`. Put units in the name ("Training time (s)") and keep a value short.
- **Metrics and env are listed alphabetically** by name, not in the order the script printed them;
  prefix related names alike ("Correct by area: …") to keep them together. A name used in both
  `metrics` and `env` shows the `env` value.
- **Limits:** up to 50 checks, 50 metrics and 50 env entries are kept, and any text over 512
  characters is cut. The line must be within the last 400 lines of the log, and it must be valid
  JSON on a single line; a malformed line is ignored rather than reported.
- **One result per run:** only the last `AIF_RESULT` line counts. Print it once, at the end, and
  `flush` it, so a run that ends straight after still has it in its log.

The card is a summary. Keep detailed output (every answer, a full log, plots) on the run's
checkpoint volume and name its path in a metric ("Answers saved to"); `checkpoints get` or *Browse
files* fetches it.

**A result is what the run says about itself.** Whoever controls a run's script controls its report,
so a card shows information, not proof: don't use it as a security or compliance gate. The
safeguards are about where a report can come from and how it is shown, not whether it is true:
only a pod the run's own Job (or PyTorchJob) created can report for it, the log read is capped, and
every value is treated as untrusted text: the Deployments page and notebook cards escape it, and
`run result` replaces control characters and line breaks before printing.

## Your own code on AI Factory's scheduler

An AI project spans clusters, and each cluster's nodes are compute pools (GPU or CPU, each with its
own scheduler: KAI, Kueue, Volcano, HAMi or none). You submit to the project, not to a cluster: the
run is an AIJob in `aif-<project>` on Rancher's local cluster, AI Factory's queue places it on a
project pool that fits (or holds it until one does), and the pool's scheduler runs it there.

```sh
rancher-ai projects list                                   # the AI projects you can see
rancher-ai -p vision pools list                            # its pools: what is free, scheduler, runtimes
rancher-ai -p vision run create --profile python-cpu-dev --code train.py --workers 2 --wait
rancher-ai -p vision run create --profile ray-cpu-dev --code my_ray.py --workers 2   # a Ray cluster, the program as its driver
rancher-ai -p vision run status <name>                     # where it was placed, or why it waits
```

`--code` takes a file or inline source; `--pool` picks a pool yourself; `--reclaim-policy` and
`--idle-timeout` override the profile's idle reclaim. Your program reads its rank, the world size
and rank 0's address from `JOB_COMPLETION_INDEX`, `NNODES` and `RDZV_ENDPOINT`, and may print one
`AIF_RESULT` line (see above). In Python: `ai.pools.list("vision")`,
`ai.runs.create("python-cpu-dev", code=src, workers=2, pool=None)`.

A complete demo, as a script and as a notebook:
[examples/scheduling_demo.py](examples/scheduling_demo.py) (`python examples/scheduling_demo.py
--project vision [--pool P] [--skip-ray] [--keep]`) and
[examples/scheduling-demo.ipynb](examples/scheduling-demo.ipynb). The `ray-cpu-dev` profile needs the
KubeRay add-on on the project's clusters (Compute Pools → Add-ons).

## Python and Jupyter

```python
from rancher_ai import Client

ai = Client(project="team-a")
ai.profiles.list()                                   # a DataFrame with pandas, a table without

check = ai.runs.create(profile="gpu-smoke", name="validate-gpu")
check.wait()
check.result()                                       # {test, status, checks, metrics, env}

run = ai.runs.create(profile="shared-gpu-dev", name="dev-notebook-demo", script=TRAIN, runtime_hours=1)
run.wait()                                           # or run.wait({"Running"})
run.status()                                         # a card in Jupyter
run.logs(tail=10)                                    # rank=N, follow=True

endpoint = ai.endpoints.create(profile="suse-inference-endpoint-qwen", name="chat")
endpoint.wait()
endpoint.chat("What is a large language model?")     # api_key= or RANCHER_AI_API_KEY for the LiteLLM gateway
run.delete(); endpoint.delete()
```

[`examples/rancher-ai-demo.ipynb`](examples/rancher-ai-demo.ipynb) is the whole flow, and
[`examples/kai-share-lora-demo.ipynb`](examples/kai-share-lora-demo.ipynb) fine-tunes two LoRA
adapters on GPU shares beside a running endpoint.

### Jupyter on your machine (Docker)

Step by step for Rancher Desktop or Docker Desktop, from starting the container to the first
`ai.whoami()`, permissions and troubleshooting: [docs/jupyter-local.md](docs/jupyter-local.md).
In short: run `quay.io/jupyter/base-notebook` with this folder mounted, `pip install` it inside the
container, and connect with a Rancher API key (no helm or kubeconfig needed in the container).

### Jupyter in the cluster

```sh
sdk/python/deploy/notebook.sh <project-namespace> --context <ctx>       # --delete to remove
```

Deploys JupyterLab into the project with the SDK, helm and the example notebook, and prints how to
open it (port-forward; the Jupyter token is in a Secret it creates). The notebook's ServiceAccount
gets the **AI Job Submitter** rules in that namespace and the **AI Scheduler Cluster Read** rules
cluster-wide, copied from [`examples/training/rbac.yaml`](../../examples/training/rbac.yaml):
what a submitter can do in the UI, in that project only. To act as yourself instead, create a
`rancher-ai-token` Secret with your Rancher URL and API key (the manifest shows how). In a pod,
`chat()` calls the endpoint's Service directly.

## Authentication and certificates

The SDK uses the first of these that is configured, in this order: **Rancher API token →
kubeconfig → in-cluster ServiceAccount**. Passing `--context` (or `context=`) picks the kubeconfig
even when a token is set.

| | How | Identity, and how runs install |
|---|---|---|
| Rancher API token | `RANCHER_URL`, `RANCHER_TOKEN`, `RANCHER_CLUSTER` (default `local`) | you, through Rancher's cluster proxy; runs install through Rancher's catalog, as the UI does (no helm needed) |
| kubeconfig | the current context, or `--context` / `RANCHER_AI_CONTEXT`. A Rancher-generated kubeconfig counts as Rancher | that context's user; through Rancher, or with helm |
| ServiceAccount | inside a pod (see [Jupyter in the cluster](#jupyter-in-the-cluster)) | the ServiceAccount; helm against the in-cluster chart repository |

The SDK calls the Kubernetes API with that identity, so RBAC decides what it may read and create: a
user with AI Job Submitter in a project can do what the UI lets them do there. Where a run becomes an
AIJob, the AI Factory operator then installs its chart with the operator's own service account,
limited to the charts its allow-list permits.

The project is `-p/--project`, `RANCHER_AI_PROJECT`, or the context's namespace.

### A Rancher API key

Rancher → avatar (top right) → **Account & API Keys** → **Create API Key**. Choose **No Scope** (a
key scoped to one cluster cannot use Rancher's catalog API, which starts training runs) and a short
expiry. Rancher shows the key once: the **Bearer Token**, `token-xxxxx:yyyy...`, is `RANCHER_TOKEN`.
It acts as you until it expires or you delete it on the same page, so keep it out of notebooks you
commit (read it from a file or the environment).

```python
import os
os.environ.update(RANCHER_URL="https://rancher.example.com", RANCHER_TOKEN=open("/home/jovyan/.rancher-token").read().strip(),
                  RANCHER_CLUSTER="local")
from rancher_ai import Client
ai = Client(project="team-a")
ai.whoami()          # should show your Rancher user
```

`RANCHER_CLUSTER` is the cluster id in Rancher's URLs (`/c/<id>/...`); `local` is the cluster
Rancher itself runs on.

### Private or self-signed certificates

Prefer `RANCHER_CA_CERT` for a Rancher whose certificate is signed by a private CA or is
self-signed. Rancher publishes its CA without a login:

```sh
curl -sk https://rancher.example.com/v3/settings/cacerts | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])' > rancher-ca.pem
export RANCHER_CA_CERT=$PWD/rancher-ca.pem
```

(`kubectl -n cattle-system get secret tls-rancher-ingress -o jsonpath='{.data.ca\.crt}' | base64 -d`
gives the same where you have cluster access.) The hostname in `RANCHER_URL` must be one the
certificate is issued for (its subject alternative names).

`RANCHER_INSECURE=1` disables TLS certificate verification. Limit it to development or disposable
environments. With it set, the SDK also silences urllib3's `InsecureRequestWarning`, which would
otherwise print on every request.

## Checkpoint volumes

Runs from a profile that creates a checkpoint volume (`<run>-checkpoints`, kept after the run) leave
it behind so the outputs survive. Look inside, copy files off, and clean up the ones you no longer
need:

```console
$ rancher-ai -p team-a checkpoints list
NAME                        RUN             PROFILE          PROJECT   SIZE   CLASS      AGE   IN USE
dev-ckpt-demo-checkpoints   dev-ckpt-demo   shared-gpu-dev   team-a    5Gi    longhorn   45s   no
$ rancher-ai -p team-a checkpoints ls dev-ckpt-demo-checkpoints                    # files, from a short-lived read-only pod
$ rancher-ai -p team-a checkpoints get dev-ckpt-demo-checkpoints adapter/model.safetensors ./out/
$ rancher-ai -p team-a checkpoints delete dev-ckpt-demo-checkpoints                # asks you to type the name
$ rancher-ai -p team-a checkpoints prune --older-than 14                           # shows what would go; --yes deletes
```

```python
ai.checkpoints.list()
vol = ai.checkpoints.get("dev-ckpt-demo-checkpoints")
vol.ls()
vol.get("adapter/model.safetensors", "~/Downloads/")         # returns the absolute path it wrote
ai.checkpoints.delete("dev-ckpt-demo-checkpoints", confirm=True)
ai.checkpoints.delete_older_than(14)                         # dry run: names only
ai.checkpoints.delete_older_than(14, dry_run=False, confirm=True)
```

`get` copies one file through a short-lived pod's log, so it takes files up to 7 MiB (the kubelet
rotates container logs at 10 MiB); for larger ones, mount the volume in a pod and use `kubectl cp`.
A destination ending in `/` is created if missing.

Only volumes the chart created for a run are managed (its labels and the `<run>-checkpoints` name),
never a dataset or a shared PVC; a volume a pod mounts, or whose run is still active, is refused; and
nothing is deleted without confirmation. With Longhorn (reclaim policy Delete) deleting the claim
deletes the data. The Deployments page offers the same: *Browse files* (with a download per file,
up to the same size) and *Delete volume* in a run's detail, and in the list of kept volumes whose
run is gone.

## Current limitations

The SDK enforces a profile's fields and limits itself, but does not yet run the cluster-side
pre-flight checks the Deploy page runs: free GPUs, quota headroom, storage classes and image cache.
The chart's own install-time pre-flight still applies, and `run status` and the Deployments page
show why a submitted run is waiting.

## How it maps to AI Factory

| AI Factory | CLI | Python |
|---|---|---|
| Catalog → Training, Inference | `profiles list` | `ai.profiles.list()` |
| AI projects, Compute Pools | `projects list`, `pools list` | `ai.projects.list()`, `ai.pools.list()` |
| Deploy a training profile | `run create` | `ai.runs.create()` |
| Deployments → Training | `run list`, `run status` | `ai.runs.list()`, `run.status()` |
| A run's logs | `run logs` | `run.logs()` |
| Catalog → Validate your environment | `run create` + `run result` | `run.result()` |
| Deploy an inference profile | `endpoint create` | `ai.endpoints.create()` |
| An inference endpoint | `endpoint chat` | `endpoint.chat()` |
| Kept checkpoint volumes | `checkpoints` | `ai.checkpoints` |

### Developer notes

| | UI | SDK |
|---|---|---|
| Profiles | ConfigMaps labelled `trainingjobs/profile` in `ai-profiles` | the same |
| Profile rules | `profiles.ts` (`resolveForm`, `profileChecks`) | `profiles.py` (`resolve`, `check`) |
| Scheduler and queue | the project's KAI / Run:AI queue label, else its Kueue LocalQueue | the same |
| Shared GPU | a KAI GPU-memory share; in a DRA project, the project's MPS claim (Kueue skipped: it cannot admit a pod on an existing claim) | the same |
| Training run | an AIJob, installed by the operator; a Rancher catalog install where there is no AIJob API | the same; `helm install` without Rancher |
| Profile on the run | chart value `profile` (Job label `trainingjobs/profile`) | the same |
| Endpoint | `aiWorkloadFor()`: an `AIWorkload` | `endpoints.create()`; one workload per blueprint per project; required Secrets checked |

## Tests

```sh
cd sdk/python && uv venv && uv pip install -e '.[test]' && .venv/bin/pytest -q
```
