"""Installing a training run: the gpu-train-job chart as a Helm release in the project namespace.

Two ways, chosen by the connection:
  - through Rancher (a Rancher-generated kubeconfig): the ClusterRepo install action, exactly what the
    UI's Submit and Deploy pages call; Helm runs as the user in Rancher's helm-operation pod, so no
    helm binary is needed;
  - otherwise: the helm CLI, against the chart's OCI reference (RANCHER_AI_CHART, or the ClusterRepo's
    URL when it is an oci:// one).
Either way the release is an ordinary Helm release that Rancher lists under Installed Apps and the
Deployments page shows.

Where the cluster has the AIJob API (AI Factory's operator), neither is used: the run is an AIJob,
the durable record the operator installs the chart from and keeps after the Job is gone."""

from __future__ import annotations

import json
import os
import re
import shutil
import ssl
import subprocess
import tempfile
import urllib.error
import urllib.request
from urllib.parse import urlparse

import yaml

from .kube import Connection

CHART_NAME = "gpu-train-job"
CHART_REPO = "gpu-train-charts"


def project_scheduler(conn: Connection, namespace: str) -> dict:
    """Scheduler and queue for a run in this namespace, as the Submit page picks them: a namespace
    bound to a KAI / Run:AI queue, else the namespace's Kueue LocalQueue, else the default scheduler."""
    try:
        labels = conn.core.read_namespace(namespace).metadata.labels or {}
    except Exception:
        labels = {}
    queue = labels.get("kai.scheduler/queue") or labels.get("runai/queue")
    if queue:
        return {"type": "runai" if conn.has_group("run.ai") else "kai", "queue": queue}
    lqs = conn.list_custom("kueue.x-k8s.io", "v1beta1", "localqueues", namespace)
    if lqs:
        return {"type": "kueue", "queue": lqs[0]["metadata"]["name"]}
    return {"type": "none", "queue": ""}


def shared_claim(conn: Connection, namespace: str) -> str:
    """The project's shared GPU: an MPS-configured ResourceClaim (see docs/gpu-sharing.md)."""
    for c in conn.list_custom("resource.k8s.io", "v1", "resourceclaims", namespace):
        for cfg in c.get("spec", {}).get("devices", {}).get("config", []) or []:
            p = (cfg.get("opaque") or {}).get("parameters") or {}
            if p.get("kind") == "GpuConfig" and (p.get("sharing") or {}).get("strategy") == "MPS":
                return c["metadata"]["name"]
    return ""


def complete(conn: Connection, values: dict, namespace: str, profile_name: str) -> dict:
    """Fill in what the profile leaves to the project: scheduler and queue, the shared GPU claim, the
    profile label, and the headroom lookup (which needs cluster-wide pod reads)."""
    values = json.loads(json.dumps(values))
    sched = values.setdefault("scheduler", {})
    if not sched.get("type"):
        sched.update(project_scheduler(conn, namespace))
    gpu = values.setdefault("gpu", {})
    shared = int(gpu.get("sharedMemoryMiB") or 0) > 0
    if shared and sched.get("type") in ("kai", "runai"):
        # A GPU-memory share under KAI: the chart writes KAI's gpu-memory annotation; KAI queues the
        # pod until the memory is free and caps it. No claim (same rule as the UI's chartValuesFor).
        gpu["sharedClaim"] = ""
        values["profile"] = profile_name
        values.setdefault("preflight", {})["checkHeadroom"] = conn.can_i("list", "pods")
        return values
    if shared and sched.get("type") == "kueue":
        # Kueue marks a pod that attaches to an existing ResourceClaim Inadmissible; it would never
        # start. Same rule as the UI (kueueSkipped in preflight.ts).
        sched.update({"type": "none", "queue": ""})
    if shared and not gpu.get("sharedClaim"):
        claim = shared_claim(conn, namespace)
        if not claim:
            raise RuntimeError(f"the profile shares a GPU, and {namespace} has no shared GPU (an MPS ResourceClaim); "
                               "a platform admin creates one, see docs/gpu-sharing.md")
        gpu["sharedClaim"] = claim
        gpu.setdefault("mode", "dra")
    values["profile"] = profile_name
    values.setdefault("preflight", {})["checkHeadroom"] = conn.can_i("list", "pods")
    return values


