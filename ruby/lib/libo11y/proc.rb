# frozen_string_literal: true

require "opentelemetry"

module Libo11y
  # Child-process environment and framed-map propagation (TRACEPARENT/TRACESTATE only; never baggage).
  module Proc
    TRACEPARENT_ENV = "TRACEPARENT"
    TRACESTATE_ENV = "TRACESTATE"

    module_function

    def env_carrier(context: OpenTelemetry::Context.current)
      carrier = {}
      OpenTelemetry::Trace::Propagation::TraceContext.text_map_propagator.inject(carrier, context: context)
      out = {}
      out[TRACEPARENT_ENV] = carrier["traceparent"] if carrier["traceparent"]
      out[TRACESTATE_ENV] = carrier["tracestate"] if carrier["tracestate"]
      out
    end

    # The environment for a child process: base_env with TRACEPARENT and
    # TRACESTATE set from the active span. A variable the span does not set
    # maps to nil, which makes Process.spawn remove it from the child, so the
    # child never inherits a stale trace from this process.
    def child_env(base_env = {}, context: OpenTelemetry::Context.current)
      base_env.to_h.merge(TRACEPARENT_ENV => nil, TRACESTATE_ENV => nil).merge(env_carrier(context: context))
    end

    def extract_env(env_map = ENV, context: OpenTelemetry::Context.current)
      carrier = {}
      tp = env_map[TRACEPARENT_ENV]
      ts = env_map[TRACESTATE_ENV]
      carrier["traceparent"] = tp if tp && !tp.empty?
      carrier["tracestate"] = ts if ts && !ts.empty?
      OpenTelemetry::Trace::Propagation::TraceContext.text_map_propagator.extract(carrier, context: context)
    end

    def inject_frame(frame = {}, telemetry: nil, context: OpenTelemetry::Context.current)
      propagator = telemetry ? telemetry.propagator : OpenTelemetry.propagation
      propagator.inject(frame, context: context)
      frame
    end

    def extract_frame(frame, telemetry: nil, context: OpenTelemetry::Context.current)
      propagator = telemetry ? telemetry.propagator : OpenTelemetry.propagation
      propagator.extract(frame, context: context)
    end
  end
end
