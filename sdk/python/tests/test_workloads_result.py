from rancher_ai.workloads import TrainingRun


def _run(report):
    r = TrainingRun.__new__(TrainingRun)
    r.report = report
    return r


def test_a_kept_report_with_a_failed_check_is_a_failed_result():
    res = _run({"test": "t", "status": "pass", "checks": [{"name": "a", "ok": True}, {"name": "b", "ok": False}]}).result()
    assert res["status"] == "fail"


def test_a_kept_report_keeps_its_status_when_every_check_passes():
    res = _run({"test": "t", "status": "pass", "checks": [{"name": "a", "ok": True, "warn": True}]}).result()
    assert res["status"] == "pass" and res["metrics"] == {} and res["env"] == {}


def test_the_terminal_gets_no_control_characters_or_line_breaks():
    from rancher_ai.display import plain
    assert plain("ok\x1b[2K\x1b[1A  PASS  fake") == "ok?[2K?[1A  PASS  fake"
    assert plain("a\nPASS  b\rc") == "a PASS  b c"
    assert plain("\x9b31m") == "?31m" and plain(None) == "" and plain(3.5) == "3.5"


def test_a_run_card_escapes_what_users_set():
    from types import SimpleNamespace
    from rancher_ai.workloads import RunStatus
    run = SimpleNamespace(name="r", namespace="p", state="Running", profile="<b>x</b>", ready=1, workers=1, gpus="1", queue="q",
                          image="img<script>alert(1)</script>", created="now", dashboard="javascript:alert(1)")
    page = RunStatus(run)._repr_html_()
    assert "<script>" not in page and "&lt;script&gt;" in page and "<b>x</b>" not in page
    assert "href='javascript" not in page


def test_an_endpoint_card_escapes_what_users_set():
    from rancher_ai.workloads import Endpoint
    ep = Endpoint(client=None, name="e", namespace="p", model="<img src=x onerror=alert(1)>")
    assert "<img" not in ep._repr_html_()