class RancherInstaller:
    """The ClusterRepo install action, through Rancher's Steve API (same as the UI)."""

    def __init__(self, conn: Connection):
        self.conn = conn

    def _latest(self) -> str:
        idx = self.conn.call("GET", f"/v1/catalog.cattle.io.clusterrepos/{CHART_REPO}", query={"link": "index"})
        versions = (idx.get("entries") or {}).get(CHART_NAME) or []
        if not versions:
            raise RuntimeError(f"chart {CHART_NAME} not found in ClusterRepo {CHART_REPO}; add the repo from the Projects page")
        return versions[0]["version"]

    def install(self, namespace: str, name: str, values: dict, profile: str, **_placement) -> dict:
        body = {
            "charts": [{
                "chartName": CHART_NAME, "version": self._latest(), "releaseName": name,
                "annotations": {"catalog.cattle.io/ui-source-repo-type": "cluster", "catalog.cattle.io/ui-source-repo": CHART_REPO,
                                "trainingjobs/submitted-by": "rancher-ai", "trainingjobs/profile": profile},
                "values": values,
            }],
            "noHooks": False, "timeout": "600s", "wait": False, "namespace": namespace,
        }
        return self.conn.call("POST", f"/v1/catalog.cattle.io.clusterrepos/{CHART_REPO}", body=body, query={"action": "install"})

    def uninstall(self, namespace: str, name: str) -> None:
        self.conn.call("POST", f"/v1/catalog.cattle.io.apps/{namespace}/{name}", body={}, query={"action": "uninstall"})


class HelmInstaller:
    """The helm CLI, against the chart's OCI reference."""

    def __init__(self, conn: Connection, chart: str | None = None, insecure: bool | None = None):
        self.conn = conn
        self.repo = ""
        self.chart = chart or os.environ.get("RANCHER_AI_CHART") or self._from_cluster_repo()
        self.insecure = insecure if insecure is not None else os.environ.get("RANCHER_AI_CHART_INSECURE", "") in ("1", "true", "yes")
        if not shutil.which("helm"):
            raise RuntimeError("helm is not installed; install it, or use a Rancher-generated kubeconfig (no helm needed)")

    def _from_cluster_repo(self) -> str:
        """The chart from the gpu-train-charts ClusterRepo: an oci:// reference as is; a repo served by a
        Service in the cluster (how the extension publishes it) downloaded through the API server's
        service proxy, so it works from a laptop as well as from a pod."""
        try:
            repo = self.conn.custom.get_cluster_custom_object("catalog.cattle.io", "v1", "clusterrepos", CHART_REPO)
        except Exception:
            repo = {}
        url = (repo.get("spec") or {}).get("url", "").rstrip("/")
        if url.startswith("oci://"):
            return url if url.endswith(CHART_NAME) else f"{url}/{CHART_NAME}"
        if url.startswith("http") and self.conn.in_cluster:
            self.repo = url  # a pod reaches the repo's Service directly
            return CHART_NAME
        m = re.match(r"^https?://([a-z0-9-]+)\.([a-z0-9-]+)(?:\.svc(?:\.cluster\.local)?)?(?::(\d+))?(/.*)?$", url)
        if m:
            svc, ns, port, base = m.group(1), m.group(2), m.group(3) or "80", m.group(4) or ""
            proxy = f"/api/v1/namespaces/{ns}/services/http:{svc}:{port}/proxy{base}"
            index = yaml.safe_load(self.conn.call("GET", f"{proxy}/index.yaml", headers={"Accept": "*/*"}) or "") or {}
            entries = (index.get("entries") or {}).get(CHART_NAME) or []
            if not entries:
                raise RuntimeError(f"{CHART_NAME} is not in the {CHART_REPO} repo ({url})")
            latest = max(entries, key=lambda e: tuple(int(x) for x in re.findall(r"\d+", e["version"])[:3]))
            tgz = latest["urls"][0]
            path = tgz if tgz.startswith("/") else f"{proxy}/{tgz}" if not tgz.startswith("http") else proxy + urlparse(tgz).path[len(base):]
            data = self.conn.call("GET", path, headers={"Accept": "*/*"}, raw=True).data
            fd, local = tempfile.mkstemp(suffix=f"-{CHART_NAME}-{latest['version']}.tgz")
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            self._downloaded = local
            return local
        if url.startswith("http"):
            self.repo = url
            return CHART_NAME
        raise RuntimeError(f"no chart reference: set RANCHER_AI_CHART to the gpu-train-job chart "
                           f"(e.g. oci://registry.example.com/charts/{CHART_NAME}), or connect through Rancher")

    def _base(self) -> list[str]:
        args = ["helm"]
        if self.conn.kubeconfig:
            args += ["--kubeconfig", self.conn.kubeconfig]
        if not self.conn.in_cluster:
            args += ["--kube-context", self.conn.context]
        return args

    def install(self, namespace: str, name: str, values: dict, profile: str, **_placement) -> dict:
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
            yaml.safe_dump(values, f)
            path = f.name
        try:
            cmd = self._base() + ["install", name, self.chart, "-n", namespace, "-f", path] + (["--repo", self.repo] if self.repo else [])
            if self.insecure:
                cmd.append("--insecure-skip-tls-verify")
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0:
                # the chart's own install-time pre-flight fails with "preflight: ..." here
                raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "helm install failed")
            return {"release": name, "namespace": namespace}
        finally:
            os.unlink(path)

    def uninstall(self, namespace: str, name: str) -> None:
        r = subprocess.run(self._base() + ["uninstall", name, "-n", namespace], capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip() or "helm uninstall failed")


