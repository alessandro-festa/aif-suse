"""AI projects and compute pools: where a run goes.

An AI project (AIProject) is a team's work across clusters. Its runs are AIJobs in its namespace on
Rancher's local cluster, aif-<project>; AI Factory's queue places each on one of the project's compute
pools (ComputePool: a cluster's GPU or CPU nodes) when it fits, or a run names a pool itself. Both are
read from the cluster this connects to (local), whatever cluster a run then runs on.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from .display import Table

if TYPE_CHECKING:
    from .client import Client

AIF = ("ai-factory.suse.com", "v1alpha1")


def project_namespace(project: str) -> str:
    """The namespace on local that holds an AI project's runs."""
    return f"aif-{project}"


@dataclass
class Project:
    name: str
    display_name: str
    namespace: str
    clusters: list[dict] = field(default_factory=list)  # [{clusterId, namespace}]
    ready: bool = False

    def namespace_on(self, cluster_id: str) -> str:
        """The project's namespace on a cluster it spans ('' when it does not span it)."""
        return next((c.get("namespace", "") for c in self.clusters if c.get("clusterId") == cluster_id), "")


@dataclass
class Pool:
    name: str
    cluster: str
    cluster_id: str
    kind: str  # gpu | cpu
    nodes: int
    cpu: str  # "requested / total"
    cpu_free: float
    memory_free: str
    gpus: int
    gpus_free: int
    gpu_models: list[str]
    schedulers: list[str]
    sharing: list[str]
    training: list[str]
    reclaim: dict | None
    connected: bool


def _cores(q) -> float:
    s = str(q or "0")
    if s.endswith("m"):
        return float(s[:-1]) / 1000
    try:
        return float(s)
    except ValueError:
        return 0.0


def _bytes(q) -> float:
    s = str(q or "0")
    units = {"Ki": 2**10, "Mi": 2**20, "Gi": 2**30, "Ti": 2**40, "k": 1e3, "M": 1e6, "G": 1e9, "T": 1e12}
    for u, f in units.items():
        if s.endswith(u):
            return float(s[: -len(u)]) * f
    try:
        return float(s)
    except ValueError:
        return 0.0


def _gib(b: float) -> str:
    return f"{b / 2**30:.1f}Gi"


class Projects:
    def __init__(self, c: "Client"):
        self.c = c

    def all(self) -> list[Project]:
        out = []
        for p in self.c.conn.list_custom(*AIF, "aiprojects"):
            md, spec, st = p.get("metadata", {}), p.get("spec", {}), p.get("status", {}) or {}
            ready = any(c.get("type") == "Ready" and c.get("status") == "True" for c in st.get("conditions", []))
            out.append(Project(name=md["name"], display_name=spec.get("displayName") or md["name"],
                               namespace=st.get("namespace") or project_namespace(md["name"]),
                               clusters=spec.get("clusters") or [], ready=ready))
        return sorted(out, key=lambda p: p.name)

    def get(self, name: str) -> Project:
        p = next((p for p in self.all() if p.name == name), None)
        if not p:
            raise LookupError(f"no AI project {name!r}; `rancher-ai projects list` shows the ones you can see")
        return p

    def table(self) -> Table:
        rows = [{"name": p.name, "display": p.display_name, "namespace": p.namespace,
                 "clusters": ", ".join(f"{c.get('clusterId')}/{c.get('namespace')}" for c in p.clusters),
                 "state": "Ready" if p.ready else "Not ready"} for p in self.all()]
        return Table(rows, ["name", "display", "namespace", "clusters", "state"], state_column="state")

    def list(self):
        return self.table()


class Pools:
    def __init__(self, c: "Client"):
        self.c = c

    def all(self, project: str | None = None) -> list[Pool]:
        """Every usable compute pool; with project=, only those on the clusters the project spans."""
        spans = None
        if project:
            spans = {c.get("clusterId") for c in self.c.projects.get(project).clusters}
        names = self._cluster_names()
        out = []
        for p in self.c.conn.list_custom(*AIF, "computepools"):
            spec, st = p.get("spec", {}), p.get("status", {}) or {}
            cid = spec.get("clusterId", "")
            if cid == "local" or spec.get("disabled") or (spans is not None and cid not in spans):
                continue
            alloc, req = st.get("allocatable") or {}, st.get("requested") or {}
            connected = any(c.get("type") == "Connected" and c.get("status") == "True" for c in st.get("conditions", []))
            out.append(Pool(
                name=p["metadata"]["name"], cluster=spec.get("displayName") or names.get(cid, cid), cluster_id=cid,
                kind=spec.get("kind", "cpu"), nodes=int(st.get("nodes") or 0),
                cpu=f"{_cores(req.get('cpu')):.1f} / {_cores(alloc.get('cpu')):.1f}",
                cpu_free=round(max(0.0, _cores(alloc.get("cpu")) - _cores(req.get("cpu"))), 1),
                memory_free=_gib(max(0.0, _bytes(alloc.get("memory")) - _bytes(req.get("memory")))),
                gpus=int(alloc.get("gpus") or 0), gpus_free=max(0, int(alloc.get("gpus") or 0) - int(req.get("gpus") or 0)),
                gpu_models=(st.get("gpu") or {}).get("models") or [], schedulers=st.get("schedulers") or [],
                sharing=st.get("sharing") or [], training=st.get("training") or [], reclaim=spec.get("reclaim"),
                connected=connected,
            ))
        return sorted(out, key=lambda p: (p.cluster, p.kind))

    def _cluster_names(self) -> dict:
        try:
            items = self.c.conn.list_custom("management.cattle.io", "v3", "clusters")
            return {c["metadata"]["name"]: (c.get("spec") or {}).get("displayName") or c["metadata"]["name"] for c in items}
        except Exception:
            return {}

    def get(self, name: str) -> Pool:
        p = next((p for p in self.all() if p.name == name), None)
        if not p:
            raise LookupError(f"no compute pool {name!r}; `rancher-ai pools list` shows them")
        return p

    def table(self, project: str | None = None) -> Table:
        rows = [{"name": p.name, "cluster": p.cluster, "kind": p.kind.upper(),
                 "cpu_free": f"{p.cpu_free} of {p.cpu.split(' / ')[1]}", "memory_free": p.memory_free,
                 "gpus_free": f"{p.gpus_free} of {p.gpus}" if p.kind == "gpu" else "-",
                 "scheduler": ", ".join(p.schedulers) or "default", "runtimes": ", ".join(["job"] + p.training),
                 "state": "Active" if p.connected else "Unreachable"} for p in self.all(project)]
        return Table(rows, ["name", "cluster", "kind", "cpu_free", "memory_free", "gpus_free", "scheduler", "runtimes", "state"],
                     state_column="state")

    def list(self, project: str | None = None):
        return self.table(project)
