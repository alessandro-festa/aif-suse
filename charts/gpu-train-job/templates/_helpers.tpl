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
{{- else if eq .Values.job.kind "trainjob" -}}
{{- /* node 0 of the JobSet's "node" Job, through the JobSet's headless Service */ -}}
{{ include "gpu-train-job.fullname" . }}-node-0-0.{{ include "gpu-train-job.fullname" . }}.{{ .Release.Namespace }}.svc.cluster.local:{{ .Values.rendezvous.port }}
{{- else -}}
{{ include "gpu-train-job.fullname" . }}-0.{{ include "gpu-train-job.fullname" . }}.{{ .Release.Namespace }}.svc.cluster.local:{{ .Values.rendezvous.port }}
{{- end -}}
{{- end -}}

{{/*
The scheduler backend scheduler.type names, from schedulers.yaml (the table AI Factory's operator
and UI read too), as YAML: include it and fromYaml the result.
*/}}
{{- define "gpu-train-job.backend" -}}
{{- $backends := (.Files.Get "schedulers.yaml" | fromYaml).backends -}}
{{- if not (hasKey $backends .Values.scheduler.type) -}}
{{- fail (printf "scheduler.type %q is not one of: %s" .Values.scheduler.type (keys $backends | sortAlpha | join ", ")) -}}
{{- end -}}
{{- index $backends .Values.scheduler.type | toYaml -}}
{{- end -}}

{{/*
The queue label on the workload itself (Job / PyTorchJob), for backends whose queue target is the
workload (schedulers.yaml): Kueue.
*/}}
{{- define "gpu-train-job.queueWorkloadLabels" -}}
{{- $queue := (include "gpu-train-job.backend" . | fromYaml).queue -}}
{{- if and $queue (eq $queue.target "workload") -}}
{{ $queue.label }}: {{ include "gpu-train-job.queueName" . | quote }}
{{- end -}}
{{- end -}}

{{/*
The queue a run is bound to: scheduler.queue, else the backend's default queue (schedulers.yaml),
else an error.
*/}}
{{- define "gpu-train-job.queueName" -}}
{{- $queue := (include "gpu-train-job.backend" . | fromYaml).queue -}}
{{- .Values.scheduler.queue | default ($queue.default | default "") | required (printf "scheduler.queue is required when scheduler.type=%s" .Values.scheduler.type) -}}
{{- end -}}

{{/*
The sharing layer gpu.sharing names (schedulers.yaml sharingLayers), as YAML; empty for none.
*/}}
{{- define "gpu-train-job.sharingLayer" -}}
{{- with .Values.gpu.sharing -}}
{{- $layers := ($.Files.Get "schedulers.yaml" | fromYaml).sharingLayers -}}
{{- if not (hasKey $layers .) -}}
{{- fail (printf "gpu.sharing %q is not one of: %s" . (keys $layers | sortAlpha | join ", ")) -}}
{{- end -}}
{{- index $layers . | toYaml -}}
{{- end -}}
{{- end -}}

{{/*
job.command as one shell command line, every word single-quoted (a quote inside is closed, escaped
and reopened), so any command survives being run by `sh`: the RayJob's driver script.
*/}}
{{- define "gpu-train-job.shellCommand" -}}
{{- $words := list -}}
{{- range .Values.job.command -}}
{{- $words = append $words (printf "'%s'" (replace "'" "'\\''" (toString .))) -}}
{{- end -}}
{{- range .Values.job.args -}}
{{- $words = append $words (printf "'%s'" (replace "'" "'\\''" (toString .))) -}}
{{- end -}}
{{- join " " $words -}}
{{- end -}}

{{/*
"true" when the backend admits a run by unsuspending it, so the workload is created suspended.
*/}}
{{- define "gpu-train-job.suspended" -}}
{{- if eq (include "gpu-train-job.backend" . | fromYaml).admission "suspend" }}true{{ end }}
{{- end -}}

{{/*
Pod affinity, both kinds: required node affinity for the compute pool's nodes (poolSelector, a label
selector as in ComputePool.spec.nodeSelector), and a soft spread of a multi-node run's pods over
nodes. Empty when neither applies.
*/}}
{{- define "gpu-train-job.affinity" -}}
{{- $terms := list -}}
{{- with .Values.poolSelector -}}
{{- range $k, $v := (.matchLabels | default dict) -}}
{{- $terms = append $terms (dict "key" $k "operator" "In" "values" (list $v)) -}}
{{- end -}}
{{- range (.matchExpressions | default list) -}}
{{- $terms = append $terms . -}}
{{- end -}}
{{- end -}}
{{- if $terms }}
nodeAffinity:
  requiredDuringSchedulingIgnoredDuringExecution:
    nodeSelectorTerms:
      - matchExpressions:
          {{- toYaml $terms | nindent 10 }}
{{- end }}
{{- if gt (int .Values.job.nodes) 1 }}
podAntiAffinity:
  preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 100
      podAffinityTerm:
        topologyKey: kubernetes.io/hostname
        labelSelector:
          matchLabels:
            {{- include "gpu-train-job.selectorLabels" . | nindent 12 }}
{{- end }}
{{- end -}}

{{/*
"true" when the cluster serves the DRA API (resource.k8s.io/v1, Kubernetes 1.34+). A `lookup` of an
API the server does not serve is a hard template error, not an empty result, so every DRA lookup
is guarded by this.
*/}}
{{- define "gpu-train-job.hasDRA" -}}
{{- if .Capabilities.APIVersions.Has "resource.k8s.io/v1" }}true{{ end -}}
{{- end -}}

{{/*
Resolve gpu.mode. "auto" picks device-plugin if any node advertises gpu.resourceName,
else dra if the DeviceClass exists. Offline (helm template) auto resolves to device-plugin.
*/}}
{{- define "gpu-train-job.gpuMode" -}}
{{- $backend := include "gpu-train-job.backend" . | fromYaml -}}
{{- if and (eq (int .Values.job.gpusPerNode) 0) (eq (int .Values.gpu.sharedMemoryMiB) 0) -}}
{{- /* A CPU-only run (a CPU compute pool): no GPU request, no claim, no GPU checks. */ -}}
none
{{- else if and (eq .Values.gpu.sharing "hami") (gt (int .Values.gpu.sharedMemoryMiB) 0) -}}
{{- /* A GPU-memory share under HAMi: one GPU slot plus nvidia.com/gpumem, placed by hami-scheduler. */ -}}
hami
{{- else if and (has "kai-fraction" $backend.sharing) (gt (int .Values.gpu.sharedMemoryMiB) 0) (not .Values.gpu.sharedClaim) -}}
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
  {{- if and (not $dp) (include "gpu-train-job.hasDRA" .) (lookup "resource.k8s.io/v1" "DeviceClass" "" .Values.gpu.deviceClassName) }}{{ $mode = "dra" }}{{ end -}}
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
