# frozen_string_literal: true

require "time"
require "opentelemetry/sdk"
require "opentelemetry-metrics-sdk"
require "opentelemetry-logs-sdk"
require_relative "errors"
require_relative "options"
require_relative "spec"
require_relative "internal/env"
require_relative "internal/endpoint"
require_relative "internal/histogram_buckets"
require_relative "internal/policy"
require_relative "internal/resource"
require_relative "internal/propagators"
require_relative "internal/bridges"
require_relative "internal/logging_device"
require_relative "internal/runtime_metrics"
require_relative "internal/summary"

module Libo11y
  # Owned telemetry handle returned by Libo11y.setup and Libo11y.init.
  class Telemetry
    attr_reader :tracer_provider, :meter_provider, :logger_provider, :propagator,
                :logger, :resource, :policy, :shutdown_timeout

    def initialize(
      tracer_provider:,
      meter_provider:,
      logger_provider:,
      propagator:,
      logger:,
      resource:,
      policy:,
      effective_config:,
      shutdown_timeout:,
      is_global:,
      failures:,
      on_global_shutdown: nil
    )
      @tracer_provider = tracer_provider
      @meter_provider = meter_provider
      @logger_provider = logger_provider
      @propagator = propagator
      @logger = logger
      @resource = resource
      @policy = policy
      @effective_config = effective_config
      @shutdown_timeout = shutdown_timeout
      @is_global = is_global
      @failures = failures
      @on_global_shutdown = on_global_shutdown
      @shutdown_mutex = Mutex.new
      @shutdown_done = false
      @shutdown_report = nil
      @shutdown_cv = ConditionVariable.new
      @shutdown_in_progress = false
    end

    def tracer(name, version = nil)
      @tracer_provider.tracer(name, version)
    end

    def meter(name, version: nil)
      @meter_provider.meter(name, version: version)
    end

    # The resolved configuration as one line of key=value pairs: the
    # attributes of the o11y.telemetry.configured startup event.
    #
    # @return [String] frozen
    attr_reader :effective_config

    def inject(carrier, context: OpenTelemetry::Context.current)
      @propagator.inject(carrier, context: context)
      carrier
    end

    def extract(carrier, context: OpenTelemetry::Context.current)
      @propagator.extract(carrier, context: context)
    end

    # Emit a registered (or custom) event, always force-emitted past level gates.
    def event(name, attributes = {}, body: nil)
      attrs = {}
      attributes&.each { |k, v| attrs[k.to_s] = v }
      @logger.log_with_attrs(::Logger::INFO, body || name.to_s, attrs, event_name: name.to_s, force: true)
    end

    # Stops logs, metrics and traces concurrently under one deadline, and
    # returns a ShutdownReport with one error per signal that failed, missed
    # the deadline, or had its final export rejected. It runs once: every
    # later and concurrent caller gets the first call's report. For each
    # signal in the report an o11y.telemetry.dropped event goes to the
    # console and the extra sinks.
    #
    # @param timeout [Numeric, nil] seconds. nil uses the shutdown_timeout
    #   option, 5 by default.
    # @raise [ArgumentError] when timeout is not a number
    def shutdown(timeout: nil)
      secs = resolve_timeout(timeout)
      @shutdown_mutex.synchronize do
        @shutdown_cv.wait(@shutdown_mutex) while @shutdown_in_progress
        return @shutdown_report if @shutdown_done

        @shutdown_in_progress = true
      end

      report = nil
      begin
        report = run_shutdown(secs)
      ensure
        @shutdown_mutex.synchronize do
          # An unexpected error leaves no report, and the next caller runs it again.
          @shutdown_report = report
          @shutdown_done = !report.nil?
          @shutdown_in_progress = false
          @shutdown_cv.broadcast
        end
      end
      report
    end

    # Exports what is buffered on all three signals concurrently, under one
    # deadline, without stopping them.
    #
    # @return [Boolean] false when a signal failed, missed the deadline, or
    #   had an export rejected while the call ran
    # @raise [ArgumentError] when timeout is not a number
    def force_flush(timeout: nil)
      secs = resolve_timeout(timeout)
      each_signal("flush", secs) { |provider| provider.force_flush(timeout: secs) }.empty?
    end

    private

    SIGNALS = %i[logs metrics traces].freeze
    private_constant :SIGNALS

    def resolve_timeout(timeout)
      secs = timeout.nil? ? @shutdown_timeout : Float(timeout)
      secs.positive? ? secs : 5.0
    rescue TypeError
      raise ArgumentError, "libo11y: timeout must be a number of seconds, got #{timeout.inspect}"
    end

    def run_shutdown(secs)
      errors = each_signal("shutdown", secs) { |provider| provider.shutdown(timeout: secs) }
      # The OTLP log leg is already down, so these reach the console and the
      # extra sinks only.
      errors.each { |signal, error| emit_dropped(signal, error) }
      @on_global_shutdown&.call if @is_global
      ShutdownReport.new(traces_error: errors[:traces], metrics_error: errors[:metrics], logs_error: errors[:logs])
    end

    # Runs the block for each signal's provider on its own thread, under one
    # deadline. Returns the error of each signal that failed.
    def each_signal(action, secs)
      providers = { logs: @logger_provider, metrics: @meter_provider, traces: @tracer_provider }
      errors = {}
      lock = Mutex.new
      threads = SIGNALS.to_h do |signal|
        thread = Thread.new do
          status, failed = @failures.fetch(signal).during { yield providers.fetch(signal) }
          cause = failed.first&.message
          cause ||= "the provider answered #{status}" if status.is_a?(Integer) && !status.zero?
          lock.synchronize { errors[signal] = ExporterError.new("o11y: #{action} #{signal}: #{cause}") } if cause
        rescue StandardError => e
          lock.synchronize { errors[signal] = ExporterError.new("o11y: #{action} #{signal}: #{e.message}") }
        end
        [signal, thread]
      end

      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + secs
      threads.each do |signal, thread|
        remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
        next if thread.join([remaining, 0].max)

        lock.synchronize { errors[signal] ||= ExporterError.new("o11y: #{action} #{signal}: timed out after #{secs}s") }
      end
      lock.synchronize { errors.dup }
    end

    def emit_dropped(signal, error)
      event(Spec::EVENT_TELEMETRY_DROPPED, { Spec::ATTR_SIGNAL => signal.to_s, "error.type" => error.class.name })
    rescue StandardError
      nil
    end
  end

  module Builder
    @global_mutex = Mutex.new
    # nil when no global setup exists, :starting while one is being built,
    # :active once it is installed.
    @global_state = nil

    class << self
      def build(options_or_nil = nil, is_global:, **)
        opts = if options_or_nil.is_a?(Options)
                 options_or_nil
               else
                 Options.new(**)
               end

        # Claimed before anything is built, so a second caller fails at once
        # and builds nothing.
        claim_global! if is_global
        built = []
        begin
          construct(opts, is_global, built)
        rescue StandardError
          # Stop the workers of every provider built so far.
          built.each do |provider|
            provider.shutdown(timeout: 1.0)
          rescue StandardError
            nil
          end
          reset_global! if is_global
          raise
        end
      end

      def reset_global!
        @global_mutex.synchronize { @global_state = nil }
      end

      private

      def claim_global!
        @global_mutex.synchronize do
          raise AlreadySetup unless @global_state.nil?

          @global_state = :starting
        end
      end

      def construct(opts, is_global, built)
        env_map = Internal::Env.resolve_map(opts.env)
        hermetic = Internal::Env.hermetic?(opts.env)
        sdk_disabled = !hermetic && Internal::Env.sdk_disabled?(env_map)

        app_classes = Internal::SensitivityPolicy.load_app_registries(opts.app_registries)
        violation_recorder = Internal::ViolationRecorder.new
        policy = Internal::SensitivityPolicy.new(
          pii_mode: opts.pii_mode,
          pii_hash_key: opts.pii_hash_key,
          app_classes: app_classes,
          recorder: violation_recorder
        )

        res_result = Internal::ResourceBuilder.build(opts, env_map, policy, violation_recorder)
        resource = res_result.resource
        propagator = Internal::Propagators.build(opts.propagators, opts.baggage_egress_allow)
        failures = %i[traces metrics logs].to_h { |signal| [signal, Internal::Bridges::ExportFailures.new] }
        observe = ->(exporter, signal) { Internal::Bridges::ObservedExporter.new(exporter, failures.fetch(signal), signal) }

        # Build TracerProvider
        sampler = Internal::Bridges.build_sampler(opts.sampler, env_map)
        tracer_provider = if sdk_disabled
                            Internal::Bridges::NoopTracerProvider.new
                          else
                            OpenTelemetry::SDK::Trace::TracerProvider.new(
                              sampler: sampler, resource: resource, span_limits: Internal::Env.span_limits(env_map)
                            )
                          end
        built << tracer_provider

        # An injected processor owns the export path, as an injected exporter
        # does, so no exporter is built from the environment beside it.
        span_processors = Array(opts.span_processors)
        trace_exporter_mode = if !sdk_disabled && (opts.span_exporter || !span_processors.empty?)
                                "injected"
                              elsif sdk_disabled || hermetic
                                "none"
                              else
                                Internal::Env.parse_exporter_choice(env_map, "OTEL_TRACES_EXPORTER", default: "otlp")
                              end

        unless sdk_disabled
          if opts.span_exporter
            wrapped = Internal::Bridges::PolicySpanExporter.new(observe.call(opts.span_exporter, :traces), policy)
            tracer_provider.add_span_processor(
              OpenTelemetry::SDK::Trace::Export::SimpleSpanProcessor.new(wrapped)
            )
          elsif trace_exporter_mode == "otlp"
            otlp_exp = Internal::Bridges.build_otlp_trace_exporter(env_map)
            wrapped = Internal::Bridges::PolicySpanExporter.new(observe.call(otlp_exp, :traces), policy)
            tracer_provider.add_span_processor(
              OpenTelemetry::SDK::Trace::Export::BatchSpanProcessor.new(
                wrapped,
                schedule_delay: Internal::Env.parse_int(env_map, "OTEL_BSP_SCHEDULE_DELAY", 5000),
                max_queue_size: Internal::Env.parse_int(env_map, "OTEL_BSP_MAX_QUEUE_SIZE", 2048),
                max_export_batch_size: Internal::Env.parse_int(env_map, "OTEL_BSP_MAX_EXPORT_BATCH_SIZE", 512),
                exporter_timeout: Internal::Env.parse_int(env_map, "OTEL_BSP_EXPORT_TIMEOUT", 30_000),
                start_thread_on_boot: Internal::Env.start_thread_on_boot?(env_map, "OTEL_RUBY_BSP_START_THREAD_ON_BOOT")
              )
            )
          elsif trace_exporter_mode == "console"
            wrapped = Internal::Bridges::PolicySpanExporter.new(
              observe.call(OpenTelemetry::SDK::Trace::Export::ConsoleSpanExporter.new, :traces), policy
            )
            tracer_provider.add_span_processor(
              OpenTelemetry::SDK::Trace::Export::SimpleSpanProcessor.new(wrapped)
            )
          end

          # An injected processor gets a redacted view of the finished span.
          # A span's violations are counted once: by the exporter path when
          # there is one, else by the first injected processor.
          exporter_counts = !opts.span_exporter.nil? || %w[otlp console].include?(trace_exporter_mode)
          span_processors.each_with_index do |sp, idx|
            proc_policy = !exporter_counts && idx.zero? ? policy : policy.silent
            tracer_provider.add_span_processor(Internal::Bridges::PolicySpanProcessor.new(sp, proc_policy))
          end
        end

        # Build MeterProvider
        raw_meter_provider = OpenTelemetry::SDK::Metrics::MeterProvider.new(resource: resource)
        built << raw_meter_provider
        exemplar_filter = if sdk_disabled
                            ExemplarFilter::ALWAYS_OFF
                          else
                            Internal::Env.parse_exemplar_filter(opts.exemplar_filter, env_map)
                          end
        Internal::Bridges.configure_exemplar_filter(raw_meter_provider, exemplar_filter)

        metric_exporter_mode = if sdk_disabled || (opts.metric_reader.nil? && hermetic)
                                 "none"
                               elsif opts.metric_reader
                                 "injected"
                               else
                                 Internal::Env.parse_exporter_choice(env_map, "OTEL_METRICS_EXPORTER", default: "otlp")
                               end

        unless sdk_disabled
          if opts.metric_reader
            raw_meter_provider.add_metric_reader(opts.metric_reader)
          elsif metric_exporter_mode == "otlp"
            otlp_mexp = Internal::Bridges.build_otlp_metric_exporter(env_map)
            reader = OpenTelemetry::SDK::Metrics::Export::PeriodicMetricReader.new(
              exporter: observe.call(otlp_mexp, :metrics),
              export_interval_millis: Internal::Env.parse_int(env_map, "OTEL_METRIC_EXPORT_INTERVAL", 60_000),
              export_timeout_millis: Internal::Env.parse_int(env_map, "OTEL_METRIC_EXPORT_TIMEOUT", 30_000)
            )
            raw_meter_provider.add_metric_reader(reader)
          elsif metric_exporter_mode == "console"
            reader = OpenTelemetry::SDK::Metrics::Export::PeriodicMetricReader.new(
              exporter: OpenTelemetry::SDK::Metrics::Export::ConsoleMetricPullExporter.new
            )
            raw_meter_provider.add_metric_reader(reader)
          end

          # One view per histogram with boundaries: libo11y's own duration
          # histograms, then the histogram_buckets option, which wins for a
          # name both give.
          buckets = Internal::HistogramBuckets::DEFAULTS.merge((opts.histogram_buckets || {}).to_h.transform_keys(&:to_s))
          buckets.each do |name, boundaries|
            aggregation = OpenTelemetry::SDK::Metrics::Aggregation::ExplicitBucketHistogram.new(boundaries: Array(boundaries))
            raw_meter_provider.add_view(name, type: :histogram, aggregation: aggregation)
          end
          Array(opts.views).each do |view|
            unless view.is_a?(Hash) && view.transform_keys(&:to_sym)[:name]
              raise ArgumentError, "libo11y: views takes Hashes of MeterProvider#add_view arguments with a :name, got #{view.inspect}"
            end

            arguments = view.transform_keys(&:to_sym)
            raw_meter_provider.add_view(arguments[:name].to_s, **arguments.except(:name))
          end
        end

        meter_provider = Internal::Bridges::PolicyMeterProvider.new(raw_meter_provider, policy)

        # Wire o11y.schema.violations counter and flush buffered resource violations
        violations_counter = raw_meter_provider.meter("libo11y", version: Libo11y::VERSION).create_counter(
          Spec::METRIC_SCHEMA_VIOLATIONS,
          unit: "{violation}",
          description: "Specification and sensitivity policy violations."
        )
        violation_recorder.attach(lambda do |sig, rule|
          violations_counter.add(1, attributes: { Spec::ATTR_SIGNAL => sig.to_s, Spec::ATTR_RULE => rule.to_s })
        end)

        Internal::RuntimeMetrics.register(meter_provider) if opts.runtime_metrics && !sdk_disabled

        # Build LoggerProvider
        logger_provider = OpenTelemetry::SDK::Logs::LoggerProvider.new(
          resource: resource, log_record_limits: Internal::Env.log_record_limits(env_map)
        )
        built << logger_provider
        log_exporter_mode = if sdk_disabled || (opts.log_exporter.nil? && hermetic)
                              "none"
                            elsif opts.log_exporter
                              "injected"
                            else
                              Internal::Env.parse_exporter_choice(env_map, "OTEL_LOGS_EXPORTER", default: "otlp")
                            end

        unless sdk_disabled
          # First, so every later processor sees the classified record.
          logger_provider.add_log_record_processor(Internal::Bridges::PolicyLogRecordProcessor.new(policy))
          if opts.log_exporter
            proc = OpenTelemetry::SDK::Logs::Export::SimpleLogRecordProcessor.new(observe.call(opts.log_exporter, :logs))
            logger_provider.add_log_record_processor(proc)
          elsif log_exporter_mode == "otlp"
            otlp_lexp = Internal::Bridges.build_otlp_log_exporter(env_map)
            proc = OpenTelemetry::SDK::Logs::Export::BatchLogRecordProcessor.new(
              observe.call(otlp_lexp, :logs),
              schedule_delay: Internal::Env.parse_int(env_map, "OTEL_BLRP_SCHEDULE_DELAY", 1000),
              max_queue_size: Internal::Env.parse_int(env_map, "OTEL_BLRP_MAX_QUEUE_SIZE", 2048),
              max_export_batch_size: Internal::Env.parse_int(env_map, "OTEL_BLRP_MAX_EXPORT_BATCH_SIZE", 512),
              exporter_timeout: Internal::Env.parse_int(env_map, "OTEL_BLRP_EXPORT_TIMEOUT", 30_000),
              start_thread_on_boot: Internal::Env.start_thread_on_boot?(env_map, "OTEL_RUBY_BLRP_START_THREAD_ON_BOOT")
            )
            logger_provider.add_log_record_processor(proc)
          elsif log_exporter_mode == "console"
            proc = OpenTelemetry::SDK::Logs::Export::SimpleLogRecordProcessor.new(
              observe.call(OpenTelemetry::SDK::Logs::Export::ConsoleLogRecordExporter.new, :logs)
            )
            logger_provider.add_log_record_processor(proc)
          end

          Array(opts.log_processors).each do |lp|
            logger_provider.add_log_record_processor(lp)
          end
        end

        otel_logger = logger_provider.logger(name: "libo11y", version: Libo11y::VERSION)
        structured_logger = Internal::StructuredLogger.new(
          policy: policy,
          otel_logger: otel_logger,
          console_writer: opts.console_writer.nil? ? $stdout : opts.console_writer,
          console_enabled: opts.console_enabled,
          log_level: opts.log_level,
          attr_replacer: opts.attr_replacer,
          extra_sinks: opts.extra_log_sinks
        )

        summary_attrs, summary_line = Internal::Summary.build(
          options: opts,
          env_map: env_map,
          identity: res_result,
          level: structured_logger.level,
          exporters: {
            traces: trace_exporter_mode,
            metrics: metric_exporter_mode,
            logs: log_exporter_mode,
            runtime_metrics: opts.runtime_metrics && !sdk_disabled ? true : false
          },
          propagator: propagator
        )

        # The startup canary, on global setup only and before any global is
        # installed. A sink that raises, or a log exporter that answers the
        # record with a failure, fails setup.
        if is_global
          begin
            _, rejected = failures.fetch(:logs).during do
              structured_logger.log_with_attrs(
                ::Logger::INFO,
                "telemetry configured",
                summary_attrs,
                event_name: Spec::EVENT_TELEMETRY_CONFIGURED,
                force: true,
                raise_on_sink_error: true
              )
            end
          rescue StandardError => e
            raise CanaryRejected, "o11y: startup canary rejected by log pipeline: #{e.message}"
          end
          raise CanaryRejected, "o11y: startup canary rejected by log pipeline: #{rejected.first.message}" unless rejected.empty?

          @global_mutex.synchronize do
            @global_state = :active
            OpenTelemetry.tracer_provider = tracer_provider
            OpenTelemetry.meter_provider = meter_provider if OpenTelemetry.respond_to?(:meter_provider=)
            OpenTelemetry.logger_provider = logger_provider if OpenTelemetry.respond_to?(:logger_provider=)
            OpenTelemetry.propagation = propagator
          end
        end

        Telemetry.new(
          tracer_provider: tracer_provider,
          meter_provider: meter_provider,
          logger_provider: logger_provider,
          propagator: propagator,
          logger: structured_logger,
          resource: resource,
          policy: policy,
          effective_config: summary_line,
          shutdown_timeout: opts.shutdown_timeout,
          is_global: is_global,
          failures: failures,
          on_global_shutdown: method(:reset_global!)
        )
      end
    end
  end
end
