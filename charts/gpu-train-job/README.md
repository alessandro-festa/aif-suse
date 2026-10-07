# gpu-train-job

Helm chart that runs one distributed training run as a Kubernetes **Indexed Job** running
`torchrun`, with no Kubeflow dependency, or as a Kubeflow **PyTorchJob**. `questions.yaml` turns it
into a form in **Rancher Apps**.

It is the chart AI Factory's AIJobs install: the operator installs it once per run from the
`gpu-train-charts` ClusterRepo (see [the AIJob design](../../docs/design/aijob.md)), and the training
pages and the [SDK](../../sdk/python) set its values from a profile. A profile's open fields map onto
the values below.

| Layer | How it is covered |
|---|---|
| Pod per node, stable names | Indexed Job + headless Service (`<job>-<index>.<job>.<ns>.svc`) |
| Rank assignment | `--node_rank=$(JOB_COMPLETION_INDEX)`, `--nproc_per_node=<gpusPerNode>` |
| Rendezvous | c10d on pod index 0 (default) or external etcd (`rendezvous.backend=etcd-v2`) |
| NCCL data path | optional Multus attachment (`network.multusNetwork`) + `NCCL_SOCKET_IFNAME`, or `network.hostNetwork` + `network.rdma` for an RoCE/InfiniBand fabric |
| Secrets | `storage.secretMounts`: existing Secrets mounted read-only (object-store credentials, an `.s3cfg`, a token file) |
| GPU request | `nvidia.com/gpu` (device plugin), a DRA ResourceClaimTemplate, or a KAI GPU-memory share (`gpu.sharedMemoryMiB`) |
| Scheduling | none / Kueue (queue label, suspended until admitted) / KAI or Run:AI (`schedulerName` + queue label, gang via PodGroup) |
| Storage | scratch (node-local or a per-pod volume), a dataset claim, and a checkpoint volume created per run and kept after it (`storage.checkpointCreate`) |
| Failure | failed index is recreated with the same index; etcd rendezvous re-forms the group |
| Multi-node NVLink domain (rack-scale NVL systems, e.g. GB200/GB300) | `computeDomain.enabled`: one ComputeDomain per run (numNodes = nodes) plus a channel claim per pod, via the NVIDIA DRA driver |

Every pod gets `JOB_NAME`, `NNODES`, `NPROC_PER_NODE`, `NODE_NAME` (the node it runs on), and
`SCRATCH_DIR`, `DATASET_DIR` and `CHECKPOINT_DIR` when those volumes are set.

## Modes

- `smoke` (default): `nvidia-smi`, interface list, hold N seconds. Works with any image, including the
  default (SUSE's BCI base): the NVIDIA container toolkit mounts `nvidia-smi` into a container that
  gets a GPU. Proves scheduling, queue admission, GPU attach and the Multus interface without torch.
- `torchrun`: runs `/workspace/train.py` (inline `job.script`, or the built-in NCCL all-reduce demo)
  under torchrun.
- `custom`: `job.command` / `job.args` verbatim. The test and benchmark profiles in
  [examples/training](../../examples/training) use this mode.

## Examples

```bash
# a smoke test on one GPU, admitted by a Kueue LocalQueue
helm install smoke1 ./charts/gpu-train-job -n team-a \
  --set scheduler.type=kueue --set scheduler.queue=gpu-queue

# 8 nodes x 2 GPUs, NCCL over a Multus network, etcd rendezvous, a KAI queue
helm install run1 ./charts/gpu-train-job -n team-a \
  --set job.mode=torchrun --set job.nodes=8 --set job.gpusPerNode=2 \
  --set network.multusNetwork=team-a/nccl-net \
  --set rendezvous.backend=etcd-v2 --set rendezvous.endpoint=etcd.team-a.svc:2379 \
  --set scheduler.type=kai --set scheduler.queue=team-a

# 4 GiB of a shared GPU under KAI (HAMi-core caps the pod's GPU memory)
helm install dev1 ./charts/gpu-train-job -n team-a \
  --set scheduler.type=kai --set scheduler.queue=team-a --set gpu.sharedMemoryMiB=4096

# a cluster that already runs Run:AI: same queues, different schedulerName. The namespace has to
# be one a run.ai Project owns -- labelling one by hand gets the pods scheduled and then refused
# at bind time. `kubectl get projects.run.ai -o custom-columns=:.status.namespace` lists them.
helm install smoke2 ./charts/gpu-train-job -n runai-training \
  --set scheduler.type=runai --set scheduler.queue=training
```

## RDMA / RoCE

A pod on the cluster network cannot see an RDMA rail, so a fabric run needs three things together:

```yaml
network:
  hostNetwork: true              # the pod gets the node's NICs, and loses its own IP
  rdma:
    enabled: true                # mounts /dev/infiniband, runs privileged, NCCL_IB_DISABLE=0
    hostLibPath: /usr/lib/aarch64-linux-gnu   # only for images without libibverbs
  ncclIbHca: "mlx5_0:1,mlx5_1:1" # both rails -- one HCA is half the width
  ncclIbGidIndex: "3"            # RoCEv2
  ncclNetGdrLevel: "0"           # host staging; raise it where GPUDirect actually works
  ncclCrossNic: "1"
```

`hostNetwork` also means two runs on one node collide on the rendezvous port, and that the pods
answer on the node's address — reasons enough to leave it off for anything the pod network can
carry. A LoRA's gradient is small; a full fine-tune's is not.

## Scheduler backends

`scheduler.type` names a backend in [`schedulers.yaml`](schedulers.yaml): its `schedulerName`, the
label that names the queue and whether it goes on the pods or on the Job, and whether the Job is
created suspended for the backend to admit. The AI Factory operator and UI read the same table, so
a backend is added there, not in the templates.

## Pre-flight

`scheduler.type=kai` and `scheduler.type=runai` are the same scheduler under two names and must not
be swapped: pick the wrong one and every pod stays `Pending` with no event explaining it. The chart's
pre-flight detects that, a missing queue, and GPUs or DRA devices the cluster does not have, and fails
the install with the reason. It uses `lookup`, so it runs under `helm install`/`upgrade` and
`helm install --dry-run=server`, not under `helm template`. Installed by an AIJob, it runs as the
AI Factory operator, whose ClusterRole grants the reads it needs.

## Tests

```bash
./charts/gpu-train-job/verify-render.sh     # renders the combinations that matter and checks them; no cluster
```
