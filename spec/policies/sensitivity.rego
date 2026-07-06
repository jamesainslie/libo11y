package before_resolution

# Every attribute defined by libo11y must carry a sensitivity
# classification, and it must be a known class. This is the machine-readable
# annotation OTel itself lacks (OTEP 176 never landed); the runtime's
# redaction layer is driven by it, so an unclassified attribute is a hole.

sensitivity_classes := {"public", "internal", "pii", "secret"}

deny contains violation if {
	some group in input.groups
	some attr in group.attributes
	attr.id != null
	not attr.deprecated
	not attr.annotations["o11y.sensitivity"]
	violation := {
		"id": "libo11y_sensitivity_missing",
		"type": "semconv_attribute",
		"category": "sensitivity",
		"group": group.id,
		"attr": attr.id,
	}
}

deny contains violation if {
	some group in input.groups
	some attr in group.attributes
	attr.id != null
	class := attr.annotations["o11y.sensitivity"]
	not sensitivity_classes[class]
	violation := {
		"id": "libo11y_sensitivity_unknown",
		"type": "semconv_attribute",
		"category": "sensitivity",
		"group": group.id,
		"attr": attr.id,
	}
}

# Secret-class attributes may exist only as documentation of a forbidden
# key: no signal group may reference one.
deny contains violation if {
	some group in input.groups
	some attr in group.attributes
	attr.ref != null
	attr.annotations["o11y.sensitivity"] == "secret"
	violation := {
		"id": "libo11y_secret_referenced",
		"type": "semconv_attribute",
		"category": "sensitivity",
		"group": group.id,
		"attr": attr.ref,
	}
}
