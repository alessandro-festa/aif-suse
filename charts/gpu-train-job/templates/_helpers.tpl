{{- define "gpu-train-job.fullname" -}}
{{- .Release.Name | trunc 52 | trimSuffix "-" -}}
{{- end -}}

{{- define "gpu-train-job.selectorLabels" -}}
app.kubernetes.io/name: gpu-train-job
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "gpu-train-job.labels" -}}
{{ include "gpu-train-job.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- with .Values.profile }}
trainingjobs/profile: {{ . | quote }}
{{- end }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
Labels for pods and the volumes and claims made for them: the selector labels plus commonLabels,
so a job-id label set by the AI Factory operator reaches everything that runs (logs and metrics are
keyed by it). Not used in label selectors.
*/}}
{{- define "gpu-train-job.podLabels" -}}
{{ include "gpu-train-job.selectorLabels" . }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "gpu-train-job.rdzvEndpoint" -}}
{{- if eq .Values.rendezvous.backend "etcd-v2" -}}
{{ required "rendezvous.endpoint is required for etcd-v2" .Values.rendezvous.endpoint }}
{{- else -}}
{{ include "gpu-train-job.fullname" . }}-0.{{ include "gpu-train-job.fullname" . }}.{{ .Release.Namespace }}.svc.cluster.local:{{ .Values.rendezvous.port }}
{{- end -}}
{{- end -}}

{{/*
Resolve gpu.mode. "auto" picks device-plugin if any node advertises gpu.resourceName,
else dra if the DeviceClass exists. Offline (helm template) auto resolves to device-plugin.
*/}}
{{- define "gpu-train-job.gpuMode" -}}
{{- if and (eq .Values.scheduler.type "kai") (gt (int .Values.gpu.sharedMemoryMiB) 0) (not .Values.gpu.sharedClaim) -}}
{{- /* A GPU-memory share under KAI: KAI places the pod on a GPU by its gpu-memory annotation and
       HAMi-core / NvFractions caps it. No whole nvidia.com/gpu and no DRA claim: KAI rejects a pod
       that mixes a fraction with a whole-GPU request. */ -}}
kai-fraction
{{- else if ne .Values.gpu.mode "auto" -}}
{{ .Values.gpu.mode }}
{{- else -}}
{{- $mode := "device-plugin" -}}
{{- $nodes := lookup "v1" "Node" "" "" -}}
{{- if $nodes.items -}}
  {{- $dp := false -}}
  {{- range $nodes.items -}}
    {{- $cap := index .status.allocatable $.Values.gpu.resourceName | default "0" -}}
    {{- if ne (toString $cap) "0" }}{{ $dp = true }}{{ end -}}
  {{- end -}}
  {{- if and (not $dp) (lookup "resource.k8s.io/v1" "DeviceClass" "" .Values.gpu.deviceClassName) }}{{ $mode = "dra" }}{{ end -}}
{{- end -}}
{{ $mode }}
{{- end -}}
{{- end -}}

{{/*
The checkpoint claim the pods mount: an existing PVC (storage.checkpointPVC), or the one this release
creates (storage.checkpointCreate). "" = no checkpoint volume.
*/}}
{{- define "gpu-train-job.checkpointClaim" -}}
{{- if .Values.storage.checkpointPVC -}}
{{ .Values.storage.checkpointPVC }}
{{- else if .Values.storage.checkpointCreate.enabled -}}
{{ include "gpu-train-job.fullname" . }}-checkpoints
{{- end -}}
{{- end -}}

{{/* Kubernetes quantity -> millicores (int). Handles "500m", "2", "0.5". */}}
{{- define "gpu-train-job.cpuMilli" -}}
{{- $q := toString . -}}
{{- if or (eq $q "") (eq $q "<nil>") -}}0
{{- else if hasSuffix "m" $q -}}{{ trimSuffix "m" $q | float64 | int }}
{{- else -}}{{ mulf ($q | float64) 1000 | int }}
{{- end -}}
{{- end -}}

{{/* Kubernetes quantity -> MiB (int). Handles Ki/Mi/Gi/Ti, k/M/G, and raw bytes. */}}
{{- define "gpu-train-job.memMi" -}}
{{- $q := toString . -}}
{{- if or (eq $q "") (eq $q "<nil>") -}}0
{{- else if hasSuffix "Ki" $q -}}{{ divf (trimSuffix "Ki" $q | float64) 1024 | int }}
{{- else if hasSuffix "Mi" $q -}}{{ trimSuffix "Mi" $q | float64 | int }}
{{- else if hasSuffix "Gi" $q -}}{{ mulf (trimSuffix "Gi" $q | float64) 1024 | int }}
{{- else if hasSuffix "Ti" $q -}}{{ mulf (trimSuffix "Ti" $q | float64) 1048576 | int }}
{{- else if hasSuffix "k" $q -}}{{ divf (trimSuffix "k" $q | float64) 1048.576 | int }}
{{- else if hasSuffix "M" $q -}}{{ divf (mulf (trimSuffix "M" $q | float64) 1000000) 1048576 | int }}
{{- else if hasSuffix "G" $q -}}{{ divf (mulf (trimSuffix "G" $q | float64) 1000000000) 1048576 | int }}
{{- else -}}{{ divf ($q | float64) 1048576 | int }}
{{- end -}}
{{- end -}}
