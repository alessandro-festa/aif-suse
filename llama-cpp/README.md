# llama.cpp

llama.cpp's OpenAI-compatible llama-server: a GGUF model on CPU or NVIDIA GPU, for SUSE AI Factory.

Runs a GGUF model on CPU (`gpu.count: 0`, the default) or, with `gpu.count` of 1 or more, offloads every
layer to NVIDIA GPUs using the `server-cuda` image. The default is Qwen2.5 0.5B Instruct (Q4_K_M), small
enough for any node.

The server listens on the Service's port 8000 (`/v1/models`, `/v1/chat/completions`), named after the
release. Downloaded models are kept in a PVC (`cache`), which survives an uninstall.

AI Factory serves this chart from the "Inference Engines Apps" git custom repository (Settings →
Custom repositories), published from `charts/inference-engines/` of the aif-suse fork; the engine
Blueprints reference it from there.

The icon is llama.cpp's own (github.com/ggml-org/llama.cpp, media/llama1-icon.png, MIT).
