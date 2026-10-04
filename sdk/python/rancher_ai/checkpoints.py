"""Checkpoint volumes a run created and kept: list them, look inside, delete the ones you no longer
need. Only volumes the gpu-train-job chart made for a run (<run>-checkpoints with the chart's labels)
are touched, never a dataset or a shared PVC, and never one a pod is still using. With Longhorn and
most CSI classes (reclaimPolicy Delete) deleting the claim deletes the data for good."""

from __future__ import annotations

import base64
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from kubernetes import client

from .display import Table
from .workloads import age

if TYPE_CHECKING:
    from .client import Client

CHART = "gpu-train-job"
SUFFIX = "-checkpoints"
# SUSE's BCI busybox: maintained by SUSE, pullable without an account, mirrored like the other BCI images
TOOLS_IMAGE = "registry.suse.com/bci/bci-busybox:15.7"
# the file travels base64-encoded between these lines; "@" is not in the base64 alphabet, so no line of
# the file's encoding can be mistaken for them (a bare "END" can: base64 contains those letters)
BEGIN, END = "@@AIF-BEGIN@@", "@@AIF-END@@"
# base64 grows a file by a third, and the kubelet rotates a container's log at 10 MiB by default
MAX_GET_BYTES = 7 * 2**20


class CheckpointError(RuntimeError):
    """A delete the guardrails refused: not a run's volume, in use, or not confirmed."""


@dataclass
class Checkpoint:
    client: "Client" = field(repr=False)
    name: str
    namespace: str
    run: str
    profile: str = ""
    size: str = ""
    storage_class: str = ""
    phase: str = ""
    created: datetime | None = None
    in_use_by: list[str] = field(default_factory=list)
    run_active: bool = False
    reclaim_policy: str = ""

    def __repr__(self) -> str:
        return f"<Checkpoint {self.name} run={self.run} size={self.size} in_use={bool(self.in_use_by)}>"

    @property
    def in_use(self) -> bool:
        return bool(self.in_use_by) or self.run_active

    def ls(self, path: str = "", max_entries: int = 500, timeout: float = 120) -> Table:
        """The volume's files (under `path`, recursively; lost+found skipped), from a short-lived read-only
        pod. A table: each row's `path` is what get() takes, `bytes` its exact size."""
        if self.in_use_by:
            raise CheckpointError(f"{self.name} is mounted by {', '.join(self.in_use_by)}; look from that pod instead")
        return _ls(self.client, self.namespace, self.name, path, max_entries, timeout)

    def get(self, path: str, dest: str = ".", timeout: float = 300) -> str:
        """Copy one file off the volume (a diagnostics bundle, a model adapter) to `dest`: a directory
        (created when it ends in "/"), or a file name; "~" is expanded. Returns the absolute path
        written. The file travels through a short-lived Job's log, which the kubelet rotates at
        10 MiB by default, so files over MAX_GET_BYTES are refused rather than cut short."""
        if self.in_use_by:
            raise CheckpointError(f"{self.name} is mounted by {', '.join(self.in_use_by)}; copy from that pod instead")
        src = "/ckpt/" + path.lstrip("/")
        out = _job(self.client, self.namespace, self.name,
                   f"test -f {src!r} || {{ echo NOFILE; exit 3; }}; n=$(wc -c < {src!r}); echo SIZE $n; "
                   f"[ $n -le {MAX_GET_BYTES} ] || {{ echo TOOBIG; exit 4; }}; echo {BEGIN}; base64 {src!r}; echo {END}", timeout)
        if "NOFILE" in out:
            raise FileNotFoundError(f"{path} is not a file on {self.name}")
        if "TOOBIG" in out:
            size = next((ln.split()[1] for ln in out.splitlines() if ln.startswith("SIZE ")), "?")
            raise CheckpointError(f"{path} is {size} bytes, over the {MAX_GET_BYTES // 2**20} MiB a copy through a pod's "
                                  f"log can carry; mount {self.name} in a pod and use kubectl cp")
        lines = out.splitlines()
        if BEGIN not in lines or END not in lines[lines.index(BEGIN):]:
            raise CheckpointError(f"copying {path} did not complete; try again")
        body = "".join(lines[lines.index(BEGIN) + 1:lines.index(END, lines.index(BEGIN))])
        target = target_path(dest, path)
        with open(target, "wb") as f:
            f.write(base64.b64decode("".join(body.split())))
        return target

    def delete(self, confirm: bool = False) -> None:
        """Delete the volume and, with a Delete reclaim policy, its data. confirm=True is required."""
        self.client.checkpoints.delete(self.name, project=self.namespace, confirm=confirm)


