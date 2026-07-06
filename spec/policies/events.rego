package before_resolution

# Event discipline: libo11y event names are static, dot-namespaced, and
# owned (o11y.*); every event group declares stability.

deny contains violation if {
	some group in input.groups
	group.type == "event"
	not startswith(group.name, "o11y.")
	violation := {
		"id": "libo11y_event_namespace",
		"type": "semconv_group",
		"category": "events",
		"group": group.id,
		"attr": group.name,
	}
}

deny contains violation if {
	some group in input.groups
	group.type == "event"
	not group.stability
	violation := {
		"id": "libo11y_event_stability",
		"type": "semconv_group",
		"category": "events",
		"group": group.id,
		"attr": group.name,
	}
}
