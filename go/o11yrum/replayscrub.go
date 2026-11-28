package o11yrum

// The session replay event scrubber: a port of
// ts/packages/rum-replay/src/scrub.ts, rule for rule, so the gateway and
// the collector make the same decision on every event. The shared vectors
// in conformance/rum-replay hold both to it, and that file's comment is
// the statement of the rules. In short: everything is an allow-list, so a
// field, attribute, event type or incremental source rrweb adds later is
// dropped rather than stored.
//
// Events arrive decoded by encoding/json with UseNumber: objects are
// map[string]any, arrays []any, numbers json.Number. Every kept number is
// written back as a float64, as JavaScript would hold it, so digits past
// float64 precision cannot carry data into the store.
//
// The collector answers its ScrubContext from the live DOM. The gateway
// has no DOM, so scrubSegment answers it from the segment itself
// (segmentModel), in one of two modes:
//
//   - scrubStrict, the default: no text is allowed except the text of a
//     style element and the inlined stylesheet of a style or link
//     element, whose URLs are stripped. Text aimed at the style or link
//     element itself, and its text attributes, are masked. All other text and every masked
//     attribute is masked, whatever the client sent.
//   - scrubTrust, for an app whose operator set replay.unmasked_text:
//     text is kept as the client sent it, except where the segment's own
//     tree says it is under a fixed mask (input, textarea, select,
//     option, contenteditable, data-o11y-mask) or a block.
//
// In both modes input values, input events and every attribute off the
// allow-list are removed, and URLs are stripped.

import (
	"encoding/json"
	"errors"
	"math"
	"strconv"
)

// scrubContext is what the scrubber needs to know about a node it cannot
// see in the event itself. Node IDs are numbers as JSON holds them.
type scrubContext interface {
	// textAllowed reports whether the text and masked attributes of node
	// id may be kept.
	textAllowed(id float64) bool
	// stylesheetAllowed reports whether the inlined stylesheet (_cssText)
	// of node id, and CSSOM edits aimed at it, may be kept. The collector
	// asks textAllowed for both; the gateway's strict mode keeps
	// stylesheets and no other text, so it needs them apart.
	stylesheetAllowed(id float64) bool
	// attrsAllowed reports whether the masked attributes of node id may
	// be kept. The collector asks textAllowed; the gateway's strict mode
	// keeps none.
	attrsAllowed(id float64) bool
	// parentTag is the lowercase tag of the parent element of node id, or
	// "" when it is not known.
	parentTag(id float64) string
	// editable reports whether node id is user-editable content, whose
	// text is never recorded.
	editable(id float64) bool
	// blocked reports whether node id is under a block selector.
	blocked(id float64) bool
}

// maxScrubDepth cuts trees below this depth, as the collector's
// MAX_DEPTH does.
const maxScrubDepth = 1000

var (
	fixedMaskTags   = stringSet("input", "textarea", "select", "option")
	stylesheetTags  = stringSet("style", "link")
	placeholderKeys = []string{"class", "rr_width", "rr_height"}
)

type obj = map[string]any

func isObj(v any) (obj, bool) {
	m, ok := v.(map[string]any)
	return m, ok
}

// toNum returns v as a finite float64, as the collector's isNum accepts
// it: a number JSON.parse would not read as Infinity.
func toNum(v any) (float64, bool) {
	var f float64
	switch n := v.(type) {
	case json.Number:
		var err error
		f, err = strconv.ParseFloat(string(n), 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return 0, false
		}
	case float64:
		f = n
	default:
		return 0, false
	}
	if math.IsInf(f, 0) || math.IsNaN(f) {
		return 0, false
	}
	if f == 0 {
		f = 0 // -0 is written as 0, as JSON.stringify writes it
	}
	return f, true
}

// num returns the finite number in v, for fields already checked.
func num(v any) float64 {
	f, _ := toNum(v)
	return f
}

func anyBool(v any) (bool, bool) {
	b, ok := v.(bool)
	return b, ok
}

// numbers returns the fields of o named in keys whose values are finite
// numbers.
func numbers(o obj, keys ...string) obj {
	out := obj{}
	for _, k := range keys {
		if f, ok := toNum(o[k]); ok {
			out[k] = f
		}
	}
	return out
}

// booleans returns the fields of o named in keys whose values are
// booleans.
func booleans(o obj, keys ...string) obj {
	out := obj{}
	for _, k := range keys {
		if b, ok := anyBool(o[k]); ok {
			out[k] = b
		}
	}
	return out
}

func merge(dst obj, srcs ...obj) obj {
	for _, s := range srcs {
		for k, v := range s {
			dst[k] = v
		}
	}
	return dst
}

