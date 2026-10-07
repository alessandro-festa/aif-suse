{{/*
Pod-level pieces shared by the two workload kinds (batch/v1 Job and kubeflow.org/v1 PyTorchJob).
Everything here renders list/map entries at column 0; callers nindent to their own depth.

Only the parts that genuinely differ between the kinds stay in the workload templates:
  Job         — Indexed completions, subdomain + headless Service, rank from JOB_COMPLETION_INDEX
  PyTorchJob  — replica specs, rank/rendezvous injected by the training-operator
*/}}

{{- define "gpu-train-job.volumes" -}}
{{- if and .Values.storage.scratchSize (eq .Values.storage.scratchMedium "node") }}
- name: scratch
  emptyDir:
    sizeLimit: {{ .Values.storage.scratchSize }}
{{- else }}
{{- with .Values.storage.scratchSize }}
- name: scratch
  ephemeral:
    volumeClaimTemplate:
      metadata:
        labels:
          {{- include "gpu-train-job.podLabels" $ | nindent 10 }}
      spec:
        accessModes: [ReadWriteOnce]
        {{- with $.Values.storage.scratchStorageClass }}
        storageClassName: {{ . }}
        {{- end }}
        resources:
          requests:
            storage: {{ . }}
{{- end }}
{{- end }}
{{- with .Values.storage.configMap }}
- name: config
  configMap:
    name: {{ . }}
{{- end }}
- name: dshm
  emptyDir:
    medium: Memory
    sizeLimit: {{ .Values.storage.shmSizeLimit }}
{{- with .Values.storage.datasetPVC }}
- name: dataset
  persistentVolumeClaim:
    claimName: {{ . }}
    readOnly: true
{{- end }}
{{- with (include "gpu-train-job.checkpointClaim" . | trim) }}
- name: checkpoints
  persistentVolumeClaim:
    claimName: {{ . }}
{{- end }}
{{- range $i, $s := .Values.storage.secretMounts }}
- name: secret-{{ $i }}
  secret:
    secretName: {{ required "storage.secretMounts[].name is required" $s.name }}
{{- end }}
{{- if .Values.network.rdma.enabled }}
- name: rdma-devices
  hostPath:
    path: {{ .Values.network.rdma.devicePath }}
{{- with .Values.network.rdma.hostLibPath }}
- name: rdma-libs
  hostPath:
    path: {{ . }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "gpu-train-job.volumeMounts" -}}
{{- if .Values.storage.scratchSize }}
- name: scratch
  mountPath: {{ .Values.storage.scratchMountPath }}
{{- end }}
{{- if .Values.storage.configMap }}
- name: config
  mountPath: {{ .Values.storage.configMountPath }}
  readOnly: true
{{- end }}
- name: dshm
  mountPath: /dev/shm
{{- if .Values.storage.datasetPVC }}
- name: dataset
  mountPath: {{ .Values.storage.datasetMountPath }}
  readOnly: true
{{- end }}
{{- if (include "gpu-train-job.checkpointClaim" . | trim) }}
- name: checkpoints
  mountPath: {{ .Values.storage.checkpointMountPath }}
{{- end }}
{{- range $i, $s := .Values.storage.secretMounts }}
- name: secret-{{ $i }}
  mountPath: {{ required "storage.secretMounts[].mountPath is required" $s.mountPath }}
  readOnly: true
{{- end }}
{{- if .Values.network.rdma.enabled }}
- name: rdma-devices
  mountPath: {{ .Values.network.rdma.devicePath }}
{{- if .Values.network.rdma.hostLibPath }}
- name: rdma-libs
  mountPath: {{ .Values.network.rdma.hostLibMountPath }}
  readOnly: true
{{- end }}
{{- end }}
{{- end -}}

{{/*
Pod network. hostNetwork needs the matching dnsPolicy or the pod keeps the node's resolver and
cannot resolve cluster Services -- which for a PyTorchJob means MASTER_ADDR, so the run never
rendezvouses.
*/}}
{{- define "gpu-train-job.podNetwork" -}}
{{- if .Values.network.hostNetwork }}
hostNetwork: true
dnsPolicy: ClusterFirstWithHostNet
{{- end }}
{{- end -}}

