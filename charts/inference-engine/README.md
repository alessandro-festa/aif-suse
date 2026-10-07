# inference-engine

One chart for the OpenAI-compatible model servers AI Factory does not get from the SUSE Application
Collection (vLLM and Ollama come from there):

| `engine` | Server | Model | Hardware |
|---|---|---|---|
| `llamacpp` | llama.cpp `llama-server` | a GGUF file in a Hugging Face repo (`model.hfRepo`, `model.hfFile`) | CPU, or NVIDIA GPU with `gpu.count` > 0 |
| `sglang` | SGLang | a Hugging Face model ID (`model.id`) | NVIDIA GPU, `gpu.count` >= 1 |

Images, commands and health paths per engine are in `templates/_engines.tpl`. The defaults are small
enough to run anywhere: Qwen2.5 0.5B (Q4_K_M) on CPU for llama.cpp, Qwen2.5 1.5B for SGLang.

The server listens on the Service's port 8000 (`/v1/models`, `/v1/chat/completions`). Downloaded
models are kept in a PVC (`cache`), which survives an uninstall.

AI Factory reaches the chart through a git custom repo (Settings → Custom repositories) pointing at
this repository; the engine Blueprints reference it from there.

```
helm install llm charts/inference-engine
helm install llm charts/inference-engine --set engine=sglang --set gpu.count=1
```
