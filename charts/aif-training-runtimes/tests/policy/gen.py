#!/usr/bin/env python3
"""Writes the policy cases (NN-name.yaml) and expected.txt. Run it after changing a case; run.sh
sends them to a cluster."""
import os
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
NS, OTHER_Q, OTHER_NS = "aif-submit", "scdoc-transcription", "tenant-default"
M = "ai-factory.suse.com/policy-test"


def patch(md, mgr=M, spec=None):
    pod = {"metadata": md, **({"spec": spec} if spec else {})}
    return {"manager": mgr, "trainingRuntimeSpec": {"template": {"spec": {"replicatedJobs": [
        {"name": "node", "template": {"spec": {"template": pod}}}]}}}}


def queue(q=NS, **annotations):
    md = {"labels": {"kai.scheduler/queue": q}}
    if annotations:
        md["annotations"] = {k.replace("_", "-"): v for k, v in annotations.items()}
    return md


def tj(name, runtime, patches, ns=NS, kind=None, nodes=1, gpus=None, image=None, deadline=None, requests=None):
    ref = {"name": runtime, **({"kind": kind} if kind else {})}
    trainer = {"numNodes": nodes, "command": ["python", "-c", "print('hi')"]}
    if gpus:
        trainer["resourcesPerNode"] = {"limits": {"nvidia.com/gpu": gpus}}
    if requests:
        trainer["resourcesPerNode"] = {"requests": requests}
    if image:
        trainer["image"] = image
    spec = {"runtimeRef": ref, "trainer": trainer, **({"activeDeadlineSeconds": deadline} if deadline else {})}
    if patches:
        spec["runtimePatches"] = patches
    return {"apiVersion": "trainer.kubeflow.org/v1alpha1", "kind": "TrainJob",
            "metadata": {"name": name, "namespace": ns}, "spec": spec}


def pod(name, scheduler, q, gpus, image="nvcr.io/nvidia/cuda:12.8.0-base-ubuntu24.04", init_image=None):
    c = {"name": "c", "image": image, "command": ["true"]}
    if gpus:
        c["resources"] = {"limits": {"nvidia.com/gpu": gpus}}
    md = {"name": name, "namespace": NS, **({"labels": {"kai.scheduler/queue": q}} if q else {})}
    spec = {"restartPolicy": "Never", "containers": [c], **({"schedulerName": scheduler} if scheduler else {})}
    if init_image:
        spec["initContainers"] = [{"name": "init", "image": init_image, "command": ["true"]}]
    return {"apiVersion": "v1", "kind": "Pod", "metadata": md, "spec": spec}


