package o11y

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"reflect"
	"slices"
	"strconv"
	"strings"

	"go.opentelemetry.io/otel/attribute"

	"github.com/jamesainslie/libo11y/go/internal/spectables"
	"github.com/jamesainslie/libo11y/go/spec"
)

// classAction reports what classification did to one attribute, so callers
// track changes without comparing values (slog.Value.Equal panics on
// uncomparable values such as slices and maps).
type classAction int

const (
	actionKeep classAction = iota
	actionRewrite
	actionDrop
)

// sensitivityPolicy is the single enforcement point for the specification's
// sensitivity classification. One policy per SDK serves the classifying slog
// legs (console, OTLP, and extra sinks), the LoggerProvider's redacting
// processor (records from every other log bridge), the span wrappers around the
// exporter and any injected processor's OnEnd (span, event, and link
// attributes), and the metric views and exemplar reservoirs (data point and
// exemplar filtered attributes), and the resource. newSDK builds it before
// the violation counter exists, classifies the resource while it has no
// recorder (recording those counts afterwards), and attaches the recorder
// before any provider is handed out. Every signal asks
// the same policy what to do with a key, so the signals cannot drift apart.
//
// Classification is key-based, so a value logged under an entirely
// unclassified key escapes this layer; that residual gap is inherent and is
// the redact package's job (capture-time protection of the value itself).
//
// Known limitations, outside this layer by design:
//   - Map-valued span and metric attributes (attribute.MAP) are judged on
//     their own key only; their members are not walked. Log records walk
//     map members on every path.
//   - Log record bodies are not classified.
//   - Instrumentation scope attributes (set when a tracer, meter, or logger
//     is obtained) bypass every wrapper.
//   - An injected span processor's OnStart sees the live span before
//     redaction.
//   - Baggage is not classified.
//   - Metric streams always carry the policy's attribute filter, so an
//     instrument's experimental advisory attribute keys, which the SDK
//     applies only to streams without a filter, are not honoured.
type sensitivityPolicy struct {
	lookup func(attribute.Key) spectables.Sensitivity
	pii    PIIMode
	key    []byte // HMAC key for PIIHash tokens
	rec    *violationRecorder
}

// newSensitivityPolicy builds the policy from s. app holds the classes the
// application registries declare (nil when there are none); the policy
// consults it only for keys the specification leaves unclassified.
func newSensitivityPolicy(s *settings, app map[attribute.Key]spectables.Sensitivity, rec *violationRecorder) *sensitivityPolicy {
	lookup := s.sensitivity
	if lookup == nil {
		lookup = func(k attribute.Key) spectables.Sensitivity { return spectables.SensitivityOf[k] }
	}
	if len(app) > 0 {
		// Registry namespaces are disjoint from the specification's (the
		// validator refuses o11y, otel, and every semconv namespace), so a
		// spec answer, when there is one, never contradicts the registry.
		base := lookup
		lookup = func(k attribute.Key) spectables.Sensitivity {
			if class := base(k); class != spectables.Unclassified {
				return class
			}
			return app[k]
		}
	}
	return &sensitivityPolicy{lookup: lookup, pii: s.piiMode, key: s.piiHashKey, rec: rec}
}

// silent returns a copy of p that makes the same decisions and produces the
// same output but records no violations. It serves a second redaction of
// data another wrapper already counts, so one attribute is one violation.
func (p *sensitivityPolicy) silent() *sensitivityPolicy {
	quiet := *p
	quiet.rec = nil
	return &quiet
}

// classOf classifies key without recording anything: secret-classified keys
// are always dropped, and PII-classified keys are handled per the PII mode.
func (p *sensitivityPolicy) classOf(key attribute.Key) classAction {
	return p.actionFor(p.lookup(key))
}

// actionFor maps a sensitivity class to the action this policy takes on it.
func (p *sensitivityPolicy) actionFor(class spectables.Sensitivity) classAction {
	switch class {
	case spectables.Secret:
		return actionDrop
	case spectables.PII:
		switch p.pii {
		case PIIAllow:
			return actionKeep
		case PIIHash:
			return actionRewrite
		default: // PIIDrop
			return actionDrop
		}
	default:
		return actionKeep
	}
}

