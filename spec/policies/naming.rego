package before_resolution

# Minted attribute names: lowercase dotted namespaces, snake_case within
# segments, no leading/trailing separators.

deny contains violation if {
	some group in input.groups
	some attr in group.attributes
	attr.id != null
	not regex.match(`^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$`, attr.id)
	violation := {
		"id": "libo11y_attr_naming",
		"type": "semconv_attribute",
		"category": "naming",
		"group": group.id,
		"attr": attr.id,
	}
}
