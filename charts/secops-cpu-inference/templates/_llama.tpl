{{/*
One llama-server Deployment + Service + PVC, shared by the generative and
embedding roles.

Lifted from operator/internal/controller/tokenfactorydeployment/llamacpp.go on
branch suse-token-factory-llm, with its AIBrix coupling stripped: the
`model.aibrix.ai/name` and `model.aibrix.ai/port` labels are gone, and because
the first of those was ALSO the Deployment's selector, the selector had to be
replaced rather than merely cleaned up. There is no AIBrix on this cluster and
no meta-gateway routing to satisfy — the agents reach these Services by name.

Call with a dict: (dict "ctx" $ "role" "generative" "cfg" .Values.generative)
*/}}
{{- define "secops-cpu-inference.llama" -}}
{{- $ctx := .ctx -}}
{{- $cfg := .cfg -}}
{{- $role := .role -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ $cfg.name }}
  namespace: {{ $ctx.Release.Namespace }}
  labels:
    {{- include "secops-cpu-inference.labels" $ctx | nindent 4 }}
    ai-factory.suse.com/inference-role: {{ $role }}
spec:
  type: {{ $ctx.Values.service.type }}
  selector:
    app.kubernetes.io/instance: {{ $ctx.Release.Name }}
    ai-factory.suse.com/inference-role: {{ $role }}
  ports:
    - name: http
      port: {{ $ctx.Values.service.port }}
      targetPort: http
      protocol: TCP
{{- if $ctx.Values.modelCache.persistence }}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ $cfg.name }}-models
  namespace: {{ $ctx.Release.Namespace }}
  labels:
    {{- include "secops-cpu-inference.labels" $ctx | nindent 4 }}
spec:
  accessModes:
    - ReadWriteOnce
  {{- with $ctx.Values.modelCache.storageClass }}
  storageClassName: {{ . }}
  {{- end }}
  resources:
    requests:
      storage: {{ $ctx.Values.modelCache.size }}
{{- end }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $cfg.name }}
  namespace: {{ $ctx.Release.Namespace }}
  labels:
    {{- include "secops-cpu-inference.labels" $ctx | nindent 4 }}
    ai-factory.suse.com/inference-role: {{ $role }}
spec:
  replicas: 1
  # One replica, and not configurable. The PVC is ReadWriteOnce on a local-path
  # StorageClass, so a second replica on another node cannot mount the cache and
  # would sit Pending forever — a failure that reads as "the model is still
  # downloading" rather than as a scheduling problem.
  strategy:
    # Recreate, not RollingUpdate: with an RWO volume the new pod cannot bind
    # the PVC until the old one releases it, so a rolling update deadlocks.
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/instance: {{ $ctx.Release.Name }}
      ai-factory.suse.com/inference-role: {{ $role }}
  template:
    metadata:
      labels:
        {{- include "secops-cpu-inference.labels" $ctx | nindent 8 }}
        ai-factory.suse.com/inference-role: {{ $role }}
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "{{ $ctx.Values.service.port }}"
        prometheus.io/path: /metrics
    spec:
      {{- include "secops-cpu-inference.imagePullSecrets" $ctx | nindent 6 }}
      containers:
        - name: llama-server
          image: {{ include "secops-cpu-inference.image" $ctx }}
          imagePullPolicy: {{ $ctx.Values.image.pullPolicy }}
          args:
            - -hf
            - {{ $cfg.ggufRepo }}
            - -a
            - {{ $cfg.servedModelName }}
            - --host
            - 0.0.0.0
            - --port
            - "{{ $ctx.Values.service.port }}"
            - --metrics
            # --threads MUST equal the CPU limit. llama.cpp sizes its thread
            # pool from hardware_concurrency() — the node's core count, not the
            # cgroup quota — so without an explicit --threads it oversubscribes
            # its own limit and thrashes. The node has 6 cores and the limit is
            # 4; left to itself it would start 6 threads inside a 4-core quota.
            - --threads
            - "{{ $cfg.resources.limits.cpu }}"
            - -c
            - "{{ $cfg.contextSize }}"
          {{- if eq $role "generative" }}
            {{- if $cfg.jinja }}
            # See values.yaml: without this, tool calls come back as prose and
            # every agent degrades into a narrator.
            - --jinja
            {{- end }}
            - --parallel
            - "{{ $cfg.parallel }}"
          {{- else }}
            - --embeddings
          {{- end }}
          env:
            - name: LLAMA_CACHE
              value: /models
          ports:
            - containerPort: {{ $ctx.Values.service.port }}
              name: http
          volumeMounts:
            - name: model-cache
              mountPath: /models
          startupProbe:
            httpGet:
              path: /health
              port: http
            # 10s x 120 = a 20-minute budget for the first GGUF pull. That is
            # the real reason this probe exists: readiness alone would restart
            # the pod mid-download, forever.
            periodSeconds: 10
            failureThreshold: 120
          readinessProbe:
            httpGet:
              path: /health
              port: http
            periodSeconds: 10
          resources:
            {{- toYaml $cfg.resources | nindent 12 }}
      volumes:
        - name: model-cache
        {{- if $ctx.Values.modelCache.persistence }}
          persistentVolumeClaim:
            claimName: {{ $cfg.name }}-models
        {{- else }}
          emptyDir: {}
        {{- end }}
      {{- with $ctx.Values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $ctx.Values.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $ctx.Values.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
{{- end -}}