// decide classifies key and records a violation for every action taken.
func (p *sensitivityPolicy) decide(signal spec.Signal, key attribute.Key) classAction {
	return p.decideClass(signal, p.lookup(key))
}

// decideClass is decide for a class already looked up, so a caller that
// needs the class first does not look the key up twice.
func (p *sensitivityPolicy) decideClass(signal spec.Signal, class spectables.Sensitivity) classAction {
	act := p.actionFor(class)
	if act != actionKeep {
		p.rec.record(signal, ruleFor(class))
	}
	return act
}

// metricKeep reports whether a metric attribute may be exported. Metrics drop
// secret and PII attributes outright, even under PIIHash, because a distinct
// token per value would multiply series cardinality. Metric-side removals are
// not counted as violations: the filter runs on the measurement hot path.
// Every measurement on every stream runs it once per attribute (one table
// lookup each), and sampled exemplars run it again over the attributes the
// stream filtered out. It must never read p.rec, which newSDK attaches after the meter provider
// (and possibly its periodic reader and runtime metrics) is already running.
func (p *sensitivityPolicy) metricKeep(kv attribute.KeyValue) bool {
	switch p.lookup(kv.Key) {
	case spectables.Secret:
		return false
	case spectables.PII:
		return p.pii == PIIAllow
	default:
		return true
	}
}

// ruleFor names the violation rule for an attribute of the given class that
// classification dropped or rewrote.
func ruleFor(class spectables.Sensitivity) string {
	if class == spectables.Secret {
		return "secret_attribute"
	}
	return "pii_attribute"
}

// minPIIHashKeyLen is the shortest key PIIHash accepts: 256 bits, the
// SHA-256 output size, so the key is never the weakest part of the token.
const minPIIHashKeyLen = 32

// token renders the keyed, non-reversible replacement for a PII value under
// PIIHash: HMAC-SHA256, truncated to 128 bits, which keeps tokens joinable
// while making collisions negligible. v must be the canonical rendering from
// canonicalSlog or canonicalAttr, so one value tokenizes identically on every
// signal.
func (p *sensitivityPolicy) token(v string) string {
	mac := hmac.New(sha256.New, p.key)
	mac.Write([]byte(v)) // hash.Hash writes never fail
	return "hmac-sha256:" + hex.EncodeToString(mac.Sum(nil)[:16])
}

// slogLeaf classifies a leaf slog attribute whose effective grouped key has
// the given class.
func (p *sensitivityPolicy) slogLeaf(a slog.Attr, class spectables.Sensitivity) (slog.Attr, classAction) {
	switch act := p.decideClass(spec.SignalLogs, class); act {
	case actionDrop:
		return slog.Attr{}, act
	case actionRewrite:
		return slog.String(a.Key, p.token(canonicalSlog(a.Value))), act
	default:
		return a, act
	}
}

// kv classifies a flat OTel attribute for the given signal.
func (p *sensitivityPolicy) kv(signal spec.Signal, kv attribute.KeyValue) (attribute.KeyValue, classAction) {
	switch act := p.decide(signal, kv.Key); act {
	case actionDrop:
		return attribute.KeyValue{}, act
	case actionRewrite:
		return kv.Key.String(p.token(canonicalAttr(kv.Value))), act
	default:
		return kv, act
	}
}

