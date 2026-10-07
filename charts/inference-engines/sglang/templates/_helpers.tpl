{{/* The model's name in the API. */}}
{{- define "sglang.servedName" -}}
{{- .Values.model.servedName | default .Values.model.id -}}
{{- end -}}

{{/* SGLang's command line. */}}
{{- define "sglang.args" -}}
- --host
- 0.0.0.0
- --port
- {{ int .Values.service.port | quote }}
- --model-path
- {{ required "model.id is required" .Values.model.id | quote }}
- --served-model-name
- {{ include "sglang.servedName" . | quote }}
{{- if gt (int .Values.model.contextLength) 0 }}
- --context-length
- {{ .Values.model.contextLength | quote }}
{{- end }}
{{- if gt (int .Values.gpu.count) 1 }}
- --tp-size
- {{ .Values.gpu.count | quote }}
{{- end }}
{{- range .Values.extraArgs }}
- {{ . | quote }}
{{- end }}
{{- end -}}

{{- define "sglang.image" -}}
{{ .Values.image.repository | default "lmsysorg/sglang" }}:{{ .Values.image.tag | default "latest" }}
{{- end -}}

{{- define "sglang.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "sglang.labels" -}}
app.kubernetes.io/name: sglang
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "sglang.selector" -}}
app.kubernetes.io/name: sglang
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
