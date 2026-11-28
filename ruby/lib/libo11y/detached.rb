# frozen_string_literal: true

require "opentelemetry"
require_relative "errors"

module Libo11y
  # Trace propagation for work that runs detached from the request that
  # caused it: a background job, a queue message, an outbox row. The request
  # captures a Carrier, the carrier travels as text with the work, and the
  # worker starts a new root span linked to the request's span.
  module Detached
    # The longest text form of a carrier, in bytes.
    MAX_CARRIER_BYTES = 32 * 1024

    # A captured span context and baggage. Its text form is the URL-encoded
    # query every libo11y implementation writes, so a carrier a Ruby service
    # captured starts a linked span in a Go or Python worker, and the other
    # way round. The zero carrier, captured outside a span, has no
    # traceparent and writes empty text.
    class Carrier
      attr_reader :traceparent, :tracestate, :baggage

      # Reads the text form. Empty text is the zero carrier.
      #
      # @raise [InvalidCarrier] when the text is longer than 32 KiB, is not a
      #   URL-encoded query, or holds no valid traceparent
      def self.unmarshal_text(text)
        raise InvalidCarrier, "o11y: invalid carrier: the text is nil" if text.nil?
        return ZERO if text.empty?
        if text.bytesize > MAX_CARRIER_BYTES
          raise InvalidCarrier, "o11y: invalid carrier: #{text.bytesize} bytes exceeds the #{MAX_CARRIER_BYTES} byte limit"
        end

        fields = Query.parse(text)
        context = new(fields["traceparent"].to_s, fields["tracestate"].to_s, "").span_context
        raise InvalidCarrier, "o11y: invalid carrier: no valid traceparent" unless context.valid?

        from_span_context(context, Baggage.valid_members(fields["baggage"].to_s))
      end

      # Builds the carrier of a span context and a baggage header value. To
      # stay within 32 KiB it drops the trace state first and then the
      # baggage, and always keeps the traceparent, so the link survives.
      def self.from_span_context(span_context, baggage)
        headers = {}
        span = OpenTelemetry::Trace.non_recording_span(span_context)
        context = OpenTelemetry::Trace.context_with_span(span, parent_context: OpenTelemetry::Context.empty)
        OpenTelemetry::Trace::Propagation::TraceContext.text_map_propagator.inject(headers, context: context)

        carrier = new(headers["traceparent"].to_s, headers["tracestate"].to_s, baggage.to_s)
        carrier = new(carrier.traceparent, "", carrier.baggage) if carrier.marshal_text.bytesize > MAX_CARRIER_BYTES
        carrier = new(carrier.traceparent, "", "") if carrier.marshal_text.bytesize > MAX_CARRIER_BYTES
        carrier
      end

      def initialize(traceparent, tracestate, baggage)
        @traceparent = traceparent.dup.freeze
        @tracestate = tracestate.dup.freeze
        @baggage = baggage.dup.freeze
        freeze
      end

      # True for the carrier captured outside a span.
      def zero?
        @traceparent.empty?
      end

      # The captured span context. It is invalid for the zero carrier.
      def span_context
        headers = { "traceparent" => @traceparent, "tracestate" => @tracestate }.reject { |_, v| v.empty? }
        context = OpenTelemetry::Trace::Propagation::TraceContext.text_map_propagator.extract(headers, context: OpenTelemetry::Context.empty)
        OpenTelemetry::Trace.current_span(context).context
      end

      # The text form: a URL-encoded query with its keys in order.
      def marshal_text
        return "" if zero?

        fields = { "baggage" => @baggage, "traceparent" => @traceparent, "tracestate" => @tracestate }
        fields.reject { |_, value| value.empty? }.map { |key, value| "#{key}=#{Query.escape(value)}" }.join("&")
      end
      alias to_s marshal_text

      def ==(other)
        other.is_a?(Carrier) && traceparent == other.traceparent && tracestate == other.tracestate && baggage == other.baggage
      end
      alias eql? ==

      def hash
        [traceparent, tracestate, baggage].hash
      end

      ZERO = new("", "", "")
    end

    # URL query encoding as Go's net/url writes and reads it, so the text
    # form is the same bytes in every implementation.
    module Query
      module_function

      def escape(value)
        value.b.gsub(/[^A-Za-z0-9\-_.~]/n) { |byte| byte == " " ? "+" : format("%%%02X", byte.ord) }
      end

      def unescape(text)
        raise InvalidCarrier, "o11y: invalid carrier: invalid URL escape #{text[/%.{0,2}/].inspect}" if text.match?(/%(?![0-9A-Fa-f]{2})/)

        text.tr("+", " ").b.gsub(/%([0-9A-Fa-f]{2})/) { Regexp.last_match(1).hex.chr }.force_encoding(Encoding::UTF_8).scrub
      end

      # The first value of each key.
      def parse(text)
        raise InvalidCarrier, "o11y: invalid carrier: invalid semicolon separator in query" if text.include?(";")

        text.split("&").each_with_object({}) do |pair, fields|
          next if pair.empty?

          key, value = pair.split("=", 2)
          fields[unescape(key)] ||= unescape(value.to_s)
        end
      end
    end
    private_constant :Query

    # W3C baggage header values.
    module Baggage
      MEMBER = /\A\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=\s*[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*\s*(;.*)?\z/
      private_constant :MEMBER

      module_function

      # The members of a baggage value that are valid on their own, in
      # order, the first of each key.
      def valid_members(header)
        seen = {}
        kept = header.split(",").select do |member|
          next false unless MEMBER.match?(member)

          key = member.split("=", 2).first.strip
          next false if seen[key]

          seen[key] = true
        end
        kept.join(",")
      end
    end
    private_constant :Baggage

    module_function

    # Captures the active span and the baggage the egress filter lets out.
    # Outside a span it returns the zero carrier.
    #
    # @param telemetry [Libo11y::Telemetry, nil] the handle whose propagator
    #   filters the baggage. Without one the global propagator does.
    def capture(telemetry: nil, context: OpenTelemetry::Context.current)
      span_context = OpenTelemetry::Trace.current_span(context).context
      return Carrier::ZERO unless span_context.valid?

      headers = {}
      propagator(telemetry).inject(headers, context: context)
      Carrier.from_span_context(span_context, headers["baggage"].to_s)
    end

    # Returns context with the carrier's baggage merged over its own. The
    # carrier's span is not adopted.
    def restore_baggage(carrier, context: OpenTelemetry::Context.current)
      return context if carrier.baggage.empty?

      OpenTelemetry::Baggage::Propagation.text_map_propagator.extract({ "baggage" => carrier.baggage }, context: context)
    end

    # Starts a new root span linked to the carrier's span, with the carrier's
    # baggage merged into the caller's, and runs the block inside it. The
    # zero carrier gives a root span with no link.
    #
    # @param telemetry [Libo11y::Telemetry, nil] the handle to trace through.
    #   Without one the global tracer provider is used.
    def start_linked(carrier, span_name, tracer_name: "libo11y.detached", telemetry: nil, kind: :internal, attributes: nil, &)
      linked = carrier.span_context
      links = linked.valid? ? [OpenTelemetry::Trace::Link.new(linked)] : nil
      # The caller's span is taken out of the context, so the new span is a root.
      context = restore_baggage(carrier)
      context = OpenTelemetry::Trace.context_with_span(OpenTelemetry::Trace::Span::INVALID, parent_context: context)

      provider = telemetry ? telemetry.tracer_provider : OpenTelemetry.tracer_provider
      OpenTelemetry::Context.with_current(context) do
        provider.tracer(tracer_name, Libo11y::VERSION).in_span(span_name, links: links, kind: kind, attributes: attributes, &)
      end
    end

    def propagator(telemetry)
      telemetry ? telemetry.propagator : OpenTelemetry.propagation
    end
    private_class_method :propagator
  end
end
