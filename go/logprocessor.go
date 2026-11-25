package o11y

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	sdklog "go.opentelemetry.io/otel/sdk/log"

	"github.com/jamesainslie/libo11y/go/spec"
)

// redactingLogProcessor enforces the sensitivity policy on every record the
// SDK's LoggerProvider emits, whichever bridge produced it (otelslog,
// otelzap, otellogr, and so on). It is registered before the batch
// processor and runs synchronously; sdk/log documents that a processor's
// synchronous changes to the record are visible to the next one. Map values,
// and maps inside slices, are walked so grouped attributes are judged on
// their dotted effective keys; a value under a classified key is judged as
// one value. The walk is bounded by the slog path's depth bound and node
// budget and fails closed at either, dropping what it did not examine. The
// record body is not classified.
//
// Records from the SDK's own slog pipeline are skipped: that leg classifies
// slog values before the bridge converts them (see [classifyingHandler]),
// which keeps its tokens identical to the console's for values with a text
// form such as net.IP, and classifying them again would hash a token. That
// leg walks Go maps (and slices of them) logged as one slog value on their
// dotted member keys, as this processor walks the map values a bridge makes
// of them, so both paths drop or tokenize the same members.
type redactingLogProcessor struct {
	policy *sensitivityPolicy
}

// Enabled reports true: the redactor cannot tell from the parameters
// whether a record carries classified attributes, and sdk/log asks
// processors to default to true when undecided. The batch processor
// registered after it also always reports true, so this changes no
// Logger.Enabled result.
func (redactingLogProcessor) Enabled(context.Context, sdklog.EnabledParameters) bool { return true }

// OnEmit drops or tokenizes classified attributes in place. A first pass
// decides without recording whether anything is classified, so a record with
// nothing to change is left untouched; it allocates only when it walks map
// or slice values (their member copies and nested effective keys).
//
// Rewriting the attributes resets the record's dropped-attribute count, which
// sdk/log offers no way to preserve; it changes only when a classified
// attribute is present.
func (p redactingLogProcessor) OnEmit(ctx context.Context, r *sdklog.Record) error {
	if pipelineClassified(ctx) {
		return nil
	}
	needed := false
	r.WalkAttributes(func(kv attribute.KeyValue) bool {
		needed = p.needsClassification("", kv, 0, newCompositeWalk())
		return !needed
	})
	if !needed {
		return nil
	}
	kept := make([]attribute.KeyValue, 0, r.AttributesLen())
	r.WalkAttributes(func(kv attribute.KeyValue) bool {
		if out, keep, _ := p.classify("", kv, 0, newCompositeWalk()); keep {
			kept = append(kept, out)
		}
		return true
	})
	r.SetAttributes(kept...)
	return nil
}

// nestedKey returns the effective dotted key of key under prefix, the
// effective key of the map or slice that holds it ("" at the top level).
func nestedKey(prefix string, key attribute.Key) string {
	if prefix == "" {
		return string(key)
	}
	return prefix + "." + string(key)
}

// isComposite reports whether v is a map or slice value, the values the
// walk descends into.
func isComposite(v attribute.Value) bool {
	return v.Type() == attribute.MAP || v.Type() == attribute.SLICE
}

// needsClassification reports, without recording violations, whether kv or
// any attribute nested in it is classified, or whether the walk would cut
// it at the depth bound or the node budget. depth is the number of
// composites enclosing kv's value, and w is the walk of the top-level
// attribute that holds it.
func (p redactingLogProcessor) needsClassification(prefix string, kv attribute.KeyValue, depth int, w *compositeWalk) bool {
	key := nestedKey(prefix, kv.Key)
	if p.policy.classOf(attribute.Key(key)) != actionKeep {
		return true
	}
	return p.valueNeedsClassification(key, kv.Value, depth, w)
}

// valueNeedsClassification reports whether any attribute nested in v, a
// value held under the effective key prefix, is classified, or whether the
// walk would cut v. Map members are judged on their dotted keys; slice
// elements share their holder's key. It spends the budget exactly as
// classifyValue does.
func (p redactingLogProcessor) valueNeedsClassification(prefix string, v attribute.Value, depth int, w *compositeWalk) bool {
	if !isComposite(v) {
		return false
	}
	if depth >= maxCompositeDepth || !w.spend() {
		return true
	}
	switch v.Type() {
	case attribute.MAP:
		for _, m := range v.AsMap() {
			if !w.spend() || p.needsClassification(prefix, m, depth+1, w) {
				return true
			}
		}
	case attribute.SLICE:
		for _, e := range v.AsSlice() {
			if isComposite(e) && !w.spend() {
				return true
			}
			if p.valueNeedsClassification(prefix, e, depth+1, w) {
				return true
			}
		}
	}
	return false
}