class Checkpoints:
    def __init__(self, c: "Client"):
        self.c = c

    def list(self, project: str | None = None, all_projects: bool = False) -> list[Checkpoint]:
        ns = None if all_projects else (project or self.c.project)
        core = self.c.conn.core
        sel = f"app.kubernetes.io/name={CHART}"
        pvcs = (core.list_namespaced_persistent_volume_claim(ns, label_selector=sel) if ns
                else core.list_persistent_volume_claim_for_all_namespaces(label_selector=sel)).items
        if not pvcs:
            return []
        pods = (core.list_namespaced_pod(ns) if ns else core.list_pod_for_all_namespaces()).items
        mounts: dict[tuple[str, str], list[str]] = {}
        for p in pods:
            if p.status.phase in ("Succeeded", "Failed"):
                continue
            for v in p.spec.volumes or []:
                if v.persistent_volume_claim:
                    mounts.setdefault((p.metadata.namespace, v.persistent_volume_claim.claim_name), []).append(p.metadata.name)
        jobs = {(j.metadata.namespace, j.metadata.name): (j.status.active or 0) > 0
                for j in (self.c.conn.batch.list_namespaced_job(ns, label_selector=sel) if ns
                          else self.c.conn.batch.list_job_for_all_namespaces(label_selector=sel)).items}
        reclaim = _reclaim_policies(self.c)
        out = []
        for v in pvcs:
            run = _run_of(v)
            if not run:
                continue  # a chart-labelled PVC that is not a run's checkpoint volume (e.g. scratch)
            labels = v.metadata.labels or {}
            out.append(Checkpoint(
                client=self.c, name=v.metadata.name, namespace=v.metadata.namespace, run=run,
                profile=labels.get("trainingjobs/profile", ""),
                size=(v.status.capacity or {}).get("storage") or (v.spec.resources.requests or {}).get("storage", ""),
                storage_class=v.spec.storage_class_name or "", phase=v.status.phase or "",
                created=v.metadata.creation_timestamp,
                in_use_by=mounts.get((v.metadata.namespace, v.metadata.name), []),
                run_active=jobs.get((v.metadata.namespace, run), False),
                reclaim_policy=reclaim.get(v.spec.storage_class_name or "", ""),
            ))
        return sorted(out, key=lambda x: x.created or datetime.min.replace(tzinfo=timezone.utc))

    def table(self, project: str | None = None, all_projects: bool = False) -> Table:
        rows = [{"name": k.name, "run": k.run, "profile": k.profile or "-", "project": k.namespace, "size": k.size,
                 "class": k.storage_class or "-", "age": age(k.created),
                 "in_use": ("yes: " + ", ".join(k.in_use_by)) if k.in_use_by else ("run active" if k.run_active else "no")}
                for k in self.list(project, all_projects)]
        return Table(rows, ["name", "run", "profile", "project", "size", "class", "age", "in_use"])

    def get(self, name: str, project: str | None = None) -> Checkpoint:
        ns = project or self.c.project
        k = next((k for k in self.list(ns) if k.name == name), None)
        if not k:
            raise LookupError(f"{name} is not a run's checkpoint volume in {ns} (only <run>{SUFFIX} volumes the "
                              f"{CHART} chart created are managed here)")
        return k

    def delete(self, name: str, project: str | None = None, confirm: bool = False) -> None:
        """Delete one run's checkpoint volume. Refuses a volume a run did not create, one in use, and
        anything without confirm=True."""
        k = self.get(name, project)
        if k.in_use_by:
            raise CheckpointError(f"{name} is mounted by {', '.join(k.in_use_by)}")
        if k.run_active:
            raise CheckpointError(f"{name} belongs to run {k.run}, which is still running")
        if not confirm:
            lost = "its data is deleted permanently" if k.reclaim_policy in ("", "Delete") else f"reclaim policy {k.reclaim_policy}: the volume is released, not wiped"
            raise CheckpointError(f"not deleted: pass confirm=True to delete {name} ({k.size}); {lost}")
        self.c.conn.core.delete_namespaced_persistent_volume_claim(name, k.namespace)

    def delete_older_than(self, days: float, project: str | None = None, dry_run: bool = True,
                          confirm: bool = False) -> list[str]:
        """Delete run checkpoint volumes older than `days` that nothing uses. dry_run (the default)
        only returns the names that would go."""
        cutoff = time.time() - days * 86400
        names = [k.name for k in self.list(project)
                 if not k.in_use and k.created and k.created.timestamp() < cutoff]
        if dry_run:
            return names
        if not confirm:
            raise CheckpointError(f"not deleted: pass confirm=True to delete {len(names)} volume(s): {', '.join(names) or 'none'}")
        for n in names:
            self.delete(n, project=project, confirm=True)
        return names


