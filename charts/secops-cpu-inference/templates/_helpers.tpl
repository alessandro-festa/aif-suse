{{/*
Image reference. Prefers the digest when set, because the floating `server`
tag is rebuilt continuously and the model gate's numbers only mean something
against a known binary.
*/}}
{{- define "secops-cpu-inference.image" -}}
{{- if .Values.image.digest -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- end -}}
{{- end -}}

{{/*
Pull secrets. Emits whichever of the two keys the SUSE vendor injector
populated — it writes `imagePullSecrets` and `global.imagePullSecrets`
unconditionally, and which one arrives is not ours to control.
*/}}
{{- define "secops-cpu-inference.imagePullSecrets" -}}
{{- $secrets := concat (.Values.imagePullSecrets | default list) (.Values.global.imagePullSecrets | default list) -}}
{{- if $secrets }}
imagePullSecrets:
{{- range $secrets }}
  - name: {{ .name | default . }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "secops-cpu-inference.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}
