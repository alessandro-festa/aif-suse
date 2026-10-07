# Inference Engines Apps

Model servers AI Factory does not get from the SUSE Application Collection (vLLM and Ollama come
from there), one chart per engine:

| Chart | Server | Hardware |
|---|---|---|
| `llama-cpp` | llama.cpp `llama-server`, a GGUF model | CPU, or NVIDIA GPU |
| `sglang` | SGLang, a Hugging Face model | NVIDIA GPU |

AI Factory serves them as Apps from a git custom repository, "Inference Engines Apps" (ClusterRepo
`aif-engines`), which points at the fork's `inference-engines` branch. That branch holds only this
directory, so Rancher indexes these charts and nothing else from the repository. Publish it after a
change here:

```
git subtree split --prefix=charts/inference-engines -b inference-engines
git push origin inference-engines
```