def target_path(dest: str, path: str) -> str:
    """Where get() writes: inside `dest` when it is a directory (made when it ends in a separator),
    else `dest` itself; always absolute, with "~" expanded."""
    dest = os.path.expanduser(dest or ".")
    if dest.endswith(("/", os.sep)):
        os.makedirs(dest, exist_ok=True)
    if os.path.isdir(dest):
        dest = os.path.join(dest, os.path.basename(path.rstrip("/")))
    return os.path.abspath(dest)


def _run_of(pvc: Any) -> str:
    """The run a PVC is the checkpoint volume of: <instance>-checkpoints, labelled by the chart."""
    labels = pvc.metadata.labels or {}
    run = labels.get("app.kubernetes.io/instance", "")
    expected = (run[:52].rstrip("-") if len(run) > 52 else run) + SUFFIX
    return run if run and pvc.metadata.name == expected and labels.get("app.kubernetes.io/name") == CHART else ""


def _reclaim_policies(c: "Client") -> dict[str, str]:
    try:
        return {s.metadata.name: s.reclaim_policy or "Delete" for s in client.StorageV1Api(c.conn.api).list_storage_class().items}
    except client.ApiException:
        return {}


def _ls(c: "Client", ns: str, claim: str, path: str, max_entries: int, timeout: float) -> Table:
    sub = path.strip("/")
    target = "/ckpt/" + sub
    out = _job(c, ns, claim, f"cd {target!r} || exit 3; find . -path ./lost+found -prune -o -type f "
                             f"-exec stat -c '%s|%Y|%n' {{}} + | head -n {int(max_entries)}", timeout)
    return Table(parse_listing(out, sub), ["path", "size", "modified"], first_bold=False, empty="No files.")


def parse_listing(out: str, under: str = "") -> list[dict]:
    """Rows from `size|mtime|./path` lines, sorted by path; `path` relative to the volume's root."""
    rows = []
    for line in out.splitlines():
        parts = line.strip().split("|", 2)
        if len(parts) != 3 or not parts[0].isdigit() or not parts[1].isdigit() or not parts[2].startswith("./"):
            continue
        rel = parts[2][2:]
        rows.append({"path": f"{under}/{rel}" if under else rel, "size": human_bytes(int(parts[0])), "bytes": int(parts[0]),
                     "modified": datetime.fromtimestamp(int(parts[1]), timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")})
    return sorted(rows, key=lambda r: r["path"])


def human_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    v = float(n)
    for unit in ("KiB", "MiB", "GiB", "TiB"):
        v /= 1024
        if v < 1024 or unit == "TiB":
            return f"{v:.1f} {unit}" if v < 10 else f"{v:.0f} {unit}"
    return f"{n} B"


def _job(c: "Client", ns: str, claim: str, script: str, timeout: float) -> str:
    """Run `script` against the volume (read-only at /ckpt) in a one-pod Job, rather than a bare Pod:
    AI Job Submitter may create Jobs (and read their pods' logs) but not Pods. Returns its log."""
    core, batch = c.conn.core, c.conn.batch
    name = f"ckpt-job-{int(time.time() * 1000) % 10000000}"
    job = client.V1Job(
        metadata=client.V1ObjectMeta(name=name, namespace=ns, labels={"app.kubernetes.io/managed-by": "rancher-ai"}),
        spec=client.V1JobSpec(
            backoff_limit=0, ttl_seconds_after_finished=300,
            template=client.V1PodTemplateSpec(
                metadata=client.V1ObjectMeta(labels={"app.kubernetes.io/managed-by": "rancher-ai"}),
                spec=client.V1PodSpec(
                    restart_policy="Never",
                    containers=[client.V1Container(
                        name="ls", image=TOOLS_IMAGE,
                        command=["sh", "-c", script],
                        volume_mounts=[client.V1VolumeMount(name="ckpt", mount_path="/ckpt", read_only=True)],
                        resources=client.V1ResourceRequirements(requests={"cpu": "20m", "memory": "16Mi"}, limits={"memory": "64Mi"}),
                    )],
                    volumes=[client.V1Volume(name="ckpt", persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(claim_name=claim, read_only=True))],
                ),
            ),
        ),
    )
    batch.create_namespaced_job(ns, job)
    try:
        end = time.time() + timeout
        while True:
            j = batch.read_namespaced_job(name, ns)
            if (j.status.succeeded or 0) or (j.status.failed or 0):
                break
            if time.time() > end:
                raise TimeoutError(f"listing {claim} did not finish in {timeout:.0f}s (job {name})")
            time.sleep(2)
        pod = core.list_namespaced_pod(ns, label_selector=f"job-name={name}").items[0]
        return core.read_namespaced_pod_log(pod.metadata.name, ns, _preload_content=False).data.decode(errors="replace")
    finally:
        batch.delete_namespaced_job(name, ns, propagation_policy="Background")
