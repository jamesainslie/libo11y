package o11yrum

import (
	"fmt"
	"maps"
	"slices"
	"strings"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/ptrace"

	"github.com/jamesainslie/libo11y/go/o11yrum/internal/rumspec"
)

// Reasons a record is dropped. They appear in the partial success message
// and, from R4b, in self-telemetry.
const (
	reasonSpanID            = "span_id"
	reasonSpanTime          = "span_time"
	reasonRUMShape          = "rum_shape"
	reasonEventRequired     = "event_required"
	reasonEventUnregistered = "event_unregistered"
)

// dropCounts counts records dropped, by reason.
type dropCounts map[string]int64

func (d dropCounts) total() int64 {
	var n int64
	for _, c := range d {
		n += c
	}
	return n
}

// message renders the counts for an OTLP partial success, sorted by
// reason: "o11yrum dropped 3 records: event_required=1, rum_shape=2". It
// is empty when nothing was dropped.
func (d dropCounts) message() string {
	total := d.total()
	if total == 0 {
		return ""
	}
	parts := make([]string, 0, len(d))
	for _, r := range slices.Sorted(maps.Keys(d)) {
		if d[r] > 0 {
			parts = append(parts, fmt.Sprintf("%s=%d", r, d[r]))
		}
	}
	return fmt.Sprintf("o11yrum dropped %d records: %s", total, strings.Join(parts, ", "))
}

// validator checks and cleans one batch in place for one app.
type validator struct {
	policy       attrPolicy
	limits       LimitsConfig
	attrsRemoved int64 // attributes removed across the batch, for self-telemetry
}

// serverOnlyResourcePrefixes are resource keys only a server may set. A
// client claiming them is either misconfigured or lying.
var serverOnlyResourcePrefixes = []string{"host.", "k8s.", "container.", "cloud.", "process.", "faas."}

func (v *validator) resource(res pcommon.Resource) {
	attrs := res.Attributes()
	attrs.RemoveIf(func(k string, _ pcommon.Value) bool {
		if k == "service.instance.id" || hasAnyPrefix(k, serverOnlyResourcePrefixes) {
			v.attrsRemoved++
			return true
		}
		return false
	})
	v.filter(attrs)
}

// filter applies the attribute policy to m and counts what it removed.
func (v *validator) filter(m pcommon.Map) {
	v.attrsRemoved += int64(v.policy.apply(m))
}

func (v *validator) truncate(s string) string { return truncateUTF8(s, v.limits.MaxValueLength) }

// traces validates td in place and returns the spans it dropped, by
// reason. Scopes and resources left empty are removed.
func (v *validator) traces(td ptrace.Traces) dropCounts {
	drops := dropCounts{}
	td.ResourceSpans().RemoveIf(func(rs ptrace.ResourceSpans) bool {
		v.resource(rs.Resource())
		res := rs.Resource().Attributes()
		rs.ScopeSpans().RemoveIf(func(ss ptrace.ScopeSpans) bool {
			v.filter(ss.Scope().Attributes())
			ss.Spans().RemoveIf(func(s ptrace.Span) bool {
				if reason := v.span(s, res); reason != "" {
					drops[reason]++
					return true
				}
				return false
			})
			return ss.Spans().Len() == 0
		})
		return rs.ScopeSpans().Len() == 0
	})
	return drops
}

// span validates one span in place and returns why it must be dropped.
func (v *validator) span(s ptrace.Span, res pcommon.Map) string {
	if s.TraceID().IsEmpty() || s.SpanID().IsEmpty() {
		return reasonSpanID
	}
	if s.StartTimestamp() == 0 || s.EndTimestamp() < s.StartTimestamp() {
		return reasonSpanTime
	}
	s.SetName(v.truncate(s.Name()))
	s.Status().SetMessage(v.truncate(s.Status().Message()))
	attrs := s.Attributes()
	// The shape claim is read before the policy runs, so a span whose
	// claiming attribute is removed as an invalid value still counts as
	// that shape and fails its requirements below.
	shape, claimed := defaultShapes.shape(attrs)
	v.filter(attrs)
	events := s.Events()
	if events.Len() > v.limits.MaxSpanEvents {
		events.RemoveIf(keepFirst[ptrace.SpanEvent](v.limits.MaxSpanEvents))
	}
	for i := range events.Len() {
		e := events.At(i)
		e.SetName(v.truncate(e.Name()))
		v.filter(e.Attributes())
	}
	links := s.Links()
	if links.Len() > v.limits.MaxSpanLinks {
		links.RemoveIf(keepFirst[ptrace.SpanLink](v.limits.MaxSpanLinks))
	}
	for i := range links.Len() {
		v.filter(links.At(i).Attributes())
	}
	if missingRUM(attrLookup{record: attrs, resource: res}, shape, claimed) {
		return reasonRUMShape
	}
	return ""
}