CASES = [
    ("valid-share-profile", "admitted", "a share profile, in the project's queue",
     tj("t-share", "aif-share-4g", [patch(queue())])),
    ("valid-whole-gpu", "admitted", "one whole GPU, in the project's queue",
     tj("t-gpu", "aif-gpu", [patch(queue())], gpus=1)),
    ("no-queue", "refused", "the pods carry no queue", tj("t-no-queue", "aif-share-4g", [])),
    ("wrong-queue", "refused", "another project's queue", tj("t-wrong-queue", "aif-share-4g", [patch(queue(OTHER_Q))])),
    ("share-in-patch", "refused", "a job setting its own share: it comes from the profile",
     tj("t-share-patch", "aif-share-4g", [patch(queue(gpu_memory="4096"))])),
    ("bigger-share-in-patch", "refused", "a job raising its share above the profile's",
     tj("t-share-big", "aif-share-4g", [patch(queue(gpu_memory="32768"))])),
    ("too-many-nodes", "refused", "more nodes than the profile allows",
     tj("t-nodes", "aif-gpu", [patch(queue())], nodes=6, gpus=1)),
    ("too-many-gpus", "refused", "more GPUs per node than the profile allows",
     tj("t-gpus", "aif-gpu", [patch(queue())], gpus=16)),
    ("gpus-on-cpu", "refused", "whole GPUs on the CPU profile", tj("t-cpu-gpus", "aif-cpu", [patch(queue())], gpus=1)),
    ("gpus-on-share", "refused", "whole GPUs on a share profile", tj("t-share-gpus", "aif-share-4g", [patch(queue())], gpus=1)),
    ("other-runtime", "refused", "a runtime that is not an AI Factory profile",
     tj("t-other", "torch-distributed", [patch(queue())])),
    ("unmanaged-namespace", "admitted", "a namespace outside policy.namespaceSelector is not checked",
     tj("t-unmanaged", "aif-share-4g", [], ns=OTHER_NS)),
    ("second-patch-share", "refused", "a later patch adding a share",
     tj("t-two-shares", "aif-share-4g", [patch(queue(), M + "-a"), patch({"annotations": {"gpu-memory": "999999"}}, M + "-b")])),
    ("second-patch-queue", "refused", "a later patch naming another project's queue",
     tj("t-two-queues", "aif-share-4g", [patch(queue(), M + "-a"), patch(queue(OTHER_Q), M + "-b")])),
    ("fraction-on-cpu", "refused", "a KAI share annotation on the CPU profile",
     tj("t-fraction-cpu", "aif-cpu", [patch(queue(gpu_fraction="1"))])),
    ("fraction-on-share", "refused", "gpu-fraction on a share profile",
     tj("t-fraction-share", "aif-share-4g", [patch(queue(gpu_fraction="1"))])),
    ("namespaced-runtime", "refused", "a namespaced TrainingRuntime borrowing a profile's name",
     tj("t-ns-runtime", "aif-share-4g", [patch(queue())], kind="TrainingRuntime")),
    ("multi-node-rwo-outputs", "refused", "2 nodes on ReadWriteOnce outputs (outputs.enabled, RWO; admitted otherwise)",
     tj("t-rwo", "aif-gpu", [patch(queue())], nodes=2, gpus=1)),
    ("image-allowed-registry", "admitted", "an image from an allowed registry",
     tj("t-img-ok", "aif-share-4g", [patch(queue())], image="nvcr.io/nvidia/pytorch:25.01-py3")),
    ("image-other-registry", "refused", "an image from a registry outside the profile's",
     tj("t-img-bad", "aif-share-4g", [patch(queue())], image="ghcr.io/someone/trainer:latest")),
    ("deadline-within-limit", "admitted", "a deadline within the profile's runtime limit",
     tj("t-deadline-ok", "aif-share-4g", [patch(queue())], deadline=3600)),
    ("deadline-over-limit", "refused", "a deadline beyond the profile's runtime limit (4 h)",
     tj("t-deadline-long", "aif-share-4g", [patch(queue())], deadline=999999)),
    ("cpu-within-cap", "admitted", "CPU and memory within the profile's caps",
     tj("t-cpu-ok", "aif-share-4g", [patch(queue())], requests={"cpu": "4", "memory": "16Gi"})),
    ("cpu-over-cap", "refused", "more CPU than the profile allows",
     tj("t-cpu-big", "aif-share-4g", [patch(queue())], requests={"cpu": "64"})),
    ("memory-over-cap", "refused", "more memory than the profile allows",
     tj("t-mem-big", "aif-share-4g", [patch(queue())], requests={"memory": "1Ti"})),
    ("placement-in-patch", "refused", "a nodeSelector in the job's patches",
     tj("t-placement", "aif-share-4g", [patch(queue(), spec={"nodeSelector": {"kubernetes.io/hostname": "rke2-worker1"}})])),
    ("privileged-in-patch", "refused", "a privileged container in the job's patches",
     tj("t-privileged", "aif-gpu", [patch(queue(), spec={"containers": [{"name": "node", "securityContext": {"privileged": True}}]})], gpus=1)),
    ("hostpath-in-patch", "refused", "a node path mounted through the job's patches",
     tj("t-hostpath", "aif-share-4g", [patch(queue(), spec={"volumes": [{"name": "h", "hostPath": {"path": "/"}}],
                                                         "containers": [{"name": "node", "volumeMounts": [{"name": "h", "mountPath": "/host"}]}]})])),
    ("pvc-in-patch", "admitted", "a project PVC mounted through the job's patches (a dataset)",
     tj("t-pvc", "aif-share-4g", [patch(queue(), spec={"volumes": [{"name": "d", "persistentVolumeClaim": {"claimName": "datasets"}}],
                                                    "containers": [{"name": "node", "volumeMounts": [{"name": "d", "mountPath": "/data"}]}]})])),
    ("serviceaccount-in-patch", "refused", "another service account in the job's patches",
     tj("t-sa", "aif-share-4g", [patch(queue(), spec={"serviceAccountName": "default"})])),
    ("pod-gpu-default-scheduler", "refused", "a GPU pod not scheduled by KAI", pod("p-default-sched", None, NS, 1)),
    ("pod-kai-other-queue", "refused", "a KAI pod in another project's queue", pod("p-other-queue", "kai-scheduler", OTHER_Q, 1)),
    ("pod-kai-own-queue", "admitted", "a KAI pod in its project's queue", pod("p-own-queue", "kai-scheduler", NS, 1)),
    ("pod-gpu-other-registry", "refused", "a GPU pod running an image from an unapproved registry",
     pod("p-bad-image", "kai-scheduler", NS, 1, image="ghcr.io/someone/miner:latest")),
    ("pod-gpu-init-other-registry", "refused", "a GPU pod whose init container comes from an unapproved registry",
     pod("p-bad-init", "kai-scheduler", NS, 1, init_image="docker.io/library/busybox:1.36")),
    ("pod-no-gpu", "admitted", "a pod without GPUs is not checked (busybox from Docker Hub)",
     pod("p-no-gpu", None, None, None, image="busybox:1.36")),
]

import glob, re
for old in glob.glob(os.path.join(HERE, "[0-9][0-9]-*.yaml")):   # the previous run's cases
    if re.fullmatch(r"\d\d-[a-z0-9-]+\.yaml", os.path.basename(old)):
        os.remove(old)

with open(os.path.join(HERE, "expected.txt"), "w") as exp:
    for i, (name, want, why, obj) in enumerate(CASES, 1):
        n = f"{i:02d}-{name}"
        with open(os.path.join(HERE, f"{n}.yaml"), "w") as f:
            yaml.safe_dump(obj, f, sort_keys=False)
        exp.write(f"{n}: {want}: {why}\n")
print(len(CASES), "cases")
