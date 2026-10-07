"""The connection, first that applies:
  1. a Rancher URL and API token (arguments, or RANCHER_URL / RANCHER_TOKEN, with RANCHER_CLUSTER
     for the cluster id, default local): you, through Rancher's cluster proxy;
  2. a kubeconfig context (a Rancher-generated one, or any other);
  3. inside a pod, its service account.
Everything goes through the Kubernetes API with those credentials, so RBAC is exactly what the AI
Factory UI would allow the same identity."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

from kubernetes import client, config

IN_CLUSTER_NS = "/var/run/secrets/kubernetes.io/serviceaccount/namespace"


@dataclass
class Rancher:
    """Set when the kubeconfig points at Rancher's proxy (https://rancher/k8s/clusters/<id>)."""

    url: str
    cluster_id: str


class Connection:
    def __init__(self, context: str | None = None, kubeconfig: str | None = None, namespace: str | None = None,
                 rancher_url: str | None = None, token: str | None = None, cluster: str | None = None):
        self.kubeconfig = kubeconfig or os.environ.get("KUBECONFIG")
        self.in_cluster = False
        rancher_url = rancher_url or (os.environ.get("RANCHER_URL") if not context else None)
        token = token or os.environ.get("RANCHER_TOKEN")
        default_ns = None
        if rancher_url and token:
            cfg = client.Configuration()
            cfg.host = f"{rancher_url.rstrip('/')}/k8s/clusters/{cluster or os.environ.get('RANCHER_CLUSTER', 'local')}"
            # the client looks the token up as BearerToken (newer releases) or authorization (older)
            cfg.api_key = {"BearerToken": token, "authorization": token}
            cfg.api_key_prefix = {"BearerToken": "Bearer", "authorization": "Bearer"}
            ca = os.environ.get("RANCHER_CA_CERT")  # PEM file of the CA that signed Rancher's certificate
            if ca:
                cfg.ssl_ca_cert = ca
            elif os.environ.get("RANCHER_INSECURE", "") in ("1", "true", "yes"):
                # opted in (a self-signed certificate): skip verification without a warning on every request
                import urllib3
                urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
                cfg.verify_ssl = False
            self.api = client.ApiClient(cfg)
            self.context = "rancher-token"
        else:
            self.api, self.context, default_ns = self._from_kubeconfig_or_pod(context)
        self.namespace = namespace or default_ns or "default"
        self._clients()

    def _from_kubeconfig_or_pod(self, context: str | None):
        context = context or os.environ.get("RANCHER_AI_CONTEXT")
        try:
            contexts, active = config.list_kube_config_contexts(config_file=self.kubeconfig)
            ctx = next((c for c in contexts if c["name"] == context), None) if context else active
            if context and not ctx:
                raise RuntimeError(f"no context {context!r} in kubeconfig")
            api = config.new_client_from_config(config_file=self.kubeconfig, context=ctx["name"])
            return api, ctx["name"], ctx.get("context", {}).get("namespace")
        except config.ConfigException:
            if not os.environ.get("KUBERNETES_SERVICE_HOST"):
                half = [k for k in ("RANCHER_URL", "RANCHER_TOKEN") if os.environ.get(k)]
                hint = f" ({half[0]} is set; set both)" if len(half) == 1 else ""
                raise RuntimeError("no connection: set RANCHER_URL and RANCHER_TOKEN (a Rancher API key)" + hint +
                                   ", or have a kubeconfig (~/.kube/config, $KUBECONFIG or --kubeconfig)") from None
            config.load_incluster_config()
            self.in_cluster = True
            ns = open(IN_CLUSTER_NS).read().strip() if os.path.exists(IN_CLUSTER_NS) else None
            return client.ApiClient(), "in-cluster", ns

    def _clients(self) -> None:
        self.core = client.CoreV1Api(self.api)
        self.batch = client.BatchV1Api(self.api)
        self.custom = client.CustomObjectsApi(self.api)
        host = self.api.configuration.host.rstrip("/")
        self.server = host
        self.rancher: Rancher | None = None
        if "/k8s/clusters/" in host:
            base, rest = host.split("/k8s/clusters/", 1)
            self.rancher = Rancher(url=base, cluster_id=rest.split("/")[0])

    # ---- raw calls, for APIs the generated client does not cover (Rancher's /v1, service proxy)
    def call(self, method: str, path: str, body: Any = None, query: dict | None = None, headers: dict | None = None,
             raw: bool = False) -> Any:
        """A request with the connection's credentials; JSON in and out. Errors raise ApiException."""
        hdrs = {"Accept": "application/json", "Content-Type": "application/json", **(headers or {})}
        if hasattr(self.api, "param_serialize"):
            # kubernetes >= 33 (openapi-generator 7): serialise the request, then send it
            m, url, h, b, post = self.api.param_serialize(
                method=method, resource_path=path, query_params=list((query or {}).items()), header_params=hdrs,
                body=body, auth_settings=["BearerToken"])
            resp = self.api.call_api(m, url, header_params=h, body=b, post_params=post)
            resp.read()
            if resp.status >= 400:
                raise client.ApiException(http_resp=resp)
        else:
            resp = self.api.call_api(
                path, method, query_params=list((query or {}).items()), header_params=hdrs, body=body,
                auth_settings=["BearerToken"], _return_http_data_only=True, _preload_content=False,
            )
        # The generated client's own deserialisation differs between releases; read the bytes instead.
        if raw:
            return resp
        data = resp.data if hasattr(resp, "data") else resp
        text = data.decode() if isinstance(data, bytes) else str(data or "")
        try:
            return json.loads(text) if text else {}
        except ValueError:
            return text

    def whoami(self) -> dict:
        """User and groups as the API server sees them (SelfSubjectReview, Kubernetes 1.28+)."""
        try:
            r = self.call("POST", "/apis/authentication.k8s.io/v1/selfsubjectreviews",
                          {"apiVersion": "authentication.k8s.io/v1", "kind": "SelfSubjectReview"})
            info = r.get("status", {}).get("userInfo", {})
        except client.ApiException:
            info = {}
        return {
            "user": info.get("username", "?"),
            "groups": info.get("groups", []),
            "context": self.context,
            "cluster": self.rancher.cluster_id if self.rancher else self.server,
            "namespace": self.namespace,
            "rancher": self.rancher.url if self.rancher else None,
        }

    def can_i(self, verb: str, resource: str, group: str = "", namespace: str | None = None) -> bool:
        body = {"apiVersion": "authorization.k8s.io/v1", "kind": "SelfSubjectAccessReview",
                "spec": {"resourceAttributes": {"verb": verb, "resource": resource, "group": group,
                                                **({"namespace": namespace} if namespace else {})}}}
        try:
            return bool(self.call("POST", "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", body)
                        .get("status", {}).get("allowed"))
        except client.ApiException:
            return False

    def has_group(self, group: str) -> bool:
        try:
            return any(g.name == group for g in client.ApisApi(self.api).get_api_versions().groups)
        except client.ApiException:
            return False

    def list_custom(self, group: str, version: str, plural: str, namespace: str | None = None,
                    label_selector: str | None = None, required: bool = False) -> list[dict]:
        """Namespaced list when a namespace is given, else cluster-wide; [] when the type is missing.
        Forbidden is [] too for optional facts (a queue, a release); with required=True it raises
        PermissionError, so "you may not see these" never reads as "there are none"."""
        kw = {"label_selector": label_selector} if label_selector else {}
        try:
            if namespace:
                return self.custom.list_namespaced_custom_object(group, version, namespace, plural, **kw).get("items", [])
            return self.custom.list_cluster_custom_object(group, version, plural, **kw).get("items", [])
        except client.ApiException as e:
            if e.status == 403 and required:
                where = f" in {namespace}" if namespace else " (cluster-wide)"
                raise PermissionError(f"not allowed to list {plural}.{group}{where}: {self.whoami()['user']} needs a role "
                                      f"that grants it (see docs/rbac.md)") from None
            if e.status in (403, 404):
                return []
            raise

    def for_cluster(self, cluster_id: str) -> "Connection":
        """The same identity on another Rancher cluster (Rancher's proxy, /k8s/clusters/<id>): where a run
        placed on a compute pool runs. Without Rancher there is only this connection's cluster."""
        if not self.rancher or cluster_id == self.rancher.cluster_id:
            return self
        other = object.__new__(Connection)
        other.__dict__.update(self.__dict__)
        cfg = client.Configuration()
        src = self.api.configuration
        for k in ("api_key", "api_key_prefix", "ssl_ca_cert", "verify_ssl", "cert_file", "key_file"):
            setattr(cfg, k, getattr(src, k))
        cfg.host = f"{self.rancher.url}/k8s/clusters/{cluster_id}"
        other.api = client.ApiClient(cfg)
        other._clients()
        return other

    def dashboard(self, path: str) -> str | None:
        """A link into the Rancher UI, when the connection goes through Rancher."""
        if not self.rancher:
            return None
        return f"{self.rancher.url}/dashboard/c/{self.rancher.cluster_id}/{path.lstrip('/')}"
