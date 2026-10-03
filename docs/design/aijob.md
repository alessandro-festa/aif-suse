# AIJob: a durable record of a finite AI workload

This document defines the API contract for an AIJob, a durable record of
one finite AI workload: its identity, ownership, and lifecycle.

## Problem

A training job on the cluster is a Helm release that creates a Job or a
PyTorchJob. The Job carries `ttlSecondsAfterFinished`, so after the ttl it
finishes the Job and its pods are deleted, and the container logs on the
node go with them. The Helm release secret stays forever and records the
values, not the outcome. The result is a cluster with many releases, no
Jobs, and a UI that can only say the Job has been cleaned up.

Three lifetimes are tied together that should be separate:

| Lifetime | What it is | How long it should last |
|---|---|---|
| Execution | Job, pods, Kueue Workload, ResourceClaims, ephemeral PVC, Helm release | days |
| Observability | logs and metrics | months, by backend retention |
| History | what was submitted, where it ran, how it finished, what it consumed | a year or more |

## Proposal

`AIJob` is a namespaced resource in `ai-factory.suse.com/v1alpha1`, short
name `aijob`. It is the durable record of one finite execution. Its name is
the job id.
The operator creates the execution from the spec, copies execution facts
into the status while they exist, and removes the execution objects when
their retention passes. Deleting the execution does not delete the run.

`AIWorkload` stays what it is: a long-running deployment of a Blueprint.
An AIJob is finite and ends. The two kinds share the source model and the
Helm machinery, not a status model, the same way a Deployment and a Job
share a pod template and nothing else. Extending AIWorkload with a
lifecycle discriminator was considered and rejected: its phase derives
from controller readiness, its operations are upgrade and rollback
against a certified baseline, and its spec is mutable by design. None of
that applies to an execution that ends.

### Two axes: lifecycle and category

Lifecycle is the kind: AIWorkload keeps running, AIJob ends. Purpose is a
field, `category`, on Blueprint, AIWorkload, and AIJob, with values
`inference`, `training`, `agent`, `rag`, `data`, and `custom`. The UI
filters and groups on it. An agent is a long-running service, so it is an
AIWorkload with category `agent`; its governance stays with the platform
that provides it. The `category` field is a separate, smaller independent
change.

### Identity

- `metadata.name` is the job id. The UI generates it at submit as
  `<prefix>-<date>-<5 hex>`, for example `train-20261002-8f29a`.
- The Helm release is named after the job. There is no mapping table.
- Every object the chart creates carries the label
  `ai-factory.suse.com/job-id: <name>`. The operator passes it as a
  common label on install. A chart used by an AIJob must propagate
  common labels to its Job or PyTorchJob, pod templates, ResourceClaim
  templates, and PVCs. Logs and metrics are later keyed by this label.
  Until a chart honours it, the operator finds a release's pods by
  `app.kubernetes.io/instance`.

### Who writes what

- A client (the UI, a CLI, a notebook, or another controller) creates the
  AIJob and nothing else. The spec is the whole statement of intent.
- The operator owns the Helm release, through the in-process Helm client
  it already uses for AIWorkloads. It installs on creation, never
  upgrades, and uninstalls at cleanup.
- The chart comes from the ClusterRepo's HTTP or OCI URL, which the
  operator hands to the Helm client directly, so no Rancher token is
  involved. Git-backed ClusterRepos are refused in the first version;
  supporting them means the catalog download the AIWorkload controller
  uses for Git-backed Blueprint charts.
- The operator owns the status. Clients do not write it.
- The operator reads the execution objects (Jobs, pods, Kueue Workloads,
  ResourceClaims) uncached on a timer rather than watching them, so it
  does not cache every pod in the cluster: every 10 seconds while a job
  is starting or running, every 30 seconds while Kueue holds it. A watch
  filtered by the job-id label is a later improvement.
- Kueue, the Job controller, and the training operator own the execution
  objects as they do today. The chart stops relying on
  `ttlSecondsAfterFinished` for normal cleanup and keeps it as a backstop
  set beyond the retention period, so a broken operator still cannot
  leave finished Jobs behind forever. `activeDeadlineSeconds` remains the
  backstop for a run that never finishes.

## API

