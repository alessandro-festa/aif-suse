"""The Rancher-token connection sends `Authorization: Bearer <token>`, whatever the client release."""

import pytest
from kubernetes import client

from rancher_ai.kube import Connection, Rancher


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


class _Custom:
    def list_cluster_custom_object(self, *a, **k):
        raise client.ApiException(status=404)


def _conn(version):
    c = object.__new__(Connection)
    c.custom, c.server = _Custom(), "https://192.168.1.74:8443/k8s/clusters/local"
    c.rancher = Rancher(url="https://192.168.1.74:8443", cluster_id="local")
    calls = []

    def call(method, path, *a, **k):
        calls.append(path)
        if isinstance(version, Exception):
            raise version
        return version
    c.call, c.calls = call, calls
    return c


def test_a_missing_type_on_a_real_api_is_empty():
    c = _conn({"gitVersion": "v1.31.4"})
    assert c.list_custom("ai-factory.suse.com", "v1alpha1", "computepools") == []
    assert c.list_custom("ai-factory.suse.com", "v1alpha1", "aiprojects") == []
    assert c.calls == ["/version"], "checked once"


def test_a_server_that_is_not_kubernetes_is_an_error_not_an_empty_list():
    c = _conn(client.ApiException(status=404))
    with pytest.raises(ConnectionError, match="routes by hostname"):
        c.list_custom("ai-factory.suse.com", "v1alpha1", "computepools")
    with pytest.raises(ConnectionError):
        _conn("<html>404 page not found</html>").list_custom("ai-factory.suse.com", "v1alpha1", "computepools")
