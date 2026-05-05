{{/*
Expand the name of the chart.
*/}}
{{- define "claude-mem.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "claude-mem.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "claude-mem.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels
*/}}
{{- define "claude-mem.labels" -}}
helm.sh/chart: {{ include "claude-mem.chart" . }}
{{ include "claude-mem.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "claude-mem.selectorLabels" -}}
app.kubernetes.io/name: {{ include "claude-mem.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "claude-mem.chroma.labels" -}}
helm.sh/chart: {{ include "claude-mem.chart" . }}
{{ include "claude-mem.chroma.selectorLabels" . }}
app.kubernetes.io/component: chroma
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "claude-mem.chroma.selectorLabels" -}}
app.kubernetes.io/name: {{ include "claude-mem.name" . }}-chroma
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "claude-mem.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "claude-mem.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Database secret name (existing or chart-managed).
*/}}
{{- define "claude-mem.dbSecretName" -}}
{{- if .Values.database.existingSecret -}}
{{- .Values.database.existingSecret -}}
{{- else if .Values.postgresql.enabled -}}
{{- printf "%s-postgresql" .Release.Name -}}
{{- else -}}
{{- printf "%s-db" (include "claude-mem.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
Build the DATABASE_URL for the worker.
*/}}
{{- define "claude-mem.dbUrl" -}}
{{- if .Values.database.url -}}
{{- .Values.database.url -}}
{{- else if .Values.postgresql.enabled -}}
{{- printf "postgres://%s@%s-postgresql:5432/%s" .Values.postgresql.auth.username .Release.Name .Values.postgresql.auth.database -}}
{{- else -}}
{{- printf "postgres://%s@%s:%d/%s" .Values.database.user .Values.database.host (.Values.database.port | int) .Values.database.name -}}
{{- end -}}
{{- end -}}

{{/*
API keys secret name.
*/}}
{{- define "claude-mem.authSecretName" -}}
{{- if .Values.auth.existingSecret -}}
{{- .Values.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-api-keys" (include "claude-mem.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
Encode auth.keys map as alice:k1,bob:k2 string.
*/}}
{{- define "claude-mem.apiKeysValue" -}}
{{- $entries := list -}}
{{- range $user, $key := .Values.auth.keys -}}
{{- $entries = append $entries (printf "%s:%s" $user $key) -}}
{{- end -}}
{{- join "," $entries -}}
{{- end -}}

{{/*
Chroma host for worker env (built-in or external).
*/}}
{{- define "claude-mem.chromaHost" -}}
{{- if .Values.chroma.external -}}
{{- .Values.chroma.host -}}
{{- else -}}
{{- printf "%s-chroma" (include "claude-mem.fullname" .) -}}
{{- end -}}
{{- end -}}
