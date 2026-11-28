# frozen_string_literal: true

require_relative "../errors"

module Libo11y
  module Internal
    module Env
      SUPPORTED_EXPORTERS = %w[otlp console none].freeze
      SUPPORTED_PROTOCOLS = %w[http/protobuf].freeze

      module_function

      def resolve_map(env_opt)
        return {} if env_opt.equal?(Libo11y::HERMETIC)
        return ENV.to_h if env_opt.nil?

        env_opt.transform_keys(&:to_s).transform_values(&:to_s)
      end

      def hermetic?(env_opt)
        env_opt.equal?(Libo11y::HERMETIC)
      end

      def sdk_disabled?(env_map)
        env_map["OTEL_SDK_DISABLED"].to_s.strip.downcase == "true"
      end

      def parse_resource_attributes(raw)
        return {} if raw.nil? || raw.strip.empty?

        out = {}
        raw.split(",").each do |pair|
          k, v = pair.split("=", 2)
          next if k.nil? || v.nil?

          key = k.strip
          next if key.empty?

          out[key] = decode_percent(v.strip)
        end
        out
      end

      def decode_percent(str)
        str.gsub(/%([0-9A-Fa-f]{2})/) { Regexp.last_match(1).to_i(16).chr(Encoding::UTF_8) }
      rescue StandardError
        str
      end

      def parse_headers(raw)
        return {} if raw.nil? || raw.strip.empty?

        out = {}
        raw.split(",").each do |pair|
          k, v = pair.split("=", 2)
          next if k.nil? || v.nil?

          key = k.strip
          next if key.empty?

          out[key] = decode_percent(v.strip)
        end
        out
      end

      def parse_exporter_choice(env_map, var_name, default:)
        raw = env_map[var_name]
        return default if raw.nil? || raw.strip.empty?

        first = raw.split(",").first.to_s.strip.downcase
        raise UnsupportedProtocol, "o11y: unsupported exporter #{first.inspect} in #{var_name}" unless SUPPORTED_EXPORTERS.include?(first)

        first
      end

      def parse_protocol(env_map, signal_var)
        raw = env_map[signal_var] || env_map["OTEL_EXPORTER_OTLP_PROTOCOL"]
        return "http/protobuf" if raw.nil? || raw.strip.empty?

        proto = raw.strip.downcase
        unless SUPPORTED_PROTOCOLS.include?(proto)
          raise UnsupportedProtocol, "o11y: unsupported OTLP protocol #{proto.inspect} (supported: http/protobuf)"
        end

        proto
      end

      def signal_endpoint(env_map, signal_var, path_suffix)
        specific = env_map[signal_var]
        return specific.strip unless specific.nil? || specific.strip.empty?

        base = env_map["OTEL_EXPORTER_OTLP_ENDPOINT"]
        base = "http://localhost:4318" if base.nil? || base.strip.empty?
        "#{base.strip.sub(%r{/+\z}, "")}#{path_suffix}"
      end

      def signal_headers(env_map, signal_var)
        base = parse_headers(env_map["OTEL_EXPORTER_OTLP_HEADERS"])
        specific = parse_headers(env_map[signal_var])
        base.merge(specific)
      end

      def signal_timeout(env_map, signal_var, default: 10.0)
        raw = env_map[signal_var] || env_map["OTEL_EXPORTER_OTLP_TIMEOUT"]
        return default if raw.nil? || raw.strip.empty?

        ms = Float(raw.strip)
        ms.positive? ? ms / 1000.0 : default
      rescue ArgumentError
        default
      end

      def signal_compression(env_map, signal_var)
        raw = env_map[signal_var] || env_map["OTEL_EXPORTER_OTLP_COMPRESSION"]
        return "gzip" if raw.nil? || raw.strip.empty?

        val = raw.strip.downcase
        return "gzip" if val == "gzip"
        return "none" if val == "none"

        raise UnsupportedProtocol, "o11y: unsupported OTLP compression #{val.inspect}"
      end

      def signal_tls(env_map, prefix)
        {
          certificate_file: env_map["#{prefix}_CERTIFICATE"] || env_map["OTEL_EXPORTER_OTLP_CERTIFICATE"],
          client_certificate_file: env_map["#{prefix}_CLIENT_CERTIFICATE"] || env_map["OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE"],
          client_key_file: env_map["#{prefix}_CLIENT_KEY"] || env_map["OTEL_EXPORTER_OTLP_CLIENT_KEY"]
        }.compact
      end

      def parse_exemplar_filter(opt_filter, env_map)
        return opt_filter unless opt_filter.nil?

        raw = env_map["OTEL_METRICS_EXEMPLAR_FILTER"]
        return ExemplarFilter::TRACE_BASED if raw.nil? || raw.strip.empty?

        case raw.strip.downcase
        when "trace_based" then ExemplarFilter::TRACE_BASED
        when "always_on" then ExemplarFilter::ALWAYS_ON
        when "always_off" then ExemplarFilter::ALWAYS_OFF
        else
          raise ExporterError, "o11y: unsupported exemplar filter #{raw.inspect}"
        end
      end

      def parse_int(env_map, key, default)
        raw = env_map[key]
        return default if raw.nil? || raw.strip.empty?

        val = Integer(raw.strip, 10)
        val.positive? ? val : default
      rescue ArgumentError
        default
      end
    end
  end
end