// The canonical rendering is the hash input for PII tokens. Logs carry
// slog values and spans and the resource carry attribute values, whose own
// String methods disagree on slices (slog renders []string{"a", "b"} as
// "[a b]", attribute as a JSON array), so both are rendered here to one
// form: scalars as their strconv text (floats in the shortest 'g' form),
// slices as a JSON array of the elements' canonical forms, for example
// ["10.0.0.1","10.0.0.2"] and ["1","2"], and maps (Go maps on the slog path,
// map values on the attribute path, which is what a log bridge makes of a
// Go map) as a JSON object of the members' canonical forms with sorted keys,
// for example {"a":"x","b":"2"}; nested composites nest, as in
// [{"ip":"1"}]. Go pointers render as what they point to, and Go map keys
// that are not strings render with %+v, as otelslog renders them. Byte
// slices render as standard base64 on both paths, and slog values with a
// text form (net.IP, net.HardwareAddr, and other encoding.TextMarshaler or
// fmt.Stringer types) render as that text. Values with no counterpart on the
// other path (slog times, durations, and arbitrary types) fall back to their
// own String rendering.
//
// The form deliberately does not encode the type, so values that render to
// the same text share a token: the string "1", the integer 1, and the float
// 1.0 all render as 1, a net.IP shares a token with its string form, and a
// string that reads as a JSON array, such as ["1","2"], shares a token with
// the slice it spells. The value, not its Go or OTel type, is what PII joins
// on. A named slice type with its own String or MarshalText method hashes
// that text, not the JSON-array form, so it joins with an attribute holding
// the same text rather than with a slice attribute. Strings hash their raw
// bytes when scalar, but inside a slice they pass through JSON encoding,
// which replaces invalid UTF-8 with U+FFFD, so slice elements that differ
// only in invalid bytes share a token.

// canonicalAttr renders an attribute value in the canonical form.
func canonicalAttr(v attribute.Value) string {
	return renderCanonical(attrNode(v, 0, newCompositeWalk()))
}

// canonicalSlog renders a resolved slog value in the canonical form. A group
// renders as the object a log bridge makes of it (see groupNode).
func canonicalSlog(v slog.Value) string {
	if v.Kind() == slog.KindGroup {
		return renderCanonical(groupNode(v, 0, newCompositeWalk()))
	}
	return renderCanonical(slogNode(v))
}

// groupNode builds the canonical node of a slog group: an object of its
// members' canonical forms, which is what [attrNode] builds for the map a
// log bridge makes of the same group. It spends nodes from w the way
// attrNode does, one for the group and one for each member, and visits the
// members in sorted key order, so a group and its bridged map truncate, and
// tokenize, alike. A member group with an empty key is inlined, as slog
// handlers and bridges inline it, and a later member replaces an earlier
// one with the same key.
//
// One shape tokenizes differently on the two paths. The SDK's handler
// elides an empty group before classification, as slog asks of handlers,
// and a bridge that keeps it renders an empty object in its place.
func groupNode(v slog.Value, depth int, w *compositeWalk) any {
	if depth > maxCompositeDepth || !w.spend() {
		return canonicalTruncated
	}
	members := inlineGroups(v.Group())
	slices.SortStableFunc(members, func(a, b slog.Attr) int { return strings.Compare(a.Key, b.Key) })
	obj := make(map[string]any, len(members))
	for _, m := range members {
		switch m.Value.Kind() {
		case slog.KindGroup:
			obj[m.Key] = groupNode(m.Value, depth+1, w)
		case slog.KindAny:
			obj[m.Key] = anyNode(m.Value.Any(), depth+1, w)
		default:
			if depth+1 > maxCompositeDepth || !w.spend() {
				obj[m.Key] = canonicalTruncated
				continue
			}
			obj[m.Key] = slogNode(m.Value)
		}
	}
	return obj
}

// inlineGroups returns members with every value resolved and the members of
// each empty-keyed group in place of that group, at any depth.
func inlineGroups(members []slog.Attr) []slog.Attr {
	out := make([]slog.Attr, 0, len(members))
	for _, m := range members {
		m.Value = m.Value.Resolve()
		if m.Key == "" && m.Value.Kind() == slog.KindGroup {
			out = append(out, inlineGroups(m.Value.Group())...)
			continue
		}
		out = append(out, m)
	}
	return out
}

// canonicalAny renders an arbitrary slog payload in the canonical form.
func canonicalAny(x any) string { return renderCanonical(anyNode(x, 0, newCompositeWalk())) }

// A canonical node is a string (a scalar's canonical text), a []any (an
// array of nodes), or a map[string]any (an object of nodes). Composite
// values are built as one node tree and JSON-encoded once, so nesting never
// re-escapes already encoded text.

