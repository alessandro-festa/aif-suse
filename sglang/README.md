# SGLang

SGLang's OpenAI-compatible server: a Hugging Face model on NVIDIA GPUs, for SUSE AI Factory.

Needs at least one NVIDIA GPU (`gpu.count`); more than one splits the model across them (tensor
parallel). The default is Qwen2.5 1.5B Instruct.

The server listens on the Service's port 8000 (`/v1/models`, `/v1/chat/completions`), named after the
release. Downloaded models are kept in a PVC (`cache`), which survives an uninstall.

AI Factory serves this chart from the "Inference Engines Apps" git custom repository (Settings →
Custom repositories), published from `charts/inference-engines/` of the aif-suse fork; the engine
Blueprints reference it from there.

The icon is SGLang's own (github.com/sgl-project/sglang, assets/logo_square.png, Apache-2.0). It is icon.png here; Rancher serves it from the git repository and the AI Factory Apps page inlines it.