func jsonList(v any) []any {
	l, _ := v.([]any)
	return l
}

// jsNumberString formats f as JavaScript's String(f) does for the values
// the scrubber meets. encoding/json formats float64 the way ECMAScript
// does.
func jsNumberString(f float64) string {
	if f == 0 {
		return "0"
	}
	raw, err := json.Marshal(f)
	if err != nil {
		return "NaN"
	}
	return string(raw)
}

// jsFalse reports whether JavaScript's String(v), lowercased in ASCII,
// is "false": a string "false" in any case, the boolean false, or an
// array of exactly one such value (an array joins its elements with
// commas). It answers without building the string, so a deeply nested
// value costs only its depth.
func jsFalse(v any) bool {
	for {
		switch x := v.(type) {
		case string:
			return asciiLower(x) == "false"
		case bool:
			return !x
		case []any:
			if len(x) != 1 || x[0] == nil {
				return false
			}
			v = x[0]
		default:
			return false
		}
	}
}

// textRule is how a text value is recorded, given what is known about its
// node.
type textRule struct {
	parentTag string
	allowed   bool
	editable  bool
}

func textValue(value string, r textRule, allow map[string]bool) string {
	if r.parentTag == "script" || r.parentTag == "textarea" || r.editable {
		return ""
	}
	if !r.allowed {
		return maskText(value)
	}
	if r.parentTag == "style" {
		return stripCSSURLs(value, allow)
	}
	return value
}

func styleDiff(diff obj, allow map[string]bool) obj {
	out := obj{}
	for prop, v := range diff {
		// Assigning __proto__ on a JavaScript object literal sets its
		// prototype, so the collector never emits that key.
		if prop == "__proto__" {
			continue
		}
		switch x := v.(type) {
		case string:
			out[prop] = stripCSSValue(x, allow)
		case bool:
			if !x {
				out[prop] = false
			}
		case []any:
			if len(x) > 0 {
				if s, ok := x[0].(string); ok {
					priority := ""
					if len(x) > 1 {
						priority, _ = x[1].(string)
					}
					out[prop] = []any{stripCSSValue(s, allow), priority}
				}
			}
		}
	}
	return out
}

// attributes reduces attrs to the allow-list. textAllowed decides masked
// attributes, cssAllowed the inlined stylesheet. On editable content every
// URL and CSS attribute is dropped. A null value (a removal in a mutation)
// is kept for a known attribute when removals is true.
func attributes(attrs obj, textAllowed, cssAllowed, editable, removals bool, allow map[string]bool) obj {
	out := obj{}
	for name, value := range attrs {
		key := asciiLower(name)
		known := keptAttributes[key] || maskedAttributes[key] || urlAttributes[key] || cssAttributes[key] || key == "_csstext"
		if !known {
			continue
		}
		if editable && (urlAttributes[key] || cssAttributes[key] || key == "_csstext") {
			continue
		}
		if value == nil {
			if removals {
				out[name] = nil
			}
			continue
		}
		s, isString := value.(string)
		switch {
		case maskedAttributes[key]:
			switch {
			case !isString:
				// A text attribute that is not a string is dropped.
			case !textAllowed:
				out[name] = maskText(s)
			case key == "content":
				out[name] = stripContent(s, allow)
			default:
				out[name] = s
			}
		case urlAttributes[key]:
			if isString {
				if key == "srcset" {
					out[name] = stripSrcset(s, allow)
				} else {
					out[name] = stripURL(s, allow)
				}
			}
		case cssAttributes[key]:
			if isString {
				out[name] = stripCSSURLs(s, allow)
			} else if m, ok := isObj(value); ok && key == "style" && removals {
				out[name] = styleDiff(m, allow)
			}
		case key == "_csstext":
			if isString && cssAllowed {
				out[name] = stripCSSURLs(s, allow)
			}
		default:
			if isString {
				out[name] = s
			} else if f, ok := toNum(value); ok {
				out[name] = f
			} else if b, ok := anyBool(value); ok {
				out[name] = b
			}
		}
	}
	return out
}

func placeholder(kept obj) obj {
	out := obj{}
	for _, k := range placeholderKeys {
		if s, ok := kept[k].(string); ok {
			out[k] = s
		}
	}
	return out
}

// attr returns the value of the attribute named name (lowercase) and
// whether it is present, matching names in ASCII lowercase. Go maps have
// no order, so where the collector takes the first of several names that
// differ only in case, this takes the strictest.
func attr(attrs obj, name string) []any {
	var vals []any
	for k, v := range attrs {
		if asciiLower(k) == name {
			vals = append(vals, v)
		}
	}
	return vals
}