// renderCanonical renders a node: a scalar as its text, a composite as JSON.
func renderCanonical(n any) string {
	if s, ok := n.(string); ok {
		return s
	}
	out, _ := json.Marshal(n) // strings, []any and map[string]any of them always marshal
	return string(out)
}

// attrNode builds the canonical node of a bridge attribute value, the form
// a PII token hashes. It spends nodes from w the way [anyNode] spends them
// on the matching Go value on the slog path, so both paths render, and
// tokenize, the same value the same way: one node for the value itself and
// one for each element of a slice, scalar slices included, and each map
// member as a value of its own. A node past maxCompositeDepth, or once the
// budget is spent, renders as canonicalTruncated. Map members are visited
// in sorted key order so the truncation is deterministic. A byte slice is
// one node, rendered as base64, as on the slog path. An attribute value
// cannot refer to itself, so no cycle check is needed.
func attrNode(v attribute.Value, depth int, w *compositeWalk) any {
	if depth > maxCompositeDepth || !w.spend() {
		return canonicalTruncated
	}
	switch v.Type() {
	case attribute.BOOL:
		return strconv.FormatBool(v.AsBool())
	case attribute.INT64:
		return strconv.FormatInt(v.AsInt64(), 10)
	case attribute.FLOAT64:
		return canonicalFloat(v.AsFloat64())
	case attribute.STRING:
		return v.AsString()
	case attribute.BYTESLICE:
		return base64.StdEncoding.EncodeToString(v.AsByteSlice())
	case attribute.BOOLSLICE:
		return boundedArray(v.AsBoolSlice(), depth, w, func(b bool) any { return strconv.FormatBool(b) })
	case attribute.INT64SLICE:
		return boundedArray(v.AsInt64Slice(), depth, w, func(i int64) any { return strconv.FormatInt(i, 10) })
	case attribute.FLOAT64SLICE:
		return boundedArray(v.AsFloat64Slice(), depth, w, func(f float64) any { return canonicalFloat(f) })
	case attribute.STRINGSLICE:
		return boundedArray(v.AsStringSlice(), depth, w, func(s string) any { return s })
	case attribute.SLICE:
		return arrayNode(v.AsSlice(), func(e attribute.Value) any { return attrNode(e, depth+1, w) })
	case attribute.MAP:
		members := slices.Clone(v.AsMap())
		slices.SortStableFunc(members, func(a, b attribute.KeyValue) int { return strings.Compare(string(a.Key), string(b.Key)) })
		obj := make(map[string]any, len(members))
		for _, m := range members {
			obj[string(m.Key)] = attrNode(m.Value, depth+1, w)
		}
		return obj
	default:
		return v.String()
	}
}

// slogNode builds the canonical node of a resolved, non-group slog value.
func slogNode(v slog.Value) any {
	switch v.Kind() {
	case slog.KindBool:
		return strconv.FormatBool(v.Bool())
	case slog.KindInt64:
		return strconv.FormatInt(v.Int64(), 10)
	case slog.KindUint64:
		return strconv.FormatUint(v.Uint64(), 10)
	case slog.KindFloat64:
		return canonicalFloat(v.Float64())
	case slog.KindString:
		return v.String()
	case slog.KindAny:
		return anyNode(v.Any(), 0, newCompositeWalk())
	default:
		return v.String()
	}
}

// canonicalTruncated stands in for the part of a value the canonical walk
// does not render: anything nested deeper than maxCompositeDepth, a
// reference back into the current path (a cycle), and whatever remains once
// the walk's node budget is spent. A self-referencing or widely shared value
// therefore renders in bounded time and size.
const canonicalTruncated = "truncated"

