package o11y

import (
	"context"
	"slices"

	"go.opentelemetry.io/otel/attribute"
	sdklog "go.opentelemetry.io/otel/sdk/log"

	"github.com/jamesainslie/libo11y/go/spec"
)

// redactingLogProcessor enforces the sensitivity policy on every record the
// SDK's LoggerProvider emits, whichever bridge produced it (otelslog,
// otelzap, otellogr, and so on). It is registered before the batch
// processor and runs synchronously; sdk/log documents that a processor's
// synchronous changes to the record are visible to the next one. Map values
// are walked so grouped attributes are judged on their dotted effective keys,
// and a map under a classified key is judged as one value.
//
// Records from the SDK's own slog pipeline are skipped: that leg classifies
// slog values before the bridge converts them (see [classifyingHandler]),
// which keeps its tokens identical to the console's for values with a text
// form such as net.IP, and classifying them again would hash a token.
type redactingLogProcessor struct {
	policy *sensitivityPolicy
}

// Enabled reports false: the redactor never makes a record worth emitting
// on its own, so it leaves that decision to the processors that export.
// OnEmit runs for every emitted record regardless.
func (redactingLogProcessor) Enabled(context.Context, sdklog.EnabledParameters) bool { return false }

// OnEmit drops or tokenizes classified attributes in place. A first pass
// decides without recording whether anything is classified, so a record with
// nothing to change is left untouched and costs no allocation beyond the
// effective keys of grouped attributes.
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
		needed = p.needsClassification(nil, kv)
		return !needed
	})
	if !needed {
		return nil
	}
	kept := make([]attribute.KeyValue, 0, r.AttributesLen())
	r.WalkAttributes(func(kv attribute.KeyValue) bool {
		if out, keep, _ := p.classify(nil, kv); keep {
			kept = append(kept, out)
		}
		return true
	})
	r.SetAttributes(kept...)
	return nil
}

// needsClassification reports, without recording violations, whether kv or
// any attribute nested in it is classified.
func (p redactingLogProcessor) needsClassification(groups []string, kv attribute.KeyValue) bool {
	if p.policy.classOf(attribute.Key(effectiveKey(groups, string(kv.Key)))) != actionKeep {
		return true
	}
	if kv.Value.Type() != attribute.MAP {
		return false
	}
	path := append(slices.Clone(groups), string(kv.Key))
	for _, m := range kv.Value.AsMap() {
		if p.needsClassification(path, m) {
			return true
		}
	}
	return false
}

// classify applies the policy to kv at the given group path, recording a
// violation for every attribute it drops or rewrites. A map under an
// unclassified key is rebuilt from its classified members, and dropped when
// none survive. Change tracking comes from the policy's action, never from
// comparing values.
func (p redactingLogProcessor) classify(groups []string, kv attribute.KeyValue) (out attribute.KeyValue, keep, changed bool) {
	switch p.policy.decide(spec.SignalLogs, attribute.Key(effectiveKey(groups, string(kv.Key)))) {
	case actionDrop:
		return attribute.KeyValue{}, false, true
	case actionRewrite:
		return kv.Key.String(p.policy.token(canonicalAttr(kv.Value))), true, true
	}
	if kv.Value.Type() != attribute.MAP {
		return kv, true, false
	}
	path := append(slices.Clone(groups), string(kv.Key))
	members := kv.Value.AsMap()
	kept := make([]attribute.KeyValue, 0, len(members))
	for _, m := range members {
		mo, mk, mc := p.classify(path, m)
		changed = changed || mc
		if mk {
			kept = append(kept, mo)
		}
	}
	switch {
	case !changed:
		return kv, true, false
	case len(kept) == 0:
		return attribute.KeyValue{}, false, true
	default:
		return kv.Key.Map(kept...), true, true
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
