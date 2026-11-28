# frozen_string_literal: true

require "openssl"
require "opentelemetry/sdk"
require "opentelemetry-logs-sdk"
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

      # The first of the named variables that is set to more than blanks,
      # with its surrounding blanks removed. An empty per-signal variable
      # therefore falls back to the general one.
      def value(env_map, *names)
        names.each do |name|
          raw = env_map[name].to_s.strip
          return raw unless raw.empty?
        end
        nil
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

      # Decodes %XX escapes as the bytes of UTF-8 text. A % that starts no
      # escape stays, and bytes that are not UTF-8 are replaced.
      def decode_percent(str)
        str.b.gsub(/%([0-9A-Fa-f]{2})/) { Regexp.last_match(1).hex.chr }.force_encoding(Encoding::UTF_8).scrub
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
        raw = value(env_map, signal_var, "OTEL_EXPORTER_OTLP_PROTOCOL")
        return "http/protobuf" if raw.nil?

        proto = raw.downcase
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
        raw = value(env_map, signal_var, "OTEL_EXPORTER_OTLP_TIMEOUT")
        return default if raw.nil?

        ms = Float(raw)
        ms.positive? ? ms / 1000.0 : default
      rescue ArgumentError
        default
      end

      def signal_compression(env_map, signal_var)
        raw = value(env_map, signal_var, "OTEL_EXPORTER_OTLP_COMPRESSION")
        return "gzip" if raw.nil?

        val = raw.downcase
        return "gzip" if val == "gzip"
        return "none" if val == "none"

        raise UnsupportedProtocol, "o11y: unsupported OTLP compression #{val.inspect}"
      end

      # The TLS files of one signal's exporter. Every key is present, as nil
      # when unset, because an exporter reads the process environment for a
      # keyword it is not given.
      def signal_tls(env_map, prefix)
        {
          certificate_file: value(env_map, "#{prefix}_CERTIFICATE", "OTEL_EXPORTER_OTLP_CERTIFICATE"),
          client_certificate_file: value(env_map, "#{prefix}_CLIENT_CERTIFICATE", "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE"),
          client_key_file: value(env_map, "#{prefix}_CLIENT_KEY", "OTEL_EXPORTER_OTLP_CLIENT_KEY")
        }
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

      # The span limits, from env_map and the SDK's defaults. The SDK's own
      # defaults read the process environment when the SDK loads, so they are
      # never used.
      def span_limits(env_map)
        general_count = "OTEL_ATTRIBUTE_COUNT_LIMIT"
        general_length = "OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT"
        OpenTelemetry::SDK::Trace::SpanLimits.new(
          attribute_count_limit: count_limit(env_map, "OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", general_count),
          attribute_length_limit: length_limit(env_map, "OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT", general_length),
          event_count_limit: count_limit(env_map, "OTEL_SPAN_EVENT_COUNT_LIMIT"),
          link_count_limit: count_limit(env_map, "OTEL_SPAN_LINK_COUNT_LIMIT"),
          event_attribute_count_limit: count_limit(env_map, "OTEL_EVENT_ATTRIBUTE_COUNT_LIMIT"),
          event_attribute_length_limit: length_limit(env_map, "OTEL_EVENT_ATTRIBUTE_VALUE_LENGTH_LIMIT", general_length),
          link_attribute_count_limit: count_limit(env_map, "OTEL_LINK_ATTRIBUTE_COUNT_LIMIT")
        )
      end

      def log_record_limits(env_map)
        OpenTelemetry::SDK::Logs::LogRecordLimits.new(
          attribute_count_limit: count_limit(env_map, "OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT", "OTEL_ATTRIBUTE_COUNT_LIMIT"),
          attribute_length_limit: length_limit(env_map, "OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT", "OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT")
        )
      end

      # A count limit: the first of the named variables that holds a
      # positive integer, else the OpenTelemetry default of 128.
      def count_limit(env_map, *names)
        count = Integer(value(env_map, *names) || "", 10)
        count.positive? ? count : 128
      rescue ArgumentError
        128
      end

      # A value length limit, or nil for none. The SDK accepts 32 or more.
      def length_limit(env_map, *names)
        length = Integer(value(env_map, *names) || "", 10)
        length >= 32 ? length : nil
      rescue ArgumentError
        nil
      end

      # Whether an OTLP exporter verifies the collector's certificate. It
      # does, unless env_map holds OpenTelemetry Ruby's variable that turns
      # verification off. The exporters' own default reads the process
      # environment, so libo11y always passes this one.
      def ssl_verify_mode(env_map)
        return OpenSSL::SSL::VERIFY_PEER if env_map.key?("OTEL_RUBY_EXPORTER_OTLP_SSL_VERIFY_PEER")
        return OpenSSL::SSL::VERIFY_NONE if env_map.key?("OTEL_RUBY_EXPORTER_OTLP_SSL_VERIFY_NONE")

        OpenSSL::SSL::VERIFY_PEER
      end

      # OpenTelemetry Ruby's switch for starting a batch processor's worker
      # when the processor is built, read from env_map.
      def start_thread_on_boot?(env_map, name)
        !env_map[name].to_s.match?(/false/i)
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
