"""Profiles: ConfigMaps in ai-profiles, read and resolved the way the AI Factory UI does
(ui/pkg/aif-ui/training/profiles.ts). A training profile's `values` are gpu-train-job Helm
values the platform fixes; the user may set only its `editable` fields, within its `limits`."""

from __future__ import annotations

import copy
import re
import shlex
from dataclasses import dataclass, field
from typing import Any

import yaml

PROFILE_NAMESPACE = "ai-profiles"
PROFILE_LABEL = "trainingjobs/profile"
PROFILE_KEY = "profile.yaml"


class ProfileError(ValueError):
    """The request does not fit the profile: a field it fixes, or a value outside its limits."""


# Field name (as profiles and the UI call it) -> where it goes in gpu-train-job values.
def _set(path: str):
    def setter(values: dict, v: Any) -> None:
        node = values
        *parents, leaf = path.split(".")
        for p in parents:
            node = node.setdefault(p, {})
        node[leaf] = v
    return setter


def _env(values: dict, v: dict) -> None:
    current = {e["name"]: e.get("value", "") for e in values.get("env", []) if "name" in e}
    current.update({k: str(x) for k, x in v.items()})
    values["env"] = [{"name": k, "value": x} for k, x in current.items()]


def _command(values: dict, v: str | list) -> None:
    values.setdefault("job", {})["command"] = shlex.split(v) if isinstance(v, str) else list(v)
    values["job"]["mode"] = "custom"


def _args(values: dict, v: str | list) -> None:
    values.setdefault("job", {})["args"] = shlex.split(v) if isinstance(v, str) else list(v)


def _secret(values: dict, v: str) -> None:
    values.setdefault("storage", {})["secretMounts"] = [{"name": v, "mountPath": "/secrets"}] if v else []


def _runtime(values: dict, hours: float) -> None:
    values.setdefault("job", {})["activeDeadlineSeconds"] = int(round(float(hours) * 3600))


def _checkpoint_pvc(values: dict, name: str) -> None:
    """Mount an existing checkpoint volume (an earlier run's, to resume or evaluate it). It replaces the
    volume a profile creates per run, as the UI's picker does: the chart refuses both."""
    storage = values.setdefault("storage", {})
    storage["checkpointPVC"] = name
    if name:
        storage["checkpointCreate"] = {**(storage.get("checkpointCreate") or {}), "enabled": False}


def _gpu_share(values: dict, gib: float) -> None:
    values.setdefault("gpu", {})["sharedMemoryMiB"] = int(round(float(gib) * 1024))


EDITABLE: dict[str, Any] = {
    "image": _set("image.repository"),
    "tag": _set("image.tag"),
    "command": _command,
    "args": _args,
    "script": _set("job.script"),
    "configMap": _set("storage.configMap"),
    "env": _env,
    "nodes": _set("job.nodes"),
    "gpusPerNode": _set("job.gpusPerNode"),
    "gpuProduct": _set("gpu.productName"),
    "gpuShareMiB": _gpu_share,  # given in GiB here, stored in MiB like the chart
    "datasetPVC": _set("storage.datasetPVC"),
    "checkpointPVC": _checkpoint_pvc,
    "secretName": _secret,
    "runtimeLimitHours": _runtime,
    "priorityClassName": _set("scheduler.priorityClassName"),
}

# What people call them on the command line and in notebooks
ALIASES = {
    "workers": "nodes", "gpus_per_worker": "gpusPerNode", "gpu_type": "gpuProduct", "gpu_memory": "gpuShareMiB",
    "dataset": "datasetPVC", "checkpoints": "checkpointPVC", "config_map": "configMap", "secret": "secretName",
    "runtime_hours": "runtimeLimitHours", "priority_class": "priorityClassName",
}

NAME_RE = re.compile(r"^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$")


@dataclass
class Profile:
    name: str
    type: str  # training | inference
    display_name: str
    description: str = ""
    framework: str = ""
    gpu: str = ""
    status: str = "ready"
    values: dict = field(default_factory=dict)
    editable: list[str] = field(default_factory=list)
    limits: dict = field(default_factory=dict)
    name_prefix: str = ""
    blueprint: dict | None = None
    required_secrets: list[dict] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)

    # what the profile says about scale, for listings
    @property
    def workers(self) -> str:
        n = self.limits.get("nodes")
        if n:
            return str(n["min"]) if n["min"] == n["max"] else f"{n['min']}-{n['max']}"
        return str(self.values.get("job", {}).get("nodes", 1)) if self.type == "training" else "-"

    @property
    def gpu_label(self) -> str:
        p = self.values.get("gpu", {}).get("productName")
        if p:
            return gpu_short(p)
        return self.gpu or "any"

    @property
    def max_runtime(self) -> str:
        h = self.limits.get("maxRuntimeHours")
        return f"{h}h" if h else "-"


def gpu_short(product: str) -> str:
    return re.sub(r"^NVIDIA\s+", "", str(product or "").replace("-", " "), flags=re.I).strip()