{{/*
Scheduling knobs common to both kinds. nodeSelector/tolerations/priorityClassName are plain
pass-through; schedulerName is what hands the pod to KAI (and is what KAI's PodGrouper keys on,
together with the kai.scheduler/queue label, to gang-schedule the whole group).
*/}}
{{- define "gpu-train-job.podScheduling" -}}
{{- with (include "gpu-train-job.backend" . | fromYaml).schedulerName }}
schedulerName: {{ . }}
{{- else }}
{{- if eq (include "gpu-train-job.gpuMode" .) "hami" }}
schedulerName: {{ (include "gpu-train-job.sharingLayer" . | fromYaml).schedulerName }}
{{- end }}
{{- end }}
{{- with .Values.scheduler.priorityClassName }}
priorityClassName: {{ . | quote }}
{{- end }}
{{- /* gpu.productName under the device plugin: GPU Feature Discovery's product label. Under DRA the
       claim's selector does it instead (resourceclaimtemplate.yaml). */}}
{{- $ns := deepCopy (.Values.nodeSelector | default dict) }}
{{- if and .Values.gpu.productName (has (include "gpu-train-job.gpuMode" .) (list "device-plugin" "kai-fraction" "hami")) }}
{{- $_ := set $ns "nvidia.com/gpu.product" (.Values.gpu.productName | replace " " "-") }}
{{- end }}
{{- with $ns }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/*
Queue label applied to every pod template, for backends whose queue target is the pod
(schedulers.yaml). They do not agree on the key: KAI reads kai.scheduler/queue, Run:AI reads `project`.
Run:AI's webhook also stamps run.ai/* labels and the pod-group annotation onto the pod; those are
its to write, not ours.
*/}}
{{/*
Pod annotations: the Multus network, and KAI's gpu-memory request (MiB) for a GPU-memory share.
*/}}
{{- define "gpu-train-job.podAnnotations" -}}
{{- if .Values.network.multusNetwork }}
k8s.v1.cni.cncf.io/networks: {{ .Values.network.multusNetwork | quote }}
{{- end }}
{{- if eq (include "gpu-train-job.gpuMode" .) "kai-fraction" }}
gpu-memory: {{ int .Values.gpu.sharedMemoryMiB | toString | quote }}
{{- end }}
{{- $backend := include "gpu-train-job.backend" . | fromYaml }}
{{- if and $backend.queue (eq $backend.queue.target "pod") (eq ($backend.queue.as | default "label") "annotation") }}
{{ $backend.queue.label }}: {{ include "gpu-train-job.queueName" . | quote }}
{{- end }}
{{- if eq $backend.gang "podgroup" }}
scheduling.k8s.io/group-name: {{ include "gpu-train-job.fullname" . | quote }}
{{- end }}
{{- end -}}

{{- define "gpu-train-job.queuePodLabels" -}}
{{- $queue := (include "gpu-train-job.backend" . | fromYaml).queue }}
{{- if and $queue (eq $queue.target "pod") (ne ($queue.as | default "label") "annotation") }}
{{ $queue.label }}: {{ include "gpu-train-job.queueName" . | quote }}
{{- end }}
{{- end -}}

{{- define "gpu-train-job.resourceBlock" -}}
{{- $hami := dict -}}
{{- if eq (include "gpu-train-job.gpuMode" .) "hami" -}}
{{- $r := (include "gpu-train-job.sharingLayer" . | fromYaml).resources -}}
{{- $_ := set $hami $r.gpu "1" -}}
{{- $_ := set $hami $r.memory (int .Values.gpu.sharedMemoryMiB | toString) -}}
{{- if gt (int .Values.gpu.sharedCoresPercent) 0 }}{{ $_ := set $hami $r.cores (int .Values.gpu.sharedCoresPercent | toString) }}{{ end -}}
{{- end }}
requests:
  {{- toYaml .Values.resources.requests | nindent 2 }}
  {{- if eq (include "gpu-train-job.gpuMode" .) "device-plugin" }}
  {{ .Values.gpu.resourceName }}: {{ .Values.job.gpusPerNode | quote }}
  {{- end }}
  {{- range $k, $v := $hami }}
  {{ $k }}: {{ $v | quote }}
  {{- end }}
