"""Training runs and inference endpoints, with the states the Deployments page shows
(ui/pkg/aif-ui/training/trainingruns.ts and runs.ts)."""

from __future__ import annotations

import html
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Iterator

from kubernetes import client

if TYPE_CHECKING:
    from .client import Client

CHART = "gpu-train-job"
PROFILE_LABEL = "trainingjobs/profile"
AIF = ("ai-factory.suse.com", "v1alpha1")

def _ready_pods(st: dict) -> int:
    """Pods done (a run that succeeded) or running, from an AIJob's status: podCounts above 16
    pods, the listed pods below."""
    phase = "Succeeded" if st.get("phase") == "Succeeded" else "Running"
    counts = st.get("podCounts")
    if counts:
        return int(counts.get(phase.lower()) or 0)
    return sum(1 for p in st.get("pods") or [] if p.get("phase") == phase)


TRAINING_STATE = {"Running": "Running", "Scheduling": "Pending", "Pending": "Pending", "Queued": "Queued",
                  "Suspended": "Suspended", "Complete": "Completed", "Failed": "Failed"}
ENDPOINT_STATE = {"Running": "Ready", "Ready": "Ready", "Pending": "Deploying", "Deploying": "Deploying",
                  "Degraded": "Degraded", "Failed": "Failed", "Error": "Failed"}
DONE = {"Completed", "Failed", "Cancelled", "Reclaimed"}
# An AIJob's phase in the same vocabulary as a Job's
AIJOB_STATE = {"Pending": "Pending", "Queued": "Queued", "Admitted": "Pending", "Running": "Running",
               "Succeeded": "Completed", "Failed": "Failed", "Cancelled": "Cancelled", "Reclaimed": "Reclaimed"}
JOB_ID_LABEL = "ai-factory.suse.com/job-id"


def age(ts: Any) -> str:
    if not ts:
        return "-"
    t = ts if isinstance(ts, datetime) else datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    s = int((datetime.now(timezone.utc) - t).total_seconds())
    for unit, n in (("d", 86400), ("h", 3600), ("m", 60)):
        if s >= n:
            return f"{s // n}{unit}"
    return f"{s}s"


def _ts(ts: Any) -> str:
    if isinstance(ts, datetime):
        return ts.strftime("%Y-%m-%d %H:%M:%S")
    return str(ts or "").replace("T", " ").replace("Z", "")


def _drop_runtime_lines(text: str) -> str:
    return "".join(l for l in text.splitlines(keepends=True) if "[HAMI-core Msg" not in l)


def gpus_of(spec: Any) -> int:
    """GPUs one pod asks for: nvidia.com/gpu limits, or the DRA claims it attaches (one GPU each)."""
    n = 0
    for c in spec.containers or []:
        lim = (c.resources.limits or {}) if c.resources else {}
        n += int(lim.get("nvidia.com/gpu", 0) or 0)
    return n or len(spec.resource_claims or [])