AIJOB = ("ai-factory.suse.com", "v1alpha1", "aijobs")


def chart_version(conn: Connection) -> str:
    """The newest gpu-train-job version in the ClusterRepo, or RANCHER_AI_CHART_VERSION."""
    if os.environ.get("RANCHER_AI_CHART_VERSION"):
        return os.environ["RANCHER_AI_CHART_VERSION"]
    if conn.rancher:
        return RancherInstaller(conn)._latest()
    try:
        repo = conn.custom.get_cluster_custom_object("catalog.cattle.io", "v1", "clusterrepos", CHART_REPO)
    except Exception as e:
        raise RuntimeError(f"cannot read ClusterRepo {CHART_REPO}: {e}; set RANCHER_AI_CHART_VERSION") from e
    url = (repo.get("spec") or {}).get("url", "").rstrip("/")
    if url.startswith("oci://"):
        insecure = bool((repo.get("spec") or {}).get("insecureSkipTLSVerify")) or \
            os.environ.get("RANCHER_AI_CHART_INSECURE", "") in ("1", "true", "yes")
        tags = oci_tags(url if url.endswith("/" + CHART_NAME) else f"{url}/{CHART_NAME}", insecure)
        if not tags:
            raise RuntimeError(f"{CHART_NAME} has no versions in {url}; set RANCHER_AI_CHART_VERSION")
        return newest(tags)
    m = re.match(r"^https?://([a-z0-9-]+)\.([a-z0-9-]+)(?:\.svc(?:\.cluster\.local)?)?(?::(\d+))?(/.*)?$", url)
    if not m:
        raise RuntimeError(f"cannot read the chart index of {url}; set RANCHER_AI_CHART_VERSION")
    svc, ns, port, base = m.group(1), m.group(2), m.group(3) or "80", m.group(4) or ""
    index = yaml.safe_load(conn.call("GET", f"/api/v1/namespaces/{ns}/services/http:{svc}:{port}/proxy{base}/index.yaml",
                                     headers={"Accept": "*/*"}) or "") or {}
    entries = (index.get("entries") or {}).get(CHART_NAME) or []
    if not entries:
        raise RuntimeError(f"{CHART_NAME} is not in the {CHART_REPO} repo ({url})")
    return newest([e["version"] for e in entries])


def semver_key(v: str) -> tuple:
    """Sort key for a chart version: a release sorts after its pre-releases (2.3.0 > 2.3.0-rc.3), and
    numeric pre-release parts compare as numbers (rc.10 > rc.9)."""
    core, _, pre = v.lstrip("v").split("+", 1)[0].partition("-")
    nums = tuple(int(x) if x.isdigit() else 0 for x in (core.split(".") + ["0", "0"])[:3])
    parts = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split(".")) if pre else ()
    return nums + ((1,) if not pre else (0,) + parts)


def newest(versions: list[str]) -> str:
    return max(versions, key=semver_key)