limits:
  {{- toYaml .Values.resources.limits | nindent 2 }}
  {{- if eq (include "gpu-train-job.gpuMode" .) "device-plugin" }}
  {{ .Values.gpu.resourceName }}: {{ .Values.job.gpusPerNode | quote }}
  {{- end }}
  {{- range $k, $v := $hami }}
  {{ $k }}: {{ $v | quote }}
  {{- end }}
{{- if eq (include "gpu-train-job.gpuMode" .) "dra" }}
claims:
  - name: gpu
  {{- if .Values.computeDomain.enabled }}
  - name: compute-domain
  {{- end }}
{{- end }}
{{- end -}}

{{/*
Environment shared by both kinds. Rank/rendezvous variables are NOT here: the Job path derives them
from JOB_COMPLETION_INDEX and the headless Service, while the training-operator injects
MASTER_ADDR/MASTER_PORT/WORLD_SIZE/RANK into every PyTorchJob pod.
*/}}
{{- define "gpu-train-job.commonEnv" -}}
- name: JOB_NAME
  value: {{ include "gpu-train-job.fullname" . | quote }}
{{- /* a script that cannot succeed on a retry creates this file before it exits (see job.failFastExitCodes) */}}
- name: AIF_NO_RETRY_FILE
  value: /tmp/tj/no-retry
{{- /* where the pod runs: a test's report names the node, and the pod's hostname is only its own name */}}
- name: NODE_NAME
  valueFrom:
    fieldRef:
      fieldPath: spec.nodeName
- name: NNODES
  value: {{ .Values.job.nodes | quote }}
- name: NPROC_PER_NODE
  {{- /* one process per GPU; a CPU-only run still runs one */}}
  value: {{ max 1 (int .Values.job.gpusPerNode) | toString | quote }}
- name: SMOKE_HOLD_SECONDS
  value: {{ .Values.job.smokeHoldSeconds | quote }}
{{- if .Values.storage.scratchSize }}
- name: SCRATCH_DIR
  value: {{ .Values.storage.scratchMountPath | quote }}
{{- end }}
{{- if .Values.storage.datasetPVC }}
- name: DATASET_DIR
  value: {{ .Values.storage.datasetMountPath | quote }}
{{- end }}
{{- if (include "gpu-train-job.checkpointClaim" . | trim) }}
- name: CHECKPOINT_DIR
  value: {{ .Values.storage.checkpointMountPath | quote }}
{{- end }}
{{- if eq .Values.job.mode "smoke" }}
- name: TJ_SMOKE_SH
  value: {{ include "gpu-train-job.smokeScript" . | quote }}
{{- end }}
{{- if and (eq .Values.job.mode "torchrun") (not .Values.storage.configMap) }}
- name: TJ_TRAIN_PY
  value: {{ include "gpu-train-job.trainScript" . | quote }}
{{- end }}
{{- with .Values.network.ncclSocketIfname }}
- name: NCCL_SOCKET_IFNAME
  value: {{ . | quote }}
{{- end }}
{{- /* rdma.enabled is the switch users reason about; leaving IB disabled alongside it would mount
       the devices and then route the all-reduce over TCP anyway. */}}
- name: NCCL_IB_DISABLE
  value: {{ if .Values.network.rdma.enabled }}"0"{{ else }}{{ .Values.network.ncclIbDisable | quote }}{{ end }}
