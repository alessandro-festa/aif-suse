# aif-training

SUSE AI Factory's option for the [Kubeflow Trainer SDK](https://github.com/kubeflow/sdk): a TrainJob
in the KAI queue of the namespace it runs in. The GPUs come from the compute profile the job names
(the `aif-training-runtimes` chart's ClusterTrainingRuntimes).

```python
from kubeflow.common.types import KubernetesBackendConfig
from kubeflow.trainer import CustomTrainer, TrainerClient
from aif_training import namespace_queue

def train():
    import os, torch
    ...                                   # write what to keep to os.environ["OUTPUT_DIR"]

client = TrainerClient(backend_config=KubernetesBackendConfig(namespace="team-a-training"))
client.list_runtimes()                    # the profiles: aif-share-4g, aif-share-8g, aif-gpu, aif-cpu
job = client.train(runtime=client.get_runtime("aif-share-4g"),
                   trainer=CustomTrainer(func=train),
                   options=[namespace_queue(client)])
```

**Projects, namespaces, queues.** These are three things:
- **A Rancher project** owns namespaces: RBAC and governance.
- **A namespace** is where a TrainJob runs.
- **A KAI queue** schedules GPU work, against a quota.

The platform assigns each namespace a queue, its `kai.scheduler/queue` label. A project's namespaces
may share one queue, or have their own. Only principals with `assign` on
`ai-factory.suse.com/namespacequeues` can set the label: cluster admins, and the chart's
`aif-queue-assigner` role. Admission refuses anyone else, including the project's owners.

**What `namespace_queue(client)` does:**
- It reads the queue of the namespace the client submits to, through the client's own connection: its
  credentials and context, or its pod's service account in a cluster.
- So the queue and the job's namespace can't disagree.
- It doesn't choose a queue, and doesn't resolve Rancher projects.
- `queue_of(client)` returns the queue's name, for code that needs it (e.g. an inference server in
  the same queue).

**It fails closed.** It raises, naming the namespace, unless the namespace is managed by AI Factory
(`ai-factory.suse.com/managed=true`) and has a valid queue label. It never falls back to another
namespace or queue. The refused cases:
- **No namespace given:** the SDK resolves one itself, from the kubeconfig context, `default`, or
  the pod's own namespace. When that isn't a managed namespace, the job is refused, with a message
  to give the namespace explicitly.
- **An unmanaged namespace**, even one with a queue label.
- **A managed namespace with no queue,** or an invalid one.
- **A namespace that can't be read:** not found, or forbidden.
- **A client that isn't the Kubernetes backend's,** or a plain name instead of a client.

`tests/` checks these against a fake client: `python sdk/aif-training/tests/test_namespace_queue.py`.

It builds the trainer pods' metadata patch for the installed SDK: `RuntimePatch` (SDK 0.4 and later,
Trainer 2.2) or `PodTemplateOverrides` (SDK 0.3, Trainer 2.1). Both are tested, 0.4.1 and 0.3.1. It
reads the client's `backend.namespace` and `backend.core_api`.

Leave the job's name to the SDK (no `Name` option): a run's outputs volume is named after its job,
and a reused name meets the previous run's volume.

**The long-term aim is to need none of this.** The option exists because KAI needs the queue on the
pods, and Kubeflow Trainer doesn't supply it. Admission-time defaulting would set the queue from the
namespace instead, a MutatingAdmissionPolicy on the trainer pods. Then a job is only a runtime and
code. That needs MutatingAdmissionPolicy on the cluster, which is off by default in Kubernetes 1.34.
It also needs testing that the label added at pod admission reaches KAI's pod grouping.

```sh
pip install "aif-training @ git+https://github.com/dstanley/aif@prototype/kubeflow-trainer#subdirectory=sdk/aif-training"
```