// isContentEditable reports whether a contenteditable attribute makes an
// element editable: present, not null and not "false".
func isContentEditable(attrs obj) bool {
	for _, ce := range attr(attrs, "contenteditable") {
		if ce != nil && !jsFalse(ce) {
			return true
		}
	}
	return false
}

// treeState is where a node sits in the tree being scrubbed.
type treeState struct {
	parentTag string
	masked    bool
	editable  bool
	depth     int
}

func common(n obj, id float64) obj {
	out := obj{"type": num(n["type"]), "id": id}
	if f, ok := toNum(n["rootId"]); ok {
		out["rootId"] = f
	}
	if b, ok := anyBool(n["isShadowHost"]); ok {
		out["isShadowHost"] = b
	}
	if b, ok := anyBool(n["isShadow"]); ok {
		out["isShadow"] = b
	}
	return out
}

func children(n obj, state treeState, allow map[string]bool, ctx scrubContext) []any {
	out := []any{}
	if state.depth >= maxScrubDepth {
		return out
	}
	for _, c := range jsonList(n["childNodes"]) {
		if s, ok := scrubNode(c, state, allow, ctx); ok {
			out = append(out, s)
		}
	}
	return out
}

func scrubNode(v any, state treeState, allow map[string]bool, ctx scrubContext) (obj, bool) {
	n, ok := isObj(v)
	if !ok {
		return nil, false
	}
	id, ok := toNum(n["id"])
	if !ok {
		return nil, false
	}
	typ, ok := toNum(n["type"])
	if !ok {
		return nil, false
	}
	out := common(n, id)
	next := state
	next.depth++
	switch typ {
	case 0:
		if s, ok := n["compatMode"].(string); ok {
			out["compatMode"] = s
		}
		next.parentTag = ""
		out["childNodes"] = children(n, next, allow, ctx)
		return out, true
	case 1:
		for _, k := range []string{"name", "publicId", "systemId"} {
			s, _ := n[k].(string)
			out[k] = s
		}
		return out, true
	case 2:
		tagName, ok := n["tagName"].(string)
		if !ok {
			return nil, false
		}
		tag := asciiLower(tagName)
		attrs, _ := isObj(n["attributes"])
		editable := state.editable || tag == "textarea" || isContentEditable(attrs)
		masked := state.masked || editable || fixedMaskTags[tag] || len(attr(attrs, "data-o11y-mask")) > 0
		attrsAllowed := !masked && ctx.attrsAllowed(id)
		cssAllowed := !masked && ctx.stylesheetAllowed(id)
		editableHere := editable || ctx.editable(id)
		textAttrs := attrsAllowed && !editableHere && !stylesheetTags[tag]
		blocked := len(attr(attrs, "data-o11y-block")) > 0 || ctx.blocked(id)
		kept := attributes(attrs, textAttrs, cssAllowed, editableHere, false, allow)
		out["tagName"] = tagName
		if blocked {
			out["attributes"] = placeholder(kept)
			out["childNodes"] = []any{}
		} else {
			out["attributes"] = kept
			out["childNodes"] = children(n, treeState{parentTag: tag, masked: masked || editableHere, editable: editableHere, depth: next.depth}, allow, ctx)
		}
		if b, _ := anyBool(n["isSVG"]); b {
			out["isSVG"] = true
		}
		if b, ok := anyBool(n["needBlock"]); ok {
			out["needBlock"] = b
		}
		if b, _ := anyBool(n["isCustom"]); b {
			out["isCustom"] = true
		}
		return out, true
	case 3:
		parentTag := state.parentTag
		if state.depth == 0 {
			parentTag = ctx.parentTag(id)
		}
		r := textRule{
			parentTag: parentTag,
			allowed:   !state.masked && ctx.textAllowed(id),
			editable:  state.editable || ctx.editable(id),
		}
		text := ""
		if s, ok := n["textContent"].(string); ok {
			text = textValue(s, r, allow)
		}
		out["textContent"] = text
		if b, _ := anyBool(n["isStyle"]); b && parentTag == "style" {
			out["isStyle"] = true
		}
		return out, true
	case 4, 5:
		out["textContent"] = ""
		return out, true
	}
	return nil, false
}

func scrubRule(v any, allow map[string]bool) (obj, bool) {
	r, ok := isObj(v)
	if !ok {
		return nil, false
	}
	s, ok := r["rule"].(string)
	if !ok {
		return nil, false
	}
	out := obj{"rule": stripCSSURLs(s, allow)}
	if idx, ok := ruleIndex(r["index"]); ok {
		out["index"] = idx
	}
	return out, true
}