@dataclass
class TrainingRun:
    client: "Client" = field(repr=False)
    name: str
    namespace: str
    state: str = "Pending"
    profile: str = ""
    workers: int = 1
    ready: int = 0
    gpus: str = ""
    queue: str = ""
    image: str = ""
    created: str = ""
    id: str = ""
    # the result the run's AIJob kept when it finished (status.report), which outlives its pods
    report: dict | None = field(default=None, repr=False)
    # where AI Factory placed it: {pool, clusterId, namespace}; None until placed (or on this cluster)
    placement: dict | None = None
    # why it is still waiting for a pool, from AI Factory's queue
    waiting: str = ""
    # its utilisation in a pool that reclaims idle runs (status.activity)
    activity: dict | None = field(default=None, repr=False)

    def __repr__(self) -> str:
        where = f" pool={self.placement['pool']!r}" if self.placement else ""
        return f"<TrainingRun name={self.name!r} id={self.id!r} state={self.state!r}{where}>"

    @property
    def cluster(self) -> str:
        """The Rancher cluster the run's pods are on."""
        return (self.placement or {}).get("clusterId") or self.client.cluster_id

    def _where(self):
        """The connection and namespace of the run's pods: the pool's cluster once placed."""
        if self.placement and self.placement.get("clusterId"):
            return self.client.conn.for_cluster(self.placement["clusterId"]), self.placement.get("namespace") or self.namespace
        return self.client.conn, self.namespace

    # ---- lifecycle
    def refresh(self) -> "TrainingRun":
        fresh = self.client.runs.get(self.name, self.namespace)
        self.__dict__.update({k: v for k, v in fresh.__dict__.items() if k != "client"})
        return self

    def status(self) -> "RunStatus":
        self.refresh()
        return RunStatus(self)

    def wait(self, until: set[str] | None = None, timeout: float = 3600, interval: float = 5) -> str:
        """Block until the run reaches one of `until` (default: Completed or Failed)."""
        until = until or DONE
        end = time.time() + timeout
        while self.refresh().state not in until:
            if time.time() > end:
                raise TimeoutError(f"{self.name} still {self.state} after {timeout:.0f}s")
            time.sleep(interval)
        return self.state

    def pods(self) -> list:
        conn, ns = self._where()
        pods = conn.core.list_namespaced_pod(ns, label_selector=f"{JOB_ID_LABEL}={self.name}").items
        return pods or conn.core.list_namespaced_pod(ns, label_selector=f"job-name={self.name}").items

    def logs(self, tail: int | None = 100, rank: int = 0, follow: bool = False, print_: bool = True,
             runtime_messages: bool = False) -> str | None:
        """Logs of one rank (default rank 0). follow=True streams until the pod ends. The GPU-sharing
        runtime's own informational lines (HAMi-core "Msg") are left out unless runtime_messages;
        its errors (e.g. an allocation refused at the cap) are always kept."""
        all_pods = self.pods()
        # a Ray run's output is its driver's, in the submitter pod's log
        pod = next((p for p in all_pods if (p.metadata.labels or {}).get("ai-factory.suse.com/ray-role") == "submitter"), None)
        if pod is None:
            pods = sorted(all_pods, key=lambda p: int((p.metadata.annotations or {}).get("batch.kubernetes.io/job-completion-index", 0)))
            pod = next((p for p in pods if int((p.metadata.annotations or {}).get("batch.kubernetes.io/job-completion-index", -1)) == rank), None)
            if pod is None and rank == 0 and pods:
                pod = pods[0]
        if not pod:
            where = f" (waiting: {self.waiting})" if self.waiting else ""
            raise LookupError(f"{self.name}: no pod for rank {rank} yet (state {self.state}){where}")
        conn, ns = self._where()
        core = conn.core
        if follow:
            resp = core.read_namespaced_pod_log(pod.metadata.name, ns, follow=True, tail_lines=tail,
                                                _preload_content=False)
            for chunk in resp.stream():
                text = chunk.decode(errors="replace")
                print(text if runtime_messages else _drop_runtime_lines(text), end="", flush=True)
            return None
        # the raw body: some client releases hand back str(bytes) for this call otherwise
        # read extra so the tail still holds `tail` lines of the job's own output once runtime lines go
        resp = core.read_namespaced_pod_log(pod.metadata.name, ns, tail_lines=None if tail is None or runtime_messages is False else tail,
                                            _preload_content=False)
        text = resp.data.decode(errors="replace")
        if not runtime_messages:
            text = _drop_runtime_lines(text)
        if tail is not None:
            text = "\n".join(text.splitlines()[-tail:]) + ("\n" if text.strip() else "")
        if print_:
            print(text, end="")
            return None
        return text

    def delete(self) -> None:
        self.client.installer.uninstall(self.namespace, self.name)

    def result(self) -> dict | None:
        """What a test or benchmark run reported, as {test, status, checks, metrics, env}: the report its
        AIJob kept when it finished, else the last AIF_RESULT line of the first worker's log. None for a run
        that prints none, or whose pods are gone without an AIJob to keep it."""
        if self.report:
            r = self.report
            checks = r.get("checks") or []
            # as the UI shows it: a failed check fails the result, whatever its status says
            status = "fail" if any(not c.get("ok") for c in checks) else r.get("status", "")
            return {"test": r.get("test", ""), "status": status, "checks": checks,
                    "metrics": r.get("metrics") or {}, "env": r.get("env") or {}}
        try:
            log = self.logs(tail=400, print_=False) or ""
        except Exception:
            return None
        for line in reversed(log.splitlines()):
            at = line.find("AIF_RESULT ")
            if at >= 0:
                try:
                    r = json.loads(line[at + len("AIF_RESULT "):])
                except ValueError:
                    return None
                if any(not c.get("ok") for c in r.get("checks", [])):
                    r["status"] = "fail"
                return r
        return None

    @property
    def dashboard(self) -> str | None:
        # AI Factory's Deployments page, Training tab
        return self.client.conn.dashboard(f"suseai/workloads?tab=training&q={self.name}")

    def _repr_html_(self) -> str:
        return RunStatus(self)._repr_html_()


