# frozen_string_literal: true

require "opentelemetry"

module Libo11y
  # Database client instrumentation with parent-gated client spans, SQL literal sanitization,
  # and db.client.operation.duration metrics with exemplars.
  module DB
    SANITIZABLE_SYSTEMS = %w[postgresql sqlite mysql mariadb].freeze
    DB_DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0].freeze

    module_function

    # Sanitize SQL string and numeric literals for supported dialects.
    def sanitize_sql(sql, db_system:)
      return nil unless SANITIZABLE_SYSTEMS.include?(db_system.to_s.downcase)

      out = +""
      i = 0
      len = sql.length
      while i < len
        ch = sql[i]
        # Line comment --
        if ch == "-" && sql[i + 1] == "-"
          nl = sql.index("\n", i)
          i = nl ? nl + 1 : len
          out << " "
        # Block comment /* ... */
        elsif ch == "/" && sql[i + 1] == "*"
          close = sql.index("*/", i + 2)
          i = close ? close + 2 : len
          out << " "
        # Single-quoted string literal
        elsif ch == "'"
          i += 1
          while i < len
            if sql[i] == "'" && sql[i + 1] == "'"
              i += 2
            elsif sql[i] == "'"
              i += 1
              break
            else
              i += 1
            end
          end
          out << "?"
        # Hex literal 0x...
        elsif ch == "0" && %w[x X].include?(sql[i + 1]) && (i.zero? || !/[A-Za-z0-9_]/.match?(sql[i - 1]))
          i += 2
          i += 1 while i < len && /[0-9a-fA-F]/.match?(sql[i])
          out << "?"
        # Numeric literal
        elsif ch.between?("0", "9") && (i.zero? || !/[A-Za-z0-9_$]/.match?(sql[i - 1]))
          i += 1 while i < len && /[0-9.]/.match?(sql[i])
          if i < len && %w[e E].include?(sql[i])
            i += 1
            i += 1 if i < len && ["+", "-"].include?(sql[i])
            i += 1 while i < len && sql[i] >= "0" && sql[i] <= "9"
          end
          out << "?"
        else
          out << ch
          i += 1
        end
      end
      out.strip.gsub(/\s+/, " ")
    end

    def extract_operation(sql)
      m = /\A\s*([A-Za-z]+)/.match(sql.to_s)
      m ? m[1].upcase : "QUERY"
    end

    class Client
      def initialize(db_system:, db_namespace: nil, server_address: nil, server_port: nil, telemetry: nil)
        @db_system = db_system.to_s
        @db_namespace = db_namespace
        @server_address = server_address
        @server_port = server_port
        @telemetry = telemetry
      end

      # Execute a DB operation; emits a client span only when an active parent span exists,
      # and always records db.client.operation.duration with exemplars.
      def execute(sql, operation: nil, &block)
        op = operation || DB.extract_operation(sql)
        sanitized = DB.sanitize_sql(sql, db_system: @db_system)

        meter = @telemetry ? @telemetry.meter("libo11y.db", version: Libo11y::VERSION) : OpenTelemetry.meter_provider.meter("libo11y.db", version: Libo11y::VERSION)
        @duration_hist ||= meter.create_histogram(
          "db.client.operation.duration",
          unit: "s",
          description: "Duration of database client operations.",
          explicit_bucket_boundaries: DB_DURATION_BUCKETS
        )

        metric_attrs = {
          "db.system.name" => @db_system,
          "db.operation.name" => op
        }
        metric_attrs["db.namespace"] = @db_namespace.to_s if @db_namespace
        metric_attrs["server.address"] = @server_address.to_s if @server_address
        metric_attrs["server.port"] = @server_port.to_i if @server_port

        parent_valid = OpenTelemetry::Trace.current_span.context.valid?
        started = Process.clock_gettime(Process::CLOCK_MONOTONIC)

        unless parent_valid
          begin
            return yield
          rescue StandardError => e
            metric_attrs["error.type"] = e.class.name
            raise
          ensure
            @duration_hist.record(Process.clock_gettime(Process::CLOCK_MONOTONIC) - started, attributes: metric_attrs)
          end
        end

        span_attrs = metric_attrs.dup
        span_attrs["db.query.text"] = sanitized if sanitized
        span_name = @db_namespace ? "#{op} #{@db_namespace}" : op

        tracer = @telemetry ? @telemetry.tracer("libo11y.db", Libo11y::VERSION) : OpenTelemetry.tracer_provider.tracer("libo11y.db", Libo11y::VERSION)
        tracer.in_span(span_name, attributes: span_attrs, kind: :client) do |span|
          yield
        rescue StandardError => e
          span.record_exception(e)
          span.status = OpenTelemetry::Trace::Status.error(e.message)
          span.set_attribute("error.type", e.class.name)
          metric_attrs["error.type"] = e.class.name
          raise
        ensure
          @duration_hist.record(Process.clock_gettime(Process::CLOCK_MONOTONIC) - started, attributes: metric_attrs)
        end
      end
    end
  end
end
