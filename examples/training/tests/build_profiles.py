#!/usr/bin/env python3
"""Build the test and benchmark profiles in ../profiles from the scripts in this directory, so a
profile always carries its script's current text. Run after changing a script:

  python3 examples/training/tests/build_profiles.py
"""
import os

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "profiles")
TORCH = {"repository": "dp.apps.rancher.io/containers/pytorch", "tag": "2.14.0-nvidia-2.1"}
PULL = [{"name": "suse-ai-pull-combined"}]
ENV = [{"name": "PYTHONUNBUFFERED", "value": "1"}]


def script(name):
    with open(os.path.join(HERE, name)) as f:
        return f.read()


def torchrun(name, nodes, requests, **extra):
    v = {"image": TORCH, "imagePullSecrets": PULL, "job": {"kind": "job", "mode": "torchrun", "nodes": nodes, "gpusPerNode": 1, "script": script(name)},
         "resources": {"requests": requests}, "env": ENV}
    v.update(extra)
    return v


SMOKE = {"image": {"repository": "registry.suse.com/bci/bci-base", "tag": "15.7"},
         "job": {"kind": "job", "mode": "custom", "nodes": 1, "gpusPerNode": 1, "command": ["sh", "-c", script("gpu_smoke_test.sh")]},
         "resources": {"requests": {"cpu": "250m", "memory": "512Mi", "ephemeral-storage": "1Gi"}}}
SMALL = {"cpu": "1", "memory": "4Gi", "ephemeral-storage": "2Gi"}
DIAG = {"image": {"repository": "registry.suse.com/bci/bci-base", "tag": "15.7"},
        "job": {"kind": "job", "mode": "custom", "nodes": 1, "gpusPerNode": 1, "command": ["sh", "-c", script("gpu_diagnostics_bundle.sh")]},
        "resources": {"requests": {"cpu": "250m", "memory": "512Mi", "ephemeral-storage": "1Gi"}},
        # the bundle lands on a small volume kept after the run, for download
        "storage": {"checkpointCreate": {"enabled": True, "size": "1Gi", "storageClass": "longhorn", "keep": True}}}

CPU_SMOKE = {"image": {"repository": "registry.suse.com/bci/bci-base", "tag": "15.7"},
             "job": {"kind": "job", "mode": "custom", "nodes": 1, "gpusPerNode": 0, "command": ["sh", "-c", script("cpu_smoke_test.sh")]},
             "resources": {"requests": {"cpu": "1", "memory": "256Mi", "ephemeral-storage": "256Mi"}},
             "env": [{"name": "WORK_SECONDS", "value": "30"}, {"name": "HOLD_SECONDS", "value": "0"}]}

def framework_test(script_name, tag, memory, env):
    """A multi-node CPU test of a framework on a stock Python image: the script installs the framework
    (pinned by env) and runs it across the Indexed Job's pods."""
    return {"image": {"repository": "python", "tag": tag},
            "job": {"kind": "job", "mode": "custom", "nodes": 2, "gpusPerNode": 0, "command": ["sh", "-c", script(script_name)]},
            "resources": {"requests": {"cpu": "1", "memory": memory, "ephemeral-storage": "4Gi"}},
            "env": env}


FRAMEWORK_LIMITS = {"nodes": {"min": 1, "max": 4}, "registries": ["python", "docker.io/library/python"], "maxRuntimeHours": 1}

