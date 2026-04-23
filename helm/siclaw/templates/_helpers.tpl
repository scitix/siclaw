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
