package o11yrum

// Signal names an OTLP signal the gateway ingests.
type Signal string

const (
	// SignalTraces is OTLP traces, POST /_o11y/v1/traces.
	SignalTraces Signal = "traces"
	// SignalLogs is OTLP logs, POST /_o11y/v1/logs.
	SignalLogs Signal = "logs"
	// SignalMetrics is OTLP metrics, POST /_o11y/v1/metrics.
	SignalMetrics Signal = "metrics"
)
