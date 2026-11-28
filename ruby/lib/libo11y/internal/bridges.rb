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

      # Delegates to a finished Span while exposing policy-redacted to_span_data and attributes.
      class RedactedSpanView
        def initialize(span, policy)
          @span = span
          @policy = policy
          @span_data = nil
        end

        def to_span_data
          @to_span_data ||= PolicySpanExporter.redact_span_data(@span.to_span_data, @policy)
        end

        def attributes
          to_span_data.attributes
        end

        def method_missing(name, ...)
          @span.public_send(name, ...)
        end

        def respond_to_missing?(name, include_private = false)
          @span.respond_to?(name, include_private)
        end
      end

      # Wraps a LogRecordProcessor so records emitted directly via OTel Logs API are classified.
      class PolicyLogRecordProcessor
        def initialize(inner, policy)
          @inner = inner
          @policy = policy
        end

        def on_emit(log_record, context)
          if log_record.respond_to?(:attributes) && log_record.attributes && !log_record.attributes.empty?
            classified = @policy.classify_log_attributes(log_record.attributes)
            if log_record.respond_to?(:attributes=)
              log_record.attributes = classified
            else
              log_record.instance_variable_set(:@attributes, classified)
            end
          end
          @inner.on_emit(log_record, context)
        end

        def force_flush(timeout: nil)
          @inner.force_flush(timeout: timeout)
        end

        def shutdown(timeout: nil)
          @inner.shutdown(timeout: timeout)
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

        def create_observable_counter(name, callback:, unit: nil, description: nil)
          @inner.create_observable_counter(name, callback: wrap_callback(callback), unit: unit, description: description)
        end

        def create_observable_up_down_counter(name, callback:, unit: nil, description: nil)
          @inner.create_observable_up_down_counter(name, callback: wrap_callback(callback), unit: unit, description: description)
        end

        def create_observable_gauge(name, callback:, unit: nil, description: nil)
          @inner.create_observable_gauge(name, callback: wrap_callback(callback), unit: unit, description: description)
        end

        def method_missing(name, ...)
          @inner.public_send(name, ...)
        end

        def respond_to_missing?(name, include_private = false)
          @inner.respond_to?(name, include_private)
        end

        private

        def wrap_callback(cb)
          policy = @policy
          lambda do |*args|
            # OTel Ruby observable callbacks either take an observer or return a value
            if cb.arity.zero?
              cb.call
            else
              observer = args.first
              if observer.respond_to?(:observe)
                wrapped_observer = PolicyObserver.new(observer, policy)
                cb.call(wrapped_observer)
              else
                cb.call(*args)
              end
            end
          end
        end
      end

      class PolicyObserver
        def initialize(inner, policy)
          @inner = inner
          @policy = policy
        end

        def observe(value, attributes: {})
          @inner.observe(value, attributes: @policy.classify_metric_attrs(attributes))
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

      def build_otlp_trace_exporter(env_map)
        Env.parse_protocol(env_map, "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL")
        tls = Env.signal_tls(env_map, "OTEL_EXPORTER_OTLP_TRACES")
        OpenTelemetry::Exporter::OTLP::Exporter.new(
          endpoint: Env.signal_endpoint(env_map, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "/v1/traces"),
          headers: Env.signal_headers(env_map, "OTEL_EXPORTER_OTLP_TRACES_HEADERS"),
          compression: Env.signal_compression(env_map, "OTEL_EXPORTER_OTLP_TRACES_COMPRESSION"),
          timeout: Env.signal_timeout(env_map, "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT"),
          **tls
        )
      end

      def build_otlp_metric_exporter(env_map)
        Env.parse_protocol(env_map, "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL")
        tls = Env.signal_tls(env_map, "OTEL_EXPORTER_OTLP_METRICS")
        OpenTelemetry::Exporter::OTLP::Metrics::MetricsExporter.new(
          endpoint: Env.signal_endpoint(env_map, "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "/v1/metrics"),
          headers: Env.signal_headers(env_map, "OTEL_EXPORTER_OTLP_METRICS_HEADERS"),
          compression: Env.signal_compression(env_map, "OTEL_EXPORTER_OTLP_METRICS_COMPRESSION"),
          timeout: Env.signal_timeout(env_map, "OTEL_EXPORTER_OTLP_METRICS_TIMEOUT"),
          **tls
        )
      end

      def build_otlp_log_exporter(env_map)
        Env.parse_protocol(env_map, "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL")
        tls = Env.signal_tls(env_map, "OTEL_EXPORTER_OTLP_LOGS")
        OpenTelemetry::Exporter::OTLP::Logs::LogsExporter.new(
          endpoint: Env.signal_endpoint(env_map, "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "/v1/logs"),
          headers: Env.signal_headers(env_map, "OTEL_EXPORTER_OTLP_LOGS_HEADERS"),
          compression: Env.signal_compression(env_map, "OTEL_EXPORTER_OTLP_LOGS_COMPRESSION"),
          timeout: Env.signal_timeout(env_map, "OTEL_EXPORTER_OTLP_LOGS_TIMEOUT"),
          **tls
        )
      end
    end
  end
end
