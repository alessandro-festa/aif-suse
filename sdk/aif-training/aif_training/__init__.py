"""SUSE AI Factory's option for the Kubeflow Trainer SDK.

    from kubeflow.trainer import CustomTrainer, TrainerClient
    from aif_training import namespace_queue

    client.train(runtime=client.get_runtime("aif-share-4g"), trainer=CustomTrainer(func=train),
                 options=[namespace_queue(client)])

A TrainJob runs in the namespace its client submits to. A namespace belongs to a Rancher project,
and the platform assigns it a KAI queue: its kai.scheduler/queue label, set by whoever
administers queues (admission refuses anyone else). A project's namespaces may share a queue or
have their own. namespace_queue() reads the target namespace's queue and puts the trainer pods in
it. It doesn't choose a queue, and it doesn't resolve Rancher projects.
"""
from __future__ import annotations

QUEUE_LABEL = "kai.scheduler/queue"
MANAGED_LABEL = "ai-factory.suse.com/managed"
__all__ = ["namespace_queue", "queue_of", "QUEUE_LABEL", "MANAGED_LABEL"]

_FALLBACK = ("A KubernetesBackendConfig without a namespace targets the kubeconfig context's namespace, "
             "'default', or the pod's own: give the namespace explicitly, "
             "TrainerClient(backend_config=KubernetesBackendConfig(namespace=...)).")


def queue_of(client) -> str:
    """The KAI queue the platform assigned to the namespace a TrainerClient submits to, read
    through the client's own connection (its credentials and context, or its pod's service
    account). Fails, naming the namespace, unless it's an AI Factory-managed namespace with a
    valid queue: there's no fallback to another namespace or queue."""
    import re

    backend = getattr(client, "backend", None)
    namespace, core = getattr(backend, "namespace", None), getattr(backend, "core_api", None)
    if core is None or not isinstance(namespace, str) or not namespace:
        raise TypeError("namespace_queue() and queue_of() take a TrainerClient with the Kubernetes backend "
                        "and a namespace. " + _FALLBACK)
    try:
        ns = core.read_namespace(namespace)
    except Exception as e:  # not found, forbidden, unreachable: never guess
        status = getattr(e, "status", None)
        raise ValueError(f"the TrainerClient's namespace {namespace!r} can't be read"
                         f"{f' (HTTP {status})' if status else ''}: {getattr(e, 'reason', e)}. " + _FALLBACK) from e
    labels = ns.metadata.labels or {}
    if labels.get(MANAGED_LABEL) != "true":
        raise ValueError(f"the TrainerClient's namespace {namespace!r} isn't an AI Factory-managed namespace "
                         f"({MANAGED_LABEL}=true). " + _FALLBACK)
    q = labels.get(QUEUE_LABEL, "")
    if not re.fullmatch(r"[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?", q):
        raise ValueError(f"namespace {namespace!r} has no valid KAI queue ({QUEUE_LABEL}={q!r}): "
                         "the platform assigns one to an AI Factory namespace with a GPU quota")
    return q


def namespace_queue(client):
    """A TrainJob option: the trainer pods run in the KAI queue of the namespace the client submits
    to. Kubeflow SDK 0.4 and later (Trainer 2.2, runtimePatches), or 0.3 (Trainer 2.1,
    podTemplateOverrides)."""
    metadata = {"labels": {QUEUE_LABEL: queue_of(client)}}
    from kubeflow.trainer import options as o

    if hasattr(o, "RuntimePatch"):
        pod = o.PodTemplatePatch(metadata=metadata)
        node = o.ReplicatedJobPatch(name="node", template=o.JobTemplatePatch(spec=o.JobSpecPatch(template=pod)))
        return o.RuntimePatch(o.TrainingRuntimeSpecPatch(o.JobSetTemplatePatch(spec=o.JobSetSpecPatch(replicated_jobs=[node]))))
    return o.PodTemplateOverrides(o.PodTemplateOverride(target_jobs=["node"], metadata=metadata))