// rumBaseRequired are the attributes every RUM span and event carries.
var rumBaseRequired = []string{keySessionID, keyViewID}

// missingRUM reports whether a span lacks an attribute its RUM shape
// requires. A span that claims a shape the table does not define, or more
// than one, always fails. A span that claims no shape but carries an
// o11y.rum.* attribute or a session.id must carry the base RUM IDs.
func missingRUM(l attrLookup, shape string, claimed bool) bool {
	var required []string
	switch {
	case claimed && shape == "":
		return true
	case claimed:
		required = rumspec.RUMSpanRequired[shape]
	case hasPrefix(l.record, "o11y.rum.") || l.has(keySessionID):
		required = rumBaseRequired
	}
	for _, k := range required {
		if !l.has(k) {
			return true
		}
	}
	return false
}

// logs validates ld in place and returns the records it dropped, by
// reason. Scopes and resources left empty are removed.
func (v *validator) logs(ld plog.Logs) dropCounts {
	drops := dropCounts{}
	ld.ResourceLogs().RemoveIf(func(rl plog.ResourceLogs) bool {
		v.resource(rl.Resource())
		res := rl.Resource().Attributes()
		rl.ScopeLogs().RemoveIf(func(sl plog.ScopeLogs) bool {
			v.filter(sl.Scope().Attributes())
			sl.LogRecords().RemoveIf(func(lr plog.LogRecord) bool {
				if reason := v.logRecord(lr, res); reason != "" {
					drops[reason]++
					return true
				}
				return false
			})
			return sl.LogRecords().Len() == 0
		})
		return rl.ScopeLogs().Len() == 0
	})
	return drops
}

// logRecord validates one record in place and returns why it must be
// dropped.
func (v *validator) logRecord(lr plog.LogRecord, res pcommon.Map) string {
	v.filter(lr.Attributes())
	body := lr.Body()
	switch body.Type() {
	case pcommon.ValueTypeStr:
		body.SetStr(v.truncate(body.Str()))
	case pcommon.ValueTypeMap:
		v.filter(body.Map())
	case pcommon.ValueTypeSlice:
		if !v.policy.keepSlice(body.Slice()) {
			lr.Body().SetEmptySlice()
		}
	case pcommon.ValueTypeBytes:
		pcommon.NewValueEmpty().CopyTo(body)
	}
	name := eventName(lr)
	required, registered := rumspec.Events[name]
	switch {
	case registered:
		l := attrLookup{record: lr.Attributes(), resource: res}
		for _, k := range required {
			if !l.has(k) {
				return reasonEventRequired
			}
		}
	case strings.HasPrefix(name, "o11y."):
		return reasonEventUnregistered
	}
	return ""
}

// eventName reads the event name from the record's EventName field, or
// from the event.name attribute that older SDKs use.
func eventName(lr plog.LogRecord) string {
	if n := lr.EventName(); n != "" {
		return n
	}
	if v, ok := lr.Attributes().Get(keyEventName); ok && v.Type() == pcommon.ValueTypeStr {
		return v.Str()
	}
	return ""
}

// attrLookup reads a record attribute, falling back to its resource.
type attrLookup struct{ record, resource pcommon.Map }

func (l attrLookup) get(k string) (pcommon.Value, bool) {
	if v, ok := l.record.Get(k); ok {
		return v, true
	}
	return l.resource.Get(k)
}

func (l attrLookup) has(k string) bool {
	_, ok := l.get(k)
	return ok
}

// hasPrefix reports whether any key of m starts with p.
func hasPrefix(m pcommon.Map, p string) bool {
	found := false
	m.Range(func(k string, _ pcommon.Value) bool {
		found = strings.HasPrefix(k, p)
		return !found
	})
	return found
}

func hasAnyPrefix(s string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

// keepFirst returns a RemoveIf predicate that keeps the first n elements.
func keepFirst[E any](n int) func(E) bool {
	i := 0
	return func(E) bool {
		i++
		return i > n
	}
}
