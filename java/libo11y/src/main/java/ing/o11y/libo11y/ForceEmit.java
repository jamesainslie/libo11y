package ing.o11y.libo11y;

import io.opentelemetry.context.Context;
import io.opentelemetry.context.ContextKey;
import io.opentelemetry.context.Scope;

/** Marks audit log records to bypass minimum level gates on every sink. */
public final class ForceEmit {
    private static final ContextKey<Boolean> FORCE_EMIT_KEY = ContextKey.named("o11y.force_emit");

    private ForceEmit() {}

    /** Returns an OTel Context with force-emit enabled. */
    public static Context withForceEmit(Context context) {
        return (context == null ? Context.current() : context).with(FORCE_EMIT_KEY, Boolean.TRUE);
    }

    /** Enables force-emit for the current thread until the returned {@link Scope} is closed. */
    public static Scope enable() {
        return withForceEmit(Context.current()).makeCurrent();
    }

    public static boolean isForced(Context context) {
        Context ctx = context == null ? Context.current() : context;
        return Boolean.TRUE.equals(ctx.get(FORCE_EMIT_KEY));
    }

    public static boolean isForced() {
        return isForced(Context.current());
    }
}
