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
require_relative "internal/policy"
require_relative "internal/resource"
require_relative "internal/propagators"
require_relative "internal/bridges"
require_relative "internal/logging_device"
require_relative "internal/runtime_metrics"

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
      on_global_shutdown: nil
    )
      @tracer_provider = tracer_provider
      @meter_provider = meter_provider
      @logger_provider = logger_provider
      @propagator = propagator
      @logger = logger
      @resource = resource
      @policy = policy
      @effective_config = effective_config.freeze
      @shutdown_timeout = shutdown_timeout
      @is_global = is_global
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

    def effective_config
      @effective_config.dup
    end

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

    # Idempotent, bounded, concurrent shutdown across traces, metrics, and logs.
    def shutdown(timeout: nil)
      elected = false
      @shutdown_mutex.synchronize do
        return @shutdown_report if @shutdown_done

        if @shutdown_in_progress
          @shutdown_cv.wait(@shutdown_mutex) until @shutdown_done
          return @shutdown_report
        end

        @shutdown_in_progress = true
        elected = true
      end

      return @shutdown_report unless elected

      deadline_secs = timeout.nil? ? @shutdown_timeout : Float(timeout)
      deadline_secs = 5.0 if deadline_secs <= 0
      errors = {}
      err_mutex = Mutex.new

      signals = {
        logs: @logger_provider,
        metrics: @meter_provider,
        traces: @tracer_provider
      }

      threads = signals.map do |sig_name, provider|
        Thread.new do
          next if provider.nil?

          res = provider.shutdown(timeout: deadline_secs)
          if res.is_a?(Integer) && res != 0
            err_mutex.synchronize do
              errors[sig_name] = ExporterError.new("o11y: #{sig_name} shutdown failed with status #{res}")
            end
          end
        rescue StandardError => e
          err_mutex.synchronize { errors[sig_name] = e }
        end
      end

      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + deadline_secs
      threads.each_with_index do |t, idx|
        sig_name = signals.keys[idx]
        remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
        joined = remaining.positive? ? t.join(remaining) : t.join(0)
        next if joined

        err_mutex.synchronize do
          errors[sig_name] ||= ExporterError.new("o11y: #{sig_name} shutdown timed out after #{deadline_secs}s")
        end
      end

      report = ShutdownReport.new(
        traces_error: errors[:traces],
        metrics_error: errors[:metrics],
        logs_error: errors[:logs]
      )

      @on_global_shutdown&.call if @is_global

      @shutdown_mutex.synchronize do
        @shutdown_report = report
        @shutdown_done = true
        @shutdown_in_progress = false
        @shutdown_cv.broadcast
      end

      report
    end

    def force_flush(timeout: nil)
      t = timeout.nil? ? @shutdown_timeout : Float(timeout)
      @logger_provider&.force_flush(timeout: t)
      @meter_provider&.force_flush(timeout: t)
      @tracer_provider&.force_flush(timeout: t)
      true
    end
  end

  module Builder
    @global_mutex = Mutex.new
    @global_active = false

    class << self
      def build(options_or_nil = nil, is_global:, **)
        opts = if options_or_nil.is_a?(Options)
                 options_or_nil
               else
                 Options.new(**)
               end

        if is_global
          @global_mutex.synchronize do
            raise AlreadySetup if @global_active
          end
        end

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

        # Effective config tracking
        cfg = {
          "service.name" => res_result.service_name,
          "deployment.environment.name" => res_result.environment,
          "service.version" => res_result.service_version,
          "service.instance.id" => res_result.instance_id,
          "sdk.disabled" => sdk_disabled.to_s
        }

        # Build TracerProvider
        sampler = Internal::Bridges.build_sampler(opts.sampler, env_map)
        tracer_provider = OpenTelemetry::SDK::Trace::TracerProvider.new(
          sampler: sampler,
          resource: resource
        )

        trace_exporter_mode = if sdk_disabled || (opts.span_exporter.nil? && hermetic)
                                "none"
                              elsif opts.span_exporter
                                "injected"
                              else
                                Internal::Env.parse_exporter_choice(env_map, "OTEL_TRACES_EXPORTER", default: "otlp")
                              end
        cfg["traces.exporter"] = trace_exporter_mode

        unless sdk_disabled
          if opts.span_exporter
            wrapped = Internal::Bridges::PolicySpanExporter.new(opts.span_exporter, policy)
            tracer_provider.add_span_processor(
              OpenTelemetry::SDK::Trace::Export::SimpleSpanProcessor.new(wrapped)
            )
          elsif trace_exporter_mode == "otlp"
            endpoint = Internal::Env.signal_endpoint(env_map, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "/v1/traces")
            cfg["traces.endpoint"] = Internal::Endpoint.sanitize(endpoint)
            otlp_exp = Internal::Bridges.build_otlp_trace_exporter(env_map)
            wrapped = Internal::Bridges::PolicySpanExporter.new(otlp_exp, policy)
            tracer_provider.add_span_processor(
              OpenTelemetry::SDK::Trace::Export::BatchSpanProcessor.new(
                wrapped,
                schedule_delay: Internal::Env.parse_int(env_map, "OTEL_BSP_SCHEDULE_DELAY", 5000),
                max_queue_size: Internal::Env.parse_int(env_map, "OTEL_BSP_MAX_QUEUE_SIZE", 2048),
                max_export_batch_size: Internal::Env.parse_int(env_map, "OTEL_BSP_MAX_EXPORT_BATCH_SIZE", 512),
                exporter_timeout: Internal::Env.parse_int(env_map, "OTEL_BSP_EXPORT_TIMEOUT", 30_000)
              )
            )
          elsif trace_exporter_mode == "console"
            wrapped = Internal::Bridges::PolicySpanExporter.new(
              OpenTelemetry::SDK::Trace::Export::ConsoleSpanExporter.new, policy
            )
            tracer_provider.add_span_processor(
              OpenTelemetry::SDK::Trace::Export::SimpleSpanProcessor.new(wrapped)
            )
          end

          Array(opts.span_processors).each do |sp|
            tracer_provider.add_span_processor(Internal::Bridges::PolicySpanProcessor.new(sp, policy))
          end
        end

        # Build MeterProvider
        raw_meter_provider = OpenTelemetry::SDK::Metrics::MeterProvider.new(resource: resource)
        exemplar_filter = if sdk_disabled
                            ExemplarFilter::ALWAYS_OFF
                          else
                            Internal::Env.parse_exemplar_filter(opts.exemplar_filter, env_map)
                          end
        Internal::Bridges.configure_exemplar_filter(raw_meter_provider, exemplar_filter)
        cfg["metrics.exemplar_filter"] = exemplar_filter.to_s

        metric_exporter_mode = if sdk_disabled || (opts.metric_reader.nil? && hermetic)
                                 "none"
                               elsif opts.metric_reader
                                 "injected"
                               else
                                 Internal::Env.parse_exporter_choice(env_map, "OTEL_METRICS_EXPORTER", default: "otlp")
                               end
        cfg["metrics.exporter"] = metric_exporter_mode

        unless sdk_disabled
          if opts.metric_reader
            raw_meter_provider.add_metric_reader(opts.metric_reader)
          elsif metric_exporter_mode == "otlp"
            endpoint = Internal::Env.signal_endpoint(env_map, "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "/v1/metrics")
            cfg["metrics.endpoint"] = Internal::Endpoint.sanitize(endpoint)
            otlp_mexp = Internal::Bridges.build_otlp_metric_exporter(env_map)
            reader = OpenTelemetry::SDK::Metrics::Export::PeriodicMetricReader.new(
              exporter: otlp_mexp,
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

          if opts.histogram_buckets.is_a?(Hash)
            opts.histogram_buckets.each do |inst_name, buckets|
              raw_meter_provider.add_view(
                inst_name.to_s,
                type: :histogram,
                aggregation: OpenTelemetry::SDK::Metrics::Aggregation::ExplicitBucketHistogram.new(
                  boundaries: Array(buckets)
                )
              )
            end
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
        logger_provider = OpenTelemetry::SDK::Logs::LoggerProvider.new(resource: resource)
        log_exporter_mode = if sdk_disabled || (opts.log_exporter.nil? && hermetic)
                              "none"
                            elsif opts.log_exporter
                              "injected"
                            else
                              Internal::Env.parse_exporter_choice(env_map, "OTEL_LOGS_EXPORTER", default: "otlp")
                            end
        cfg["logs.exporter"] = log_exporter_mode

        unless sdk_disabled
          if opts.log_exporter
            proc = OpenTelemetry::SDK::Logs::Export::SimpleLogRecordProcessor.new(opts.log_exporter)
            logger_provider.add_log_record_processor(Internal::Bridges::PolicyLogRecordProcessor.new(proc, policy))
          elsif log_exporter_mode == "otlp"
            endpoint = Internal::Env.signal_endpoint(env_map, "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "/v1/logs")
            cfg["logs.endpoint"] = Internal::Endpoint.sanitize(endpoint)
            otlp_lexp = Internal::Bridges.build_otlp_log_exporter(env_map)
            proc = OpenTelemetry::SDK::Logs::Export::BatchLogRecordProcessor.new(
              otlp_lexp,
              schedule_delay: Internal::Env.parse_int(env_map, "OTEL_BLRP_SCHEDULE_DELAY", 1000),
              max_queue_size: Internal::Env.parse_int(env_map, "OTEL_BLRP_MAX_QUEUE_SIZE", 2048),
              max_export_batch_size: Internal::Env.parse_int(env_map, "OTEL_BLRP_MAX_EXPORT_BATCH_SIZE", 512),
              exporter_timeout: Internal::Env.parse_int(env_map, "OTEL_BLRP_EXPORT_TIMEOUT", 30_000)
            )
            logger_provider.add_log_record_processor(Internal::Bridges::PolicyLogRecordProcessor.new(proc, policy))
          elsif log_exporter_mode == "console"
            proc = OpenTelemetry::SDK::Logs::Export::SimpleLogRecordProcessor.new(
              OpenTelemetry::SDK::Logs::Export::ConsoleLogRecordExporter.new
            )
            logger_provider.add_log_record_processor(Internal::Bridges::PolicyLogRecordProcessor.new(proc, policy))
          end

          Array(opts.log_processors).each do |lp|
            logger_provider.add_log_record_processor(Internal::Bridges::PolicyLogRecordProcessor.new(lp, policy))
          end
        end

        otel_logger = logger_provider.logger(name: "libo11y", version: Libo11y::VERSION)
        structured_logger = Internal::StructuredLogger.new(
          policy: policy,
          otel_logger: otel_logger,
          console_writer: opts.console_writer.nil? ? $stdout : opts.console_writer,
          console_enabled: opts.console_enabled,
          console_level: opts.console_level,
          attr_replacer: opts.attr_replacer,
          extra_sinks: opts.extra_log_sinks
        )

        # Startup canary on global setup only (before installing globals)
        if is_global
          canary_attrs = {}
          cfg.each { |k, v| canary_attrs["o11y.config.#{k}"] = v }
          begin
            structured_logger.log_with_attrs(
              ::Logger::INFO,
              "telemetry configured",
              canary_attrs,
              event_name: Spec::EVENT_TELEMETRY_CONFIGURED,
              force: true,
              raise_on_sink_error: true
            )
          rescue StandardError => e
            begin
              tracer_provider.shutdown(timeout: 1.0)
            rescue StandardError
              nil
            end
            begin
              raw_meter_provider.shutdown(timeout: 1.0)
            rescue StandardError
              nil
            end
            begin
              logger_provider.shutdown(timeout: 1.0)
            rescue StandardError
              nil
            end
            raise CanaryRejected, "o11y: startup canary rejected by sink: #{e.message}"
          end

          @global_mutex.synchronize do
            raise AlreadySetup if @global_active

            @global_active = true
            OpenTelemetry.tracer_provider = tracer_provider
            OpenTelemetry.meter_provider = meter_provider if OpenTelemetry.respond_to?(:meter_provider=)
            OpenTelemetry.logger_provider = logger_provider if OpenTelemetry.respond_to?(:logger_provider=)
            OpenTelemetry.propagation = propagator
          end
        end

        on_global_shutdown = lambda do
          @global_mutex.synchronize { @global_active = false }
        end

        Telemetry.new(
          tracer_provider: tracer_provider,
          meter_provider: meter_provider,
          logger_provider: logger_provider,
          propagator: propagator,
          logger: structured_logger,
          resource: resource,
          policy: policy,
          effective_config: cfg,
          shutdown_timeout: opts.shutdown_timeout,
          is_global: is_global,
          on_global_shutdown: on_global_shutdown
        )
      end

      def reset_global!
        @global_mutex.synchronize { @global_active = false }
      end
    end
  end
end