class RunStatus:
    """A snapshot of a run: printed as text, rendered as a card in a notebook."""

    def __init__(self, run: TrainingRun):
        self.run = run
        self.rows = [
            ("Profile", run.profile or "-"), ("Project", run.namespace),
            ("Workers", f"{run.ready} / {run.workers} {'done' if run.state == 'Completed' else 'ready'}"),
            ("GPU allocation", run.gpus or "-"), ("Queue", run.queue or "-"), ("Image", run.image),
            ("Created", run.created), ("Dashboard", run.dashboard or "-"),
        ]
        p = getattr(run, "placement", None)
        if p:
            self.rows.insert(2, ("Placed in", f"pool {p.get('pool')} (cluster {p.get('clusterId')}, namespace {p.get('namespace')})"))
        elif getattr(run, "waiting", ""):
            self.rows.insert(2, ("Waiting", run.waiting))
        a = getattr(run, "activity", None) or {}
        if a.get("sampledAt"):
            idle = f", idle since {a.get('idleSince')}" if a.get("idleSince") else ""
            self.rows.append(("Activity", f"{a.get('utilisation', 0)}% of its {'GPUs' if str(a.get('source', '')).startswith('gpu') else 'CPU request'}{idle}"))

    def __repr__(self) -> str:
        w = max(len(k) for k, _ in self.rows)
        return "\n".join([f"{self.run.name}  {self.run.state}"] + [f"  {k + ':':<{w + 1}} {v}" for k, v in self.rows])

    def _repr_html_(self) -> str:
        colour = {"Running": "#1a7f37", "Completed": "#0969da", "Failed": "#cf222e", "Queued": "#9a6700"}.get(self.run.state, "#57606a")
        # every value is escaped: an image, a profile or a name can be set by anyone in the project
        e = lambda x: html.escape(str(x), quote=True)
        link = lambda v: (f"<a href='{e(v)}' target='_blank' rel='noopener'>Open in Rancher</a>"
                          if str(v).startswith(("https://", "http://")) else e(v))
        cells = "".join(
            f"<tr><td style='color:#57606a;padding:2px 16px 2px 0;text-align:left'>{e(k)}</td><td style='padding:2px 0;text-align:left'>"
            + (link(v) if k == "Dashboard" and v != "-" else e(v)) + "</td></tr>"
            for k, v in self.rows)
        return (f"<div style='border:1px solid #d0d7de;border-radius:6px;padding:10px 14px;display:inline-block'>"
                f"<b style='font-size:1.1em'>{e(self.run.name)}</b> <span style='background:{colour};color:#fff;border-radius:10px;"
                f"padding:1px 8px;font-size:.85em'>{e(self.run.state)}</span><table style='margin-top:6px'>{cells}</table></div>")


