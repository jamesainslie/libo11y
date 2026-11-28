# frozen_string_literal: true

require "opentelemetry/sdk"
require "opentelemetry-metrics-sdk"
require "opentelemetry-logs-sdk"
require_relative "bridges"
require_relative "env"
require_relative "histogram_buckets"
require_relative "runtime_metrics"

module Libo11y
  module Internal
    # Builds the tracer, meter and logger providers of one Telemetry handle
    # from its options and the environment it was given. Every exporter is
    # wrapped so that its failures are observed and what it sends is
    # classified by the sensitivity policy.
    class Pipeline
      SIGNALS = %i[traces metrics logs].freeze
      EXPORTER_VARIABLES = {
        traces: "OTEL_TRACES_EXPORTER", metrics: "OTEL_METRICS_EXPORTER", logs: "OTEL_LOGS_EXPORTER"
      }.freeze

      # failures holds one ExportFailures per signal. exporters holds what
      # each signal exports to: "injected", "otlp", "console" or "none".
      attr_reader :tracer_provider, :meter_provider, :logger_provider, :failures, :exporters

      # @param built [Array] receives each provider as it is created, so the
      #   caller can stop the ones that exist when a later step raises
      def initialize(options:, env_map:, hermetic:, policy:, resource:, violations:, built:)
        @options = options
        @env = env_map
        @hermetic = hermetic
        # OTEL_SDK_DISABLED beats every exporter, reader and processor, the injected ones included.
        @disabled = !hermetic && Env.sdk_disabled?(env_map)
        @policy = policy
        @resource = resource
        @violations = violations
        @built = built
        @failures = SIGNALS.to_h { |signal| [signal, Bridges::ExportFailures.new] }
        @exporters = {}
      end

      def build
        build_traces
        build_metrics
        build_logs
        self
      end

      def runtime_metrics?
        @options.runtime_metrics && !@disabled ? true : false
      end

      private

      def track(provider)
        @built << provider
        provider
      end

      def observe(exporter, signal)
        Bridges::ObservedExporter.new(exporter, @failures.fetch(signal), signal)
      end

      # What a signal exports to. Under HERMETIC a signal with nothing
      # injected is off.
      def exporter_mode(signal, injected)
        @exporters[signal] =
          if injected && !@disabled
            "injected"
          elsif @disabled || @hermetic
            "none"
          else
            Env.parse_exporter_choice(@env, EXPORTER_VARIABLES.fetch(signal), default: "otlp")
          end
      end

      def batch_settings(prefix, schedule_delay:)
        {
          schedule_delay: Env.parse_int(@env, "OTEL_#{prefix}_SCHEDULE_DELAY", schedule_delay),
          max_queue_size: Env.parse_int(@env, "OTEL_#{prefix}_MAX_QUEUE_SIZE", 2048),
          max_export_batch_size: Env.parse_int(@env, "OTEL_#{prefix}_MAX_EXPORT_BATCH_SIZE", 512),
          exporter_timeout: Env.parse_int(@env, "OTEL_#{prefix}_EXPORT_TIMEOUT", 30_000),
          start_thread_on_boot: Env.start_thread_on_boot?(@env, "OTEL_RUBY_#{prefix}_START_THREAD_ON_BOOT")
        }
      end

      def build_traces
        sampler = Bridges.build_sampler(@options.sampler, @env)
        @tracer_provider = track(
          if @disabled
            Bridges::NoopTracerProvider.new
          else
            OpenTelemetry::SDK::Trace::TracerProvider.new(sampler: sampler, resource: @resource, span_limits: Env.span_limits(@env))
          end
        )
        # An injected processor owns the export path, as an injected exporter
        # does, so no exporter is built from the environment beside it.
        processors = Array(@options.span_processors)
        mode = exporter_mode(:traces, @options.span_exporter || !processors.empty?)
        return if @disabled

        exporting = span_export_processor(mode)
        @tracer_provider.add_span_processor(exporting) if exporting
        return if processors.empty?

        # The injected processors get a redacted snapshot of each finished
        # span. A span's violations are counted once: by the exporter path
        # when there is one, else here.
        policy = exporting ? @policy.silent : @policy
        @tracer_provider.add_span_processor(Bridges::PolicySpanProcessor.new(processors, policy))
      end

      def span_export_processor(mode)
        export = OpenTelemetry::SDK::Trace::Export
        if @options.span_exporter
          export::SimpleSpanProcessor.new(redacting(@options.span_exporter))
        elsif mode == "otlp"
          exporter = redacting(Bridges.build_otlp_trace_exporter(@env))
          export::BatchSpanProcessor.new(exporter, **batch_settings("BSP", schedule_delay: 5000))
        elsif mode == "console"
          export::SimpleSpanProcessor.new(redacting(export::ConsoleSpanExporter.new))
        end
      end

      def redacting(span_exporter)
        Bridges::PolicySpanExporter.new(observe(span_exporter, :traces), @policy)
      end

      def build_metrics
        raw = track(OpenTelemetry::SDK::Metrics::MeterProvider.new(resource: @resource))
        filter = @disabled ? ExemplarFilter::ALWAYS_OFF : Env.parse_exemplar_filter(@options.exemplar_filter, @env)
        Bridges.configure_exemplar_filter(raw, filter)
        mode = exporter_mode(:metrics, @options.metric_reader)
        unless @disabled
          reader = metric_reader(mode)
          raw.add_metric_reader(reader) if reader
          add_views(raw)
        end

        @meter_provider = Bridges::PolicyMeterProvider.new(raw, @policy)
        count_violations(raw)
        RuntimeMetrics.register(@meter_provider) if runtime_metrics?
      end

      def metric_reader(mode)
        return @options.metric_reader if @options.metric_reader

        exporter = case mode
                   when "otlp" then observe(Bridges.build_otlp_metric_exporter(@env), :metrics)
                   when "console" then OpenTelemetry::SDK::Metrics::Export::ConsoleMetricPullExporter.new
                   end
        return if exporter.nil?

        OpenTelemetry::SDK::Metrics::Export::PeriodicMetricReader.new(
          exporter: exporter,
          export_interval_millis: Env.parse_int(@env, "OTEL_METRIC_EXPORT_INTERVAL", 60_000),
          export_timeout_millis: Env.parse_int(@env, "OTEL_METRIC_EXPORT_TIMEOUT", 30_000)
        )
      end

      # One view per histogram with boundaries: libo11y's own duration
      # histograms, then the histogram_buckets option, which wins for a name
      # both give. Then the views option.
      def add_views(raw)
        buckets = HistogramBuckets::DEFAULTS.merge((@options.histogram_buckets || {}).to_h.transform_keys(&:to_s))
        buckets.each do |name, boundaries|
          aggregation = OpenTelemetry::SDK::Metrics::Aggregation::ExplicitBucketHistogram.new(boundaries: Array(boundaries))
          raw.add_view(name, type: :histogram, aggregation: aggregation)
        end
        Array(@options.views).each do |view|
          arguments = view.is_a?(Hash) ? view.transform_keys(&:to_sym) : {}
          unless arguments[:name]
            raise ArgumentError, "libo11y: views takes Hashes of MeterProvider#add_view arguments with a :name, got #{view.inspect}"
          end

          raw.add_view(arguments[:name].to_s, **arguments.except(:name))
        end
      end

      # Feeds the o11y.schema.violations counter, the violations recorded
      # while the resource was built included. It is on the raw provider,
      # because its own attributes are not subject to the policy.
      def count_violations(raw)
        counter = raw.meter("libo11y", version: Libo11y::VERSION).create_counter(
          Spec::METRIC_SCHEMA_VIOLATIONS, unit: "{violation}", description: "Specification and sensitivity policy violations."
        )
        @violations.attach(lambda do |signal, rule|
          counter.add(1, attributes: { Spec::ATTR_SIGNAL => signal.to_s, Spec::ATTR_RULE => rule.to_s })
        end)
      end

      def build_logs
        @logger_provider = track(
          OpenTelemetry::SDK::Logs::LoggerProvider.new(resource: @resource, log_record_limits: Env.log_record_limits(@env))
        )
        mode = exporter_mode(:logs, @options.log_exporter)
        return if @disabled

        # First, so every later processor sees the classified record.
        @logger_provider.add_log_record_processor(Bridges::PolicyLogRecordProcessor.new(@policy))
        exporting = log_export_processor(mode)
        @logger_provider.add_log_record_processor(exporting) if exporting
        Array(@options.log_processors).each { |processor| @logger_provider.add_log_record_processor(processor) }
      end

      def log_export_processor(mode)
        export = OpenTelemetry::SDK::Logs::Export
        if @options.log_exporter
          export::SimpleLogRecordProcessor.new(observe(@options.log_exporter, :logs))
        elsif mode == "otlp"
          exporter = observe(Bridges.build_otlp_log_exporter(@env), :logs)
          export::BatchLogRecordProcessor.new(exporter, **batch_settings("BLRP", schedule_delay: 1000))
        elsif mode == "console"
          export::SimpleLogRecordProcessor.new(observe(export::ConsoleLogRecordExporter.new, :logs))
        end
      end
    end
  end
end
