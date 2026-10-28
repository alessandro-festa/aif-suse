# aif-training-runtimes

Kubeflow Trainer runtimes for SUSE AI Factory projects, and the admission policy that governs
TrainJobs. Training runs are Kubeflow TrainJobs, submitted with the Kubeflow Python SDK from a
notebook or a script; KAI schedules them, on a share of a GPU, whole GPUs or CPUs, in the project's
queue and within its GPU quota.

The runtimes are the **compute profiles**. A job names one, and `client.list_runtimes()` lists them.
A share profile carries its share, and the job doesn't set it. Profiles are entries in `runtimes`
(values):

| Profile | Runs on | Limits |
|---|---|---|
| `aif-share-4g` | a 4 GiB share of one GPU, one node | 4 h; 8 CPU, 32 Gi per node |
| `aif-share-8g` | an 8 GiB share of one GPU, one node | 8 h; 16 CPU, 64 Gi per node |
| `aif-gpu` | whole GPUs, torchrun a process per GPU | 24 h; up to 4 nodes, 8 GPUs per node |
| `aif-cpu` | CPUs | 8 h; up to 4 nodes; 32 CPU, 128 Gi per node |

### What a profile sets

Each entry in `runtimes` becomes a ClusterTrainingRuntime. The AI Job profile's settings map onto
these fields:

| Profile field | Sets | Who can change it per job |
|---|---|---|
| `displayName`, `description`, `framework`, `gpu`, `status`, `purpose`, `requires` | annotations and labels on the runtime: what a Profiles page and `list_runtimes()` show | — |
| `image`, `imagePullSecrets`, `env` | the trainer container | `image` within `registries`; `env` added |
| `gpuMemoryMiB` (share profiles) | the pods' KAI share | no |
| `maxNodes`, `maxGpusPerNode` | caps on the job's `numNodes` and `resourcesPerNode` GPUs | within the caps |
| `resources` | the container's default requests and limits | `resourcesPerNode`, within `maxCpu` and `maxMemory` |
| `registries` (or `policy.registries`) | image prefixes a job's `trainer.image` may use | no |
| `maxRuntimeHours` | each node Job's `activeDeadlineSeconds`; caps the TrainJob's | a shorter one |
| `nodeSelector`, `tolerations`, `priorityClassName` | where and at what priority the pods run | no (`policy.allowPlacement`) |
| `shmSize` | `/dev/shm`, memory-backed (the container default is 64 MiB) | no |
| `network` | Multus, NCCL, host network, RDMA (below) | no |
| outputs (chart-wide `outputs`) | the run's kept volume | no |

**How the runtime limit counts.** `maxRuntimeHours` counts from when a node's pods are created, so
time spent waiting in KAI's queue counts as well. A job queued for an hour on a 4 h profile has 3 h
to run.

## Networking: NCCL and RDMA

For multi-node GPU profiles, set a `network` block in the chart's values. A profile's own `network`
overrides it:

- **A secondary interface for NCCL:**
  - `multusNetwork` (a Multus NetworkAttachmentDefinition) adds the pods' `k8s.v1.cni.cncf.io/networks`
    annotation;
  - `ncclSocketIfname` (e.g. `net1`) pins NCCL to it.
  - The rendezvous stays on the pod network.
- **RDMA (RoCE or InfiniBand):** `rdma.enabled` sets `NCCL_IB_DISABLE=0`, with two ways to reach the
  HCAs:
  - **a device plugin's resource** (`rdma.resourceName`, e.g. `rdma/rdma_shared_device_a` from the
    NVIDIA Network Operator): the container gets that resource and the `IPC_LOCK` capability;
  - **the node's verbs devices** (`rdma.devicePath`, `/dev/infiniband`): mounted from the node, with
    the container privileged. This is how the AI Job chart did it, for nodes without a device plugin.
  - `rdma.hostLibPath` adds the node's verbs libraries to images that don't ship them.
- **The node's network:** `hostNetwork`, for an RDMA rail with no pod-network presence. It comes
  with `dnsPolicy: ClusterFirstWithHostNet`, so the rendezvous still resolves.
- **Tuning:** `ncclIbHca` (stripe across rails), `ncclIbGidIndex` (RoCEv2, usually 3),
  `ncclNetGdrLevel`, `ncclCrossNic`, `ncclDebug`, each set only when given.

**Things to know:**
- **These are profile settings.** A job can't set `hostNetwork`, a privileged container, node paths or
  capabilities through its patches: the policy refuses them, so an RDMA profile's privileges stay
  with that profile.
- **Pod Security Admission.** See "Pod Security" below: GPU shares and RDMA both rule out enforcing
  `baseline`.