// ruleIndex returns a CSSOM rule index: a number or an array of numbers.
func ruleIndex(v any) (any, bool) {
	if f, ok := toNum(v); ok {
		return f, true
	}
	l, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := make([]any, len(l))
	for i, x := range l {
		f, ok := toNum(x)
		if !ok {
			return nil, false
		}
		out[i] = f
	}
	return out, true
}

// numList returns the numbers of v, dropping everything else.
func numList(v any) []any {
	out := []any{}
	for _, x := range jsonList(v) {
		if f, ok := toNum(x); ok {
			out = append(out, f)
		}
	}
	return out
}

func mutationData(data obj, allow map[string]bool, ctx scrubContext) obj {
	texts := []any{}
	for _, v := range jsonList(data["texts"]) {
		t, ok := isObj(v)
		if !ok {
			continue
		}
		id, ok := toNum(t["id"])
		if !ok || ctx.blocked(id) {
			continue
		}
		if t["value"] == nil {
			if _, present := t["value"]; present {
				texts = append(texts, obj{"id": id, "value": nil})
			}
			continue
		}
		s, ok := t["value"].(string)
		if !ok {
			continue
		}
		r := textRule{parentTag: ctx.parentTag(id), allowed: ctx.textAllowed(id), editable: ctx.editable(id)}
		texts = append(texts, obj{"id": id, "value": textValue(s, r, allow)})
	}
	attrs := []any{}
	for _, v := range jsonList(data["attributes"]) {
		a, ok := isObj(v)
		if !ok {
			continue
		}
		id, ok := toNum(a["id"])
		if !ok {
			continue
		}
		m, ok := isObj(a["attributes"])
		if !ok {
			continue
		}
		editable := ctx.editable(id)
		kept := attributes(m, ctx.attrsAllowed(id) && !editable, ctx.stylesheetAllowed(id), editable, true, allow)
		if ctx.blocked(id) {
			kept = placeholder(kept)
		}
		if len(kept) > 0 {
			attrs = append(attrs, obj{"id": id, "attributes": kept})
		}
	}
	removes := []any{}
	for _, v := range jsonList(data["removes"]) {
		r, ok := isObj(v)
		if !ok {
			continue
		}
		parent, ok1 := toNum(r["parentId"])
		id, ok2 := toNum(r["id"])
		if !ok1 || !ok2 {
			continue
		}
		removes = append(removes, merge(obj{"parentId": parent, "id": id}, booleans(r, "isShadow")))
	}
	adds := []any{}
	for _, v := range jsonList(data["adds"]) {
		a, ok := isObj(v)
		if !ok {
			continue
		}
		parent, ok := toNum(a["parentId"])
		if !ok || ctx.blocked(parent) {
			continue
		}
		n, ok := scrubNode(a["node"], treeState{}, allow, ctx)
		if !ok {
			continue
		}
		out := obj{"parentId": parent, "nextId": nil}
		if f, ok := toNum(a["nextId"]); ok {
			out["nextId"] = f
		}
		if f, ok := toNum(a["previousId"]); ok {
			out["previousId"] = f
		} else if prev, present := a["previousId"]; present && prev == nil {
			out["previousId"] = nil
		}
		out["node"] = n
		adds = append(adds, out)
	}
	out := obj{"source": float64(0), "texts": texts, "attributes": attrs, "removes": removes, "adds": adds}
	if b, _ := anyBool(data["isAttachIframe"]); b {
		out["isAttachIframe"] = true
	}
	return out
}

func positions(data obj) []any {
	out := []any{}
	for _, v := range jsonList(data["positions"]) {
		p, ok := isObj(v)
		if !ok {
			continue
		}
		if kept := numbers(p, "x", "y", "id", "timeOffset"); len(kept) == 4 {
			out = append(out, kept)
		}
	}
	return out
}

// cssomAllowed reports whether a CSSOM rule or declaration edit (source 8
// or 13) may be kept: one aimed at an element ID needs that element's
// stylesheet allowed, as its inlined stylesheet does. An edit to a
// constructed stylesheet, named by styleId alone, is kept.
func cssomAllowed(data obj, ctx scrubContext) bool {
	id, ok := toNum(data["id"])
	return !ok || ctx.stylesheetAllowed(id)
}

