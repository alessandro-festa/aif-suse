{{- define "ray-serve.fullname" -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{/* The model's name in the API. */}}
{{- define "ray-serve.servedName" -}}
{{- .Values.model.servedName | default .Values.model.id -}}
{{- end -}}

{{- define "ray-serve.labels" -}}
app.kubernetes.io/name: ray-serve
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "ray-serve.selector" -}}
app.kubernetes.io/name: ray-serve
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "ray-serve.image" -}}
{{- if .Values.image.repository -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default "2.49.2" }}
{{- else if eq .Values.mode "llm" -}}
rayproject/ray-llm:{{ .Values.image.tag | default "2.49.2-py311-cu128" }}
{{- else if gt (int .Values.gpu.count) 0 -}}
rayproject/ray:{{ .Values.image.tag | default "2.49.2-gpu" }}
{{- else -}}
rayproject/ray:{{ .Values.image.tag | default "2.49.2" }}
{{- end -}}
{{- end -}}

{{/* Whole cores of the worker's CPU request, at least 1: torch's thread count. */}}
{{- define "ray-serve.threads" -}}
{{- $cpu := toString .Values.resources.requests.cpu -}}
{{- if hasSuffix "m" $cpu -}}
{{- max 1 (div (int (trimSuffix "m" $cpu)) 1000) -}}
{{- else -}}
{{- max 1 (int (float64 $cpu)) -}}
{{- end -}}
{{- end -}}

{{/* Serve's configuration: the applications the RayService runs. */}}
{{- define "ray-serve.serveConfig" -}}
{{- $gpus := int .Values.gpu.count -}}
applications:
  - name: llm
    route_prefix: /
    {{- if eq .Values.mode "llm" }}
    import_path: ray.serve.llm:build_openai_app
    args:
      llm_configs:
        - model_loading_config:
            model_id: {{ include "ray-serve.servedName" . | quote }}
            model_source: {{ .Values.model.id | quote }}
          deployment_config:
            num_replicas: {{ int .Values.replicas }}
          engine_kwargs:
            max_model_len: {{ int .Values.model.contextLength }}
            tensor_parallel_size: {{ $gpus }}
    {{- else }}
    import_path: serve_app:app
    runtime_env:
      pip:
        packages:
          - torch=={{ .Values.app.torchVersion }}
          - transformers=={{ .Values.app.transformersVersion }}
        pip_install_options: ["--index-url", "https://download.pytorch.org/whl/{{ ternary "cu128" "cpu" (gt $gpus 0) }}", "--extra-index-url", "https://pypi.org/simple"]
      env_vars:
        MODEL_ID: {{ .Values.model.id | quote }}
        SERVED_NAME: {{ include "ray-serve.servedName" . | quote }}
        MAX_TOKENS: {{ int .Values.model.maxTokens | quote }}
        TORCH_THREADS: {{ include "ray-serve.threads" . | quote }}
    deployments:
      - name: Chat
        num_replicas: {{ int .Values.replicas }}
        ray_actor_options:
          num_cpus: 1
          num_gpus: {{ $gpus }}
    {{- end }}
{{- end -}}

{{/* A Ray pod: the head (role head) or a worker (role worker). */}}
{{- define "ray-serve.pod" -}}
{{- $ := .ctx -}}
{{- $worker := eq .role "worker" -}}
metadata:
  labels:
    {{- include "ray-serve.selector" $ | nindent 4 }}
    {{- with $.Values.podLabels }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  {{- with $.Values.podAnnotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  {{- with $.Values.imagePullSecrets }}
  imagePullSecrets:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  containers:
    - name: ray-{{ .role }}
      image: {{ include "ray-serve.image" $ | quote }}
      imagePullPolicy: {{ $.Values.image.pullPolicy }}
      env:
        - name: PYTHONPATH
          value: /home/ray/aif
        {{- if $.Values.hfTokenSecret }}
        - name: HF_TOKEN
          valueFrom:
            secretKeyRef:
              name: {{ $.Values.hfTokenSecret }}
              key: HF_TOKEN
        {{- end }}
      ports:
        - { name: serve, containerPort: {{ $.Values.service.port }} }
        {{- if not $worker }}
        - { name: gcs, containerPort: 6379 }
        - { name: dashboard, containerPort: 8265 }
        {{- end }}
      resources:
        {{- if $worker }}
        {{- $res := deepCopy $.Values.resources }}
        {{- if gt (int $.Values.gpu.count) 0 }}
        {{- $limits := $res.limits | default dict }}
        {{- $_ := set $limits $.Values.gpu.resourceName (int $.Values.gpu.count) }}
        {{- $_ := set $res "limits" $limits }}
        {{- end }}
        {{- toYaml $res | nindent 8 }}
        {{- else }}
        {{- toYaml $.Values.head.resources | nindent 8 }}
        {{- end }}
      volumeMounts:
        - { name: app, mountPath: /home/ray/aif, readOnly: true }
        - { name: shm, mountPath: /dev/shm }
  volumes:
    - name: app
      configMap:
        name: {{ include "ray-serve.fullname" $ }}-app
    - name: shm
      emptyDir: { medium: Memory, sizeLimit: 2Gi }
  {{- with $.Values.nodeSelector }}
  nodeSelector:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with $.Values.tolerations }}
  tolerations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with $.Values.affinity }}
  affinity:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end -}}