- **Device plugin and `resourcesPerNode`.** With a device-plugin RDMA profile, check that a job's
  `resourcesPerNode` keeps the runtime's RDMA resource. Trainer merges it into the container's
  resources; this isn't tested on an RDMA cluster yet.
- **Shares and NCCL.** Share profiles run one process on one node, so they need no NCCL networking.

## Requirements

- Kubeflow Trainer and JobSet (no Kubeflow dashboard, Istio or Dex needed for these runtimes):
  Trainer 2.2 and later, tested on 2.2.1. Trainer 2.1 (`podTemplateOverrides`) is read by the
  policy, best-effort: it was tested before the outputs option and the policy's later rules. SUSE's
  Kubeflow chart (`oci://registry.suse.com/ai/charts/kubeflow`, a technology preview) ships Trainer
  v2.2.1 in its 0.4 releases and v2.1 in 0.3.
- KAI scheduler, and AI Factory projects: each project's namespaces carry its KAI queue as the
  `kai.scheduler/queue` label (the Projects page sets it with the project's GPU quota).
- Kubernetes 1.30 or newer (ValidatingAdmissionPolicy).
- The Kubeflow SDK release built for the installed Trainer. A newer SDK writes fields an older
  Trainer's API does not have, which the API server drops: the job then runs without its queue or
  share (and the policy refuses it).

| Trainer | SUSE Kubeflow chart | Kubeflow SDK | The TrainJob sets pod metadata through |
|---|---|---|---|
| 2.1 | 0.3 | 0.3.x | `podTemplateOverrides` |
| 2.2.1 | 0.4.0, 0.4.1 | 0.4.x | `runtimePatches` |

```sh
helm install aif-training-runtimes charts/aif-training-runtimes -n kubeflow
kubectl label namespace team-a ai-factory.suse.com/managed=true    # each project namespace the policy covers
```

## Who can train, and where

**Project membership** decides which namespaces someone can submit to: the chart's ClusterRole
`ai-trainer` (submit, follow and delete TrainJobs; read their pods, logs and events), bound in a
project's namespaces. In Rancher, a project RoleTemplate of the same name binds it to the members
it is assigned to, in every namespace of the project. Create it once in Rancher (it refers to the
downstream cluster's `ai-trainer` ClusterRole by name):

```yaml
apiVersion: management.cattle.io/v3
kind: RoleTemplate
metadata:
  name: ai-trainer
displayName: AI Trainer
description: Submit and follow Kubeflow training runs in the project
context: project
external: true          # the rules are the downstream cluster's ClusterRole ai-trainer
```

Or set `rbac.aggregateToEdit: true` to add the rules to Kubernetes' `edit` role, which Rancher's
Project Member inherits: every project member can then train. Without either, a project member can
list the runtimes but not submit (`edit` only reads TrainJobs).

**The policy** decides what a job there may ask for: its project's queue, within the runtime's
limits. It applies in the namespaces `policy.namespaceSelector` selects, by default those labelled
`ai-factory.suse.com/managed: "true"`; `{}` selects every namespace.

## Submitting a run

With the Kubeflow SDK and `aif-training` (`sdk/aif-training`). Its `namespace_queue(client)` option
puts the job in the KAI queue of the namespace the client submits to. It fails closed: no fallback
to another namespace or queue.

```python
from kubeflow.common.types import KubernetesBackendConfig
from kubeflow.trainer import CustomTrainer, TrainerClient
from aif_training import namespace_queue

def train():
    import os, torch
    ...                                   # outputs to os.environ["OUTPUT_DIR"] (with outputs.enabled)

client = TrainerClient(backend_config=KubernetesBackendConfig(namespace="team-a"))
job = client.train(runtime=client.get_runtime("aif-share-4g"),
                   trainer=CustomTrainer(func=train, packages_to_install=["transformers", "peft"]),
                   options=[namespace_queue(client)])
client.wait_for_job_status(job)
print("\n".join(client.get_job_logs(job)))
```

For whole GPUs, use `aif-gpu` with `CustomTrainer(..., num_nodes=2, resources_per_node={"gpu": 2})`.

**Without `aif-training`.** The option is the trainer pods' queue label, `kai.scheduler/queue: <the
project's queue>`. Set it through `RuntimePatch` (SDK 0.4, Trainer 2.2) or `PodTemplateOverrides`
(SDK 0.3, Trainer 2.1) on the replicated job `node`. That's what `namespace_queue()` builds.

**Tested** on RKE2 1.34 with SUSE's Kubeflow chart 0.4.1 (Trainer v2.2.1, JobSet v0.11.1 from SUSE's
registry), KAI v0.18.2 (HAMi-core) and SDK 0.4.1. A LoRA run (Qwen2.5-0.5B) on a 4 GiB share ran in
its project's queue: the process saw 4.1 GiB and peaked at 2.9. It trained at 1,670 tokens/s, and
lowered its held-out loss from 1.414 to 1.376. Trainer started one process per node on the share.

SDK 0.4 looks for Trainer's version in the `kubeflow-system` namespace and logs a warning when
Trainer is installed elsewhere (SUSE's chart uses `kubeflow`); it carries on without it.

## The policy

Two ValidatingAdmissionPolicies, in the namespaces `policy.namespaceSelector` selects.

**`aif-trainjobs`.** A TrainJob is checked when it's created or its spec changes, not on the
Trainer controller's own updates. Every patch that sets the trainer pods' metadata is checked, since
a later patch can override an earlier one. A job is refused, with a message saying what to set,
when:

- it names a runtime other than these profiles (`policy.runtimesOnly`). That includes a namespaced
  TrainingRuntime that reuses one of their names;
- its namespace has no KAI queue, or its pods aren't labelled with that queue, in every patch that
  sets one;
- it sets a GPU share in any patch (`policy.shareAnnotations`: `gpu-memory`, `gpu-fraction`,
  `gpu-fraction-num-devices`): a job's share comes from its profile;
- it asks for more nodes, or more GPUs per node, than its profile allows, or whole GPUs on a share
  or CPU profile;
- with ReadWriteOnce outputs, it asks for more than one node (`outputs`, below);
- its image (`trainer.image`) isn't from the profile's `registries`;
- its `activeDeadlineSeconds` is beyond the profile's `maxRuntimeHours`;
- its `resourcesPerNode` CPU or memory is beyond the profile's `maxCpu` or `maxMemory`;
- its patches set:
  - the pods' placement (`nodeSelector`, `affinity`, `tolerations`), unless `policy.allowPlacement`;
  - a `securityContext`, at pod or container level;
  - a `serviceAccountName`;
  - a volume other than a PersistentVolumeClaim, ConfigMap, Secret, emptyDir, projected, downward
    API or ephemeral volume.

  A job can still mount the project's PVCs, its datasets for example.

**`aif-gpu-pods`, the backstop** (`policy.pods.enabled`):
- **What it checks.** A pod that asks for GPUs, whole or a KAI share, must be scheduled by KAI and
  carry its namespace's queue, however it was created. It covers the pod-create route around the
  TrainJob policy: a user or tool that can create pods directly.
- **When.** It's checked on create, since KAI updates the pods it places.
- **What it leaves alone.** Share sizes on pods aren't checked, so inference workloads in a project
  namespace keep their own share settings.

Set `policy.actions: [Warn, Audit]` to see what they would refuse before enforcing them.

**Things to know:**
- **Namespace labels.** Whatever creates project namespaces should label them
  `ai-factory.suse.com/managed=true`. A namespace without the label isn't checked, and KAI places
  its pods in its default queue.
- **Moving a namespace to another queue.** The TrainJob policy also checks spec changes made by
  other controllers: an admission system adding its patch, or toggling `suspend`. If a namespace's
  queue label changes while its jobs are suspended or queued, those updates are refused. Don't move
  a namespace to another queue under live jobs.

### Namespace labels

**`aif-namespace-labels`** (`policy.namespaceLabels.enabled`) protects the two labels the other
policies trust, on every namespace, managed by AI Factory or not:

| Change | Needs, beside Kubernetes RBAC on the namespace |
|---|---|
| neither label changes | nothing |
| assign queue B to a namespace without one | `assign` on `ai-factory.suse.com/namespacequeues` B |
| move a namespace from queue A to B | `assign` on A **and** B |
| remove queue A | `assign` on A |
| set or remove `ai-factory.suse.com/managed` | `set` on `ai-factory.suse.com/managednamespaces` for that namespace, independent of queues |

**Granting it.** Grants may name particular queues or namespaces (`resourceNames`), and the policy
asks about the exact names involved. Cluster admins have both permissions. The chart's
`aif-queue-assigner` and `aif-namespace-manager` ClusterRoles grant them, unrestricted: bind them
through `policy.namespaceLabels.assigners` and `.managers`, or write roles with `resourceNames`
to delegate.

**Why.** Rancher gives a project's owners `*` on their project's namespaces. Without this policy, an
owner could point a namespace at another project's queue and use its GPU quota, or remove
`managed` and leave the policies.

**Queues aren't project ownership.** A queue grant doesn't move a namespace between Rancher
projects: that's Rancher's `field.cattle.io/projectId`, guarded by Rancher itself.

**Tests.** `tests/policy/namespace-labels.sh` checks it:
- as a project owner (impersonated), and as an admin;
- with `SCOPED=1`, for per-queue and per-namespace grants: B-only refused moving A → B, A+B
  allowed, a separate manager permission. Its fixtures are in
  `queue-assigner-test-rbac.yaml`-style test grants.

### Pod Security

These are dry runs of the Pod Security labels on a project namespace (`kubectl label --dry-run=server
ns <project> pod-security.kubernetes.io/enforce=<level>`). Each lists the running pods that would
violate the level. With a training pod, the vLLM server and a LiteLLM gateway running:

| Level | Violations |
|---|---|
| `restricted` | every pod: images running as root, no `seccompProfile`, `allowPrivilegeEscalation` not false, capabilities not dropped |
| `baseline` | **every GPU-share pod**: `hostPath` volumes |

**The `hostPath` volumes come from KAI, not from the profiles.** KAI's GPU sharing (HAMi-core) adds
three to each share pod when it admits it, for its resource isolator: `/usr/local/vgpu`,
`/usr/local/vgpu/containers` and `/tmp/vgpulock`. Pod Security checks the pod after that.

**What this means for enforcement:**
- **Enforcing `baseline`** on a namespace refuses every GPU-share pod: training and inference.
- **Enforcing `restricted`** needs images built to run as non-root, plus the profiles' security
  context.
- **What's possible:**
  - `warn` and `audit` at `baseline` (or `restricted`), which report and don't refuse.
  - The policies here for the rules that matter to the platform: patches can't add privileged
    containers, capabilities, node paths, service accounts or placement; pods with GPUs go
    through KAI, in their queue, from approved registries.
  - Enforcing `baseline` only on namespaces that run no GPU shares and no RDMA profiles.
- **Not tested:** whether KAI's NvFractions sharing mode (NVIDIA driver r615+) also needs node
  paths.


`tests/policy/` holds the policy's cases, run as server-side dry runs: the valid jobs, each rule,
the bypasses (a second patch, other share annotations, a namespaced runtime, pods created
directly), and a namespace outside the scope.

```sh
CONTEXT=<kube context> NS=<managed namespace> OTHER_Q=<another queue> OTHER_NS=<unmanaged namespace> tests/policy/run.sh
```

Run them whenever the policy, Kubernetes, Trainer or KAI changes. Compile errors and CEL type
issues only show up on the API server: a dry-run `kubectl apply --server-side` of the rendered chart
checks compilation, and the cases check behaviour.

## Outputs

With `outputs.enabled`, each TrainJob gets its own volume for its outputs: JobSet creates the PVC
`outputs-<job>` from the runtime's `volumeClaimPolicies`, and mounts it on the job's nodes at
`/outputs` (`OUTPUT_DIR`). With `outputs.retain` (the default), the PVC is kept when the TrainJob is
deleted, for serving or evaluation, until someone deletes it.

```python
trainer=CustomTrainer(func=train, env={"CHECKPOINT_DIR": "/outputs"})   # or read OUTPUT_DIR in train()
```

Each outputs PVC is labelled `ai-factory.suse.com/kind: outputs` and, by JobSet,
`jobset.sigs.k8s.io/jobset-name: <job>`. Every run's volume across the cluster is listed with
`kubectl get pvc -A -l ai-factory.suse.com/kind=outputs -L jobset.sigs.k8s.io/jobset-name`, or in
Rancher's PersistentVolumeClaims list filtered on that label.

**Changing outputs or a profile's share.** Changing `outputs`, or a profile's share, on an installed
chart means recreating the runtimes:
the runtime's `volumeClaimPolicies` is immutable, as JobSet's is, and `helm upgrade` is refused
with *Value is immutable*. Delete the three ClusterTrainingRuntimes, then upgrade. Existing
TrainJobs keep running.

**Job names.** With `retain`, `outputs-<job>` outlives its TrainJob. A later TrainJob with the same
name asks JobSet for the same claim name. Expect it to reuse the old volume, and the old run's
files. Give runs unique names: the Kubeflow SDK generates one when no `Name` option is given.

This needs **JobSet v0.11 or later**. JobSet v0.10 has no `volumeClaimPolicies`, drops the field,
and the job runs without the volume. SUSE's Kubeflow chart 0.4.1 ships JobSet v0.10.1; SUSE's
registry has v0.11.1 (`registry.suse.com/ai/containers/jobset/jobset`), with which this was tested.
A multi-node run shares the one volume, so it needs `outputs.accessModes: [ReadWriteMany]`.

Tested: a LoRA run wrote its adapter to `/outputs`; after the TrainJob and its JobSet were deleted,
`outputs-kf22-lora-outputs` (Longhorn, 10 Gi) still held the adapter and the training record.

## What it does not do

A TrainJob's record is its status, kept while the TrainJob exists; the outputs volume outlives it,
but nothing records which run produced it beyond its name. AI Factory's prototype on
`prototype/aijob` adds the run record, artifacts by content hash, retention and cleanup, the Data
page and the AI Jobs UI.
