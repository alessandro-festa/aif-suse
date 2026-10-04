"""The Python SDK. In a notebook:

    from rancher_ai import Client
    ai = Client()                          # your kubeconfig context, or the pod's service account
    ai.profiles.list()
    run = ai.runs.create(profile="pytorch-distributed", project="team-a", workers=2, args="--epochs 3")
    run.status(); run.logs(tail=10)
    ep = ai.endpoints.create(profile="suse-inference-endpoint-qwen", project="team-a", name="chat")
    ep.wait(); ep.chat("What is a large language model?")
"""

from __future__ import annotations

import os
import secrets
import string
import time
import warnings
from typing import Any

from kubernetes import client as k8s

from . import install, profiles as prof, workloads
from .checkpoints import Checkpoints
from .display import Table
from .kube import Connection
from .profiles import Profile, ProfileError


class Client:
    def __init__(self, context: str | None = None, project: str | None = None, kubeconfig: str | None = None,
                 chart: str | None = None, cluster_id: str | None = None, rancher_url: str | None = None,
                 token: str | None = None):
        """context: kubeconfig context (default: the current one; in a pod, its service account).
        project: default namespace for runs and endpoints (default: the context's namespace).
        chart: gpu-train-job OCI reference, to install with helm instead of through Rancher.
        cluster_id: the Rancher cluster (default: from the kubeconfig's Rancher URL, $RANCHER_CLUSTER, else 'local').
        rancher_url / token: connect as you through Rancher (default $RANCHER_URL / $RANCHER_TOKEN)."""
        self.conn = Connection(context=context, kubeconfig=kubeconfig, namespace=project or os.environ.get("RANCHER_AI_PROJECT"),
                               rancher_url=rancher_url, token=token, cluster=cluster_id)
        self._chart = chart
        self._installer = None
        self.cluster_id = cluster_id or os.environ.get("RANCHER_CLUSTER") or (self.conn.rancher.cluster_id if self.conn.rancher else "local")
        self._blueprints: dict | None = None
        self.profiles = Profiles(self)
        self.runs = Runs(self)
        self.endpoints = Endpoints(self)
        self.checkpoints = Checkpoints(self)

    @property
    def project(self) -> str:
        return self.conn.namespace

    @property
    def installer(self):
        if self._installer is None:
            self._installer = install.installer(self.conn, self._chart)
        return self._installer

    def whoami(self) -> dict:
        return self.conn.whoami()

    def blueprints(self) -> dict:
        if self._blueprints is None:
            try:
                items = self.conn.list_custom(*workloads.AIF, "blueprints", required=True)
            except PermissionError:
                import warnings
                warnings.warn("cannot read AI Factory blueprints (needs AI Scheduler Cluster Read): inference "
                              "profiles show no model or scale, and endpoints no URL", stacklevel=3)
                return {}  # not cached: a role granted later is picked up on the next call
            self._blueprints = {}
            for b in items:
                lb = b["metadata"].get("labels") or {}
                key = (lb.get("ai-factory.suse.com/blueprint-name"), lb.get("ai-factory.suse.com/blueprint-version") or b.get("spec", {}).get("version"))
                self._blueprints[key] = workloads.summarize_blueprint(b)
        return self._blueprints

    def __repr__(self) -> str:
        w = self.whoami()
        return f"<rancher_ai.Client user={w['user']!r} cluster={w['cluster']!r} project={w['namespace']!r}>"


def _suffix(n: int = 5) -> str:
    return "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(n))


class Profiles:
    def __init__(self, c: Client):
        self.c = c

    def all(self, type: str | None = None) -> list[Profile]:
        try:
            cms = self.c.conn.core.list_namespaced_config_map(prof.PROFILE_NAMESPACE, label_selector=prof.PROFILE_LABEL).items
        except k8s.ApiException as e:
            if e.status in (403, 404):
                raise PermissionError(f"cannot read profiles in {prof.PROFILE_NAMESPACE} ({e.reason}); "
                                      "a platform admin publishes them, see docs/profiles.md") from None
            raise
        out = [p for p in (prof.from_configmap(cm) for cm in cms) if p and (not type or p.type == type)]
        return sorted(out, key=lambda p: (p.type != "training", p.name))

    def get(self, name: str) -> Profile:
        p = next((p for p in self.all() if p.name == name), None)
        if not p:
            raise LookupError(f"no profile {name!r}; `rancher-ai profiles list` shows them")
        return p

    def table(self, type: str | None = None) -> Table:
        bps = self.c.blueprints()
        rows = []
        for p in self.all(type):
            if p.type == "inference" and p.blueprint:
                bp = bps.get((p.blueprint.get("name"), p.blueprint.get("version")), {})
                scale = str(bp.get("replicas", "-")) if bp else "-"
                gpus = p.gpu or ("shared" if bp.get("shared") else "")
            else:
                scale, gpus = p.workers, p.gpu_label
            rows.append({"name": p.name, "type": p.type, "framework": p.framework or "-", "gpus": gpus or "any",
                         "max_scale": scale, "status": p.status.capitalize(), "description": p.description})
        return Table(rows, ["name", "type", "framework", "gpus", "max_scale", "status", "description"], state_column="status")

    def list(self, type: str | None = None, as_frame: bool | None = None):
        """All profiles you can deploy. A pandas DataFrame when pandas is installed (as_frame=False for a Table)."""
        t = self.table(type)
        if as_frame is not False:
            try:
                return t.to_pandas()
            except ImportError:
                if as_frame:
                    raise
        return t


