# frozen_string_literal: true

require "json"
require "opentelemetry"
require_relative "errors"

module Libo11y
  # Detached work propagation (background jobs, queues, async workers).
  module Detached
    MAX_CARRIER_BYTES = 32 * 1024

    class Carrier
      attr_reader :headers

      def initialize(headers = {})
        @headers = headers.transform_keys(&:to_s).transform_values(&:to_s).freeze
      end

      def marshal_text
        text = JSON.generate(@headers)
        raise InvalidCarrier, "o11y: carrier exceeds #{MAX_CARRIER_BYTES} byte limit" if text.bytesize > MAX_CARRIER_BYTES

        text
      end

      def self.unmarshal_text(text)
        raise InvalidCarrier, "o11y: carrier text is nil" if text.nil?
        raise InvalidCarrier, "o11y: carrier exceeds #{MAX_CARRIER_BYTES} byte limit" if text.bytesize > MAX_CARRIER_BYTES

        parsed = JSON.parse(text)
        raise InvalidCarrier, "o11y: carrier must be a JSON object" unless parsed.is_a?(Hash)

        headers = {}
        parsed.each do |k, v|
          raise InvalidCarrier, "o11y: carrier entries must be strings" unless k.is_a?(String) && v.is_a?(String)

          headers[k] = v
        end
        new(headers)
      rescue JSON::ParserError => e
        raise InvalidCarrier, "o11y: invalid carrier: #{e.message}"
      end

      def empty?
        @headers.empty?
      end

      def ==(other)
        other.is_a?(Carrier) && @headers == other.headers
      end
    end

    module_function

    # Capture current span context and egress-filtered baggage into a serializable Carrier.
    def capture(telemetry: nil, context: OpenTelemetry::Context.current)
      propagator = telemetry ? telemetry.propagator : OpenTelemetry.propagation
      carrier = {}
      propagator.inject(carrier, context: context)
      Carrier.new(carrier)
    end

    # Extract baggage from a Carrier without adopting its span as parent.
    def restore_baggage(carrier, telemetry: nil, context: OpenTelemetry::Context.current)
      propagator = telemetry ? telemetry.propagator : OpenTelemetry.propagation
      extracted = propagator.extract(carrier.headers, context: OpenTelemetry::Context.empty)
      values = OpenTelemetry::Baggage.values(context: extracted)
      ctx = context
      values.each do |k, v|
        ctx = OpenTelemetry::Baggage.set_value(k, v, context: ctx)
      end
      ctx
    end

    # Start a new root span linked to the captured carrier's span context, merging its baggage.
    def start_linked(carrier, span_name, tracer_name: "libo11y.detached", telemetry: nil, kind: :consumer, attributes: nil, &block)
      propagator = telemetry ? telemetry.propagator : OpenTelemetry.propagation
      extracted = propagator.extract(carrier.headers, context: OpenTelemetry::Context.empty)
      parent_sc = OpenTelemetry::Trace.current_span(extracted).context

      links = parent_sc.valid? ? [OpenTelemetry::Trace::Link.new(parent_sc)] : nil
      baggage_ctx = restore_baggage(carrier, telemetry: telemetry, context: OpenTelemetry::Context.empty)

      tracer = telemetry ? telemetry.tracer(tracer_name) : OpenTelemetry.tracer_provider.tracer(tracer_name)
      OpenTelemetry::Context.with_current(baggage_ctx) do
        tracer.in_span(span_name, links: links, kind: kind, attributes: attributes, &block)
      end
    end
  end
end
