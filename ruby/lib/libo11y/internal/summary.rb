# frozen_string_literal: true

require "logger"
require_relative "endpoint"

module Libo11y
  module Internal
    # The resolved configuration, as the attributes of the
    # o11y.telemetry.configured event and as one line. It reports what
    # happens after options have been weighed against the environment, with
    # the attribute names the registry defines and go/summary.go writes.
    module Summary
      LEVELS = {
        ::Logger::DEBUG => "DEBUG", ::Logger::INFO => "INFO", ::Logger::WARN => "WARN",
        ::Logger::ERROR => "ERROR", ::Logger::FATAL => "FATAL", ::Logger::UNKNOWN => "ANY"
      }.freeze
      DEFAULT_SAMPLER = "parentbased_always_on"
      # What the summary reports for propagators that declare no header field.
      FIELDLESS = "custom"
      ENDPOINTS = {
        "endpoint" => "OTEL_EXPORTER_OTLP_ENDPOINT",
        "traces_endpoint" => "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        "metrics_endpoint" => "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
        "logs_endpoint" => "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"
      }.freeze

      module_function

      # @return [Array(Hash, String)] the event attributes and the line
      def build(options:, env_map:, identity:, level:, exporters:, propagator:)
        attrs = { "service.name" => identity.service_name, "service.version" => identity.service_version }
        %i[traces metrics logs].each { |signal| attrs["o11y.config.#{signal}"] = exporters.fetch(signal) }
        attrs["o11y.config.console"] = options.console_enabled ? "json" : "off"
        attrs["o11y.config.level"] = LEVELS.fetch(level, level.to_s)
        attrs["o11y.config.sampler"] = sampler(options, env_map)
        attrs["o11y.config.propagators"] = propagator.fields.empty? ? FIELDLESS : propagator.fields.join(",")
        attrs["o11y.config.runtime_metrics"] = exporters.fetch(:runtime_metrics).to_s
        attrs["o11y.config.service_version_fallback"] = "true" if identity.version_fallback
        # An endpoint may carry credentials in its userinfo or query, and the
        # summary goes to every sink, so each one is sanitized.
        ENDPOINTS.each do |key, name|
          raw = Env.value(env_map, name)
          attrs["o11y.config.#{key}"] = Endpoint.sanitize(raw) if raw
        end
        [attrs.freeze, attrs.map { |k, v| "#{k}=#{v}" }.join(" ").freeze]
      end

      def sampler(options, env_map)
        return options.sampler.description if options.sampler

        (Env.value(env_map, "OTEL_TRACES_SAMPLER") || DEFAULT_SAMPLER).downcase
      end
    end
  end
end