// incremental reduces an incremental snapshot's data to the fields of its
// source, false to drop it.
func incremental(data obj, allow map[string]bool, ctx scrubContext) (obj, bool) {
	source, ok := toNum(data["source"])
	if !ok {
		return nil, false
	}
	src := obj{"source": source}
	switch source {
	case 0:
		return mutationData(data, allow, ctx), true
	case 1, 6, 12:
		return merge(src, obj{"positions": positions(data)}), true
	case 2:
		return merge(src, numbers(data, "type", "id", "x", "y", "pointerType")), true
	case 3:
		return merge(src, numbers(data, "id", "x", "y")), true
	case 4:
		return merge(src, numbers(data, "width", "height")), true
	case 7:
		return merge(src, numbers(data, "type", "id", "currentTime", "volume", "playbackRate"), booleans(data, "muted", "loop")), true
	case 8:
		if !cssomAllowed(data, ctx) {
			return nil, false
		}
		out := merge(src, numbers(data, "id", "styleId"))
		if adds, ok := data["adds"].([]any); ok {
			kept := []any{}
			for _, r := range adds {
				if s, ok := scrubRule(r, allow); ok {
					kept = append(kept, s)
				}
			}
			out["adds"] = kept
		}
		if removes, ok := data["removes"].([]any); ok {
			kept := []any{}
			for _, r := range removes {
				if m, ok := isObj(r); ok {
					if idx, ok := ruleIndex(m["index"]); ok {
						kept = append(kept, obj{"index": idx})
					}
				}
			}
			out["removes"] = kept
		}
		if s, ok := data["replace"].(string); ok {
			out["replace"] = stripCSSURLs(s, allow)
		}
		if s, ok := data["replaceSync"].(string); ok {
			out["replaceSync"] = stripCSSURLs(s, allow)
		}
		return out, true
	case 13:
		if !cssomAllowed(data, ctx) {
			return nil, false
		}
		out := merge(src, numbers(data, "id", "styleId"))
		out["index"] = numList(data["index"])
		if set, ok := isObj(data["set"]); ok {
			if prop, ok := set["property"].(string); ok {
				s := obj{"property": prop, "value": nil}
				if v, ok := set["value"].(string); ok {
					s["value"] = stripCSSValue(v, allow)
				}
				if p, ok := set["priority"].(string); ok && (p == "important" || p == "") {
					s["priority"] = p
				}
				out["set"] = s
			}
		}
		if rm, ok := isObj(data["remove"]); ok {
			if prop, ok := rm["property"].(string); ok {
				out["remove"] = obj{"property": prop}
			}
		}
		return out, true
	case 14:
		ranges := []any{}
		for _, v := range jsonList(data["ranges"]) {
			r, ok := isObj(v)
			if !ok {
				continue
			}
			kept := numbers(r, "start", "startOffset", "end", "endOffset")
			if len(kept) != 4 {
				continue
			}
			// Offsets in editable text track the caret as the user types.
			if ctx.editable(kept["start"].(float64)) || ctx.editable(kept["end"].(float64)) {
				continue
			}
			ranges = append(ranges, kept)
		}
		return merge(src, obj{"ranges": ranges}), true
	case 15:
		out := merge(src, numbers(data, "id"))
		out["styleIds"] = numList(data["styleIds"])
		if styles, ok := data["styles"].([]any); ok {
			kept := []any{}
			for _, v := range styles {
				s, ok := isObj(v)
				if !ok {
					continue
				}
				styleID, ok := toNum(s["styleId"])
				if !ok {
					continue
				}
				rules := []any{}
				for _, r := range jsonList(s["rules"]) {
					if sr, ok := scrubRule(r, allow); ok {
						rules = append(rules, sr)
					}
				}
				kept = append(kept, obj{"styleId": styleID, "rules": rules})
			}
			out["styles"] = kept
		}
		return out, true
	case 16:
		if def, ok := isObj(data["define"]); ok {
			if name, ok := def["name"].(string); ok {
				src["define"] = obj{"name": name}
			}
		}
		return src, true
	}
	return nil, false
}

// scrubEvent applies the privacy rules to one rrweb event. It returns
// false when the event must not be stored. It never changes its input.
func scrubEvent(event any, allow map[string]bool, ctx scrubContext) (obj, bool) {
	e, ok := isObj(event)
	if !ok {
		return nil, false
	}
	typ, ok1 := toNum(e["type"])
	ts, ok2 := toNum(e["timestamp"])
	if !ok1 || !ok2 {
		return nil, false
	}
	data, ok := isObj(e["data"])
	if !ok {
		data = obj{}
	}
	out := obj{"type": typ, "timestamp": ts}
	switch typ {
	case 0, 1:
		out["data"] = obj{}
	case 2:
		root, ok := scrubNode(data["node"], treeState{}, allow, ctx)
		if !ok {
			return nil, false
		}
		offset := obj{"top": float64(0), "left": float64(0)}
		if io, ok := isObj(data["initialOffset"]); ok {
			merge(offset, numbers(io, "top", "left"))
		}
		out["data"] = obj{"node": root, "initialOffset": offset}
	case 3:
		d, ok := incremental(data, allow, ctx)
		if !ok {
			return nil, false
		}
		out["data"] = d
	case 4:
		href := ""
		if s, ok := data["href"].(string); ok {
			href = stripURL(s, allow)
		}
		out["data"] = merge(obj{"href": href}, numbers(data, "width", "height"))
	default:
		return nil, false
	}
	return out, true
}