def from_configmap(cm: Any) -> Profile | None:
    md = cm.metadata if hasattr(cm, "metadata") else None
    labels = (md.labels if md else cm.get("metadata", {}).get("labels")) or {}
    if PROFILE_LABEL not in labels:
        return None
    name = md.name if md else cm["metadata"]["name"]
    data = (cm.data if md else cm.get("data")) or {}
    problems: list[str] = []
    try:
        doc = yaml.safe_load(data.get(PROFILE_KEY, "")) or {}
    except yaml.YAMLError as e:
        doc, problems = {}, [f"{PROFILE_KEY} is not valid YAML: {e}"]
    kind = "inference" if labels.get(PROFILE_LABEL) == "inference" else "training"
    editable = [str(f) for f in doc.get("editable", []) or []]
    for f in editable:
        if f not in EDITABLE:
            problems.append(f'editable: "{f}" is not a field a profile can open to users')
    limits = doc.get("limits") or {}
    if limits.get("maxRuntimeHours") and not (doc.get("values") or {}).get("job", {}).get("activeDeadlineSeconds"):
        _runtime(doc.setdefault("values", {}), limits["maxRuntimeHours"])
    return Profile(
        name=name, type=kind, display_name=str(doc.get("displayName") or name), description=str(doc.get("description") or ""),
        framework=str(doc.get("framework") or ""), gpu=str(doc.get("gpu") or ""),
        status="beta" if doc.get("status") == "beta" else "ready", values=doc.get("values") or {},
        editable=[f for f in editable if f in EDITABLE], limits=limits,
        name_prefix=str(doc.get("namePrefix") or ""), blueprint=doc.get("blueprint"),
        required_secrets=doc.get("requiredSecrets") or [], problems=problems,
    )


def normalise_image(image: str) -> str:
    ref = str(image or "").strip()
    first = ref.split("/")[0]
    if "/" in ref and ("." in first or ":" in first or first == "localhost"):
        return ref
    return f"docker.io/{ref}" if "/" in ref else f"docker.io/library/{ref}"


def split_image(ref: str) -> tuple[str, str | None]:
    """"registry/org/name:tag" -> (repository, tag). A port in the registry host is not a tag."""
    last = ref.rsplit("/", 1)[-1]
    if ":" in last:
        repo, tag = ref.rsplit(":", 1)
        return repo, tag
    return ref, None


def resolve(profile: Profile, overrides: dict[str, Any]) -> dict:
    """The gpu-train-job values a run installs: the profile's, with the user's input on the fields it
    opens. Raises ProfileError for a field the profile fixes."""
    values = copy.deepcopy(profile.values)
    for key, v in overrides.items():
        if v is None:
            continue
        field_name = ALIASES.get(key, key)
        if field_name == "image" and isinstance(v, str):
            repo, tag = split_image(v)
            if tag and "tag" not in profile.editable:
                raise ProfileError(f"profile {profile.name} fixes the image tag; give the image without a tag")
            if tag:
                EDITABLE["tag"](values, tag)
            v = repo
        if field_name not in profile.editable:
            raise ProfileError(f"profile {profile.name} does not let users set {key} (editable: {', '.join(profile.editable) or 'nothing'})")
        EDITABLE[field_name](values, v)
    return values


# Images with PyTorch and nothing else (no torchvision, no pip), and the usual companions code imports.
TORCH_ONLY_IMAGES = {"dp.apps.rancher.io/containers/pytorch"}
COMPANIONS = ["torchvision", "torchaudio", "transformers", "datasets", "peft", "accelerate", "timm"]


def missing_packages(image: str, code: str) -> list[str]:
    """What `code` imports that a torch-only image does not have. Mirrors missingPackages()."""
    repo = (image or "").strip().lower().removeprefix("docker.io/")
    if repo not in TORCH_ONLY_IMAGES or not code:
        return []
    return [m for m in COMPANIONS if re.search(rf"^\s*(import|from)\s+{m}\b", code, re.M)]


def check(profile: Profile, values: dict, run_name: str) -> list[str]:
    """What the profile forbids, as messages (empty = within its limits). Mirrors profileChecks()."""
    out: list[str] = []
    if not NAME_RE.match(run_name or ""):
        out.append(f"name {run_name!r} must be lowercase letters, numbers and hyphens (max 42)")
    if profile.name_prefix and not (run_name == profile.name_prefix or run_name.startswith(profile.name_prefix + "-")):
        out.append(f"name must start with {profile.name_prefix}-")
    n = profile.limits.get("nodes")
    nodes = int(values.get("job", {}).get("nodes", 1))
    if n and not (n["min"] <= nodes <= n["max"]):
        out.append(f"workers must be between {n['min']} and {n['max']} (asked {nodes})")
    g = profile.limits.get("gpusPerNode")
    gpus = int(values.get("job", {}).get("gpusPerNode", 1))
    if g and not (g["min"] <= gpus <= g["max"]):
        out.append(f"GPUs per worker must be between {g['min']} and {g['max']} (asked {gpus})")
    regs = profile.limits.get("registries") or []
    if regs:
        img = normalise_image(values.get("image", {}).get("repository", ""))
        if not any(img.startswith(normalise_image(r)) for r in regs):
            out.append(f"image {img} is not from an allowed registry ({', '.join(regs)})")
    mx = profile.limits.get("maxRuntimeHours")
    if mx:
        h = int(values.get("job", {}).get("activeDeadlineSeconds", 0)) / 3600
        if h <= 0 or h > mx:
            out.append(f"runtime limit must be set, at most {mx}h (got {h:g}h)")
    return out
