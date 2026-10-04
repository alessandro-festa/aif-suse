{{/*
Install-time checks (Helm `lookup`; skipped under `helm template`). Each failure names the
real cause instead of leaving a Pending pod with no events. Disable with preflight.enabled=false.
*/}}
{{- define "gpu-train-job.preflight" -}}
{{- if and (gt (int .Values.gpu.sharedMemoryMiB) 0) (not .Values.gpu.sharedClaim) (ne .Values.scheduler.type "kai") }}
  {{- fail "preflight: gpu.sharedMemoryMiB (a GPU-memory share) needs scheduler.type=kai (KAI GPU sharing) or gpu.sharedClaim (an MPS ResourceClaim under DRA)." }}
{{- end }}
{{- if and (eq (include "gpu-train-job.gpuMode" .) "kai-fraction") (gt (int .Values.job.gpusPerNode) 1) }}
  {{- fail (printf "preflight: a GPU-memory share is one fraction of one GPU per pod; job.gpusPerNode=%d. Use gpusPerNode=1, or whole GPUs (gpu.sharedMemoryMiB=0)." (int .Values.job.gpusPerNode)) }}
{{- end }}
{{- if and .Values.storage.checkpointCreate.enabled .Values.storage.checkpointPVC }}
  {{- fail "preflight: storage.checkpointPVC and storage.checkpointCreate.enabled are both set; use an existing checkpoint PVC or create one, not both." }}
{{- end }}
{{- if not (has .Values.storage.scratchMedium (list "volume" "node")) }}
  {{- fail (printf "preflight: storage.scratchMedium must be volume or node (got %q)." .Values.storage.scratchMedium) }}
{{- end }}
{{- if and .Values.gpu.sharedClaim (ne (include "gpu-train-job.gpuMode" .) "dra") }}
  {{- fail "preflight: gpu.sharedClaim (a shared GPU) needs gpu.mode=dra." }}
{{- end }}
{{- /* Shape checks that need no cluster access: names that become Kubernetes identifiers or label values */ -}}
{{- $name := include "gpu-train-job.fullname" . }}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]{0,50}[a-z0-9])?$" $name) }}
  {{- fail (printf "preflight: release name %q must be a DNS label (lowercase alphanumerics and '-', max 52 chars)" $name) }}
{{- end }}
{{- if and .Values.scheduler.queue (not (regexMatch "^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$" .Values.scheduler.queue)) }}
  {{- fail (printf "preflight: scheduler.queue %q is not a valid label value / resource name" .Values.scheduler.queue) }}
{{- end }}
{{- if not (regexMatch "^[A-Za-z0-9][A-Za-z0-9._/:@-]*$" (printf "%s:%s" .Values.image.repository (toString .Values.image.tag))) }}
  {{- fail (printf "preflight: image reference %q contains characters outside [A-Za-z0-9._/:@-]" (printf "%s:%s" .Values.image.repository (toString .Values.image.tag))) }}
{{- end }}
{{- if .Values.computeDomain.enabled }}
  {{- if ne (include "gpu-train-job.gpuMode" .) "dra" }}
    {{- fail "preflight: computeDomain.enabled requires gpu.mode=dra (the channel is a DRA claim)." }}
  {{- end }}
  {{- if and (lookup "v1" "Namespace" "" .Release.Namespace) (not (.Capabilities.APIVersions.Has "resource.nvidia.com/v1beta1/ComputeDomain")) }}
    {{- fail "preflight: computeDomain.enabled but the ComputeDomain CRD (resource.nvidia.com/v1beta1) is not installed; deploy the NVIDIA DRA driver (k8s-dra-driver-gpu) with compute domains enabled or disable computeDomain." }}
  {{- end }}
{{- end }}
{{- /* lookup returns nothing under `helm template`; only check when we can see the cluster.
       Probe the release namespace itself: Rancher grants project members `get` on their namespaces,
       and Helm runs as the submitting user (a forbidden lookup is a hard template error). */ -}}
{{- $online := lookup "v1" "Namespace" "" .Release.Namespace }}
{{- if and .Values.preflight.enabled $online }}
{{- if eq .Values.job.kind "pytorchjob" }}
  {{- if not (.Capabilities.APIVersions.Has "kubeflow.org/v1/PyTorchJob") }}
    {{- fail "preflight: job.kind=pytorchjob but the Kubeflow Training Operator is not installed (no pytorchjobs.kubeflow.org CRD). Install it, or use job.kind=job (torchrun over an Indexed Job needs no operator)." }}
  {{- end }}
{{- end }}
{{- /* A PVC that does not exist, or that cannot be mounted by every pod at once, leaves the pods
       Pending with only a scheduler event to explain it. RWO is fine for a single node. */ -}}
{{- $multi := gt (int .Values.job.nodes) 1 }}
{{- range $field, $claim := dict "datasetPVC" .Values.storage.datasetPVC "checkpointPVC" .Values.storage.checkpointPVC }}
  {{- if $claim }}
    {{- $pvc := lookup "v1" "PersistentVolumeClaim" $.Release.Namespace $claim }}
    {{- if not $pvc }}
      {{- fail (printf "preflight: storage.%s=%q does not exist in namespace %q (kubectl -n %s get pvc)." $field $claim $.Release.Namespace $.Release.Namespace) }}
    {{- else if $multi }}
      {{- $modes := dig "spec" "accessModes" (list) $pvc }}
      {{- if not (or (has "ReadWriteMany" $modes) (has "ReadOnlyMany" $modes)) }}
        {{- fail (printf "preflight: storage.%s=%q is %v, but job.nodes=%d needs every pod to mount it at once. Use an RWX volume (CephFS/NFS) or set job.nodes=1." $field $claim $modes (int $.Values.job.nodes)) }}
      {{- end }}
    {{- end }}
  {{- end }}
{{- end }}
{{- if or (eq .Values.scheduler.type "kai") (eq .Values.scheduler.type "runai") }}
  {{- $product := ternary "KAI" "Run:AI" (eq .Values.scheduler.type "kai") }}
  {{- /* API discovery needs no RBAC, unlike reading CRDs */ -}}
  {{- if not (.Capabilities.APIVersions.Has "scheduling.run.ai/v2/Queue") }}
    {{- fail (printf "preflight: scheduler.type=%s but no queues.scheduling.run.ai CRD is present, so neither KAI nor Run:AI is installed here. Choose scheduler=none or kueue." .Values.scheduler.type) }}
  {{- end }}
  {{- $q := lookup "scheduling.run.ai/v2" "Queue" "" .Values.scheduler.queue }}
  {{- if not $q }}
    {{- fail (printf "preflight: %s queue %q does not exist (kubectl get queues.scheduling.run.ai)." $product .Values.scheduler.queue) }}
  {{- end }}
{{- end }}
{{- if eq .Values.scheduler.type "kai" }}
  {{- /*
    KAI and Run:AI share the queues.scheduling.run.ai CRD -- Run:AI is built on KAI -- so every
    check above passes on a Run:AI cluster and the pods then wait forever for a scheduler called
    kai-scheduler that is not there. Nothing lands on the pod to say so. The commercial product
    additionally installs the run.ai API group, which KAI on its own does not, and that is the
    cheapest way to tell the two apart.
  */ -}}
  {{- if .Capabilities.APIVersions.Has "run.ai/v1/Cluster" }}
    {{- fail "preflight: scheduler.type=kai, but this cluster is running Run:AI, not stand-alone KAI. They share the queue CRD and differ in schedulerName, so KAI pods here stay Pending with no event. Use scheduler.type=runai." }}
  {{- end }}
{{- end }}
{{- if eq .Values.scheduler.type "runai" }}
  {{- /*
    Run:AI's pod webhooks are scoped `namespaceSelector: runai/queue Exists`. Without the label the
    pods are admitted by the API server and then sit Pending with runai-scheduler never looking at
    them -- no event, no condition, nothing on the pod to read. Catching it at install time is the
    difference between a one-line fix and an afternoon.

    The label is necessary and not sufficient: the namespace also has to be one a run.ai Project
    owns, because the RoleBindings that let the scheduler create a BindRequest there are written by
    the project-controller. That is deliberately NOT checked here. It would mean `lookup`-ing a
    cluster-scoped Run:AI CRD, and a forbidden lookup is a hard template error -- it would break
    the install for every submitter who cannot list Projects, which is most of them. The message
    below names it instead, and the extension's pre-flight checks it properly (it can tolerate a
    read it is not allowed to make).
  */ -}}
  {{- $ns := lookup "v1" "Namespace" "" .Release.Namespace }}
  {{- if $ns }}
    {{- $nsQueue := dig "metadata" "labels" "runai/queue" "" $ns }}
    {{- if not $nsQueue }}
      {{- fail (printf "preflight: namespace %q has no runai/queue label, so Run:AI will not manage pods in it. Install into a namespace a run.ai Project owns (kubectl get projects.run.ai -o custom-columns=PROJECT:.metadata.name,NAMESPACE:.status.namespace). Labelling this one by hand is not enough on its own -- it gives the pods the webhooks but none of the RoleBindings the scheduler needs to bind them." .Release.Namespace) }}
    {{- else if ne $nsQueue .Values.scheduler.queue }}
      {{- fail (printf "preflight: namespace %q is labelled runai/queue=%s but scheduler.queue is %q. The namespace label wins for admission and the pod label for accounting; disagreeing is never what you meant." .Release.Namespace $nsQueue .Values.scheduler.queue) }}
    {{- end }}
  {{- end }}
{{- end }}
{{- if eq .Values.scheduler.type "kueue" }}
  {{- if not (or (.Capabilities.APIVersions.Has "kueue.x-k8s.io/v1beta2/LocalQueue") (.Capabilities.APIVersions.Has "kueue.x-k8s.io/v1beta1/LocalQueue")) }}
    {{- fail "preflight: scheduler.type=kueue but Kueue is not installed on this cluster." }}
  {{- end }}
  {{- $lq := lookup "kueue.x-k8s.io/v1beta2" "LocalQueue" .Release.Namespace .Values.scheduler.queue }}
  {{- if not $lq }}{{ $lq = lookup "kueue.x-k8s.io/v1beta1" "LocalQueue" .Release.Namespace .Values.scheduler.queue }}{{ end }}
  {{- if not $lq }}
    {{- fail (printf "preflight: no Kueue LocalQueue %q in namespace %q (kubectl -n %s get localqueues). Pick the namespace that owns the queue." .Values.scheduler.queue .Release.Namespace .Release.Namespace) }}
  {{- end }}
  {{- /* Kueue refuses admission for any requested resource the ClusterQueue does not cover */ -}}
  {{- $cq := lookup "kueue.x-k8s.io/v1beta2" "ClusterQueue" "" $lq.spec.clusterQueue }}
  {{- if not $cq }}{{ $cq = lookup "kueue.x-k8s.io/v1beta1" "ClusterQueue" "" $lq.spec.clusterQueue }}{{ end }}
  {{- if $cq }}
    {{- $covered := list }}
    {{- range $cq.spec.resourceGroups }}{{ range .coveredResources }}{{ $covered = append $covered . }}{{ end }}{{ end }}
    {{- range $r, $v := .Values.resources.requests }}
      {{- if and $v (ne (toString $v) "") (ne $r $.Values.gpu.resourceName) (not (has $r $covered)) }}
        {{- fail (printf "preflight: ClusterQueue %q does not cover requested resource %q (covers: %s). Remove that request (resources.requests.%s=\"\") or add it to the ClusterQueue." $lq.spec.clusterQueue $r (join ", " $covered) $r) }}
      {{- end }}
    {{- end }}
    {{- if and .Values.computeDomain.enabled (not (has .Values.computeDomain.kueueResourceName $covered)) }}
      {{- fail (printf "preflight: computeDomain.enabled with Kueue, but ClusterQueue %q does not cover %q (covers: %s). Kueue must map DeviceClass %s to that resource in resources.deviceClassMappings and the ClusterQueue must cover it, or the workload stays suspended." $lq.spec.clusterQueue .Values.computeDomain.kueueResourceName (join ", " $covered) .Values.computeDomain.channelDeviceClass) }}
    {{- end }}
  {{- end }}
{{- end }}
{{- if eq (include "gpu-train-job.gpuMode" .) "device-plugin" }}
  {{- $nodes := lookup "v1" "Node" "" "" }}
  {{- $found := false }}
  {{- range $nodes.items }}
    {{- $cap := index .status.allocatable $.Values.gpu.resourceName | default "0" }}
    {{- if ne (toString $cap) "0" }}{{ $found = true }}{{ end }}
  {{- end }}
  {{- if not $found }}
    {{- fail (printf "preflight: no node advertises %s (device plugin). This cluster exposes GPUs via DRA — choose gpu.mode=dra." .Values.gpu.resourceName) }}
  {{- end }}
{{- end }}
{{- if and .Values.computeDomain.enabled (not (lookup "resource.k8s.io/v1" "DeviceClass" "" .Values.computeDomain.channelDeviceClass)) }}
  {{- fail (printf "preflight: DeviceClass %q not found; the DRA driver's compute-domain support is not active on this cluster." .Values.computeDomain.channelDeviceClass) }}
{{- end }}
{{- if eq (include "gpu-train-job.gpuMode" .) "dra" }}
  {{- $dc := lookup "resource.k8s.io/v1" "DeviceClass" "" .Values.gpu.deviceClassName }}
  {{- if not $dc }}
    {{- fail (printf "preflight: DRA DeviceClass %q not found (kubectl get deviceclasses). Choose gpu.mode=device-plugin or fix the class name." .Values.gpu.deviceClassName) }}
  {{- end }}
{{- end }}
{{- /* DiskPressure on GPU nodes: a run there loses its logs and may be evicted */ -}}
{{- if .Values.preflight.checkDiskPressure }}
  {{- $nodes := (lookup "v1" "Node" "" "").items }}
  {{- $slices := (lookup "resource.k8s.io/v1" "ResourceSlice" "" "").items }}
  {{- $gpu := dict }}{{ $pressured := list }}{{ $ok := 0 }}
  {{- range $nodes }}{{ if gt (include "gpu-train-job.cpuMilli" (index .status.allocatable $.Values.gpu.resourceName | default "0") | int) 0 }}{{ $_ := set $gpu .metadata.name true }}{{ end }}{{ end }}
  {{- range $slices }}{{ if and (eq .spec.driver $.Values.gpu.deviceClassName) .spec.nodeName }}{{ $_ := set $gpu .spec.nodeName true }}{{ end }}{{ end }}
  {{- range $nodes }}
    {{- if hasKey $gpu .metadata.name }}
      {{- $dp := false }}
      {{- range .status.conditions }}{{ if and (eq .type "DiskPressure") (eq .status "True") }}{{ $dp = true }}{{ end }}{{ end }}
      {{- if $dp }}{{ $pressured = append $pressured .metadata.name }}{{ else }}{{ $ok = add1 $ok }}{{ end }}
    {{- end }}
  {{- end }}
  {{- if and (gt (len $gpu) 0) (eq $ok 0) }}
    {{- fail (printf "preflight: every GPU node reports DiskPressure (%s). Pods there lose their logs and get evicted; free disk on the node (see node-maintenance) or set preflight.checkDiskPressure=false to override." (join ", " $pressured)) }}
  {{- end }}
{{- end }}
{{- /* CPU/memory headroom on GPU nodes: allocatable minus requests of non-terminal pods */ -}}
{{- if .Values.preflight.checkHeadroom }}
  {{- $nodes := (lookup "v1" "Node" "" "").items }}
  {{- $slices := (lookup "resource.k8s.io/v1" "ResourceSlice" "" "").items }}
  {{- $pods := (lookup "v1" "Pod" "" "").items }}
  {{- $reqCpu := include "gpu-train-job.cpuMilli" .Values.resources.requests.cpu | int }}
  {{- $reqMem := include "gpu-train-job.memMi" .Values.resources.requests.memory | int }}
  {{- $gpuNodes := dict }}
  {{- range $nodes }}
    {{- if gt (include "gpu-train-job.cpuMilli" (index .status.allocatable $.Values.gpu.resourceName | default "0") | int) 0 }}{{ $_ := set $gpuNodes .metadata.name true }}{{ end }}
  {{- end }}
  {{- range $slices }}
    {{- if and (eq .spec.driver $.Values.gpu.deviceClassName) .spec.nodeName }}{{ $_ := set $gpuNodes .spec.nodeName true }}{{ end }}
  {{- end }}
  {{- $fits := 0 }}{{ $bestName := "" }}{{ $bestCpu := -1 }}{{ $bestMem := 0 }}
  {{- range $nodes }}
    {{- if hasKey $gpuNodes .metadata.name }}
      {{- $node := . }}
      {{- $usedCpu := 0 }}{{ $usedMem := 0 }}
      {{- range $pods }}
        {{- if and (eq (dig "spec" "nodeName" "" .) $node.metadata.name) (not (has (dig "status" "phase" "" .) (list "Succeeded" "Failed"))) }}
          {{- /* pod request = sum(containers) + sum(sidecar init containers, restartPolicy Always); at least max(regular init) */ -}}
          {{- $pc := 0 }}{{ $pm := 0 }}{{ $ic := 0 }}{{ $im := 0 }}
          {{- range .spec.containers }}
            {{- $pc = add $pc (include "gpu-train-job.cpuMilli" (dig "resources" "requests" "cpu" "" .) | int) }}
            {{- $pm = add $pm (include "gpu-train-job.memMi" (dig "resources" "requests" "memory" "" .) | int) }}
          {{- end }}
          {{- range (dig "spec" "initContainers" (list) .) }}
            {{- $c := include "gpu-train-job.cpuMilli" (dig "resources" "requests" "cpu" "" .) | int }}
            {{- $m := include "gpu-train-job.memMi" (dig "resources" "requests" "memory" "" .) | int }}
            {{- if eq (dig "restartPolicy" "" .) "Always" }}{{ $pc = add $pc $c }}{{ $pm = add $pm $m }}
            {{- else }}{{ if gt $c $ic }}{{ $ic = $c }}{{ end }}{{ if gt $m $im }}{{ $im = $m }}{{ end }}{{ end }}
          {{- end }}
          {{- $usedCpu = add $usedCpu (max $pc $ic) }}
          {{- $usedMem = add $usedMem (max $pm $im) }}
        {{- end }}
      {{- end }}
      {{- $freeCpu := sub (include "gpu-train-job.cpuMilli" .status.allocatable.cpu | int) $usedCpu }}
      {{- $freeMem := sub (include "gpu-train-job.memMi" .status.allocatable.memory | int) $usedMem }}
      {{- if and (ge $freeCpu $reqCpu) (ge $freeMem $reqMem) }}{{ $fits = add1 $fits }}{{ end }}
      {{- if gt $freeCpu $bestCpu }}{{ $bestCpu = $freeCpu }}{{ $bestMem = $freeMem }}{{ $bestName = .metadata.name }}{{ end }}
    {{- end }}
  {{- end }}
  {{- if .Values.preflight.debug }}
    {{- fail (printf "preflight debug: gpuNodes=%v nodes=%d slices=%d pods=%d fits=%d best=%s freeCpu=%dm freeMem=%dMi requested=%dm/%dMi" (keys $gpuNodes) (len $nodes) (len $slices) (len $pods) $fits $bestName $bestCpu $bestMem $reqCpu $reqMem) }}
  {{- end }}
  {{- if and (gt (len $gpuNodes) 0) (eq $fits 0) }}
    {{- fail (printf "preflight: no GPU node has enough free CPU/memory for this pod. Requested %dm CPU / %dMi; most headroom is %s with %dm CPU / %dMi free. Lower resources.requests or free capacity on the GPU node(s)." $reqCpu $reqMem $bestName $bestCpu $bestMem) }}
  {{- end }}
{{- end }}
{{- end }}
{{- end -}}
