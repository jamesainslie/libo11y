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

    def child_env(base_env = ENV.to_h, context: OpenTelemetry::Context.current)
      result = base_env.dup
      result.delete(TRACEPARENT_ENV)
      result.delete(TRACESTATE_ENV)
      result.merge!(env_carrier(context: context))
      result
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
