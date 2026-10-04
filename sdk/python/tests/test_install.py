"""What the CLI adds to a profile's values for the project, offline (a stub connection)."""

from rancher_ai import install


class Conn:
    def __init__(self, ns_labels=None, localqueues=(), claims=()):
        self._labels, self._lq, self._claims = ns_labels or {}, list(localqueues), list(claims)

        class Core:
            def read_namespace(_, name):
                return type("NS", (), {"metadata": type("M", (), {"labels": self._labels})()})()
        self.core = Core()

    def has_group(self, g):
        return False

    def can_i(self, *a, **k):
        return True

    def list_custom(self, group, version, plural, namespace=None, label_selector=None):
        return {"localqueues": self._lq, "resourceclaims": self._claims}.get(plural, [])


MPS = {"metadata": {"name": "gpu-shared"}, "spec": {"devices": {"config": [{"opaque": {"parameters": {"kind": "GpuConfig", "sharing": {"strategy": "MPS"}}}}]}}}


def test_follows_the_projects_kueue_queue():
    v = install.complete(Conn(localqueues=[{"metadata": {"name": "default-queue"}}]), {"job": {}}, "ns", "p")
    assert v["scheduler"] == {"type": "kueue", "queue": "default-queue"} and v["profile"] == "p"


def test_kai_queue_from_the_namespace_label():
    v = install.complete(Conn(ns_labels={"kai.scheduler/queue": "team-a"}), {"job": {}}, "ns", "p")
    assert v["scheduler"] == {"type": "kai", "queue": "team-a"}


def test_a_shared_gpu_run_uses_the_projects_claim_and_skips_kueue():
    # Kueue marks a pod with resourceClaimName Inadmissible; queued, it would never start.
    v = install.complete(Conn(localqueues=[{"metadata": {"name": "q"}}], claims=[MPS]), {"gpu": {"sharedMemoryMiB": 4096}}, "ns", "p")
    assert v["gpu"]["sharedClaim"] == "gpu-shared" and v["gpu"]["mode"] == "dra"
    assert v["scheduler"] == {"type": "none", "queue": ""}


def test_a_shared_gpu_run_needs_a_shared_claim():
    import pytest
    with pytest.raises(RuntimeError, match="no shared GPU"):
        install.complete(Conn(), {"gpu": {"sharedMemoryMiB": 4096}}, "ns", "p")


def test_a_share_in_a_kai_project_needs_no_claim():
    v = install.complete(Conn(ns_labels={"kai.scheduler/queue": "team-a"}), {"gpu": {"mode": "dra", "sharedMemoryMiB": 3500}}, "ns", "p")
    assert v["scheduler"] == {"type": "kai", "queue": "team-a"}
    assert v["gpu"]["sharedClaim"] == "" and v["gpu"]["sharedMemoryMiB"] == 3500


def test_aijob_for_names_the_run_and_turns_off_the_capacity_check():
    j = install.aijob_for("team-a", "train-a1b2c", {"preflight": {"enabled": True, "checkHeadroom": True}, "job": {"nodes": 2}},
                          "single-gpu-dev", "0.1.34")
    assert j["kind"] == "AIJob" and j["metadata"] == {"name": "train-a1b2c", "namespace": "team-a"}
    assert j["spec"]["source"] == {"repoName": "gpu-train-charts", "chartName": "gpu-train-job", "version": "0.1.34"}
    assert j["spec"]["values"]["preflight"] == {"enabled": True, "checkHeadroom": False}
    assert j["spec"]["profile"] == "single-gpu-dev" and j["spec"]["category"] == "training"


def test_aijob_for_leaves_the_values_it_was_given():
    values = {"preflight": {"checkHeadroom": True}}
    install.aijob_for("team-a", "r", values, "", "1.0.0")
    assert values["preflight"]["checkHeadroom"] is True


def test_newest_puts_a_release_after_its_prereleases():
    from rancher_ai.install import newest
    assert newest(["2.3.0-rc.3", "2.3.0", "2.2.9"]) == "2.3.0"
    assert newest(["2.3.0-rc.9", "2.3.0-rc.10"]) == "2.3.0-rc.10"
    assert newest(["0.1.34", "2.3.0-training.1"]) == "2.3.0-training.1"
    assert newest(["0.1.9", "0.1.10"]) == "0.1.10"


def test_a_run_reads_the_report_its_aijob_kept():
    from rancher_ai.workloads import TrainingRun
    run = TrainingRun(client=None, name="smoke", namespace="team-a",
                      report={"test": "GPU Smoke Test", "status": "pass", "checks": [{"name": "GPU allocated", "ok": True}]})
    r = run.result()
    assert r["test"] == "GPU Smoke Test" and r["checks"][0]["ok"] and r["metrics"] == {}
