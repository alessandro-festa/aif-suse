"""namespace_queue() and queue_of() against a fake TrainerClient: no cluster needed.

    python -m pytest sdk/aif-training/tests     (or: python sdk/aif-training/tests/test_namespace_queue.py)
"""
from types import SimpleNamespace as NS

from aif_training import MANAGED_LABEL, QUEUE_LABEL, namespace_queue, queue_of


class Core:
    def __init__(self, namespaces):
        self.namespaces = namespaces

    def read_namespace(self, name):
        if name not in self.namespaces:
            raise type("ApiException", (Exception,), {"status": 404, "reason": "Not Found"})()
        return NS(metadata=NS(labels=self.namespaces[name]))


def client(namespace, labels=None):
    return NS(backend=NS(namespace=namespace, core_api=Core({} if labels is None else {namespace: labels})))


def refused(c, words, exc=ValueError):
    try:
        queue_of(c)
    except exc as e:
        assert all(w in str(e) for w in words), str(e)
        return
    raise AssertionError("expected a refusal")


def test_managed_namespace_with_a_queue():
    c = client("team-a-training", {MANAGED_LABEL: "true", QUEUE_LABEL: "team-a"})
    assert queue_of(c) == "team-a"
    namespace_queue(c)                      # builds the patch for the installed SDK


def test_refusals():
    refused(client("default", {}), ["'default'", "isn't an AI Factory-managed namespace", "give the namespace explicitly"])
    refused(client("team-a", {QUEUE_LABEL: "team-a"}), ["isn't an AI Factory-managed"])         # a queue, not managed
    refused(client("team-a", {MANAGED_LABEL: "true"}), ["no valid KAI queue"])                  # managed, no queue
    refused(client("team-a", {MANAGED_LABEL: "true", QUEUE_LABEL: "-bad queue"}), ["no valid KAI queue"])
    refused(client("team-a", {MANAGED_LABEL: "false", QUEUE_LABEL: "team-a"}), ["isn't an AI Factory-managed"])
    refused(client("gone"), ["can't be read", "HTTP 404"])                                       # no such namespace
    refused(client(""), ["namespace"], TypeError)                                                # no namespace at all
    refused(NS(backend=NS()), ["Kubernetes backend"], TypeError)                                 # another backend
    refused("team-a", ["TrainerClient"], TypeError)                                              # a name, not a client


if __name__ == "__main__":
    test_managed_namespace_with_a_queue()
    test_refusals()
    print("ok")