PROFILES = [
    ("12-gpu-smoke", "gpu-smoke", {
        "displayName": "GPU Smoke Test", "purpose": "test", "framework": "CUDA", "status": "ready",
        "description": "About 30 seconds on one whole GPU per worker: the GPU is allocated, the NVIDIA driver answers, the CUDA runtime and device memory are reported. No PyTorch needed.",
        "values": SMOKE, "editable": ["nodes"], "limits": {"nodes": {"min": 1, "max": 4}, "maxRuntimeHours": 1}}),
    ("39-cpu-smoke", "cpu-smoke", {
        "displayName": "CPU Smoke Test", "purpose": "test", "framework": "CPU", "gpu": "CPU", "status": "ready",
        "description": "About 30 seconds on one CPU, no GPU: the run is placed in a CPU pool, starts and computes. Set HOLD_SECONDS to keep it idle afterwards and watch idle reclaim.",
        "values": CPU_SMOKE, "editable": ["nodes", "env"], "limits": {"nodes": {"min": 1, "max": 4}, "maxRuntimeHours": 2},
        "reclaim": {"policy": "Suspend"}}),
    ("44-jax-distributed-test", "jax-distributed-test", {
        "displayName": "JAX Distributed Test (CPU)", "purpose": "test", "framework": "JAX", "gpu": "CPU", "status": "beta",
        "description": "Two or more CPU pods join one JAX job through jax.distributed on rank 0's stable name, gather every rank and train a small model with gradients averaged across processes. No GPU, no Kubeflow runtime.",
        "values": framework_test("jax_distributed_test.sh", "3.12-slim", "1Gi", [{"name": "JAX_VERSION", "value": "0.7.2"}]),
        "editable": ["nodes", "env"], "limits": FRAMEWORK_LIMITS}),
    ("45-tensorflow-distributed-test", "tensorflow-distributed-test", {
        "displayName": "TensorFlow Distributed Test (CPU)", "purpose": "test", "framework": "TensorFlow", "gpu": "CPU", "status": "beta",
        "description": "Two or more CPU pods form a MultiWorkerMirroredStrategy cluster from TF_CONFIG built off the pods' stable names, and train with gradients all-reduced across workers. No GPU, no TFJob operator.",
        "values": framework_test("tensorflow_distributed_test.sh", "3.12-slim", "2Gi", [{"name": "TF_VERSION", "value": "2.20.0"}]),
        "editable": ["nodes", "env"], "limits": FRAMEWORK_LIMITS}),
    ("46-deepspeed-distributed-test", "deepspeed-distributed-test", {
        "displayName": "DeepSpeed Distributed Test (CPU)", "purpose": "test", "framework": "DeepSpeed", "gpu": "CPU", "status": "beta",
        "description": "Two or more CPU pods set up torch.distributed from the chart's rendezvous and train with DeepSpeed ZeRO stage 1 over gloo (DeepSpeed's CPU accelerator). No GPU, no MPI or Kubeflow runtime.",
        "values": framework_test("deepspeed_distributed_test.sh", "3.12", "3Gi", [{"name": "TORCH_VERSION", "value": "2.8.0"}, {"name": "DEEPSPEED_VERSION", "value": "0.17.6"}]),
        "editable": ["nodes", "env"], "limits": FRAMEWORK_LIMITS}),
    ("30-gpu-smoke-shared", "gpu-smoke-shared", {
        "displayName": "GPU Smoke Test (shared GPU)", "purpose": "test", "framework": "CUDA", "status": "ready",
        "description": "The smoke test on a 1 GiB GPU-memory share, as shared workloads get their GPU: placed by the GPU-sharing scheduler, capped at its share.",
        "values": {**SMOKE, "gpu": {"sharedMemoryMiB": 1024}}, "editable": [], "limits": {"nodes": {"min": 1, "max": 1}, "maxRuntimeHours": 1}}),
    ("31-pytorch-gpu-test", "pytorch-gpu-test", {
        "displayName": "PyTorch GPU Test", "purpose": "test", "framework": "PyTorch", "status": "ready",
        "description": "About a minute on one whole GPU: PyTorch sees CUDA and the GPU, allocates memory, multiplies matrices in FP32, FP16 and BF16, and trains a few steps. Reports versions and TFLOPS.",
        "values": torchrun("pytorch_gpu_test.py", 1, SMALL), "editable": ["image", "tag"],
        "limits": {"nodes": {"min": 1, "max": 1}, "registries": ["dp.apps.rancher.io/containers/", "nvcr.io/nvidia/", "pytorch/"], "maxRuntimeHours": 1}}),
    ("32-pytorch-gpu-test-shared", "pytorch-gpu-test-shared", {
        "displayName": "PyTorch GPU Test (shared GPU)", "purpose": "test", "framework": "PyTorch", "status": "ready",
        "description": "The PyTorch GPU test on a 4 GiB GPU-memory share: PyTorch, CUDA and compute through the GPU-sharing layer, inside the share's memory cap.",
        "values": torchrun("pytorch_gpu_test.py", 1, SMALL, gpu={"sharedMemoryMiB": 4096}), "editable": ["image", "tag"],
        "limits": {"nodes": {"min": 1, "max": 1}, "registries": ["dp.apps.rancher.io/containers/", "nvcr.io/nvidia/", "pytorch/"], "maxRuntimeHours": 1}}),
    ("33-pytorch-distributed-test", "pytorch-distributed-test", {
        "displayName": "PyTorch Distributed Test", "purpose": "test", "framework": "PyTorch", "status": "ready",
        "description": "About two minutes on 2 or more workers, one whole GPU each: torchrun rendezvous, NCCL initialisation, a checked all-reduce and DDP training steps. Needs a separate GPU per worker.",
        "values": torchrun("pytorch_distributed_test.py", 2, {"cpu": "2", "memory": "8Gi", "ephemeral-storage": "2Gi"}, rendezvous={"backend": "c10d"}),
        "editable": ["nodes"], "limits": {"nodes": {"min": 2, "max": 8}, "maxRuntimeHours": 1}}),
    ("34-nccl-fabric-benchmark", "nccl-fabric-benchmark", {
        "displayName": "NCCL Fabric Benchmark", "purpose": "benchmark", "framework": "PyTorch", "status": "beta",
        "description": "Measures GPU-to-GPU collective bandwidth: NCCL all-reduce from 1 MiB to 1 GiB, reported as algorithm and bus bandwidth, as nccl-tests' all_reduce_perf does. 2 or more workers, one whole GPU each.",
        "values": torchrun("nccl_fabric_benchmark.py", 2, {"cpu": "2", "memory": "8Gi", "ephemeral-storage": "2Gi"}, rendezvous={"backend": "c10d"}),
        "editable": ["nodes", "gpusPerNode"], "limits": {"nodes": {"min": 2, "max": 16}, "gpusPerNode": {"min": 1, "max": 8}, "maxRuntimeHours": 1}}),
    ("35-training-storage-test", "training-storage-test", {
        "displayName": "Training + Storage Test", "purpose": "test", "framework": "PyTorch", "status": "beta",
        "description": "The path a training run takes: a dataset (synthetic on scratch, or your dataset volume) through a DataLoader into training on the GPU, then a checkpoint written and read back. Reports throughput at each step.",
        "values": torchrun("training_storage_test.py", 1, {"cpu": "2", "memory": "8Gi", "ephemeral-storage": "2Gi"}, rendezvous={"backend": "c10d"},
                           storage={"checkpointCreate": {"enabled": True, "size": "5Gi", "storageClass": "longhorn", "keep": False},
                                    "scratchSize": "10Gi", "scratchMedium": "volume", "scratchStorageClass": "longhorn"},
                           env=ENV + [{"name": "SHARDS", "value": "16"}]),
        "editable": ["nodes", "datasetPVC", "gpuShareMiB"], "limits": {"nodes": {"min": 1, "max": 4}, "maxRuntimeHours": 1}}),
    ("36-gpu-diagnostics-bundle", "gpu-diagnostics-bundle", {
        "displayName": "GPU Diagnostics Bundle", "purpose": "test", "framework": "CUDA", "status": "beta",
        "description": "Collects what NVIDIA support asks for first (nvidia-smi -q, topology, ECC, clocks, PCIe, driver and libraries) into a .tar.gz on a kept volume, and checks it: uncorrected ECC errors, pending memory repair, throttling, temperature, PCIe link width.",
        "values": DIAG, "editable": [], "limits": {"nodes": {"min": 1, "max": 1}, "maxRuntimeHours": 1}}),
    ("37-gpu-diagnostics-bundle-shared", "gpu-diagnostics-bundle-shared", {
        "displayName": "GPU Diagnostics Bundle (shared GPU)", "purpose": "test", "framework": "CUDA", "status": "beta",
        "description": "The diagnostics bundle from a 1 GiB GPU-memory share, for a GPU that is shared: what a shared workload sees, collected and checked.",
        "values": {**DIAG, "gpu": {"sharedMemoryMiB": 1024}}, "editable": [], "limits": {"nodes": {"min": 1, "max": 1}, "maxRuntimeHours": 1}}),
    ("38-gpu-health-check", "gpu-health-check", {
        "displayName": "GPU Health Check", "purpose": "test", "framework": "DCGM", "status": "beta",
        "description": "NVIDIA DCGM diagnostics on one whole GPU. Level 1 (about 30 seconds) checks the deployment and the GPU's state; set DCGM_LEVEL=2 for PCIe bandwidth, memory and a short stress (a few minutes).",
        # NVIDIA's DCGM image, as the GPU Operator uses: neither the SUSE Application Collection nor
        # the SUSE registry ships DCGM.
        "values": {"image": {"repository": "nvcr.io/nvidia/cloud-native/dcgm", "tag": "4.5.2-1-ubuntu22.04"},
                   "job": {"kind": "job", "mode": "custom", "nodes": 1, "gpusPerNode": 1, "command": ["sh", "-c", script("gpu_health_check.sh")]},
                   "resources": {"requests": {"cpu": "1", "memory": "2Gi", "ephemeral-storage": "1Gi"}},
                   "env": [{"name": "DCGM_LEVEL", "value": "1"}]},
        "editable": ["env"], "limits": {"nodes": {"min": 1, "max": 1}, "maxRuntimeHours": 1}}),
]


class Literal(str):
    pass


yaml.add_representer(Literal, lambda d, s: d.represent_scalar("tag:yaml.org,2002:str", s, style="|"))


def literal_scripts(o):
    if isinstance(o, dict):
        return {k: (Literal(v) if isinstance(v, str) and "\n" in v else literal_scripts(v)) for k, v in o.items()}
    if isinstance(o, list):
        return [Literal(v) if isinstance(v, str) and "\n" in v else literal_scripts(v) for v in o]
    return o


for fname, name, doc in PROFILES:
    body = yaml.dump(literal_scripts(doc), sort_keys=False, width=1000, allow_unicode=True)
    cm = {"apiVersion": "v1", "kind": "ConfigMap",
          "metadata": {"name": name, "namespace": "ai-profiles", "labels": {"trainingjobs/profile": "training"}},
          "data": {"profile.yaml": Literal(body)}}
    with open(os.path.join(OUT, f"{fname}.yaml"), "w") as f:
        f.write(f"# {doc['displayName']}: {doc['description']}\n# Built by ../tests/build_profiles.py from ../tests/; edit the script there and rebuild.\n")
        yaml.dump(cm, f, sort_keys=False, width=1000, allow_unicode=True)
    print("wrote", fname)
