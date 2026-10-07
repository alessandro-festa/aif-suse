# Ray Serve

Ray Serve on a KubeRay RayService, serving a Hugging Face model with OpenAI's API
(`/v1/models`, `/v1/chat/completions`), for SUSE AI Factory. Needs the KubeRay operator on the
cluster (Compute Pools → Cluster add-ons → KubeRay).

- `mode: app` (default): the chart's own Serve app (`files/serve_app.py`) runs the model through
  Hugging Face transformers, on CPU or one GPU per replica. Ray installs torch and transformers on
  start. For small models and demos; no streaming.
- `mode: llm`: Ray Serve LLM (vLLM) on NVIDIA GPUs, Ray's `ray-llm` image, `gpu.count` GPUs per
  replica (tensor parallel).

`replicas` Serve replicas run on as many Ray worker pods, beside a head with no replica. The count
is fixed (no autoscaling): AI Factory places a workload by what it asks for. A stable Service named
after the release fronts Serve's HTTP proxy.
