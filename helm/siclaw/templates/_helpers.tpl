{{/*
Expand the name of the chart.
*/}}
{{- define "siclaw.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "siclaw.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "siclaw.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "siclaw.labels" -}}
helm.sh/chart: {{ include "siclaw.chart" .ctx }}
{{ include "siclaw.selectorLabels" (dict "ctx" .ctx "component" .component) }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "siclaw.selectorLabels" -}}
app.kubernetes.io/name: {{ include "siclaw.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
{{- if .component }}
app.kubernetes.io/component: {{ .component }}
{{- end }}
{{- end }}

{{/*
Build image string for a component.
Usage: {{ include "siclaw.image" (dict "component" "gateway" "ctx" .) }}
*/}}
{{- define "siclaw.image" -}}
{{- $registry := .ctx.Values.image.registry -}}
{{- $tag := .ctx.Values.image.tag -}}
{{- if $registry -}}
{{- printf "%s/siclaw-%s:%s" $registry .component $tag -}}
{{- else -}}
{{- printf "siclaw-%s:%s" .component $tag -}}
{{- end -}}
{{- end }}

{{/*
Build agentbox image string — same registry/tag as gateway, different component name.
*/}}
{{- define "siclaw.agentboxImage" -}}
{{- include "siclaw.image" (dict "component" "agentbox" "ctx" .) -}}
{{- end }}

{{/*
Name of the shared data PVC. Defaults to "<fullname>-data" so two releases
in the same namespace don't collide; users can override via
.Values.agentbox.persistence.claimName.
*/}}
{{- define "siclaw.dataPvcName" -}}
{{- default (printf "%s-data" (include "siclaw.fullname" .)) .Values.agentbox.persistence.claimName -}}
{{- end }}

{{/*
Name of the chart-managed Runtime CA Secret.
*/}}
{{- define "siclaw.runtimeCaSecretName" -}}
{{- printf "%s-runtime-ca" (include "siclaw.fullname" .) -}}
{{- end }}

{{/*
Resolve runtime.tls.generateCa. Returns the literal string "true" or "false".
Defaults to "true" when the field is missing — critical for `helm upgrade
--reuse-values` against a release created with a pre-tls chart, where
.Values.runtime.tls itself is nil.
*/}}
{{- define "siclaw.runtimeTls.generateCa" -}}
{{- $tls := .Values.runtime.tls | default dict -}}
{{- if hasKey $tls "generateCa" -}}{{- $tls.generateCa -}}{{- else -}}true{{- end -}}
{{- end }}

{{/*
Resolve runtime.tls.caSecret. Returns "" when missing.
*/}}
{{- define "siclaw.runtimeTls.caSecret" -}}
{{- $tls := .Values.runtime.tls | default dict -}}
{{- $tls.caSecret | default "" -}}
{{- end }}

{{/*
Resolve the Secret that backs SICLAW_CA_CERT/KEY. caSecret wins when set,
otherwise the chart-managed name is used. Empty result means TLS is mis-
configured — callers must guard with siclaw.validateRuntimeTls first.
*/}}
{{- define "siclaw.runtimeCaSecretRef" -}}
{{- $caSecret := include "siclaw.runtimeTls.caSecret" . -}}
{{- $generateCa := include "siclaw.runtimeTls.generateCa" . -}}
{{- if $caSecret -}}
{{- $caSecret -}}
{{- else if eq $generateCa "true" -}}
{{- include "siclaw.runtimeCaSecretName" . -}}
{{- end -}}
{{- end }}

{{/*
Fail-fast guard. Without a CA Secret the Runtime falls back to an ephemeral
in-memory CA, and every Runtime restart silently invalidates the client certs
held by existing AgentBox pods. Refuse to render the chart in that state.
*/}}
{{- define "siclaw.validateRuntimeTls" -}}
{{- $caSecret := include "siclaw.runtimeTls.caSecret" . -}}
{{- $generateCa := include "siclaw.runtimeTls.generateCa" . -}}
{{- if and (ne $generateCa "true") (eq $caSecret "") -}}
{{- fail "runtime.tls misconfigured: set generateCa=true OR caSecret to a kubernetes.io/tls Secret name. Ephemeral CA is not supported in K8s — old AgentBox pods would lose mTLS on every Runtime restart." -}}
{{- end -}}
{{- end }}
