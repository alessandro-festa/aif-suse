"""AI projects and compute pools, read from local: what a data scientist sees before submitting."""

from types import SimpleNamespace

from rancher_ai.client import Client
from rancher_ai.factory import Pools, Projects

PROJECT = {"metadata": {"name": "vision"}, "spec": {"displayName": "Vision", "clusters": [
    {"clusterId": "c-a", "namespace": "vision"}, {"clusterId": "c-b", "namespace": "vision-b"}]},
    "status": {"namespace": "aif-vision", "conditions": [{"type": "Ready", "status": "True"}]}}
POOLS = [
    {"metadata": {"name": "c-a-cpu"}, "spec": {"clusterId": "c-a", "displayName": "downstream-1", "kind": "cpu"},
     "status": {"nodes": 1, "allocatable": {"cpu": "10", "memory": "20Gi"}, "requested": {"cpu": "2500m", "memory": "4Gi"},
                "schedulers": ["volcano"], "training": ["kuberay"], "conditions": [{"type": "Connected", "status": "True"}]}},
    {"metadata": {"name": "c-z-gpu"}, "spec": {"clusterId": "c-z", "kind": "gpu"},
     "status": {"allocatable": {"cpu": "8", "gpus": 2}, "requested": {"gpus": 1}}},
    {"metadata": {"name": "local-cpu"}, "spec": {"clusterId": "local", "kind": "cpu"}, "status": {}},
]


def fake_client():
    def list_custom(group, version, plural, *a, **k):
        return {"aiprojects": [PROJECT], "computepools": POOLS}.get(plural, [])
    c = object.__new__(Client)
    c.conn = SimpleNamespace(list_custom=list_custom, namespace="vision")
    c.projects, c.pools = Projects(c), Pools(c)
    return c


def test_an_ai_projects_runs_live_in_its_namespace_on_local():
    c = fake_client()
    assert c.namespace_of("vision") == "aif-vision"
    assert c.namespace_of(None) == "aif-vision", "the client's own project"
    assert c.namespace_of("team-a") == "team-a", "not an AI project: a namespace, as on a single cluster"
    assert c.projects.get("vision").namespace_on("c-b") == "vision-b"


def test_pools_say_what_is_free_and_skip_local():
    c = fake_client()
    names = [p.name for p in c.pools.all()]
    assert sorted(names) == ["c-a-cpu", "c-z-gpu"], "local runs no AI work"
    a = c.pools.get("c-a-cpu")
    assert (a.cluster, a.cpu_free, a.memory_free, a.schedulers, a.training, a.connected) == ("downstream-1", 7.5, "16.0Gi", ["volcano"], ["kuberay"], True)
    assert c.pools.get("c-z-gpu").gpus_free == 1
    assert [p.name for p in c.pools.all("vision")] == ["c-a-cpu"], "only the clusters the project spans"
    row = c.pools.table("vision").rows[0]
    assert row["runtimes"] == "job, kuberay" and row["scheduler"] == "volcano"