```yaml
apiVersion: ai-factory.suse.com/v1alpha1
kind: AIJob
metadata:
  name: train-20261002-8f29a
  namespace: aif-submit
spec:
  displayName: Fine-tune qwen on support tickets
  category: training
  profile: a2000-training            # informational; the profile chose the values below
  source:                            # same shape as AIWorkloadSource: a chart from a ClusterRepo
    repoName: gpu-train-charts
    chartName: gpu-train-job
    version: 0.1.27
  values: {}                         # the chart values as submitted; immutable
  retention:
    executionObjects: 168h           # how long the Job, pods, claims, release stay after completion
status:
  phase: Running
  observedGeneration: 1
  submittedAt: "2026-10-02T09:14:02Z"
  admittedAt:  "2026-10-02T09:17:14Z"
  startedAt:   "2026-10-02T09:17:40Z"
  completedAt: null
  execution:
    release: train-20261002-8f29a
    kind: PyTorchJob                  # or Job
    name: train-20261002-8f29a
  queue:
    workload: pytorchjob-train-20261002-8f29a-c4f1b
    localQueue: default-queue
    clusterQueue: gpu-cluster-queue
  pods:                              # bounded; see Status size
    - name: train-20261002-8f29a-worker-0
      node: rke2-worker1
      phase: Running
      restarts: 0
      exitCode: null
      reason: ""
  resources:
    gpuCount: 1
    gpus:
      - pod: train-20261002-8f29a-worker-0
        mode: dra                    # or device-plugin
        device: gpu-0
        claim: train-20261002-8f29a-worker-0-gpu
        product: NVIDIA RTX A2000 12GB
  result:
    exitCode: null
    reason: ""
    message: ""
  cleanup:
    dueAt: null
    completedAt: null
  conditions: []
```
### Install failures and chart checks

A chart that refuses to render fails the job. A network error while
fetching the chart is retried.

A capacity check at render time is not a failure. Some charts refuse to
render when no node has room for the job right now, which is useful
advice for a person but the wrong outcome under an operator: capacity is
for the scheduler and Kueue to manage, and the pod should wait. A client
submitting an AIJob therefore turns off a chart's install-time capacity
check (`preflight.checkHeadroom: false` for `gpu-train-job`) and keeps its
configuration checks (the queue, PVCs, and CRDs exist; the image
reference is valid), whose failures do not go away by waiting and
correctly fail the job. The operator stays chart-agnostic and does not
rewrite values. A client that wants a capacity answer before submitting
asks for one itself, as advice rather than as a gate. A disk-pressure
check stays on, since a node under disk pressure evicts the pods anyway.

### Spec rules
- `source` and `values` are immutable. A CEL rule on the CRD enforces
  `self == oldSelf` for both. A change of intent is a new run.
- `retention.executionObjects` defaults to `168h` (7 days) and may be
  changed after creation, so a person can keep a failed run's pods longer
  before they are removed.
- `profile`, `displayName`, and `category` are informational and mutable.

### Status rules

- Timestamps are raw facts, never derived. `submittedAt` is the creation
  time. `admittedAt` comes from the Kueue Workload's `Admitted`
  condition. `startedAt` is the earliest pod start. `completedAt` is the
  Job or PyTorchJob completion or failure time. Queue wait and duration
  are computed by readers.
- Pod facts are copied while the pods exist: node, restarts, exit code,
  reason, message. The pod list is kept whole up to 16 pods; above that
  the status keeps counts by phase and the full entries only for pods
  that failed.
- GPU facts are copied while the ResourceClaim exists. For DRA the
  allocation names the device and the claim; for the device plugin the
  request count and the node's GPU product label are recorded.
- Exit codes are the container's. Under `torchrun`, a script that exits
  3 is recorded as 1, which is what torchrun returns.
- Every attempt is kept: a failing index retried by the Job's backoff
  adds a pod entry with its node and exit code.
- `result` is final once the run reaches a terminal phase and does not
  change afterwards.
- If the Job is deleted (its ttl, or by hand) before its outcome was
  seen, the phase is left alone and `Completed` is `Unknown` with reason
  `ExecutionDeleted`. The status does not guess.
- `observedGeneration` advances only when a reconcile reaches a settled
  state, the same rule the AIWorkload reconciler follows.

### Phases

| Phase | Entered when | Left when |
|---|---|---|
| Pending | the AIJob exists and the release is not installed | the release is installed |
| Queued | the Kueue Workload exists without the `Admitted` condition | admitted, or cancelled |
| Admitted | the Workload has `Admitted` and no pod has started | a pod starts |
| Running | a pod is running | the execution object reports a terminal condition |
| Succeeded | Job `Complete`, or PyTorchJob `Succeeded` | never |
| Failed | Job `Failed`, or PyTorchJob `Failed`, or the install failed | never |
| Cancelled | cancel was requested before a terminal phase and the release is gone | never |

