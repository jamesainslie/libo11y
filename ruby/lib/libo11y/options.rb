# frozen_string_literal: true

module Libo11y
  # Sentinel passed to `env:` for hermetic mode (no ambient OTEL_* env vars read).
  HERMETIC = Object.new.freeze

  module PIIMode
    DROP = :drop
    HASH = :hash
    ALLOW = :allow
    ALL = [DROP, HASH, ALLOW].freeze
  end

  module ExemplarFilter
    TRACE_BASED = :trace_based
    ALWAYS_ON = :always_on
    ALWAYS_OFF = :always_off
    ALL = [TRACE_BASED, ALWAYS_ON, ALWAYS_OFF].freeze
  end

  ShutdownReport = Data.define(:traces_error, :metrics_error, :logs_error) do
    def ok?
      traces_error.nil? && metrics_error.nil? && logs_error.nil?
    end

    def errors
      {
        traces: traces_error,
        metrics: metrics_error,
        logs: logs_error
      }.compact
    end
  end

  Options = Struct.new(
    :service_name,
    :version,
    :environment,
    :service_namespace,
    :service_instance_id,
    :extra_environments,
    :strict_identity,
    :resource_attributes,
    :build_info,
    :build_info_enabled,
    :env,
    :pii_mode,
    :pii_hash_key,
    :app_registries,
    :attr_replacer,
    :propagators,
    :baggage_egress_allow,
    :sampler,
    :exemplar_filter,
    :histogram_buckets,
    :views,
    :runtime_metrics,
    :console_writer,
    :console_enabled,
    :log_level,
    :extra_log_sinks,
    :span_exporter,
    :span_processors,
    :metric_reader,
    :log_exporter,
    :log_processors,
    :shutdown_timeout,
    keyword_init: true
  ) do
    # An Options object with the keywords laid over it. The object given is
    # not changed.
    #
    # @raise [ArgumentError] for a keyword that is not an option
    def self.merge(options, **kwargs)
      return new(**kwargs) if options.nil?
      raise ArgumentError, "libo11y: options must be a Libo11y::Options, got #{options.class}" unless options.is_a?(Options)

      new(**options.to_h, **kwargs)
    end

    def initialize(**kwargs)
      unknown = kwargs.keys - self.class.members
      raise ArgumentError, "libo11y: unknown option#{"s" if unknown.length > 1} #{unknown.join(", ")}" unless unknown.empty?

      defaults = {
        extra_environments: [],
        strict_identity: true,
        resource_attributes: {},
        build_info_enabled: true,
        env: nil,
        pii_mode: PIIMode::DROP,
        app_registries: nil,
        runtime_metrics: true,
        console_enabled: true,
        log_level: ::Logger::INFO,
        extra_log_sinks: [],
        span_processors: [],
        log_processors: [],
        shutdown_timeout: 5.0
      }
      super(**defaults.merge(kwargs))
    end
  end
end