// classify applies the policy to kv under the effective key prefix,
// recording a violation for every attribute it drops or rewrites. A value
// under a classified key is judged whole; a map or slice under an
// unclassified key is rebuilt from what survives classification of its
// members, and dropped when nothing survives. Change tracking comes from the
// policy's action, never from comparing values. depth and w are as for
// needsClassification.
func (p redactingLogProcessor) classify(prefix string, kv attribute.KeyValue, depth int, w *compositeWalk) (out attribute.KeyValue, keep, changed bool) {
	key := nestedKey(prefix, kv.Key)
	switch p.policy.decide(spec.SignalLogs, attribute.Key(key)) {
	case actionDrop:
		return attribute.KeyValue{}, false, true
	case actionRewrite:
		return kv.Key.String(p.policy.token(canonicalAttr(kv.Value))), true, true
	}
	v, keep, changed := p.classifyValue(key, kv.Value, depth, w)
	switch {
	case !changed:
		return kv, true, false
	case !keep:
		return attribute.KeyValue{}, false, true
	default:
		return attribute.KeyValue{Key: kv.Key, Value: v}, true, true
	}
}

// classifyValue classifies the attributes nested in v, a value held under
// the effective key prefix. It reports whether anything changed and whether
// the value survives: a map or slice emptied by classification is dropped.
//
// The walk fails closed, as the slog path's does (see classifyComposite): a
// map or slice at maxCompositeDepth enclosing composites is dropped whole,
// and once the walk's node budget is spent the members and elements not yet
// examined are dropped. Each map or slice entered and each map member
// costs one node, as does each slice element that is itself a map or
// slice; scalar slice elements carry no key of their own and cost nothing.
func (p redactingLogProcessor) classifyValue(prefix string, v attribute.Value, depth int, w *compositeWalk) (out attribute.Value, keep, changed bool) {
	if !isComposite(v) {
		return v, true, false
	}
	if depth >= maxCompositeDepth || !w.spend() {
		return attribute.Value{}, false, true
	}
	switch v.Type() {
	case attribute.MAP:
		members := v.AsMap()
		kept := make([]attribute.KeyValue, 0, len(members))
		for _, m := range members {
			if !w.spend() {
				changed = true // the budget is spent: drop the remaining members
				break
			}
			mo, mk, mc := p.classify(prefix, m, depth+1, w)
			changed = changed || mc
			if mk {
				kept = append(kept, mo)
			}
		}
		if !changed {
			return v, true, false
		}
		return attribute.MapValue(kept...), len(kept) > 0, true
	default: // attribute.SLICE
		elems := v.AsSlice()
		kept := make([]attribute.Value, 0, len(elems))
		for _, e := range elems {
			if isComposite(e) && !w.spend() {
				changed = true // the budget is spent: drop the remaining elements
				break
			}
			eo, ek, ec := p.classifyValue(prefix, e, depth+1, w)
			changed = changed || ec
			if ek {
				kept = append(kept, eo)
			}
		}
		if !changed {
			return v, true, false
		}
		return attribute.SliceValue(kept...), len(kept) > 0, true
	}
}

func (redactingLogProcessor) Shutdown(context.Context) error   { return nil }
func (redactingLogProcessor) ForceFlush(context.Context) error { return nil }

// pipelineClassifiedKey marks a context whose log record the SDK's own slog
// pipeline has already classified. The type is unexported, so no other
// emitter can set it.
type pipelineClassifiedKey struct{}

// markPipelineClassified returns ctx marked as carrying a record the slog
// pipeline classified.
func markPipelineClassified(ctx context.Context) context.Context {
	return context.WithValue(ctx, pipelineClassifiedKey{}, true)
}

// pipelineClassified reports whether ctx carries that mark.
func pipelineClassified(ctx context.Context) bool {
	marked, _ := ctx.Value(pipelineClassifiedKey{}).(bool)
	return marked
}
