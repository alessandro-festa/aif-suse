{{- define "secops-cpu-knowledge.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "secops-cpu-knowledge.qdrantImage" -}}
{{- if .Values.qdrant.image.digest -}}
{{ .Values.qdrant.image.repository }}@{{ .Values.qdrant.image.digest }}
{{- else -}}
{{ .Values.qdrant.image.repository }}:{{ .Values.qdrant.image.tag }}
{{- end -}}
{{- end -}}

{{/*
See the note in secops-cpu-inference: the SUSE vendor injector writes both
`imagePullSecrets` and `global.imagePullSecrets` unconditionally, so both are
read here.
*/}}
{{- define "secops-cpu-knowledge.imagePullSecrets" -}}
{{- $secrets := concat (.Values.imagePullSecrets | default list) (.Values.global.imagePullSecrets | default list) -}}
{{- if $secrets }}
imagePullSecrets:
{{- range $secrets }}
  - name: {{ .name | default . }}
{{- end }}
{{- end }}
{{- end -}}