- name: NCCL_DEBUG
  value: {{ .Values.network.ncclDebug | quote }}
{{- with .Values.network.ncclIbHca }}
- name: NCCL_IB_HCA
  value: {{ . | quote }}
{{- end }}
{{- with .Values.network.ncclIbGidIndex }}
- name: NCCL_IB_GID_INDEX
  value: {{ . | quote }}
{{- end }}
{{- with .Values.network.ncclNetGdrLevel }}
- name: NCCL_NET_GDR_LEVEL
  value: {{ . | quote }}
{{- end }}
{{- with .Values.network.ncclCrossNic }}
- name: NCCL_CROSS_NIC
  value: {{ . | quote }}
{{- end }}
{{- if and .Values.network.rdma.enabled .Values.network.rdma.hostLibPath }}
- name: LD_LIBRARY_PATH
  value: {{ printf "%s:/usr/local/nvidia/lib64:/usr/local/cuda/lib64" .Values.network.rdma.hostLibMountPath | quote }}
{{- end }}
{{- range .Values.env }}
- name: {{ .name }}
  {{- if .valueFrom }}
  valueFrom:
    {{- toYaml .valueFrom | nindent 4 }}
  {{- else }}
  value: {{ .value | toString | quote }}   {{- /* numbers from --set/forms must be strings */}}
  {{- end }}
{{- end }}
{{- end -}}

{{/*
The trainer container, shared by both kinds. Takes a dict: "ctx" (root context) and "kind"
("job" or "pytorchjob"), which selects only how torchrun learns its rank and rendezvous:

  job         — rank from the Indexed Job's JOB_COMPLETION_INDEX; rendezvous through the
                headless Service (c10d on pod 0) or an external etcd.
  pytorchjob  — the training-operator injects RANK/WORLD_SIZE/MASTER_ADDR/MASTER_PORT into every
                pod, so torchrun is pointed straight at the master. RANK and WORLD_SIZE are
                captured and unset first: torchrun's elastic agent treats them as *its own*
                process rank and would otherwise start every node as rank 0 of a 1-process world.
*/}}
{{- define "gpu-train-job.trainerContainer" -}}
{{- $ := .ctx -}}
{{- $kind := .kind -}}
- name: {{ if eq $kind "pytorchjob" }}pytorch{{ else }}trainer{{ end }}
  image: {{ printf "%s:%s" $.Values.image.repository (toString $.Values.image.tag) | quote }}
  imagePullPolicy: {{ $.Values.image.pullPolicy | quote }}
  {{- if eq $.Values.job.mode "smoke" }}
  command: ["/bin/sh", "-c", "mkdir -p /tmp/tj && printf '%s\\n' \"$TJ_SMOKE_SH\" > /tmp/tj/smoke.sh && exec sh /tmp/tj/smoke.sh"]
  {{- else if eq $.Values.job.mode "torchrun" }}
  command:
    - /bin/sh
    - -c
    {{- /* Values never enter the shell string: everything user-controlled is read from
           environment variables and double-quoted, so no value can inject shell syntax. */}}
    {{- /* Script source: a mounted ConfigMap's train.py (storage.configMap — versioned, reusable,
           parameters via env) or the inline job.script delivered through TJ_TRAIN_PY. */}}
    {{- $script := "/tmp/tj/train.py" }}
    {{- $stage := "mkdir -p /tmp/tj && printf '%s\\n' \"$TJ_TRAIN_PY\" > /tmp/tj/train.py &&" }}
    {{- if $.Values.storage.configMap }}
      {{- $script = printf "%s/train.py" $.Values.storage.configMountPath }}
      {{- $stage = "true &&" }}
    {{- end }}
    {{- if eq $kind "pytorchjob" }}
    - >-
      {{ $stage }}
      NODE_RANK="${RANK:-0}" && unset RANK WORLD_SIZE &&
      exec torchrun --nnodes="$NNODES" --nproc_per_node="$NPROC_PER_NODE"
      --node_rank="$NODE_RANK" --master_addr="$MASTER_ADDR" --master_port="$MASTER_PORT"
      {{ $script }} "$@"
    {{- else }}
    {{- /* Not exec: torchrun reports any worker failure as exit 1, so a script that cannot succeed on
           a retry leaves $AIF_NO_RETRY_FILE and the shell exits 3 for it (job.failFastExitCodes).
           The shell forwards a stop signal to torchrun, so a cancel still stops it promptly. */}}
    - >-
      {{ $stage }}
      torchrun --nnodes="$NNODES" --nproc_per_node="$NPROC_PER_NODE"
      --node_rank="$JOB_COMPLETION_INDEX" --rdzv_backend="$RDZV_BACKEND"
      --rdzv_endpoint="$RDZV_ENDPOINT" --rdzv_id="$JOB_NAME"
      {{ $script }} "$@" & pid=$!;
      trap 'kill -TERM $pid 2>/dev/null' TERM INT;
      wait $pid; rc=$?; [ $rc -gt 128 ] && wait $pid && rc=$?;
      if [ -e "$AIF_NO_RETRY_FILE" ]; then exit 3; fi; exit $rc
    {{- end }}
    - --
  {{- with $.Values.job.args }}
  args:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- else }}
  {{- with $.Values.job.command }}
  command:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with $.Values.job.args }}
  args:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- end }}
  env:
    {{- include "gpu-train-job.commonEnv" $ | trim | nindent 4 }}
    {{- if ne $kind "pytorchjob" }}
    - name: RDZV_BACKEND
      value: {{ $.Values.rendezvous.backend | quote }}
    - name: RDZV_ENDPOINT
      value: {{ include "gpu-train-job.rdzvEndpoint" $ | quote }}
    {{- end }}
    {{- /* last, after the user's env, so a user variable cannot raise the cap */}}
    {{- if and $.Values.gpu.sharedClaim (gt (int $.Values.gpu.sharedMemoryMiB) 0) }}
    - name: CUDA_MPS_PINNED_DEVICE_MEM_LIMIT
      value: {{ printf "0=%dM" (int $.Values.gpu.sharedMemoryMiB) | quote }}
    {{- end }}
  {{- if $.Values.network.rdma.enabled }}
  {{- /* libibverbs opens /dev/infiniband/uverbsN and pins memory; the reference RoCE job on the
         Altra cluster runs privileged for exactly this. A tighter grant (IPC_LOCK plus an RDMA
         device plugin) is possible but is not what these nodes are set up for. */}}
  securityContext:
    privileged: true
  {{- end }}
  resources:
    {{- include "gpu-train-job.resourceBlock" $ | trim | nindent 4 }}
  volumeMounts:
    {{- include "gpu-train-job.volumeMounts" $ | trim | nindent 4 }}
{{- end -}}

