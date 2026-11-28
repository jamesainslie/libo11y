using OpenTelemetry;
using OpenTelemetry.Context.Propagation;

namespace Libo11y.Internal;

/// <summary>
/// Inject-only baggage egress filter wrapping any TextMapPropagator. Extraction is never altered.
/// </summary>
public sealed class BaggageEgressPropagator(TextMapPropagator inner, Func<string, bool>? allowPredicate = null)
    : TextMapPropagator
{
    public override ISet<string> Fields => inner.Fields ?? new HashSet<string>();

    public override PropagationContext Extract<T>(
        PropagationContext context,
        T carrier,
        Func<T, string, IEnumerable<string>?> getter) =>
        inner.Extract(context, carrier, getter);

    public override void Inject<T>(
        PropagationContext context,
        T carrier,
        Action<T, string, string> setter)
    {
        var filtered = context;
        if (allowPredicate is not null)
        {
            var kept = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var (k, v) in context.Baggage.GetBaggage())
            {
                if (allowPredicate(k)) kept[k] = v;
            }
            filtered = new PropagationContext(context.ActivityContext, Baggage.Create(kept));
        }
        inner.Inject(filtered, carrier, setter);
    }

    public static TextMapPropagator Build(
        IReadOnlyList<TextMapPropagator>? propagatorsOpt,
        Func<string, bool>? baggageEgressAllow)
    {
        IReadOnlyList<TextMapPropagator> list = propagatorsOpt is { Count: > 0 }
            ? propagatorsOpt
            : [new TraceContextPropagator(), new BaggagePropagator()];

        TextMapPropagator inner = list.Count == 1
            ? list[0]
            : new CompositeTextMapPropagator(list);

        return new BaggageEgressPropagator(inner, baggageEgressAllow);
    }
}
