{{/* CEL: a predicate on m holds for some / every trainer-pod metadata entry, in podTemplateOverrides
and in every runtimePatch (see the policy's pto and rp variables). */}}
{{- define "aif.anyMeta" -}}
(variables.pto.exists(m, {{ . }}) || variables.rp.exists(l, l.exists(m, {{ . }})))
{{- end }}
{{/* The same for the trainer pods' spec, as the patches set it (pod-level fields, containers). */}}
{{- define "aif.anySpec" -}}
(variables.ptoSpec.exists(s, {{ . }}) || variables.rpSpec.exists(l, l.exists(s, {{ . }})))
{{- end }}
{{- define "aif.allMeta" -}}
(variables.pto.all(m, {{ . }}) && variables.rp.all(l, l.all(m, {{ . }})))
{{- end }}