@dataclass
class Endpoint:
    client: "Client" = field(repr=False)
    name: str
    namespace: str
    state: str = "Deploying"
    profile: str = ""
    blueprint: str = ""
    model: str = ""
    replicas: int = 1
    url: str = ""
    created: str = ""
    id: str = ""
    _summary: dict = field(default_factory=dict, repr=False)

    def __repr__(self) -> str:
        return f"<InferenceEndpoint name={self.name!r} id={self.id!r} state={self.state!r} url={self.url!r}>"

    def refresh(self) -> "Endpoint":
        fresh = self.client.endpoints.get(self.name, self.namespace)
        self.__dict__.update({k: v for k, v in fresh.__dict__.items() if k != "client"})
        return self

    def wait(self, timeout: float = 1800, interval: float = 10) -> str:
        """Block until the endpoint is Ready (an endpoint downloads its model first: minutes)."""
        end = time.time() + timeout
        while self.refresh().state != "Ready":
            if self.state == "Failed":
                raise RuntimeError(f"{self.name} failed; see `rancher-ai endpoint list` or the Deployments page")
            if time.time() > end:
                raise TimeoutError(f"{self.name} still {self.state} after {timeout:.0f}s")
            time.sleep(interval)
        return self.state

    def _router(self) -> tuple[str, int]:
        """The vLLM router Service, which needs no key."""
        rel = self._summary.get("vllm_release", "vllm-dra")
        return f"{rel}-router-service", 80

    def _gateway(self) -> tuple[str, int] | None:
        g = self._summary.get("gateway")
        return (g["release"], g["port"]) if g else None

    def chat(self, message: str | list, api_key: str | None = None, model: str | None = None, max_tokens: int = 256,
             print_: bool = True, **params: Any) -> str | None:
        """One chat completion through the Kubernetes API service proxy, so it works from a laptop too.
        With an API key (argument or RANCHER_AI_API_KEY) it goes through the LiteLLM gateway, as clients
        do; without one, straight to the vLLM router."""
        import os
        key = api_key or os.environ.get("RANCHER_AI_API_KEY")
        messages = [{"role": "user", "content": message}] if isinstance(message, str) else message
        # the blueprint names the model; when it could not be read, ask the server what it serves
        body = {"model": model or self.model or (self.models() or [""])[0], "messages": messages, "max_tokens": max_tokens, **params}
        gw = self._gateway()
        if key and gw:
            svc, port = gw
            # the API server consumes Authorization; LiteLLM also accepts its key in x-litellm-api-key
            headers = {"x-litellm-api-key": f"Bearer {key}"}
        else:
            svc, port = self._router()
            headers = {}
        r = self._post(svc, port, "/v1/chat/completions", body, headers)
        text = r["choices"][0]["message"]["content"]
        if print_:
            print(text)
            return None
        return text

    def _post(self, svc: str, port: int, path: str, body: dict | None, headers: dict) -> dict:
        """In a pod, straight to the Service; elsewhere through the API server's service proxy
        (needs services/proxy in the project, which AI Job Submitter has)."""
        if self.client.conn.in_cluster:
            import urllib.request
            req = urllib.request.Request(f"http://{svc}.{self.namespace}.svc:{port}{path}", method="POST" if body is not None else "GET",
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={"Content-Type": "application/json", **headers})
            with urllib.request.urlopen(req, timeout=300) as resp:
                return json.loads(resp.read())
        proxy = f"/api/v1/namespaces/{self.namespace}/services/http:{svc}:{port}/proxy{path}"
        r = self.client.conn.call("POST" if body is not None else "GET", proxy, body=body, headers=headers)
        return json.loads(r) if isinstance(r, str) else r

    def models(self) -> list[str]:
        svc, port = self._router()
        return [m["id"] for m in self._post(svc, port, "/v1/models", None, {}).get("data", [])]

    def delete(self) -> None:
        self.client.conn.custom.delete_namespaced_custom_object(*AIF, self.namespace, "aiworkloads", self.name)

    def _repr_html_(self) -> str:
        rows = [("Profile", self.profile), ("Project", self.namespace), ("Blueprint", self.blueprint), ("Model", self.model),
                ("Replicas", self.replicas), ("URL (in cluster)", self.url), ("Created", self.created)]
        e = lambda x: html.escape(str(x), quote=True)  # a model or blueprint name is set by whoever deployed it
        cells = "".join(f"<tr><td style='color:#57606a;padding:2px 16px 2px 0;text-align:left'>{e(k)}</td><td style='text-align:left'>{e(v)}</td></tr>"
                        for k, v in rows)
        colour = {"Ready": "#1a7f37", "Failed": "#cf222e"}.get(self.state, "#9a6700")
        return (f"<div style='border:1px solid #d0d7de;border-radius:6px;padding:10px 14px;display:inline-block'>"
                f"<b style='font-size:1.1em'>{e(self.name)}</b> <span style='background:{colour};color:#fff;border-radius:10px;"
                f"padding:1px 8px;font-size:.85em'>{e(self.state)}</span><table style='margin-top:6px'>{cells}</table></div>")


# ---- building them from cluster objects

def _job_phase(job: Any, pods: list, workload: dict | None) -> str:
    s = job.status
    completions = job.spec.completions or 1
    if job.spec.suspend and not s.active:
        return "Queued" if workload else "Suspended"
    if (s.succeeded or 0) >= completions:
        return "Complete"
    if s.failed and not s.active:
        return "Failed"
    if s.active:
        if any(p.status.phase == "Running" for p in pods):
            return "Running"
        # KAI / Run:AI hold a pod unplaced until its queue has room: a queue, not scheduling
        if pods and all(not p.spec.node_name and p.spec.scheduler_name in ("kai-scheduler", "runai-scheduler") for p in pods):
            return "Queued"
        return "Scheduling"
    return "Pending"


