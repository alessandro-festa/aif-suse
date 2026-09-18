{{- define "secops-cpu-agents.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "secops-cpu-agents.orchestratorImage" -}}
{{- if .Values.orchestrator.image.digest -}}
{{ .Values.orchestrator.image.repository }}@{{ .Values.orchestrator.image.digest }}
{{- else -}}
{{ .Values.orchestrator.image.repository }}:{{ .Values.orchestrator.image.tag }}
{{- end -}}
{{- end -}}

{{/*
See the note in secops-cpu-inference: the SUSE vendor injector writes both
`imagePullSecrets` and `global.imagePullSecrets` unconditionally, so both are
read here.
*/}}
{{- define "secops-cpu-agents.imagePullSecrets" -}}
{{- $secrets := concat (.Values.imagePullSecrets | default list) (.Values.global.imagePullSecrets | default list) -}}
{{- if $secrets }}
imagePullSecrets:
{{- range $secrets }}
  - name: {{ .name | default . }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
Where the agents reach SUSE Security — the TLS shim when it is enabled, the
controller directly when it is not. Three helpers rather than one string,
because the policies want the host and port as separate fields and the agent
briefings want a URL.

Every consumer goes through these, so `suseSecurity.tlsShim.enabled: false` is
genuinely the only change needed on a cluster whose NeuVector presents a
certificate the sandbox image can verify. See the long note in values.yaml.
*/}}
{{- define "secops-cpu-agents.nvHost" -}}
{{- if .Values.suseSecurity.tlsShim.enabled -}}
{{ .Values.suseSecurity.tlsShim.name }}.{{ .Release.Namespace }}.svc.cluster.local
{{- else -}}
{{ .Values.suseSecurity.host }}
{{- end -}}
{{- end -}}

{{- define "secops-cpu-agents.nvPort" -}}
{{- if .Values.suseSecurity.tlsShim.enabled -}}
{{ .Values.suseSecurity.tlsShim.port }}
{{- else -}}
{{ .Values.suseSecurity.port }}
{{- end -}}
{{- end -}}

{{- define "secops-cpu-agents.nvScheme" -}}
{{- if .Values.suseSecurity.tlsShim.enabled -}}http{{- else -}}https{{- end -}}
{{- end -}}

{{/*
Where the deploy agent reaches Rancher — the same three-helper shape as the
SUSE Security ones above, and for the same reason: Rancher's server certificate
is issued by its own `dynamiclistener` CA, which nothing in the sandbox image
can verify, so the shim does the unverified hop.

ONE THING DIFFERS FROM THE NEUVECTOR SHIM, and it is why `rancher.serverHost`
exists as a separate value. NeuVector is a Service, reached directly. Rancher is
behind an ingress that routes strictly on the Host header — measured 2026-09-17:
the same request with `Host: secops-cpu-rancher-shim:8443` gets a 404 from
nginx, not a Rancher response. `rancherHost` below is the connection target;
`serverHost` is the vhost. They are different strings and both are load-bearing.

The vhost is applied by the SHIM, from `REWRITE_HOST`, and not by the `rancher`
helper — which is where it was until the first end-to-end deploy failed with
that same nginx 404. OpenShell's forward proxy rebuilds the upstream request
from the absolute-form URI and discards a client-supplied Host, so the shim is
the last hop that can still set it.
*/}}
{{- define "secops-cpu-agents.rancherHost" -}}
{{- if .Values.rancher.tlsShim.enabled -}}
{{ .Values.rancher.tlsShim.name }}.{{ .Release.Namespace }}.svc.cluster.local
{{- else -}}
{{ .Values.rancher.serverHost }}
{{- end -}}
{{- end -}}

{{- define "secops-cpu-agents.rancherPort" -}}
{{- if .Values.rancher.tlsShim.enabled -}}
{{ .Values.rancher.tlsShim.port }}
{{- else -}}
{{ .Values.rancher.serverPort }}
{{- end -}}
{{- end -}}

{{- define "secops-cpu-agents.rancherScheme" -}}
{{- if .Values.rancher.tlsShim.enabled -}}http{{- else -}}https{{- end -}}
{{- end -}}
