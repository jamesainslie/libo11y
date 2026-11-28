# frozen_string_literal: true

require "json"
require "logger"
require "opentelemetry"
require_relative "../spec"
require_relative "bridges"
require_relative "pii"

module Libo11y
  FORCE_EMIT_FIBER_KEY = :libo11y_force_emit
  REENTRY_FIBER_KEY = :libo11y_logging_reentry

  # Runs the block with every log record in it passing the logger's level,
  # for records that must always be written, such as audit records. Returns
  # the block's value.
  #
  # @raise [ArgumentError] without a block
  def self.force_emit
    raise ArgumentError, "libo11y: force_emit needs a block" unless block_given?

    previous = Thread.current[FORCE_EMIT_FIBER_KEY]
    Thread.current[FORCE_EMIT_FIBER_KEY] = true
    begin
      yield
    ensure
      Thread.current[FORCE_EMIT_FIBER_KEY] = previous
    end
  end

  def self.force_emit?
    Thread.current[FORCE_EMIT_FIBER_KEY] == true
  end

  module Internal
    # Structured logging facade built on Ruby's standard ::Logger.
    # Correlates every record with the active OpenTelemetry span context, applies attr_replacer
    # followed by SensitivityPolicy, and fans out to JSON console, OTLP logs, and extra sinks.
    class StructuredLogger < ::Logger
      SEVERITY_TO_OTEL = {
        ::Logger::DEBUG => [5, "DEBUG"],
        ::Logger::INFO => [9, "INFO"],
        ::Logger::WARN => [13, "WARN"],
        ::Logger::ERROR => [17, "ERROR"],
        ::Logger::FATAL => [21, "FATAL"],
        ::Logger::UNKNOWN => [9, "INFO"]
      }.freeze

      def initialize(
        policy:,
        otel_logger: nil,
        console_writer: $stdout,
        console_enabled: true,
        log_level: ::Logger::INFO,
        attr_replacer: nil,
        extra_sinks: []
      )
        super(nil)
        @policy = policy
        @otel_logger = otel_logger
        @console_writer = console_writer
        @console_enabled = console_enabled
        @attr_replacer = attr_replacer
        @extra_sinks = Array(extra_sinks).dup
        @mutex = Mutex.new
        self.level = log_level
      end

      def add(severity, message = nil, progname = nil, &)
        severity ||= ::Logger::UNKNOWN
        return true if Thread.current[REENTRY_FIBER_KEY]

        force = Libo11y.force_emit?
        return true if !force && severity < level

        message = block_given? ? yield : progname if message.nil?

        body, attrs = extract_message_and_attrs(message)
        emit_record(
          severity: severity,
          body: body,
          attrs: attrs,
          event_name: nil,
          force: force,
          raise_on_sink_error: false
        )
        true
      end

      def log_with_attrs(severity, body, attrs = {}, event_name: nil, force: nil, raise_on_sink_error: false)
        forced = force.nil? ? Libo11y.force_emit? : force
        emit_record(
          severity: severity,
          body: body.to_s,
          attrs: attrs || {},
          event_name: event_name,
          force: forced,
          raise_on_sink_error: raise_on_sink_error
        )
      end

      def debug(progname = nil, attrs = nil, &)
        return log_with_attrs(::Logger::DEBUG, progname, attrs) if attrs.is_a?(Hash)

        super(progname, &)
      end

      def info(progname = nil, attrs = nil, &)
        return log_with_attrs(::Logger::INFO, progname, attrs) if attrs.is_a?(Hash)

        super(progname, &)
      end

      def warn(progname = nil, attrs = nil, &)
        return log_with_attrs(::Logger::WARN, progname, attrs) if attrs.is_a?(Hash)

        super(progname, &)
      end

      def error(progname = nil, attrs = nil, &)
        return log_with_attrs(::Logger::ERROR, progname, attrs) if attrs.is_a?(Hash)

        super(progname, &)
      end

      def fatal(progname = nil, attrs = nil, &)
        return log_with_attrs(::Logger::FATAL, progname, attrs) if attrs.is_a?(Hash)

        super(progname, &)
      end

      private

      def extract_message_and_attrs(message)
        if message.is_a?(Hash)
          dup = message.dup
          body = dup.delete(:msg) || dup.delete("msg") || dup.delete(:message) || dup.delete("message") || ""
          [body.to_s, dup]
        else
          [message.to_s, {}]
        end
      end

      def emit_record(severity:, body:, attrs:, event_name:, force:, raise_on_sink_error:)
        return if Thread.current[REENTRY_FIBER_KEY]
        # One level gates every sink. force_emit and events pass it.
        return unless force || severity >= level

        Thread.current[REENTRY_FIBER_KEY] = true
        begin
          record = build_record(severity, body, attrs, event_name)
          write_console(raise_on_sink_error: raise_on_sink_error) { console_line(record) } if @console_enabled && @console_writer
          emit_otel(record, raise_on_sink_error: raise_on_sink_error) if @otel_logger
          @extra_sinks.each { |sink| emit_extra(sink, record, raise_on_sink_error: raise_on_sink_error) }
        ensure
          Thread.current[REENTRY_FIBER_KEY] = false
        end
      end

      # The record every sink gets: the trace identity of the active span,
      # and the attributes after the replacer and the policy, classified once.
      def build_record(severity, body, attrs, event_name)
        now = Time.now.utc
        severity_number, severity_text = SEVERITY_TO_OTEL.fetch(severity, [9, "INFO"])
        span_context = OpenTelemetry::Trace.current_span.context

        attributes = attrs.to_h { |key, value| [key.to_s, value] }
        attributes[Spec::EVENT_NAME_KEY] = event_name if event_name && !event_name.empty?
        classified = @policy.classify_log_attributes(attributes, replacer: @attr_replacer)
        # trace_id and span_id are reserved: they come from the active span
        # only. Removed after the replacer, which could bring them back.
        classified.delete("trace_id")
        classified.delete("span_id")

        {
          timestamp: now,
          observed_timestamp: now,
          severity_number: severity_number,
          severity_text: severity_text,
          body: body,
          event_name: event_name,
          trace_id: span_context.valid? ? span_context.hex_trace_id : nil,
          span_id: span_context.valid? ? span_context.hex_span_id : nil,
          attributes: classified
        }
      end

      def emit_extra(sink, record, raise_on_sink_error:)
        if sink.respond_to?(:call)
          sink.call(record)
        elsif sink.respond_to?(:emit)
          sink.emit(record)
        end
      rescue StandardError
        raise if raise_on_sink_error
      end

      def console_line(record)
        payload = { "time" => record[:timestamp].iso8601(6), "level" => record[:severity_text], "msg" => record[:body] }
        payload["trace_id"] = record[:trace_id] if record[:trace_id]
        payload["span_id"] = record[:span_id] if record[:span_id]
        record[:attributes].each do |key, value|
          payload[key] = json_safe(value) unless %w[time level msg trace_id span_id].include?(key)
        end
        "#{JSON.generate(payload)}\n"
      end

      # JSON has no NaN and no infinity, so those floats are written as the
      # strings Go's slog writes: "NaN", "+Inf" and "-Inf".
      def json_safe(value)
        case value
        when Float then value.finite? ? value : PII.canonical_float(value)
        when Hash then value.transform_values { |v| json_safe(v) }
        when Array then value.map { |v| json_safe(v) }
        else value
        end
      end

      # Encodes and writes one line. A failure to encode or to write stays
      # in this sink, so the record still reaches the others.
      def write_console(raise_on_sink_error:)
        line = yield
        @mutex.synchronize do
          @console_writer.write(line)
        end
      rescue StandardError
        raise if raise_on_sink_error
      end

      def emit_otel(record, raise_on_sink_error:)
        @otel_logger.on_emit(
          **record.slice(:timestamp, :observed_timestamp, :severity_number, :severity_text, :body, :event_name),
          attributes: flatten_for_otel(record[:attributes]),
          context: Bridges::PolicyLogRecordProcessor.mark_classified(OpenTelemetry::Context.current)
        )
      rescue StandardError
        raise if raise_on_sink_error
      end

      def flatten_for_otel(hash, prefix = nil, out = {})
        hash.each do |k, v|
          full = prefix ? "#{prefix}.#{k}" : k.to_s
          if v.is_a?(Hash)
            flatten_for_otel(v, full, out)
          elsif v.is_a?(Array)
            out[full] = v.map { |el| el.is_a?(Hash) || el.is_a?(Array) ? JSON.generate(el) : el }
          elsif v.is_a?(String) || v.is_a?(Integer) || v.is_a?(Float) || v.is_a?(TrueClass) || v.is_a?(FalseClass)
            out[full] = v
          elsif !v.nil?
            out[full] = v.to_s
          end
        end
        out
      end
    end
  end
end
