package before_resolution

# Namespace ownership: every attribute DEFINED in the libo11y registry
# (as opposed to referenced from upstream) must live under the o11y
# namespace. Minting names inside semconv-owned or third-party namespaces
# forfeits upstream rename tooling and invites collisions.

deny contains violation if {
	some group in input.groups
	some attr in group.attributes
	attr.id != null
	not startswith(attr.id, "o11y.")
	violation := {
		"id": "libo11y_namespace_ownership",
		"type": "semconv_attribute",
		"category": "ownership",
		"group": group.id,
		"attr": attr.id,
	}
}
