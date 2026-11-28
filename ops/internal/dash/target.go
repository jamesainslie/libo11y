package dash

// Datasource points a panel or target at a datasource. The pack only uses
// the three below, whose UIDs are dashboard variables, so no operator's
// datasource UID is ever written into a dashboard.
type Datasource struct {
	Type string `json:"type"`
	UID  string `json:"uid"`
}

// The datasources a pack dashboard selects through its variables.
var (
	Prometheus = Datasource{Type: "prometheus", UID: "${prometheus}"}
	Loki       = Datasource{Type: "loki", UID: "${loki}"}
	Tempo      = Datasource{Type: "tempo", UID: "${tempo}"}
)

// Target is one query of a panel, in the JSON form Grafana stores. A target
// without a datasource takes its panel's when the dashboard renders.
type Target map[string]any

// PromRange is a Prometheus range query.
func PromRange(ref, expr, legend string) Target {
	return Target{"refId": ref, "expr": expr, "legendFormat": legend, "range": true, "instant": false}
}

// PromInstant is a Prometheus instant query formatted as a table.
func PromInstant(ref, expr, legend string) Target {
	return Target{"refId": ref, "expr": expr, "legendFormat": legend, "range": false, "instant": true, "format": "table"}
}

// LokiLogs is a Loki range query, for log lines or a metric over time.
func LokiLogs(ref, expr string) Target {
	return Target{"refId": ref, "expr": expr, "queryType": "range"}
}

// LokiInstant is a Loki instant metric query.
func LokiInstant(ref, expr string) Target {
	return Target{"refId": ref, "expr": expr, "queryType": "instant"}
}

// TempoSearch is a TraceQL search. tableType is traces or spans.
func TempoSearch(ref, traceql, tableType string, limit int) Target {
	return Target{"refId": ref, "queryType": "traceql", "query": traceql, "tableType": tableType, "limit": limit}
}
