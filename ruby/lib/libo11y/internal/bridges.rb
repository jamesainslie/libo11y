# frozen_string_literal: true

require "opentelemetry/sdk"
require "opentelemetry-metrics-sdk"
require "opentelemetry-logs-sdk"
require "opentelemetry/exporter/otlp"
require "opentelemetry/exporter/otlp_metrics"
require "opentelemetry/exporter/otlp_logs"
require_relative "../errors"
require_relative "../options"
require_relative "../spec"
require_relative "env"
require_relative "policy"

module Libo11y
  module Internal
    module Bridges
      # The tracer provider under OTEL_SDK_DISABLED=true. Its spans record
      # nothing and mint no trace identity, and an inbound trace context still
      # passes through them.
      class NoopTracerProvider < OpenTelemetry::Trace::TracerProvider
        def add_span_processor(_processor); end

        def force_flush(timeout: nil) # rubocop:disable Lint/UnusedMethodArgument
          OpenTelemetry::SDK::Trace::Export::SUCCESS
        end

        def shutdown(timeout: nil) # rubocop:disable Lint/UnusedMethodArgument
          OpenTelemetry::SDK::Trace::Export::SUCCESS
        end
      end

      # Collects one signal's export failures while a shutdown, a flush or the
      # startup canary runs. An export that fails at any other time is not
      # kept.
      class ExportFailures
        def initialize
          @mutex = Mutex.new
          @windows = []
        end

        def record(error)
          @mutex.synchronize { @windows.each { |window| window << error } }
        end

        # Runs the block. Returns its value and the failures recorded while it
        # ran, on any thread.
        def during
          window = []
          @mutex.synchronize { @windows << window }
          begin
            [yield, window]
          ensure
            @mutex.synchronize { @windows.delete_if { |open| open.equal?(window) } }
          end
        end
      end

      # Wraps a span, metric or log record exporter and records every export
      # that fails, times out or raises.
      class ObservedExporter
        SUCCESS = OpenTelemetry::SDK::Trace::Export::SUCCESS
        TIMEOUT = OpenTelemetry::SDK::Trace::Export::TIMEOUT

        def initialize(inner, failures, signal)
          @inner = inner
          @failures = failures
          @signal = signal
        end

        def export(data, timeout: nil)
          result = @inner.export(data, timeout: timeout)
          unless result == SUCCESS
            outcome = result == TIMEOUT ? "timed out" : "failed"
            @failures.record(ExporterError.new("the #{@signal} export #{outcome}"))
          end
          result
        rescue StandardError => e
          @failures.record(e)
          raise
        end

        def method_missing(name, ...)
          @inner.public_send(name, ...)
        end

        def respond_to_missing?(name, include_private = false)
          @inner.respond_to?(name, include_private)
        end
      end

      # Wraps any span exporter so span, event, and link attributes pass through SensitivityPolicy once.
      class PolicySpanExporter
        def initialize(inner, policy)
          @inner = inner
          @policy = policy
        end

        def export(spans, timeout: nil)
          redacted = spans.map { |sd| PolicySpanExporter.redact_span_data(sd, @policy) }
          @inner.export(redacted, timeout: timeout)
        end

        def force_flush(timeout: nil)
          @inner.force_flush(timeout: timeout)
        end

        def shutdown(timeout: nil)
          @inner.shutdown(timeout: timeout)
        end

        def self.redact_span_data(sd, policy)
          attrs, attrs_changed = policy.classify_flat(Spec::Signal::TRACES, sd.attributes)

          events_changed = false
          new_events = sd.events&.map do |ev|
            ev_attrs, changed = policy.classify_flat(Spec::Signal::TRACES, ev.attributes)
            if changed
              events_changed = true
              OpenTelemetry::SDK::Trace::Event.new(ev.name, ev_attrs, ev.timestamp)
            else
              ev
            end
          end

          links_changed = false
          new_links = sd.links&.map do |lk|
            lk_attrs, changed = policy.classify_flat(Spec::Signal::TRACES, lk.attributes)
            if changed
              links_changed = true
              OpenTelemetry::Trace::Link.new(lk.span_context, lk_attrs)
            else
              lk
            end
          end

          return sd unless attrs_changed || events_changed || links_changed

          OpenTelemetry::SDK::Trace::SpanData.new(
            sd.name,
            sd.kind,
            sd.status,
            sd.parent_span_id,
            sd.total_recorded_attributes,
            sd.total_recorded_events,
            sd.total_recorded_links,
            sd.start_timestamp,
            sd.end_timestamp,
            attrs,
            new_links,
            new_events,
            sd.resource,
            sd.instrumentation_scope,
            sd.span_id,
            sd.trace_id,
            sd.trace_flags,
            sd.tracestate,
            sd.parent_span_is_remote
          )
        end
      end

      # Wraps an injected SpanProcessor so on_finish receives redacted span data.
      class PolicySpanProcessor
        def initialize(inner, policy)
          @inner = inner
          @policy = policy
        end

        def on_start(span, parent_context)
          @inner.on_start(span, parent_context)
        end

        def on_finish(span)
          redacted = RedactedSpanView.new(span, @policy)
          @inner.on_finish(redacted)
        end

        def force_flush(timeout: nil)
          @inner.force_flush(timeout: timeout)
        end

        def shutdown(timeout: nil)
          @inner.shutdown(timeout: timeout)
        end
      end

      # A finished span as an injected processor sees it. Every accessor that
      # carries attributes (attributes, events, links, to_span_data) returns
      # the redacted values, and the rest delegate to the span.
      class RedactedSpanView
        def initialize(span, policy)
          @span = span
          @policy = policy
        end

        def to_span_data
          @to_span_data ||= PolicySpanExporter.redact_span_data(@span.to_span_data, @policy)
        end

        def attributes
          to_span_data.attributes
        end

        def events
          to_span_data.events
        end

        def links
          to_span_data.links
        end

        def method_missing(name, ...)
          @span.public_send(name, ...)
        end

        def respond_to_missing?(name, include_private = false)
          @span.respond_to?(name, include_private)
        end
      end

      # The first processor on the logger provider. It classifies the
      # attributes of a record that reached the provider through the
      # OpenTelemetry Logs API, in place, so every later processor sees the
      # classified record. A record from the libo11y logger is already
      # classified and counted, and its context says so.
      class PolicyLogRecordProcessor
        CLASSIFIED_KEY = OpenTelemetry::Context.create_key("libo11y-log-classified")

        # Returns context marked as carrying a record the libo11y logger classified.
        def self.mark_classified(context)
          context.set_value(CLASSIFIED_KEY, true)
        end

        def initialize(policy)
          @policy = policy
        end

        def on_emit(log_record, context)
          return if context&.value(CLASSIFIED_KEY)

          attrs = log_record.attributes
          log_record.attributes = @policy.classify_log_attributes(attrs) unless attrs.nil? || attrs.empty?
        end

        def force_flush(timeout: nil) # rubocop:disable Lint/UnusedMethodArgument
          OpenTelemetry::SDK::Logs::Export::SUCCESS
        end

        def shutdown(timeout: nil) # rubocop:disable Lint/UnusedMethodArgument
          OpenTelemetry::SDK::Logs::Export::SUCCESS
        end
      end

      # Policy-enforcing MeterProvider wrapper: classifies attributes before SDK recording so
      # every derived View stream and every Exemplar receives filtered attributes (PII always dropped).
      class PolicyMeterProvider
        def initialize(inner, policy)
          @inner = inner
          @policy = policy
          @mutex = Mutex.new
          @meters = {}
        end

        def meter(name, version: nil, attributes: nil)
          key = [name, version, attributes]
          @mutex.synchronize do
            @meters[key] ||= PolicyMeter.new(@inner.meter(name, version: version, attributes: attributes), @policy)
          end
        end

        def add_metric_reader(reader)
          @inner.add_metric_reader(reader)
        end

        def add_view(*, **)
          @inner.add_view(*, **)
        end

        def resource
          @inner.resource
        end

        def metric_readers
          @inner.metric_readers
        end

        def exemplar_filter
          @inner.exemplar_filter
        end

        def shutdown(timeout: nil)
          @inner.shutdown(timeout: timeout)
        end

        def force_flush(timeout: nil)
          @inner.force_flush(timeout: timeout)
        end

        def sdk_provider
          @inner
        end
      end

      class PolicyMeter
        def initialize(inner, policy)
          @inner = inner
          @policy = policy
        end

        def create_counter(name, unit: nil, description: nil)
          PolicySyncInstrument.new(@inner.create_counter(name, unit: unit, description: description), @policy)
        end

        def create_up_down_counter(name, unit: nil, description: nil)
          PolicySyncInstrument.new(@inner.create_up_down_counter(name, unit: unit, description: description), @policy)
        end

        def create_histogram(name, unit: nil, description: nil, explicit_bucket_boundaries: nil)
          inst = if explicit_bucket_boundaries
                   @inner.create_histogram(
                     name,
                     unit: unit,
                     description: description,
                     advisory: { explicit_bucket_boundaries: explicit_bucket_boundaries }
                   )
                 else
                   @inner.create_histogram(name, unit: unit, description: description)
                 end
          PolicySyncInstrument.new(inst, @policy)
        end

        def create_gauge(name, unit: nil, description: nil)
          PolicySyncInstrument.new(@inner.create_gauge(name, unit: unit, description: description), @policy)
        end

        # An observable instrument's callbacks take no argument and return a
        # number, so its attributes come only through add_attributes and
        # observe, which the wrapper classifies.
        def create_observable_counter(name, callback: nil, unit: nil, description: nil)
          PolicyAsyncInstrument.new(@inner.create_observable_counter(name, callback: callback, unit: unit, description: description), @policy)
        end

        def create_observable_up_down_counter(name, callback: nil, unit: nil, description: nil)
          PolicyAsyncInstrument.new(
            @inner.create_observable_up_down_counter(name, callback: callback, unit: unit, description: description), @policy
          )
        end

        def create_observable_gauge(name, callback: nil, unit: nil, description: nil)
          PolicyAsyncInstrument.new(@inner.create_observable_gauge(name, callback: callback, unit: unit, description: description), @policy)
        end

        def method_missing(name, ...)
          @inner.public_send(name, ...)
        end

        def respond_to_missing?(name, include_private = false)
          @inner.respond_to?(name, include_private)
        end
      end

      # Wraps an observable instrument so the attributes it is given are
      # classified before the SDK records them.
      class PolicyAsyncInstrument
        def initialize(inner, policy)
          @inner = inner
          @policy = policy
        end

        def add_attributes(attributes)
          @inner.add_attributes(@policy.classify_metric_attrs(attributes))
        end

        def observe(timeout: nil, attributes: {})
          @inner.observe(timeout: timeout, attributes: @policy.classify_metric_attrs(attributes))
        end

        def method_missing(name, ...)
          @inner.public_send(name, ...)
        end

        def respond_to_missing?(name, include_private = false)
          @inner.respond_to?(name, include_private)
        end
      end

      class PolicySyncInstrument
        def initialize(inner, policy)
          @inner = inner
          @policy = policy
        end

        def add(increment, attributes: {})
          @inner.add(increment, attributes: @policy.classify_metric_attrs(attributes))
        end

        def record(amount, attributes: {})
          @inner.record(amount, attributes: @policy.classify_metric_attrs(attributes))
        end

        def method_missing(name, ...)
          @inner.public_send(name, ...)
        end

        def respond_to_missing?(name, include_private = false)
          @inner.respond_to?(name, include_private)
        end
      end

      module_function

      def build_sampler(opt_sampler, env_map)
        return opt_sampler unless opt_sampler.nil?

        raw = env_map["OTEL_TRACES_SAMPLER"]
        return OpenTelemetry::SDK::Trace::Samplers.parent_based(root: OpenTelemetry::SDK::Trace::Samplers::ALWAYS_ON) if raw.nil? || raw.strip.empty?

        arg = env_map["OTEL_TRACES_SAMPLER_ARG"].to_s.strip
        case raw.strip.downcase
        when "always_on"
          OpenTelemetry::SDK::Trace::Samplers::ALWAYS_ON
        when "always_off"
          OpenTelemetry::SDK::Trace::Samplers::ALWAYS_OFF
        when "traceidratio"
          OpenTelemetry::SDK::Trace::Samplers.trace_id_ratio_based(parse_ratio(arg))
        when "parentbased_always_on"
          OpenTelemetry::SDK::Trace::Samplers.parent_based(root: OpenTelemetry::SDK::Trace::Samplers::ALWAYS_ON)
        when "parentbased_always_off"
          OpenTelemetry::SDK::Trace::Samplers.parent_based(root: OpenTelemetry::SDK::Trace::Samplers::ALWAYS_OFF)
        when "parentbased_traceidratio"
          OpenTelemetry::SDK::Trace::Samplers.parent_based(
            root: OpenTelemetry::SDK::Trace::Samplers.trace_id_ratio_based(parse_ratio(arg))
          )
        else
          raise ExporterError, "o11y: unsupported trace sampler #{raw.inspect}"
        end
      end

      def parse_ratio(arg)
        val = Float(arg)
        raise ExporterError, "o11y: invalid trace ratio #{arg.inspect}" if val.nan? || val.negative? || val > 1.0

        val
      rescue ArgumentError
        raise ExporterError, "o11y: invalid trace ratio #{arg.inspect}"
      end

      def configure_exemplar_filter(meter_provider, filter_sym)
        case filter_sym
        when ExemplarFilter::ALWAYS_ON
          meter_provider.enable_exemplar_filter(
            exemplar_filter: OpenTelemetry::SDK::Metrics::Exemplar::AlwaysOnExemplarFilter
          )
        when ExemplarFilter::ALWAYS_OFF
          meter_provider.disable_exemplar_filter
        else
          meter_provider.enable_exemplar_filter(
            exemplar_filter: OpenTelemetry::SDK::Metrics::Exemplar::TraceBasedExemplarFilter
          )
        end
      end

      # Makes an OTLP exporter write the specification's schema URL on each
      # resource it sends. The upstream exporters do not write a schema URL.
      # Each one builds its request and hands the bytes to its private
      # send_bytes, so that method is the one place to add it for all three.
      # An exporter without that method is returned as it is, and the wire
      # test then fails.
      def stamp_schema_url(exporter, request_class, field)
        return exporter unless exporter.respond_to?(:send_bytes, true)

        stamp = Module.new do
          define_method(:send_bytes) do |bytes, timeout:|
            unless bytes.nil?
              request = request_class.decode(bytes)
              request.public_send(field).each { |entry| entry.schema_url = Spec::SCHEMA_URL if entry.schema_url.empty? }
              bytes = request_class.encode(request)
            end
            super(bytes, timeout: timeout)
          end
          private :send_bytes
        end
        exporter.singleton_class.prepend(stamp)
        exporter
      end

      def build_otlp_trace_exporter(env_map)
        Env.parse_protocol(env_map, "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL")
        tls = Env.signal_tls(env_map, "OTEL_EXPORTER_OTLP_TRACES")
        exporter = OpenTelemetry::Exporter::OTLP::Exporter.new(
          endpoint: Env.signal_endpoint(env_map, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "/v1/traces"),
          headers: Env.signal_headers(env_map, "OTEL_EXPORTER_OTLP_TRACES_HEADERS"),
          compression: Env.signal_compression(env_map, "OTEL_EXPORTER_OTLP_TRACES_COMPRESSION"),
          timeout: Env.signal_timeout(env_map, "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT"),
          ssl_verify_mode: Env.ssl_verify_mode(env_map),
          **tls
        )
        stamp_schema_url(exporter, Opentelemetry::Proto::Collector::Trace::V1::ExportTraceServiceRequest, :resource_spans)
      end

      def build_otlp_metric_exporter(env_map)
        Env.parse_protocol(env_map, "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL")
        tls = Env.signal_tls(env_map, "OTEL_EXPORTER_OTLP_METRICS")
        exporter = OpenTelemetry::Exporter::OTLP::Metrics::MetricsExporter.new(
          endpoint: Env.signal_endpoint(env_map, "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "/v1/metrics"),
          headers: Env.signal_headers(env_map, "OTEL_EXPORTER_OTLP_METRICS_HEADERS"),
          compression: Env.signal_compression(env_map, "OTEL_EXPORTER_OTLP_METRICS_COMPRESSION"),
          timeout: Env.signal_timeout(env_map, "OTEL_EXPORTER_OTLP_METRICS_TIMEOUT"),
          ssl_verify_mode: Env.ssl_verify_mode(env_map),
          **tls
        )
        stamp_schema_url(exporter, Opentelemetry::Proto::Collector::Metrics::V1::ExportMetricsServiceRequest, :resource_metrics)
      end

      def build_otlp_log_exporter(env_map)
        Env.parse_protocol(env_map, "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL")
        tls = Env.signal_tls(env_map, "OTEL_EXPORTER_OTLP_LOGS")
        exporter = OpenTelemetry::Exporter::OTLP::Logs::LogsExporter.new(
          endpoint: Env.signal_endpoint(env_map, "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "/v1/logs"),
          headers: Env.signal_headers(env_map, "OTEL_EXPORTER_OTLP_LOGS_HEADERS"),
          compression: Env.signal_compression(env_map, "OTEL_EXPORTER_OTLP_LOGS_COMPRESSION"),
          timeout: Env.signal_timeout(env_map, "OTEL_EXPORTER_OTLP_LOGS_TIMEOUT"),
          ssl_verify_mode: Env.ssl_verify_mode(env_map),
          **tls
        )
        stamp_schema_url(exporter, Opentelemetry::Proto::Collector::Logs::V1::ExportLogsServiceRequest, :resource_logs)
      end
    end
  end
end
