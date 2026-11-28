# frozen_string_literal: true

require "opentelemetry"

module Libo11y
  module Internal
    # Inject-only baggage egress filter wrapping any OpenTelemetry propagator.
    class BaggageEgressPropagator
      def initialize(inner, allow_predicate = nil)
        @inner = inner
        @allow = allow_predicate
      end

      def inject(carrier, context: OpenTelemetry::Context.current, setter: OpenTelemetry::Context::Propagation.text_map_setter)
        ctx = filter_baggage(context)
        @inner.inject(carrier, context: ctx, setter: setter)
      end

      def extract(carrier, context: OpenTelemetry::Context.current, getter: OpenTelemetry::Context::Propagation.text_map_getter)
        @inner.extract(carrier, context: context, getter: getter)
      end

      def fields
        @inner.respond_to?(:fields) ? @inner.fields : []
      end

      private

      def filter_baggage(context)
        return context if @allow.nil?

        values = OpenTelemetry::Baggage.values(context: context)
        return context if values.nil? || values.empty?

        kept = {}
        values.each do |k, v|
          kept[k] = v if @allow.call(k)
        end
        return context if kept.size == values.size

        filtered_ctx = OpenTelemetry::Baggage.clear(context: context)
        kept.each do |k, v|
          filtered_ctx = OpenTelemetry::Baggage.set_value(k, v, context: filtered_ctx)
        end
        filtered_ctx
      end
    end

    module Propagators
      module_function

      def build(propagators_opt, baggage_egress_allow)
        list = if propagators_opt.nil?
                 [
                   OpenTelemetry::Trace::Propagation::TraceContext.text_map_propagator,
                   OpenTelemetry::Baggage::Propagation.text_map_propagator
                 ]
               elsif propagators_opt.is_a?(Array)
                 propagators_opt
               else
                 [propagators_opt]
               end

        inner = CompositePropagator.new(list)
        BaggageEgressPropagator.new(inner, baggage_egress_allow)
      end

      class CompositePropagator
        def initialize(propagators)
          @propagators = propagators
        end

        def inject(carrier, context: OpenTelemetry::Context.current, setter: OpenTelemetry::Context::Propagation.text_map_setter)
          @propagators.each { |p| p.inject(carrier, context: context, setter: setter) }
        end

        def extract(carrier, context: OpenTelemetry::Context.current, getter: OpenTelemetry::Context::Propagation.text_map_getter)
          @propagators.reduce(context) { |ctx, p| p.extract(carrier, context: ctx, getter: getter) }
        end

        def fields
          @propagators.flat_map { |p| p.respond_to?(:fields) ? p.fields : [] }.uniq
        end
      end
    end
  end
end