{{/*
Pod template for a PyTorchJob replica. Master and Worker are identical here — the operator is what
distinguishes them, by injecting RANK (0 for Master) and pointing MASTER_ADDR at the Master pod.
*/}}
{{- define "gpu-train-job.pytorchReplicaTemplate" -}}
metadata:
  labels:
    {{- include "gpu-train-job.podLabels" . | nindent 4 }}
    {{- with (include "gpu-train-job.queuePodLabels" . | trim) }}
      {{- . | nindent 4 }}
    {{- end }}
  {{- with (include "gpu-train-job.podAnnotations" . | trim) }}
  annotations:
    {{- . | nindent 4 }}
  {{- end }}
spec:
  terminationGracePeriodSeconds: {{ .Values.job.terminationGracePeriodSeconds }}
  {{- with (include "gpu-train-job.podNetwork" . | trim) }}
    {{- . | nindent 2 }}
  {{- end }}
  {{- with (include "gpu-train-job.podScheduling" . | trim) }}
    {{- . | nindent 2 }}
  {{- end }}
  {{- with (include "gpu-train-job.affinity" . | trim) }}
  affinity:
    {{- . | nindent 4 }}
  {{- end }}
  {{- if eq (include "gpu-train-job.gpuMode" .) "dra" }}
  resourceClaims:
    - name: gpu
      {{- if .Values.gpu.sharedClaim }}
      resourceClaimName: {{ .Values.gpu.sharedClaim }}
      {{- else }}
      resourceClaimTemplateName: {{ include "gpu-train-job.fullname" . }}-gpu
      {{- end }}
    {{- if .Values.computeDomain.enabled }}
    - name: compute-domain
      resourceClaimTemplateName: {{ include "gpu-train-job.fullname" . }}-cd-channel
    {{- end }}
  {{- end }}
  volumes:
    {{- include "gpu-train-job.volumes" . | trim | nindent 4 }}
  containers:
    {{- include "gpu-train-job.trainerContainer" (dict "ctx" . "kind" "pytorchjob") | trim | nindent 4 }}
{{- end -}}

