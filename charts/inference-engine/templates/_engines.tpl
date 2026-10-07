{{/*
The engines this chart runs: image, the port they serve OpenAI's API on, their health path, and
whether they need a GPU. One table; an engine is added here, not in the templates.
*/}}
{{- define "inference-engine.engines" -}}
llamacpp:
  image: ghcr.io/ggml-org/llama.cpp
  tag: server
  gpuTag: server-cuda
  health: /health
  needsGPU: false
sglang:
  image: lmsysorg/sglang
  tag: latest
  gpuTag: latest
  health: /health
  needsGPU: true
{{- end -}}

{{- define "inference-engine.engine" -}}
{{- $engines := include "inference-engine.engines" . | fromYaml -}}
{{- if not (hasKey $engines .Values.engine) -}}
{{- fail (printf "engine %q is not one of: %s" .Values.engine (keys $engines | sortAlpha | join ", ")) -}}
{{- end -}}
{{- index $engines .Values.engine | toYaml -}}
{{- end -}}

{{/* The model's name in the API. */}}
{{- define "inference-engine.servedName" -}}
{{- if .Values.model.servedName -}}
{{ .Values.model.servedName }}
{{- else if eq .Values.engine "llamacpp" -}}
{{ .Values.model.hfFile | trimSuffix ".gguf" }}
{{- else -}}
{{ .Values.model.id }}
{{- end -}}
{{- end -}}

{{/* The engine's command line. */}}
{{- define "inference-engine.args" -}}
{{- $port := int .Values.service.port -}}
{{- if eq .Values.engine "llamacpp" -}}
- --host
- 0.0.0.0
- --port
- {{ $port | quote }}
- --hf-repo
- {{ required "model.hfRepo is required for llamacpp" .Values.model.hfRepo | quote }}
- --hf-file
- {{ required "model.hfFile is required for llamacpp" .Values.model.hfFile | quote }}
- --alias
- {{ include "inference-engine.servedName" . | quote }}
{{- if gt (int .Values.model.contextLength) 0 }}
- --ctx-size
- {{ .Values.model.contextLength | quote }}
{{- end }}
- --threads
- {{ include "inference-engine.threads" . | quote }}
{{- if gt (int .Values.gpu.count) 0 }}
- --n-gpu-layers
- "999"
{{- end }}
{{- else if eq .Values.engine "sglang" -}}
- --host
- 0.0.0.0
- --port
- {{ $port | quote }}
- --model-path
- {{ required "model.id is required for sglang" .Values.model.id | quote }}
- --served-model-name
- {{ include "inference-engine.servedName" . | quote }}
{{- if gt (int .Values.model.contextLength) 0 }}
- --context-length
- {{ .Values.model.contextLength | quote }}
{{- end }}
{{- if gt (int .Values.gpu.count) 1 }}
- --tp-size
- {{ .Values.gpu.count | quote }}
{{- end }}
{{- end }}
{{- range .Values.extraArgs }}
- {{ . | quote }}
{{- end }}
{{- end -}}

{{/* llama.cpp threads: the setting, else the CPU request rounded up. */}}
{{- define "inference-engine.threads" -}}
{{- if gt (int .Values.threads) 0 -}}
{{ .Values.threads }}
{{- else -}}
{{- $cpu := toString (.Values.resources.requests.cpu | default "1") -}}
{{- if hasSuffix "m" $cpu -}}
{{ max 1 (div (add (int (trimSuffix "m" $cpu)) 999) 1000) }}
{{- else -}}
{{ max 1 (int (ceil (float64 $cpu))) }}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "inference-engine.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "inference-engine.labels" -}}
app.kubernetes.io/name: inference-engine
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: {{ .Values.engine }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "inference-engine.selector" -}}
app.kubernetes.io/name: inference-engine
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