def oci_tags(ref: str, insecure: bool = False, timeout: float = 20) -> list[str]:
    """The tags of a chart's OCI repository (oci://host/path/chart), through the registry API: anonymous,
    with the bearer token a registry such as GHCR hands out for public pulls. Helm stores a version's
    "+" as "_" in tags, so they are turned back."""
    u = urlparse(ref)
    ctx = ssl._create_unverified_context() if insecure else None
    api = f"https://{u.netloc}/v2/{u.path.strip('/')}/tags/list"

    def get(url: str, headers: dict | None = None) -> dict:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=timeout, context=ctx) as r:
            return json.loads(r.read() or b"{}")
    try:
        return [t.replace("_", "+") for t in get(api).get("tags") or []]
    except urllib.error.HTTPError as e:
        challenge = e.headers.get("WWW-Authenticate", "") if e.code == 401 else ""
        if not challenge.lower().startswith("bearer "):
            raise RuntimeError(f"cannot list the versions in {ref}: HTTP {e.code}") from e
    params = dict(re.findall(r'(\w+)="([^"]*)"', challenge))
    query = "&".join(f"{k}={urllib.request.quote(params[k], safe=':/')}" for k in ("service", "scope") if k in params)
    token = get(f"{params.get('realm', '')}?{query}")
    bearer = token.get("token") or token.get("access_token") or ""
    return [t.replace("_", "+") for t in get(api, {"Authorization": f"Bearer {bearer}"}).get("tags") or []]


def aijob_for(namespace: str, name: str, values: dict, profile: str, pool: str = "", target_namespace: str = "",
              reclaim: dict | None = None) -> dict:
    """The AIJob for a run. The operator installs the training chart built into it (no chart source).
    In an AI project's namespace with no pool, AI Factory's queue places it on one of the project's
    compute pools; pool= sends it to that pool (target_namespace: the project's namespace there).
    Under an operator a chart's install-time capacity check is advice, not a gate: a busy cluster
    should queue the job, not fail it. The other pre-flight checks stay on."""
    v = dict(values or {})
    v["preflight"] = {**(v.get("preflight") or {}), "checkHeadroom": False}
    spec: dict = {"category": "training", "values": v}
    if profile:
        spec["profile"] = profile
    if pool:
        spec["pool"] = pool
        if target_namespace:
            spec["targetNamespace"] = target_namespace
    if reclaim:
        spec["reclaim"] = {k: v for k, v in reclaim.items() if v}
    return {"apiVersion": f"{AIJOB[0]}/{AIJOB[1]}", "kind": "AIJob", "metadata": {"name": name, "namespace": namespace}, "spec": spec}


class AIJobInstaller:
    """An AIJob per run: the operator installs the chart and keeps the record."""

    def __init__(self, conn: Connection):
        self.conn = conn

    def install(self, namespace: str, name: str, values: dict, profile: str, **placement) -> dict:
        job = aijob_for(namespace, name, values, profile, **placement)
        self.conn.custom.create_namespaced_custom_object(AIJOB[0], AIJOB[1], namespace, AIJOB[2], job)
        return {"aijob": name, "namespace": namespace}

    def uninstall(self, namespace: str, name: str) -> None:
        """Deleting the AIJob uninstalls its release first (the operator's finalizer)."""
        try:
            self.conn.custom.delete_namespaced_custom_object(AIJOB[0], AIJOB[1], namespace, AIJOB[2], name)
        except Exception as e:
            if getattr(e, "status", None) != 404:
                raise
            # not an AIJob: a release installed directly
            (RancherInstaller(self.conn) if self.conn.rancher else HelmInstaller(self.conn)).uninstall(namespace, name)


def has_aijobs(conn: Connection) -> bool:
    """Whether the cluster serves the AIJob API (listing one is allowed or merely forbidden)."""
    try:
        conn.custom.list_cluster_custom_object(*AIJOB, limit=1)
        return True
    except Exception as e:
        return getattr(e, "status", None) == 403


def installer(conn: Connection, chart: str | None = None, insecure: bool | None = None):
    if not chart and os.environ.get("RANCHER_AI_AIJOB", "auto") != "off" and has_aijobs(conn):
        return AIJobInstaller(conn)
    return RancherInstaller(conn) if conn.rancher and not chart else HelmInstaller(conn, chart, insecure)
