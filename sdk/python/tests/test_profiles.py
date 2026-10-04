"""Profile parsing and resolution, offline. The same rules as ui/pkg/aif-ui/training/profiles.ts."""

import pytest
import yaml

from rancher_ai.profiles import ProfileError, check, from_configmap, missing_packages, resolve, split_image

PROFILE = {
    "displayName": "PyTorch Distributed", "framework": "PyTorch", "namePrefix": "team",
    "values": {"image": {"repository": "dp.apps.rancher.io/containers/pytorch", "tag": "2.14.0-nvidia-2.1"},
               "job": {"kind": "job", "mode": "torchrun", "nodes": 2, "gpusPerNode": 1},
               "env": [{"name": "PYTHONUNBUFFERED", "value": "1"}]},
    "editable": ["image", "tag", "args", "env", "nodes", "gpuShareMiB", "runtimeLimitHours", "bogus"],
    "limits": {"nodes": {"min": 1, "max": 4}, "registries": ["dp.apps.rancher.io/containers/", "pytorch/"], "maxRuntimeHours": 8},
}


def cm(doc, kind="training", name="pytorch-distributed"):
    return {"metadata": {"name": name, "labels": {"trainingjobs/profile": kind}}, "data": {"profile.yaml": yaml.safe_dump(doc)}}


def test_reads_a_profile_and_reports_unknown_editable_fields():
    p = from_configmap(cm(PROFILE))
    assert p.type == "training" and p.workers == "1-4" and p.name_prefix == "team"
    assert "bogus" not in p.editable and any("bogus" in x for x in p.problems)
    # maxRuntimeHours sets the run's deadline when the values do not
    assert p.values["job"]["activeDeadlineSeconds"] == 8 * 3600


def test_ignores_configmaps_without_the_label():
    assert from_configmap({"metadata": {"name": "x", "labels": {}}, "data": {}}) is None


def test_resolves_user_fields_onto_the_profile():
    p = from_configmap(cm(PROFILE))
    v = resolve(p, {"image": "pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime", "workers": 3, "args": "--epochs 10 --lr 2e-5",
                    "env": {"WANDB_MODE": "offline"}, "gpu_memory": 4, "runtime_hours": 2})
    assert v["image"] == {"repository": "pytorch/pytorch", "tag": "2.4.0-cuda12.4-cudnn9-runtime"}
    assert v["job"]["nodes"] == 3 and v["job"]["args"] == ["--epochs", "10", "--lr", "2e-5"]
    assert {"name": "PYTHONUNBUFFERED", "value": "1"} in v["env"] and {"name": "WANDB_MODE", "value": "offline"} in v["env"]
    assert v["gpu"]["sharedMemoryMiB"] == 4096 and v["job"]["activeDeadlineSeconds"] == 7200
    assert p.values["job"]["nodes"] == 2  # the profile itself is untouched


def test_refuses_a_field_the_profile_fixes():
    with pytest.raises(ProfileError, match="does not let users set command"):
        resolve(from_configmap(cm(PROFILE)), {"command": "python train.py"})


def test_limits():
    p = from_configmap(cm(PROFILE))
    assert check(p, resolve(p, {"workers": 2}), "team-a") == []
    assert any("between 1 and 4" in m for m in check(p, resolve(p, {"workers": 9}), "team-a"))
    assert any("allowed registry" in m for m in check(p, resolve(p, {"image": "ghcr.io/x/y:1"}), "team-a"))
    assert any("start with team-" in m for m in check(p, resolve(p, {}), "other"))
    assert any("at most 8h" in m for m in check(p, resolve(p, {"runtime_hours": 12}), "team-a"))
    assert any("lowercase" in m for m in check(p, resolve(p, {}), "Team_A"))


def test_docker_hub_short_names_match_their_registry_prefix():
    p = from_configmap(cm(PROFILE))
    assert check(p, resolve(p, {"image": "pytorch/pytorch:2.4.0"}), "team-a") == []


def test_image_with_a_registry_port_is_not_a_tag():
    assert split_image("registry.local:5000/team/trainer") == ("registry.local:5000/team/trainer", None)
    assert split_image("registry.local:5000/team/trainer:v12") == ("registry.local:5000/team/trainer", "v12")


def test_inference_profile():
    p = from_configmap(cm({"displayName": "Qwen", "blueprint": {"name": "suse-inference-endpoint-dra", "version": "1.1.0"},
                           "requiredSecrets": [{"name": "litellm-credentials"}]}, kind="inference", name="qwen"))
    assert p.type == "inference" and p.blueprint["version"] == "1.1.0" and p.required_secrets[0]["name"] == "litellm-credentials"



def test_gpus_per_worker_range():
    p = from_configmap(cm({"displayName": "R", "values": {"job": {"gpusPerNode": 1}}, "editable": ["gpusPerNode"],
                           "limits": {"gpusPerNode": {"min": 1, "max": 2}}}, name="gpu-range"))
    assert check(p, {"job": {"gpusPerNode": 4}}, "r-1") == ["GPUs per worker must be between 1 and 2 (asked 4)"]
    assert check(p, {"job": {"gpusPerNode": 2}}, "r-1") == []


def test_missing_packages_on_a_torch_only_image():
    code = "import torch\nfrom torchvision import datasets\n"
    assert missing_packages("dp.apps.rancher.io/containers/pytorch", code) == ["torchvision"]
    assert missing_packages("pytorch/pytorch", code) == []


def test_training_run_result_is_a_method_and_dashboard_a_property():
    from rancher_ai.workloads import TrainingRun
    assert callable(TrainingRun.result)
    assert isinstance(TrainingRun.__dict__["dashboard"], property)


def test_mounting_an_existing_checkpoint_volume_replaces_the_one_a_profile_creates():
    from rancher_ai.profiles import EDITABLE
    values = {"storage": {"checkpointCreate": {"enabled": True, "size": "5Gi", "keep": True}}}
    EDITABLE["checkpointPVC"](values, "dev-r0m7s-checkpoints")
    assert values["storage"]["checkpointPVC"] == "dev-r0m7s-checkpoints"
    assert values["storage"]["checkpointCreate"]["enabled"] is False
