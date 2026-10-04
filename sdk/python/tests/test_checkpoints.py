"""Only a run's own checkpoint volume is managed: the chart's labels and the <run>-checkpoints name."""

from types import SimpleNamespace as NS

from rancher_ai.checkpoints import _run_of


def pvc(name, labels):
    return NS(metadata=NS(name=name, labels=labels))


def test_a_runs_checkpoint_volume_is_recognised():
    assert _run_of(pvc("dev-1-checkpoints", {"app.kubernetes.io/name": "gpu-train-job", "app.kubernetes.io/instance": "dev-1"})) == "dev-1"


def test_datasets_scratch_and_lookalikes_are_not():
    chart = {"app.kubernetes.io/name": "gpu-train-job", "app.kubernetes.io/instance": "dev-1"}
    assert _run_of(pvc("dolly", {})) == ""
    assert _run_of(pvc("dev-1-0-abcde-scratch", chart)) == ""
    assert _run_of(pvc("other-checkpoints", chart)) == ""
    assert _run_of(pvc("dev-1-checkpoints", {"app.kubernetes.io/instance": "dev-1"})) == ""


def test_get_writes_inside_a_directory_and_makes_one_ending_in_a_slash(tmp_path, monkeypatch):
    from rancher_ai.checkpoints import target_path
    monkeypatch.chdir(tmp_path)
    assert target_path(".", "bundles/diag.tar.gz") == str(tmp_path / "diag.tar.gz")
    assert target_path("out/", "diag.tar.gz") == str(tmp_path / "out" / "diag.tar.gz")
    assert (tmp_path / "out").is_dir()
    assert target_path("named.tgz", "diag.tar.gz") == str(tmp_path / "named.tgz")


def test_get_expands_the_home_directory(tmp_path, monkeypatch):
    from rancher_ai.checkpoints import target_path
    monkeypatch.setenv("HOME", str(tmp_path))
    assert target_path("~/Downloads/", "diag.tar.gz") == str(tmp_path / "Downloads" / "diag.tar.gz")


def test_a_listing_becomes_rows_get_can_take():
    from rancher_ai.checkpoints import parse_listing
    rows = parse_listing("noise\n10052|1791078517|./gpu-diagnostics.tar.gz\n12|1791078000|./adapter/config.json\n")
    assert [r["path"] for r in rows] == ["adapter/config.json", "gpu-diagnostics.tar.gz"]
    assert rows[1]["bytes"] == 10052 and rows[1]["size"] == "9.8 KiB"
    assert parse_listing("5|1|./x.bin", under="adapter")[0]["path"] == "adapter/x.bin"


def test_sizes_read_like_the_ui():
    from rancher_ai.checkpoints import human_bytes
    assert [human_bytes(n) for n in (512, 10052, 30 * 2**20)] == ["512 B", "9.8 KiB", "30 MiB"]


def test_get_is_not_cut_short_by_an_encoded_line_that_spells_end(tmp_path, monkeypatch):
    import base64
    from rancher_ai import checkpoints
    data = base64.b64decode("ENDAENDA")
    monkeypatch.setattr(checkpoints, "_job", lambda *a, **k: f"SIZE {len(data)}\n{checkpoints.BEGIN}\nENDAENDA\n{checkpoints.END}\n")
    vol = checkpoints.Checkpoint(client=None, name="v", namespace="ns", run="r")
    out = vol.get("f.bin", str(tmp_path) + "/")
    assert open(out, "rb").read() == data