// scrubMode chooses how much text the gateway keeps.
type scrubMode uint8

const (
	// scrubStrict masks all text but stylesheets: the default.
	scrubStrict scrubMode = iota
	// scrubTrust keeps text as the client sent it, for an app whose
	// replay.unmasked_text is set.
	scrubTrust
)

// Reasons an event is dropped, recorded in o11yrum.replay.events.dropped.
const (
	dropInvalid = "invalid" // not an event, or a snapshot without a root
	dropType    = "type"    // an event type that is never stored
	dropInput   = "input"   // an input event
	dropCanvas  = "canvas"  // a canvas mutation
	dropFont    = "font"    // a font load
	dropLog     = "log"     // a console log
	dropSource  = "source"  // any other incremental source not stored
	// dropStylesheet is a CSSOM edit (source 8 or 13) aimed at an element
	// whose stylesheet is not allowed.
	dropStylesheet = "stylesheet"
)

// scrubStats counts dropped events by reason.
type scrubStats map[string]int64

// dropReason says why scrubEvent dropped e.
func dropReason(e any) string {
	m, ok := isObj(e)
	if !ok {
		return dropInvalid
	}
	typ, ok1 := toNum(m["type"])
	_, ok2 := toNum(m["timestamp"])
	switch {
	case !ok1 || !ok2:
		return dropInvalid
	case typ == 2:
		return dropInvalid
	case typ != 3:
		return dropType
	}
	data, _ := isObj(m["data"])
	switch source, _ := toNum(data["source"]); source {
	case 5:
		return dropInput
	case 9:
		return dropCanvas
	case 10:
		return dropFont
	case 11:
		return dropLog
	case 8, 13:
		return dropStylesheet
	}
	return dropSource
}

// scrubSegment scrubs the events of one segment in order and returns the
// kept ones, with the dropped ones counted by reason. allow is the app's
// query parameter allow-list.
func scrubSegment(events []any, mode scrubMode, allow map[string]bool) ([]any, scrubStats) {
	model := newSegmentModel(mode)
	stats := scrubStats{}
	out := make([]any, 0, len(events))
	for _, e := range events {
		model.observe(e)
		if s, ok := scrubEvent(e, allow, model); ok {
			out = append(out, s)
		} else {
			stats[dropReason(e)]++
		}
	}
	return out, stats
}

// maxModelHops bounds the ancestor walk of the segment model. A longer
// chain, or a cycle, fails closed: masked, editable, blocked and in
// conflict.
const maxModelHops = maxScrubDepth

// Every ancestor walk of one segment shares a budget of
// hopBudgetPerNode hops per recorded node plus hopBudgetBase. A segment
// that spends it, which only a crafted one can, is answered fail closed
// from then on, so its cost stays linear in its size.
const (
	hopBudgetPerNode = 64
	hopBudgetBase    = 1 << 16
)

// modelNode is what a segment says about one node. Its flags are its own
// (from its tag and attributes) and only ever turn on: a node moved to a
// new parent keeps the masks of the old one, and an attribute mutation
// can add a mask but never remove one. A node serialized again with
// another kind, tag or parent is a conflict, which allows no text in
// strict mode, for it or for its children.
type modelNode struct {
	text      bool
	tag       string // lowercase, elements only
	parent    float64
	hasParent bool
	masked    bool // input, textarea, select, option, contenteditable or data-o11y-mask
	editable  bool // textarea or contenteditable
	blocked   bool // data-o11y-block
	conflict  bool
	stub      bool // known only from an attribute mutation
}

// resolved is a node's flags with its ancestors' folded in.
type resolved struct {
	masked, editable, blocked, conflict bool
}

var failClosed = resolved{masked: true, editable: true, blocked: true, conflict: true}

// segmentModel answers scrubContext from what the segment's full
// snapshots, added nodes and attribute mutations say. A segment is
// self-contained, so every node a conforming client mentions is in it. It
// holds nothing across segments. Each node keeps its parent's ID, and a
// question walks the ancestors as they stand, so a mask set later, or a
// parent added after its child, still counts.
type segmentModel struct {
	mode      scrubMode
	nodes     map[float64]*modelNode
	cache     map[float64]resolved // valid until the model next changes
	hops      int                  // ancestor hops walked so far
	exhausted bool                 // the hop budget is spent
}

