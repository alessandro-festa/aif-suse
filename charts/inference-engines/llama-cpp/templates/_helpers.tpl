{{/* The model's name in the API. */}}
{{- define "llama-cpp.servedName" -}}
{{- .Values.model.servedName | default (.Values.model.hfFile | trimSuffix ".gguf") -}}
{{- end -}}

{{/* llama-server's command line. */}}
{{- define "llama-cpp.args" -}}
- --host
- 0.0.0.0
- --port
- {{ int .Values.service.port | quote }}
- --hf-repo
- {{ required "model.hfRepo is required" .Values.model.hfRepo | quote }}
- --hf-file
- {{ required "model.hfFile is required" .Values.model.hfFile | quote }}
- --alias
- {{ include "llama-cpp.servedName" . | quote }}
{{- if gt (int .Values.model.contextLength) 0 }}
- --ctx-size
- {{ .Values.model.contextLength | quote }}
{{- end }}
- --threads
- {{ include "llama-cpp.threads" . | quote }}
{{- if gt (int .Values.gpu.count) 0 }}
- --n-gpu-layers
- "999"
{{- end }}
{{- range .Values.extraArgs }}
- {{ . | quote }}
{{- end }}
{{- end -}}

{{/* Threads: the setting, else the CPU request rounded up. */}}
{{- define "llama-cpp.threads" -}}
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

{{/* The image: server on CPU, server-cuda on a GPU. */}}
{{- define "llama-cpp.image" -}}
{{- $tag := .Values.image.tag | default (ternary "server-cuda" "server" (gt (int .Values.gpu.count) 0)) -}}
{{ .Values.image.repository | default "ghcr.io/ggml-org/llama.cpp" }}:{{ $tag }}
{{- end -}}

{{- define "llama-cpp.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "llama-cpp.labels" -}}
app.kubernetes.io/name: llama-cpp
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "llama-cpp.selector" -}}
app.kubernetes.io/name: llama-cpp
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