// anyNode builds the canonical node of an arbitrary slog payload: plain byte
// slices as base64; types with a text form (encoding.TextMarshaler, then
// fmt.Stringer) as that text, so a net.IP or net.HardwareAddr matches the
// string a span would carry for it; non-nil pointers as what they point to;
// other slices and arrays as an array of their elements; maps as an object,
// keys rendered as a log bridge renders them and visited in sorted order so
// truncation is deterministic; scalars through their slog value; and
// anything else (structs, for example) with %+v, as otelslog renders it.
//
// The walk w bounds the rendering like the classifier's composite walk: a
// value whose rendering exceeds it is truncated, so its token is stable.
// [attrNode] spends nodes the same way on the bridge path, so maps,
// slices, and scalar slices truncate at the same point on both paths. A
// value whose Go form has levels the bridge's form lacks, such as a
// pointer, spends extra nodes here and can truncate, and tokenize,
// differently.
func anyNode(x any, depth int, w *compositeWalk) any {
	if depth > maxCompositeDepth || !w.spend() {
		return canonicalTruncated
	}
	if b, ok := x.([]byte); ok {
		return base64.StdEncoding.EncodeToString(b)
	}
	if text, ok := textForm(x); ok {
		return text
	}
	rv := reflect.ValueOf(x)
	switch rv.Kind() {
	case reflect.Pointer, reflect.Slice, reflect.Array, reflect.Map:
		if rv.Kind() == reflect.Pointer && rv.IsNil() {
			break
		}
		if !w.enter(rv) {
			return canonicalTruncated
		}
		defer w.leave()
	}
	switch rv.Kind() {
	case reflect.Pointer:
		if !rv.IsNil() {
			return anyNode(rv.Elem().Interface(), depth+1, w)
		}
	case reflect.Slice, reflect.Array:
		arr := make([]any, rv.Len())
		for i := range arr {
			arr[i] = anyNode(rv.Index(i).Interface(), depth+1, w)
		}
		return arr
	case reflect.Map:
		keys := rv.MapKeys()
		names := make([]string, len(keys))
		order := make([]int, len(keys))
		for i, k := range keys {
			names[i], order[i] = mapKey(k), i
		}
		slices.SortFunc(order, func(a, b int) int { return strings.Compare(names[a], names[b]) })
		obj := make(map[string]any, len(keys))
		for _, i := range order {
			obj[names[i]] = anyNode(rv.MapIndex(keys[i]).Interface(), depth+1, w)
		}
		return obj
	}
	if v := slog.AnyValue(x); v.Kind() != slog.KindAny {
		return slogNode(v)
	}
	return fmt.Sprintf("%+v", x)
}

// textForm returns the text of a value implementing encoding.TextMarshaler
// (when MarshalText succeeds) or else fmt.Stringer, and whether it has one.
// These are caller-defined methods running inside the host's log call, so a
// panic in either (a nil receiver or a nil field, for example) is recovered
// and the value falls back to fmt.Sprint, which recovers panics itself.
func textForm(x any) (text string, ok bool) {
	defer func() {
		if recover() != nil {
			text, ok = fmt.Sprint(x), true
		}
	}()
	if m, isMarshaler := x.(encoding.TextMarshaler); isMarshaler {
		if b, err := m.MarshalText(); err == nil {
			return string(b), true
		}
	}
	if s, isStringer := x.(fmt.Stringer); isStringer {
		return s.String(), true
	}
	return "", false
}

// canonicalFloat renders a float in the shortest form that round-trips.
func canonicalFloat(f float64) string { return strconv.FormatFloat(f, 'g', -1, 64) }

// boundedArray renders the elements of a scalar slice held at depth,
// spending one node per element as [anyNode] does for each element of a Go
// slice, so an element past the bound or the budget is canonicalTruncated.
func boundedArray[T any](elems []T, depth int, w *compositeWalk, node func(T) any) []any {
	arr := make([]any, len(elems))
	for i, e := range elems {
		if depth+1 > maxCompositeDepth || !w.spend() {
			arr[i] = canonicalTruncated
			continue
		}
		arr[i] = node(e)
	}
	return arr
}

// arrayNode builds an array node from elems, rendering each with node.
func arrayNode[T any](elems []T, node func(T) any) []any {
	arr := make([]any, len(elems))
	for i, e := range elems {
		arr[i] = node(e)
	}
	return arr
}