class Runs:
    def __init__(self, c: Client):
        self.c = c

    def create(self, profile: str, project: str | None = None, name: str | None = None, wait_for_job: float = 60,
               dry_run: bool = False, demo: bool = False, **fields: Any) -> workloads.TrainingRun | dict:
        """Start a training run from a training profile. Fields are the ones the profile opens:
        image ("repo:tag"), workers, gpus_per_worker, command, args, script, env (dict), dataset, checkpoints,
        config_map, gpu_type, gpu_memory (GiB, shared GPU), runtime_hours, priority_class. When the
        profile lets you supply code, pass script= or config_map=, or demo=True for the chart's built-in
        all-reduce check. dry_run returns the values."""
        p = self.c.profiles.get(profile)
        if p.type != "training":
            raise ProfileError(f"{profile} is an inference profile; use endpoints.create")
        if p.problems:
            raise ProfileError(f"profile {profile} has problems: " + "; ".join(p.problems))
        ns = project or self.c.project
        name = name or (f"{p.name_prefix}-{_suffix()}" if p.name_prefix else f"{p.name[:30].rstrip('-')}-{_suffix()}")
        values = prof.resolve(p, fields)
        values.setdefault("job", {})
        problems = prof.check(p, values, name)
        job = values["job"]
        script, config_map = job.get("script") or "", (values.get("storage") or {}).get("configMap") or ""
        opens_code = "script" in p.editable or "configMap" in p.editable
        if opens_code and job.get("mode", "torchrun") == "torchrun":
            if demo:
                job["script"] = ""
            elif not script.strip() and not config_map:
                problems.append("no code: pass script= (your train.py), config_map= (a ConfigMap with a train.py key), "
                                "or demo=True for the built-in all-reduce check")
        if problems:
            raise ProfileError("; ".join(problems))
        missing = prof.missing_packages((values.get("image") or {}).get("repository", ""), script)
        if missing:
            warnings.warn(f"the image has PyTorch only (no pip): the script imports {', '.join(missing)} and will fail on its "
                          "first import; use an image built from dp.apps.rancher.io/containers/pytorch with them added, "
                          "or one that ships them (e.g. nvcr.io/nvidia/pytorch)", stacklevel=2)
        values = install.complete(self.c.conn, values, ns, p.name)
        if dry_run:
            return values
        if self._exists(ns, name):
            raise ProfileError(f"{name} already exists in {ns}; choose another name")
        self.c.installer.install(ns, name, values, p.name)
        end = time.time() + wait_for_job
        while True:
            try:
                return self.get(name, ns)
            except LookupError:
                if time.time() > end:
                    return workloads.TrainingRun(client=self.c, name=name, namespace=ns, state="Pending", profile=p.name,
                                                 workers=int(values["job"].get("nodes", 1)))
                time.sleep(2)

    def _exists(self, ns: str, name: str) -> bool:
        try:
            self.c.conn.batch.read_namespaced_job(name, ns)
            return True
        except k8s.ApiException as e:
            if e.status != 404:
                raise
        if self.c.conn.rancher:
            try:
                self.c.conn.call("GET", f"/v1/catalog.cattle.io.apps/{ns}/{name}")
                return True
            except k8s.ApiException:
                return False
        return False

    def list(self, project: str | None = None, all_projects: bool = False) -> list[workloads.TrainingRun]:
        return workloads.training_runs(self.c, None if all_projects else (project or self.c.project))

    def table(self, project: str | None = None, all_projects: bool = False) -> Table:
        rows = [{"name": r.name, "profile": r.profile or "-", "project": r.namespace, "resources": r.gpus, "state": r.state,
                 "age": workloads.age(r.created.replace(" ", "T") + "Z" if r.created else "")}
                for r in self.list(project, all_projects)]
        return Table(rows, ["name", "profile", "project", "resources", "state", "age"], state_column="state")

    def get(self, name: str, project: str | None = None) -> workloads.TrainingRun:
        ns = project or self.c.project
        r = next((r for r in workloads.training_runs(self.c, ns) if r.name == name), None)
        if not r:
            raise LookupError(f"no training run {name!r} in {ns}")
        return r