func newSegmentModel(mode scrubMode) *segmentModel {
	return &segmentModel{mode: mode, nodes: map[float64]*modelNode{}, cache: map[float64]resolved{}}
}

// observe records what e says about the page, before e is scrubbed, as
// the collector's DOM already holds it when it scrubs.
func (m *segmentModel) observe(e any) {
	ev, ok := isObj(e)
	if !ok {
		return
	}
	data, _ := isObj(ev["data"])
	switch typ, _ := toNum(ev["type"]); typ {
	case 2:
		// A full snapshot describes the whole page again, but only a root
		// the scrubber accepts replaces what is known.
		if !validRoot(data["node"]) {
			return
		}
		clear(m.cache)
		clear(m.nodes)
		m.walk(data["node"], 0, false, 0)
	case 3:
		if source, ok := toNum(data["source"]); !ok || source != 0 {
			return
		}
		for _, v := range jsonList(data["adds"]) {
			if a, ok := isObj(v); ok {
				if parentID, ok := toNum(a["parentId"]); ok {
					m.walk(a["node"], parentID, true, 0)
				}
			}
		}
		for _, v := range jsonList(data["attributes"]) {
			a, ok := isObj(v)
			if !ok {
				continue
			}
			id, ok := toNum(a["id"])
			attrs, ok2 := isObj(a["attributes"])
			if !ok || !ok2 {
				continue
			}
			m.markAttributes(id, attrs)
		}
	}
}

// validRoot reports whether scrubNode would keep v as a snapshot root.
func validRoot(v any) bool {
	n, ok := isObj(v)
	if !ok {
		return false
	}
	_, okID := toNum(n["id"])
	typ, okType := toNum(n["type"])
	if !okID || !okType || typ != math.Trunc(typ) || typ < 0 || typ > 5 {
		return false
	}
	_, isString := n["tagName"].(string)
	return typ != 2 || isString
}

// markAttributes turns on the flags an attribute mutation sets. A removal
// (null) changes nothing, since flags only turn on.
func (m *segmentModel) markAttributes(id float64, attrs obj) {
	set := func(name string) bool {
		for _, v := range attr(attrs, name) {
			if v != nil {
				return true
			}
		}
		return false
	}
	editable := isContentEditable(attrs)
	masked := editable || set("data-o11y-mask")
	blocked := set("data-o11y-block")
	if !masked && !blocked {
		return
	}
	n := m.nodes[id]
	if n == nil {
		n = &modelNode{stub: true}
		m.nodes[id] = n
	}
	if n.text || (n.masked || !masked) && (n.editable || !editable) && (n.blocked || !blocked) {
		return
	}
	n.masked = n.masked || masked
	n.editable = n.editable || editable
	n.blocked = n.blocked || blocked
	m.changed()
}

// changed drops the memoized answers after the model changed.
func (m *segmentModel) changed() {
	if len(m.cache) > 0 {
		clear(m.cache)
	}
}

// walk records v and its subtree under parent, following scrubNode's
// reading of a node and its depth cut.
func (m *segmentModel) walk(v any, parent float64, hasParent bool, depth int) {
	n, ok := isObj(v)
	if !ok {
		return
	}
	id, ok1 := toNum(n["id"])
	typ, ok2 := toNum(n["type"])
	if !ok1 || !ok2 {
		return
	}
	node := modelNode{parent: parent, hasParent: hasParent}
	switch typ {
	case 0, 1, 4, 5:
	case 2:
		tagName, ok := n["tagName"].(string)
		if !ok {
			return
		}
		attrs, _ := isObj(n["attributes"])
		node.tag = asciiLower(tagName)
		node.editable = node.tag == "textarea" || isContentEditable(attrs)
		node.masked = node.editable || fixedMaskTags[node.tag] || len(attr(attrs, "data-o11y-mask")) > 0
		node.blocked = len(attr(attrs, "data-o11y-block")) > 0
	case 3:
		node.text = true
	default:
		return
	}
	m.record(id, node)
	if (typ != 0 && typ != 2) || depth+1 >= maxScrubDepth {
		return
	}
	for _, c := range jsonList(n["childNodes"]) {
		m.walk(c, id, true, depth+1)
	}
}

