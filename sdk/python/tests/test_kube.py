"""The Rancher-token connection sends `Authorization: Bearer <token>`, whatever the client release."""

from rancher_ai.kube import Connection


def test_rancher_token_is_sent_as_a_bearer_header(monkeypatch):
    for k in ("RANCHER_INSECURE", "RANCHER_CA_CERT"):
        monkeypatch.delenv(k, raising=False)
    c = Connection(rancher_url="https://rancher.example.com/", token="token-abc:xyz", cluster="c-m-1")
    assert c.api.configuration.host == "https://rancher.example.com/k8s/clusters/c-m-1"
    assert c.api.configuration.auth_settings()["BearerToken"]["value"] == "Bearer token-abc:xyz"
    assert c.rancher.url == "https://rancher.example.com" and c.rancher.cluster_id == "c-m-1"


def test_unreadable_blueprints_are_not_cached(monkeypatch):
    from rancher_ai.client import Client
    calls = []

    def fake(self, *a, **k):
        calls.append(1)
        if len(calls) == 1:
            raise PermissionError("forbidden")
        return [{"metadata": {"labels": {"ai-factory.suse.com/blueprint-name": "bp", "ai-factory.suse.com/blueprint-version": "1"}},
                 "spec": {"components": []}}]

    monkeypatch.setattr("rancher_ai.kube.Connection.list_custom", fake)
    c = Client(rancher_url="https://r.example.com", token="t")
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        assert c.blueprints() == {}
    assert ("bp", "1") in c.blueprints()  # the role was granted in between


def test_no_credentials_is_one_clear_error(monkeypatch, tmp_path):
    import pytest
    for k in ("RANCHER_URL", "RANCHER_TOKEN", "KUBERNETES_SERVICE_HOST", "RANCHER_AI_CONTEXT"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("RANCHER_URL", "https://r.example.com")
    monkeypatch.setenv("KUBECONFIG", str(tmp_path / "none"))
    with pytest.raises(RuntimeError, match="RANCHER_URL is set; set both"):
        Connection()