def training_runs(c: "Client", namespace: str | None = None) -> list[TrainingRun]:
    conn = c.conn
    sel = f"app.kubernetes.io/name={CHART}"
    if namespace:
        jobs = conn.batch.list_namespaced_job(namespace, label_selector=sel).items
        pods = conn.core.list_namespaced_pod(namespace, label_selector=sel).items
    else:
        jobs = conn.batch.list_job_for_all_namespaces(label_selector=sel).items
        pods = conn.core.list_pod_for_all_namespaces(label_selector=sel).items
    workloads = conn.list_custom("kueue.x-k8s.io", "v1beta1", "workloads", namespace)
    out = []
    for j in jobs:
        jp = [p for p in pods if (p.metadata.labels or {}).get("job-name") == j.metadata.name and p.metadata.namespace == j.metadata.namespace]
        wl = next((w for w in workloads if any(o.get("uid") == j.metadata.uid for o in w["metadata"].get("ownerReferences", []))), None)
        spec = j.spec.template.spec
        workers = j.spec.completions or 1
        per = gpus_of(spec)
        product = ""
        for sel_ in (spec.node_selector or {}).items():
            if sel_[0] == "nvidia.com/gpu.product":
                product = sel_[1].replace("-", " ")
        shared = any(rc.resource_claim_name for rc in (spec.resource_claims or []))
        share_mib = int(((j.spec.template.metadata.annotations or {}).get("gpu-memory")) or 0)  # a KAI GPU-memory share
        labels = j.metadata.labels or {}
        state = TRAINING_STATE.get(_job_phase(j, jp, wl), "Pending")
        out.append(TrainingRun(
            client=c, name=j.metadata.name, namespace=j.metadata.namespace, state=state, profile=labels.get(PROFILE_LABEL, ""),
            workers=workers, ready=(j.status.succeeded or 0) if state == "Completed" else sum(1 for p in jp if p.status.phase == "Running"),
            gpus=(f"{share_mib / 1024:.1f} GiB GPU share" if share_mib else "shared GPU" if shared else f"{workers} x {per} GPU" if per else "no GPU") + (f" ({product})" if product else ""),
            queue=labels.get("kueue.x-k8s.io/queue-name") or (j.spec.template.metadata.labels or {}).get("kai.scheduler/queue", ""),
            image=spec.containers[0].image if spec.containers else "", created=_ts(j.metadata.creation_timestamp),
            id=f"run-{(j.metadata.uid or '')[:8]}",
        ))
    # AIJobs: the record of every run created through the AIJob API, which outlives its Job. A live
    # run's row (from its Job) takes the profile from it; a run whose Job is gone comes from it.
    by_key = {(r.namespace, r.name): r for r in out}
    for a in conn.list_custom("ai-factory.suse.com", "v1alpha1", "aijobs", namespace):
        md, spec, st = a.get("metadata", {}), a.get("spec", {}), a.get("status", {}) or {}
        key = (md.get("namespace"), md.get("name"))
        if key in by_key:
            by_key[key].profile = by_key[key].profile or spec.get("profile", "")
            by_key[key].report = st.get("report")
            by_key[key].placement, by_key[key].activity = st.get("placement"), st.get("activity")
            continue
        v = spec.get("values") or {}
        img = v.get("image") or {}
        share = int((v.get("gpu") or {}).get("sharedMemoryMiB") or 0)
        count = int((st.get("resources") or {}).get("gpuCount") or 0)
        out.append(TrainingRun(
            client=c, name=key[1], namespace=key[0], state=AIJOB_STATE.get(st.get("phase", ""), "Pending"), profile=spec.get("profile", ""),
            workers=int((v.get("job") or {}).get("nodes") or 1),
            # from the run's recorded pods (its pods may be on another cluster, or gone)
            ready=_ready_pods(st),
            gpus=f"{share / 1024:.1f} GiB GPU share" if share else f"{count} GPU" if count else "-",
            queue=((st.get("queue") or {}).get("name") or (v.get("scheduler") or {}).get("queue", "")),
            image=f"{img.get('repository', '')}:{img.get('tag', '')}" if img.get("repository") else "",
            created=_ts(md.get("creationTimestamp")), id=f"run-{(md.get('uid') or '')[:8]}",
            report=st.get("report"), placement=st.get("placement"),
            waiting=st.get("placementMessage", "") if not st.get("placement") else "", activity=st.get("activity"),
        ))
        by_key[key] = out[-1]
    # Releases whose Job is gone (ttlSecondsAfterFinished): finished, kept so they can be seen and removed.
    have = set(by_key)
    for a in conn.list_custom("catalog.cattle.io", "v1", "apps", namespace):
        chart = (a.get("spec", {}).get("chart") or {}).get("metadata") or {}
        rel = a.get("spec", {}).get("name") or a["metadata"]["name"]
        ns = a.get("spec", {}).get("namespace") or a["metadata"]["namespace"]
        if chart.get("name") != CHART or (ns, rel) in have:
            continue
        v = a.get("spec", {}).get("values") or {}
        img = v.get("image") or {}
        out.append(TrainingRun(
            client=c, name=rel, namespace=ns, state="Completed",
            profile=(chart.get("annotations") or {}).get(PROFILE_LABEL) or v.get("profile", ""),
            workers=int((v.get("job") or {}).get("nodes") or 1), gpus="-", queue=(v.get("scheduler") or {}).get("queue", ""),
            image=f"{img.get('repository', '')}:{img.get('tag', '')}" if img else "",
            created=_ts(a["metadata"].get("creationTimestamp")), id="",
        ))
    return sorted(out, key=lambda r: r.created, reverse=True)