Suspended is a condition, not a phase: a Workload Kueue has evicted or a
Job someone suspended by hand is `Running` or `Admitted` with
`Suspended=True`, since it will resume on its own.

### Conditions

| Type | Meaning |
|---|---|
| Installed | the Helm release is deployed |
| Admitted | Kueue admitted the Workload |
| Suspended | the execution is suspended; reason says by whom |
| Completed | the execution reached a terminal state; reason is Succeeded, Failed, or Cancelled |
| ExecutionCleaned | the execution objects and the release are gone |

## Lifecycle

```text
create AIJob
      │ operator installs the release, labels everything with the run id
      ▼
   Pending ──► Queued ──► Admitted ──► Running ──► Succeeded | Failed
                                                       │
                                        retention clock starts at completedAt
                                                       │
                                            operator uninstalls the release,
                                            which removes Job, pods, claims,
                                            ephemeral PVC; ExecutionCleaned=True
                                                       │
                                            AIJob remains, with every
                                            fact above and the time window
                                            that logs and metrics are keyed by
```

Cleanup is not a phase. It is garbage collection of the implementation
under a record that is already final.

### Cancel

Setting `spec.cancel: true` on a job that is not terminal makes the
operator uninstall the release and set the phase to Cancelled. The record
stays. This is the only way a client stops a job; the UI's Cancel sets
this field.

### Deletion

Deleting an AIJob removes the history. A finalizer makes it safe:

1. If the release still exists, uninstall it, so a running job does not
   outlive its record.
2. Remove the finalizer.

The UI presents these as two different actions: "Clean up execution
resources", which the operator also does on its own at retention, and
"Delete run record", which is subject to whatever history policy an
installation sets. Nothing deletes run records automatically in this
version.

### Operator restart

The reconciler holds no state of its own. After a restart it reads the
AIJob, the release, the Workload, the execution object, the pods,
and the claims, and fills in whatever the status is missing. A fact that
was never observed because the object was already gone stays empty; the
status never guesses.

## Retention defaults

| Object | Default | Owner |
|---|---|---|
| Pods, Job or PyTorchJob, Workload, claims, ephemeral PVC, Helm release | 7 days after completion | operator, `spec.retention.executionObjects` |
| Job `ttlSecondsAfterFinished` | 14 days | chart, as a backstop only |
| AIJob | kept | installation policy, manual |
| Logs | 90 days | log backend retention |
| Checkpoints and outputs on a named PVC | kept | storage policy, outside this API |

## What this enables, in order

1. The Workloads page lists AIJobs instead of Jobs and releases, so
   a run from months ago still shows what was submitted, how long it
   queued, where it ran, how it ended, and what it used.
2. A logging adapter needs only the job id and the time window from
   `startedAt` to `completedAt` to build a query for Loki, OpenSearch, or
   Rancher Logging. The record says whether logs are configured; the UI
   says "View logs".
3. Metrics follow the same pattern.
4. Aggregates over AIJobs: success rate, queue wait percentiles,
   GPU hours.

## Out of scope for the first version

- Multi-cluster targets. AIWorkload reaches downstream clusters through
  Fleet. An AIJob runs in the cluster where it is created. Fleet
  delivery can be added later with the same record.
- Automatic deletion of job records.
- Artifacts. A later version records references to checkpoint PVCs or
  object storage; the first version keeps the named PVC in the values
  and nothing more.
- Inference endpoints. Those are long-running and belong to AIWorkload.

## Open questions for review

- Namespace. This document puts the AIJob in the project namespace so
  Rancher project membership governs who sees and submits. Draft PR #160
  moves AIWorkload resources into a dedicated system namespace; if that
  direction holds, AIJob should follow it and the UI's project scoping
  comes from a label instead.
- Whether `spec.source` should also accept a Blueprint component, so a
  training Blueprint can be launched the way an AIWorkload is.
- Whether `retention.executionObjects` belongs in Settings as a
  cluster default with the per-run field as an override.
- The install identity. Anyone who can create an AIJob can make the
  operator install whatever the chart renders, with the operator's
  permissions, in that namespace. An allow-list of charts
  (`manager.aijobAllowedCharts`) bounds what can be installed, but the
  values are still the submitter's. Two ways to close this: install with
  an impersonated identity (the creator's, recorded by an admission
  webhook, or a per-namespace service account the project owns), or a
  validating policy on the values a chart accepts.