{{/*
Pod template of a RayJob's head or workers (role). Both get the run's labels, the scheduler's
binding, the pool affinity and the volumes; only the workers get the GPU (resources, KAI's
gpu-memory share, the DRA claim). KubeRay supplies the container's command (ray start).
*/}}
{{- define "gpu-train-job.rayPodTemplate" -}}
{{- $ := .ctx -}}
{{- $worker := eq .role "worker" -}}
{{- $annotations := include "gpu-train-job.podAnnotations" $ | trim -}}
{{- if not $worker }}{{ $annotations = regexReplaceAll "(?m)^gpu-memory:.*$\n?" $annotations "" | trim }}{{ end -}}
metadata:
  labels:
    {{- include "gpu-train-job.podLabels" $ | nindent 4 }}
    {{- with (include "gpu-train-job.queuePodLabels" $ | trim) }}
      {{- . | nindent 4 }}
    {{- end }}
    ai-factory.suse.com/ray-role: {{ .role }}
  {{- with $annotations }}
  annotations:
    {{- . | nindent 4 }}
  {{- end }}
spec:
  terminationGracePeriodSeconds: {{ $.Values.job.terminationGracePeriodSeconds }}
  {{- with (include "gpu-train-job.podNetwork" $ | trim) }}
    {{- . | nindent 2 }}
  {{- end }}
  {{- with (include "gpu-train-job.podScheduling" $ | trim) }}
    {{- . | nindent 2 }}
  {{- end }}
  {{- with (include "gpu-train-job.affinity" $ | trim) }}
  affinity:
    {{- . | nindent 4 }}
  {{- end }}
  {{- if and $worker (eq (include "gpu-train-job.gpuMode" $) "dra") }}
  resourceClaims:
    - name: gpu
      {{- if $.Values.gpu.sharedClaim }}
      resourceClaimName: {{ $.Values.gpu.sharedClaim }}
      {{- else }}
      resourceClaimTemplateName: {{ include "gpu-train-job.fullname" $ }}-gpu
      {{- end }}
  {{- end }}
  containers:
    - name: ray-{{ .role }}
      image: {{ printf "%s:%s" $.Values.image.repository (toString $.Values.image.tag) | quote }}
      imagePullPolicy: {{ $.Values.image.pullPolicy | quote }}
      env:
        {{- include "gpu-train-job.commonEnv" $ | trim | nindent 8 }}
      resources:
        {{- if $worker }}
        {{- include "gpu-train-job.resourceBlock" $ | trim | nindent 8 }}
        {{- else }}
        {{- toYaml $.Values.ray.head.resources | nindent 8 }}
        {{- end }}
      {{- if not $worker }}
      ports:
        - { name: gcs, containerPort: 6379 }
        - { name: dashboard, containerPort: 8265 }
        - { name: client, containerPort: 10001 }
      {{- end }}
      volumeMounts:
        {{- include "gpu-train-job.volumeMounts" $ | trim | nindent 8 }}
        {{- if not $worker }}
        - name: driver
          mountPath: /home/ray/aif
          readOnly: true
        {{- end }}
  volumes:
    {{- include "gpu-train-job.volumes" $ | trim | nindent 4 }}
    {{- if not $worker }}
    - name: driver
      configMap:
        name: {{ include "gpu-train-job.fullname" $ }}-driver
    {{- end }}
{{- end -}}