def endpoints(c: "Client", namespace: str | None = None) -> list[Endpoint]:
    if not c.conn.has_group(AIF[0]):
        return []  # SUSE AI Factory not installed: no endpoints, not an error
    items = c.conn.list_custom(*AIF, "aiworkloads", namespace, required=True)
    blueprints = c.blueprints()
    out = []
    for w in items:
        md, spec, st = w["metadata"], w.get("spec", {}), w.get("status", {}) or {}
        ref = (spec.get("source") or {}).get("blueprint") or {}
        bp = blueprints.get((ref.get("name"), ref.get("version")), {})
        phase = st.get("phase") or next((s.get("phase") for s in st.get("clusterStatuses", []) or []), None) or "Pending"
        ready = any(x.get("type") == "Ready" and x.get("status") == "True" for x in st.get("conditions", []) or [])
        state = "Ready" if ready and phase in ("Running", "Ready") else ENDPOINT_STATE.get(phase, "Deploying")
        ns = spec.get("targetNamespace") or md["namespace"]
        gw = bp.get("gateway")
        url = f"http://{gw['release']}.{ns}.svc:{gw['port']}/v1" if gw else (
            f"http://{bp.get('vllm_release', 'vllm-dra')}-router-service.{ns}.svc/v1" if bp else "")
        out.append(Endpoint(
            client=c, name=md["name"], namespace=md["namespace"], state=state,
            profile=(md.get("labels") or {}).get(PROFILE_LABEL, ""), blueprint=f"{ref.get('name', '?')} {ref.get('version', '')}".strip(),
            model=bp.get("model", ""), replicas=bp.get("replicas", 1), url=url, created=_ts(md.get("creationTimestamp")),
            id=f"ep-{md.get('uid', '')[:8]}", _summary=bp,
        ))
    return sorted(out, key=lambda e: e.created, reverse=True)


def summarize_blueprint(bp: dict) -> dict:
    """The parts of a Blueprint a listing needs (cf. summarizeBlueprint in inference.ts)."""
    comps = bp.get("spec", {}).get("components", []) or []
    vllm = next((x for x in comps if ((x.get("values") or {}).get("servingEngineSpec") or {}).get("modelSpec")), {})
    m = (vllm.get("values", {}).get("servingEngineSpec", {}).get("modelSpec") or [{}])[0]
    gw = next((x for x in comps if x.get("chartName") == "litellm"), None)
    return {
        "display_name": bp.get("spec", {}).get("displayName", ""),
        "model": m.get("modelURL", ""), "replicas": int(m.get("replicaCount") or 1), "gpus": int(m.get("requestGPU") or 0),
        "vllm_release": vllm.get("releaseName") or vllm.get("chartName") or "vllm-dra",
        "shared": bool(vllm.get("values", {}).get("servingEngineSpec", {}).get("dra", {}).get("sharedClaim")),
        "gateway": {"release": gw.get("releaseName") or gw["chartName"], "port": int((gw.get("values") or {}).get("service", {}).get("port") or 4000)} if gw else None,
    }
