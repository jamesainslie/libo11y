# frozen_string_literal: true

require "opentelemetry"
require_relative "internal/sql_text"

module Libo11y
  # Database client instrumentation. A call gets a client span only under an
  # active parent span, and always a db.client.operation.duration
  # measurement. Statement text is recorded with every literal and comment
  # removed, and never the driver's error message, which often quotes
  # statement values.
  module DB
    DB_DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0].freeze
    SCOPE_NAME = "libo11y.db"

    # The lexer for a db.system.name value, and whether that lexer is known to
    # find every literal the database reads. An unknown system gets the
    # standard lexer and false: its text is still summarized into
    # db.operation.name and db.collection.name, but never recorded as
    # db.query.text, because a lexer that misreads a string could keep part of
    # a value.
    def self.dialect_for(db_system)
      case db_system
      when "postgresql" then [:standard, true]
      when "sqlite" then [:sqlite, true]
      when "mysql", "mariadb" then [:mysql, true]
      else [:standard, false]
      end
    end

    # The error.type of a failed call: the SQLSTATE when the driver's error
    # carries one, else the error's class name.
    def self.error_type(error)
      state = error.sqlstate if error.respond_to?(:sqlstate)
      return state if state.is_a?(String) && !state.empty?

      error.class.name || error.class.to_s
    end

    # Wraps database calls. One client describes one database, so it is safe
    # to share between threads.
    class Client
      # @param db_system [String] the db.system.name value, such as "postgresql"
      # @param db_namespace [String, nil] the database name
      # @param query_text [Boolean] record the sanitized statement as
      #   db.query.text. It is recorded only for postgresql, sqlite, mysql and
      #   mariadb, whose literals the sanitizer knows.
      # @param telemetry [Libo11y::Telemetry, nil] the handle to record
      #   through. Without one the client uses the global providers.
      def initialize(db_system:, db_namespace: nil, server_address: nil, server_port: nil, query_text: true, telemetry: nil)
        @db_system = db_system.to_s
        @db_namespace = db_namespace
        @server_address = server_address
        @server_port = server_port
        @telemetry = telemetry
        @dialect, known = DB.dialect_for(@db_system)
        @query_text = query_text && known
        @mutex = Mutex.new
        @duration = nil
      end

      # Runs the block as one database call and returns its value.
      #
      # @param sql [String, nil] the statement. Its operation and table name
      #   the span, and its sanitized text is db.query.text.
      # @param operation [String, nil] the operation name for a call with no
      #   statement of its own, such as COMMIT. It replaces the one read from
      #   sql.
      # @param collection [String, nil] the table name, with operation.
      def execute(sql, operation: nil, collection: nil, &)
        name, attrs, text = describe(sql, operation, collection)
        started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        return measure(attrs, started, &) unless OpenTelemetry::Trace.current_span.context.valid?

        span_attrs = text.empty? ? attrs : attrs.merge("db.query.text" => text)
        span = tracer.start_span(name, attributes: span_attrs, kind: :client)
        begin
          OpenTelemetry::Trace.with_span(span) do
            measure(attrs, started) do
              yield
            rescue StandardError => e
              span.set_attribute("error.type", DB.error_type(e))
              # No description: the driver's message may quote statement values.
              span.status = OpenTelemetry::Trace::Status.error
              raise
            end
          end
        ensure
          span.finish
        end
      end

      private

      # Records the call's duration, with error.type when the block raises.
      def measure(attrs, started)
        yield
      rescue StandardError => e
        attrs = attrs.merge("error.type" => DB.error_type(e))
        raise
      ensure
        duration.record(Process.clock_gettime(Process::CLOCK_MONOTONIC) - started, attributes: attrs)
      end

      # Returns the span name, the attributes shared by the span and the
      # measurement, and the statement text to record, which may be empty.
      def describe(sql, operation, collection)
        text = ""
        unless sql.nil?
          # OTLP sends attribute values as protobuf strings, which must be
          # valid UTF-8, and one invalid value fails the whole export batch.
          sanitized = Internal::SqlText.sanitize(sql.to_s, @dialect).dup.force_encoding(Encoding::UTF_8).scrub("�")
          found_operation, found_collection = Internal::SqlText.summarize(sanitized)
          if operation.nil?
            operation = found_operation
            collection ||= found_collection
          end
          text = Internal::SqlText.truncate(sanitized) if @query_text
        end
        name, attrs = named(operation.to_s, collection.to_s)
        [name, attrs, text]
      end

      def named(operation, collection)
        attrs = { "db.system.name" => @db_system }
        attrs["db.namespace"] = @db_namespace.to_s if @db_namespace
        name = @db_system
        unless operation.empty?
          attrs["db.operation.name"] = operation
          name = operation
        end
        unless collection.empty?
          attrs["db.collection.name"] = collection
          name = operation.empty? ? collection : "#{operation} #{collection}"
        end
        attrs["server.address"] = @server_address.to_s if @server_address
        attrs["server.port"] = @server_port.to_i if @server_port
        [name, attrs]
      end

      def tracer
        provider = @telemetry ? @telemetry.tracer_provider : OpenTelemetry.tracer_provider
        provider.tracer(SCOPE_NAME, Libo11y::VERSION)
      end

      def duration
        @mutex.synchronize do
          @duration ||= begin
            provider = @telemetry ? @telemetry.meter_provider : OpenTelemetry.meter_provider
            provider.meter(SCOPE_NAME, version: Libo11y::VERSION).create_histogram(
              "db.client.operation.duration",
              unit: "s",
              description: "Duration of database client operations."
            )
          end
        end
      end
    end
  end
end
