package before_resolution

# Every attribute defined by libo11y carries a cardinality budget class.
# unbounded attributes are forbidden as metric labels (enforced by the
# metrics policy below and the generated tables).

cardinality_classes := {"enum", "bounded", "unbounded"}

deny contains violation if {
	some group in input.groups
	some attr in group.attributes
	attr.id != null
	not attr.deprecated
	not attr.annotations["o11y.cardinality"]
	violation := {
		"id": "libo11y_cardinality_missing",
		"type": "semconv_attribute",
		"category": "cardinality",
		"group": group.id,
		"attr": attr.id,
	}
}

deny contains violation if {
	some group in input.groups
	some attr in group.attributes
	attr.id != null
	class := attr.annotations["o11y.cardinality"]
	not cardinality_classes[class]
	violation := {
		"id": "libo11y_cardinality_unknown",
		"type": "semconv_attribute",
		"category": "cardinality",
		"group": group.id,
		"attr": attr.id,
	}
}

# Metric groups may not reference attributes libo11y classifies unbounded.
deny contains violation if {
	some group in input.groups
	group.type == "metric"
	some attr in group.attributes
	attr.annotations["o11y.cardinality"] == "unbounded"
	violation := {
		"id": "libo11y_unbounded_metric_label",
		"type": "semconv_attribute",
		"category": "cardinality",
		"group": group.id,
		"attr": attr.ref,
	}
}
