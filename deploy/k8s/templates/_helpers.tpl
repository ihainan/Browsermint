{{- define "browsermint.labels" -}}
app.kubernetes.io/name: browsermint
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "browsermint.selectorLabels" -}}
app.kubernetes.io/name: browsermint
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "browsermint.imagePullSecrets" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}