class Endpoints:
    def __init__(self, c: Client):
        self.c = c

    def create(self, profile: str, project: str | None = None, name: str | None = None, model: str | None = None,
               gpu_count: int | None = None, replicas: int | None = None, dry_run: bool = False) -> workloads.Endpoint | dict:
        """Deploy an inference profile: an AIWorkload for its blueprint. model / gpu_count / replicas, when
        given, must match the blueprint: aif-operator 2.2.0 installs a blueprint exactly as written."""
        p = self.c.profiles.get(profile)
        if p.type != "inference" or not p.blueprint:
            raise ProfileError(f"{profile} is not an inference profile; use runs.create")
        ns = project or self.c.project
        name = name or f"{p.name[:30].rstrip('-')}-{_suffix()}"
        if not prof.NAME_RE.match(name):
            raise ProfileError(f"name {name!r} must be lowercase letters, numbers and hyphens (max 42)")
        ref = {"name": p.blueprint["name"], "version": str(p.blueprint["version"])}
        bp = self.c.blueprints().get((ref["name"], ref["version"]))
        if bp is None:
            raise LookupError(f"blueprint {ref['name']} {ref['version']} not found (or not readable); is SUSE AI Factory installed?")
        for asked, have, what in ((model, bp["model"], "model"), (gpu_count, bp["gpus"], "gpu_count"), (replicas, bp["replicas"], "replicas")):
            if asked is not None and str(asked) != str(have):
                raise ProfileError(f"{what}={asked}: this profile's blueprint serves {what}={have}; aif-operator 2.2.0 "
                                   "cannot change a blueprint per workload, so a different one is a new blueprint version")
        existing = workloads.endpoints(self.c, ns)
        if any(e.name == name for e in existing):
            raise ProfileError(f"{name} already exists in {ns}")
        same = next((e for e in existing if e.blueprint.split(" ")[0] == ref["name"]), None)
        if same:
            raise ProfileError(f"{same.name} in {ns} already runs blueprint {ref['name']}; its components would collide")
        missing = []
        for s in p.required_secrets:
            try:
                self.c.conn.core.read_namespaced_secret(s["name"], ns)
            except k8s.ApiException as e:
                if e.status == 404:
                    missing.append(f"{s['name']} (create it: {s.get('hint', '').replace('<project-namespace>', ns).replace('<project>', ns)})")
        if missing:
            raise ProfileError("missing Secret: " + "; ".join(missing))
        body = {
            "apiVersion": "/".join(workloads.AIF), "kind": "AIWorkload",
            "metadata": {"name": name, "namespace": ns, "labels": {workloads.PROFILE_LABEL: p.name}},
            "spec": {"displayName": f"{p.display_name} — {name}", "deployStrategy": "FleetBundle",
                     "source": {"sourceType": "Blueprint", "blueprint": ref},
                     "targetClusters": [self.c.cluster_id], "targetNamespace": ns},
        }
        if dry_run:
            return body
        self.c.conn.custom.create_namespaced_custom_object(*workloads.AIF, ns, "aiworkloads", body)
        return self.get(name, ns)

    def list(self, project: str | None = None, all_projects: bool = False) -> list[workloads.Endpoint]:
        return workloads.endpoints(self.c, None if all_projects else (project or self.c.project))

    def table(self, project: str | None = None, all_projects: bool = False) -> Table:
        rows = [{"name": e.name, "profile": e.profile or "-", "project": e.namespace, "model": e.model, "url": e.url, "state": e.state}
                for e in self.list(project, all_projects)]
        return Table(rows, ["name", "profile", "project", "model", "url", "state"], state_column="state")

    def get(self, name: str, project: str | None = None) -> workloads.Endpoint:
        ns = project or self.c.project
        e = next((e for e in workloads.endpoints(self.c, ns) if e.name == name), None)
        if not e:
            raise LookupError(f"no inference endpoint {name!r} in {ns}")
        return e
