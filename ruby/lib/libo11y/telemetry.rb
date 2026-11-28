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
require_relative "internal/pipeline"
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
    # later caller gets the first call's report. A caller that arrives while
    # the shutdown is running waits for it until its own deadline, and then
    # gets a report that says the shutdown is still in progress. For each
    # signal in the report an o11y.telemetry.dropped event goes to the
    # console and the extra sinks.
    #
    # @param timeout [Numeric, nil] seconds. nil uses the shutdown_timeout
    #   option, 5 by default.
    # @raise [ArgumentError] when timeout is not a number
    def shutdown(timeout: nil)
      secs = resolve_timeout(timeout)
      deadline = monotonic + secs
      @shutdown_mutex.synchronize do
        while @shutdown_in_progress
          remaining = deadline - monotonic
          return in_progress_report(secs) unless remaining.positive?

          @shutdown_cv.wait(@shutdown_mutex, remaining)
        end
        return @shutdown_report if @shutdown_done

        @shutdown_in_progress = true
      end

      report = nil
      begin
        report = run_shutdown(secs, deadline)
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
      each_signal("flush", secs, monotonic + secs) { |provider| provider.force_flush(timeout: secs) }.empty?
    end

    def inspect
      "#<#{self.class.name} #{@effective_config}>"
    end

    private

    SIGNALS = %i[logs metrics traces].freeze
    # How long a shutdown that has used up its deadline still waits for the
    # o11y.telemetry.dropped events to be written, in seconds.
    DROPPED_EVENT_GRACE = 0.05
    private_constant :SIGNALS, :DROPPED_EVENT_GRACE

    def monotonic
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end

    def resolve_timeout(timeout)
      secs = timeout.nil? ? @shutdown_timeout : Float(timeout)
      secs.positive? ? secs : 5.0
    rescue TypeError
      raise ArgumentError, "libo11y: timeout must be a number of seconds, got #{timeout.inspect}"
    end

    def run_shutdown(secs, deadline)
      errors = each_signal("shutdown", secs, deadline) { |provider| provider.shutdown(timeout: secs) }
      report_dropped(errors, deadline)
      @on_global_shutdown&.call if @is_global
      ShutdownReport.new(traces_error: errors[:traces], metrics_error: errors[:metrics], logs_error: errors[:logs])
    end

    # Writes one o11y.telemetry.dropped event per failed signal. The OTLP log
    # leg is already down, so they reach the console and the extra sinks
    # only. A slow sink does not hold the shutdown past its deadline: the
    # events are written on their own thread, which the shutdown waits for
    # until the deadline, or for a short grace when the deadline has passed.
    def report_dropped(errors, deadline)
      return if errors.empty?

      writer = Thread.new { errors.each { |signal, error| emit_dropped(signal, error) } }
      writer.report_on_exception = false
      writer.join([deadline - monotonic, DROPPED_EVENT_GRACE].max)
    end

    def in_progress_report(secs)
      errors = SIGNALS.to_h do |signal|
        [signal, ExporterError.new("o11y: shutdown #{signal}: shutdown is still in progress after #{secs}s")]
      end
      ShutdownReport.new(traces_error: errors[:traces], metrics_error: errors[:metrics], logs_error: errors[:logs])
    end

    # Runs the block for each signal's provider on its own thread, under one
    # deadline. Returns the error of each signal that failed.
    def each_signal(action, secs, deadline)
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

      threads.each do |signal, thread|
        next if thread.join([deadline - monotonic, 0].max)

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
        opts = Options.merge(options_or_nil, **)

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

      def construct(options, is_global, built)
        env_map = Internal::Env.resolve_map(options.env)
        violations = Internal::ViolationRecorder.new
        policy = Internal::SensitivityPolicy.new(
          pii_mode: options.pii_mode,
          pii_hash_key: options.pii_hash_key,
          app_classes: Internal::SensitivityPolicy.load_app_registries(options.app_registries),
          recorder: violations
        )
        identity = Internal::ResourceBuilder.build(options, env_map, policy, violations)
        propagator = Internal::Propagators.build(options.propagators, options.baggage_egress_allow)
        pipeline = Internal::Pipeline.new(
          options: options, env_map: env_map, hermetic: Internal::Env.hermetic?(options.env),
          policy: policy, resource: identity.resource, violations: violations, built: built
        ).build
        logger = build_logger(options, policy, pipeline)

        summary_attrs, summary_line = Internal::Summary.build(
          options: options, env_map: env_map, identity: identity, level: logger.level,
          exporters: pipeline.exporters.merge(runtime_metrics: pipeline.runtime_metrics?), propagator: propagator
        )
        if is_global
          run_canary(logger, summary_attrs, pipeline.failures.fetch(:logs))
          install_globals(pipeline, propagator)
        end

        Telemetry.new(
          tracer_provider: pipeline.tracer_provider,
          meter_provider: pipeline.meter_provider,
          logger_provider: pipeline.logger_provider,
          propagator: propagator,
          logger: logger,
          resource: identity.resource,
          policy: policy,
          effective_config: summary_line,
          shutdown_timeout: options.shutdown_timeout,
          is_global: is_global,
          failures: pipeline.failures,
          on_global_shutdown: method(:reset_global!)
        )
      end

      def build_logger(options, policy, pipeline)
        Internal::StructuredLogger.new(
          policy: policy,
          otel_logger: pipeline.logger_provider.logger(name: "libo11y", version: Libo11y::VERSION),
          console_writer: options.console_writer.nil? ? $stdout : options.console_writer,
          console_enabled: options.console_enabled,
          log_level: options.log_level,
          attr_replacer: options.attr_replacer,
          extra_sinks: options.extra_log_sinks
        )
      end

      # The startup canary: the o11y.telemetry.configured event, forced
      # through the log pipeline before any global is installed. A sink that
      # raises, or a log exporter that answers the record with a failure,
      # fails setup.
      def run_canary(logger, summary_attrs, log_failures)
        _, rejected = log_failures.during do
          logger.log_with_attrs(
            ::Logger::INFO, "telemetry configured", summary_attrs,
            event_name: Spec::EVENT_TELEMETRY_CONFIGURED, force: true, raise_on_sink_error: true
          )
        end
        raise rejected.first unless rejected.empty?
      rescue StandardError => e
        raise CanaryRejected, "o11y: startup canary rejected by log pipeline: #{e.message}"
      end

      GLOBALS = %i[tracer_provider meter_provider logger_provider propagation].freeze
      private_constant :GLOBALS

      # Installs the providers and the propagator as OpenTelemetry's globals.
      # When one of them cannot be installed, the ones already replaced are
      # put back, so a failed setup leaves the globals as it found them.
      def install_globals(pipeline, propagator)
        ours = {
          tracer_provider: pipeline.tracer_provider, meter_provider: pipeline.meter_provider,
          logger_provider: pipeline.logger_provider, propagation: propagator
        }
        @global_mutex.synchronize do
          previous = {}
          begin
            GLOBALS.each do |name|
              previous[name] = OpenTelemetry.public_send(name)
              OpenTelemetry.public_send(:"#{name}=", ours.fetch(name))
            end
          rescue StandardError
            previous.each { |name, value| restore_global(name, value) }
            raise
          end
          @global_state = :active
        end
      end

      def restore_global(name, value)
        OpenTelemetry.public_send(:"#{name}=", value)
      rescue StandardError
        nil
      end
    end
  end
end
