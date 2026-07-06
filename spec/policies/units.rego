package before_resolution

# Metric naming and unit rules: UCUM units in the unit field only; no
# Prometheus-style suffixes; libo11y instruments live under o11y.*.

deny contains violation if {
	some group in input.groups
	group.type == "metric"
	endswith(group.metric_name, "_total")
	violation := {
		"id": "libo11y_metric_total_suffix",
		"type": "semconv_group",
		"category": "units",
		"group": group.id,
		"attr": group.metric_name,
	}
}

deny contains violation if {
	some group in input.groups
	group.type == "metric"
	endswith(group.metric_name, ".count")
	violation := {
		"id": "libo11y_metric_count_suffix",
		"type": "semconv_group",
		"category": "units",
		"group": group.id,
		"attr": group.metric_name,
	}
}

deny contains violation if {
	some group in input.groups
	group.type == "metric"
	not group.unit
	violation := {
		"id": "libo11y_metric_unit_missing",
		"type": "semconv_group",
		"category": "units",
		"group": group.id,
		"attr": group.metric_name,
	}
}

deny contains violation if {
	some group in input.groups
	group.type == "metric"
	not startswith(group.metric_name, "o11y.")
	violation := {
		"id": "libo11y_metric_namespace",
		"type": "semconv_group",
		"category": "units",
		"group": group.id,
		"attr": group.metric_name,
	}
}