func (m *segmentModel) record(id float64, n modelNode) {
	old := m.nodes[id]
	switch {
	case old == nil:
		// A new node can be the missing parent of one already answered.
		m.nodes[id] = &n
		m.changed()
		return
	case old.stub:
		n.masked = n.masked || old.masked
		n.editable = n.editable || old.editable
		n.blocked = n.blocked || old.blocked
		*old = n
		m.changed()
		return
	}
	before := *old
	if old.text != n.text || old.tag != n.tag {
		old.conflict = true
	}
	if old.hasParent != n.hasParent || old.parent != n.parent {
		// A move: the node keeps what its old place masked.
		r := m.walkUp(id)
		old.masked = old.masked || r.masked
		old.editable = old.editable || r.editable
		old.blocked = old.blocked || r.blocked
		old.conflict = true
		old.parent, old.hasParent = n.parent, n.hasParent
	}
	old.masked = old.masked || n.masked
	old.editable = old.editable || n.editable
	old.blocked = old.blocked || n.blocked
	if *old != before {
		m.changed()
	}
}

// spend charges hops to the segment's budget and reports whether any is
// left.
func (m *segmentModel) spend(hops int) bool {
	m.hops += hops
	if m.hops > hopBudgetPerNode*len(m.nodes)+hopBudgetBase {
		m.exhausted = true
	}
	return !m.exhausted
}

// resolve returns id's flags with its ancestors' folded in, memoized
// until the model next changes. The walk stops at a node with no known
// parent.
func (m *segmentModel) resolve(id float64) resolved {
	if m.exhausted {
		return failClosed
	}
	if r, ok := m.cache[id]; ok {
		return r
	}
	var path []float64
	cur := id
	base := resolved{}
	for {
		if r, ok := m.cache[cur]; ok {
			base = r
			break
		}
		n := m.nodes[cur]
		if n == nil {
			break
		}
		if len(path) >= maxModelHops {
			// Too deep, or a cycle.
			for _, p := range path {
				m.cache[p] = failClosed
			}
			return failClosed
		}
		path = append(path, cur)
		if !n.hasParent {
			break
		}
		cur = n.parent
	}
	if !m.spend(len(path)) {
		return failClosed
	}
	for i := len(path) - 1; i >= 0; i-- {
		n := m.nodes[path[i]]
		base = resolved{
			masked:   base.masked || n.masked,
			editable: base.editable || n.editable,
			blocked:  base.blocked || n.blocked,
			conflict: base.conflict || n.conflict,
		}
		m.cache[path[i]] = base
	}
	return m.cache[id]
}

// walkUp is resolve without the cache, for use while the model changes.
func (m *segmentModel) walkUp(id float64) resolved {
	if m.exhausted {
		return failClosed
	}
	var r resolved
	cur, hops := id, 0
	for {
		n := m.nodes[cur]
		if n == nil {
			break
		}
		if hops >= maxModelHops {
			r = failClosed
			break
		}
		hops++
		r.masked = r.masked || n.masked
		r.editable = r.editable || n.editable
		r.blocked = r.blocked || n.blocked
		r.conflict = r.conflict || n.conflict
		if !n.hasParent {
			break
		}
		cur = n.parent
	}
	if !m.spend(hops) {
		return failClosed
	}
	return r
}

// trustAllowed is trust mode's answer: the client decided, unless the
// segment's own tree masks or blocks the node.
func (m *segmentModel) trustAllowed(id float64) bool {
	r := m.resolve(id)
	return !r.masked && !r.blocked
}

func (m *segmentModel) textAllowed(id float64) bool {
	if m.mode == scrubTrust {
		return m.trustAllowed(id)
	}
	// Strict: only the text of a style element, neither in conflict.
	n := m.nodes[id]
	if n == nil || !n.text || !n.hasParent {
		return false
	}
	p := m.nodes[n.parent]
	if p == nil || p.text || p.tag != "style" {
		return false
	}
	r := m.resolve(id)
	return !r.masked && !r.blocked && !r.conflict
}

// stylesheetAllowed keeps the inlined stylesheet of a style or link
// element.
func (m *segmentModel) stylesheetAllowed(id float64) bool {
	if m.mode == scrubTrust {
		return m.trustAllowed(id)
	}
	n := m.nodes[id]
	if n == nil || n.text || !stylesheetTags[n.tag] {
		return false
	}
	r := m.resolve(id)
	return !r.masked && !r.blocked && !r.conflict
}

// attrsAllowed keeps masked attributes in trust mode only.
func (m *segmentModel) attrsAllowed(id float64) bool {
	return m.mode == scrubTrust && m.trustAllowed(id)
}

func (m *segmentModel) parentTag(id float64) string {
	n := m.nodes[id]
	if n == nil || !n.hasParent {
		return ""
	}
	p := m.nodes[n.parent]
	if p == nil || m.resolve(id).conflict {
		return ""
	}
	return p.tag
}

func (m *segmentModel) editable(id float64) bool { return m.resolve(id).editable }

func (m *segmentModel) blocked(id float64) bool { return m.resolve(id).blocked }
