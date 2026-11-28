# frozen_string_literal: true

require "json"
require "stringio"
require "webrick"
require "zlib"
require "opentelemetry/sdk"
require "opentelemetry-metrics-sdk"
require "opentelemetry-logs-sdk"
require "opentelemetry/exporter/otlp"
require "opentelemetry/exporter/otlp_metrics"
require "opentelemetry/exporter/otlp_logs"
require_relative "../libo11y"

module Libo11y
  # Hermetic test harness and in-process OTLP/HTTP receiver for unit and wire tests.
  module Testing
    class AssertionError < StandardError; end

    # Hermetic in-memory recorder that never mutates process globals and never reads OTEL_* env.
    class Recorder
      attr_reader :telemetry, :span_exporter, :metric_reader, :log_exporter, :console_io

      def initialize(
        service_name: "test-service",
        environment: Spec::Environment::TEST,
        version: "1.0.0",
        **extra_opts
      )
        @span_exporter = OpenTelemetry::SDK::Trace::Export::InMemorySpanExporter.new
        @metric_reader = OpenTelemetry::SDK::Metrics::Export::InMemoryMetricPullExporter.new
        @metric_reader.define_singleton_method(:shutdown) do |timeout: nil|
          _ = timeout
          0
        end
        @metric_reader.define_singleton_method(:force_flush) do |timeout: nil|
          _ = timeout
          0
        end
        @log_exporter = OpenTelemetry::SDK::Logs::Export::InMemoryLogRecordExporter.new
        @console_io = StringIO.new

        @telemetry = Libo11y.init(
          service_name: service_name,
          environment: environment,
          version: version,
          env: Libo11y::HERMETIC,
          span_exporter: @span_exporter,
          metric_reader: @metric_reader,
          log_exporter: @log_exporter,
          console_writer: @console_io,
          runtime_metrics: extra_opts.fetch(:runtime_metrics, false),
          **extra_opts.except(:runtime_metrics)
        )
      end

      def spans
        @telemetry.tracer_provider.force_flush
        @span_exporter.finished_spans
      end

      def logs
        @telemetry.logger_provider.force_flush
        @log_exporter.emitted_log_records
      end

      def console_records
        @console_io.string.lines.filter_map do |line|
          stripped = line.strip
          next if stripped.empty?

          JSON.parse(stripped)
        end
      end

      def metrics
        @metric_reader.pull
        @metric_reader.metric_snapshots
      end

      def exemplars(metric_name = nil)
        out = []
        metrics.each do |m|
          next if metric_name && m.name != metric_name

          Array(m.data_points).each do |dp|
            next unless dp.respond_to?(:exemplars) && dp.exemplars

            Array(dp.exemplars).each do |ex|
              out << { metric: m.name, exemplar: ex, data_point: dp }
            end
          end
        end
        out
      end

      # Assert specification conformance across resource, spans, logs, and metrics.
      def assert_conforms!
        res_attrs = @telemetry.resource.attributes
        Spec::REQUIRED_TIER0.each do |key|
          val = res_attrs[key]
          raise AssertionError, "missing required tier0 resource attribute #{key}" if val.nil? || val.to_s.empty?
        end
        if @telemetry.resource.respond_to?(:schema_url) && @telemetry.resource.schema_url != Spec::SCHEMA_URL
          raise AssertionError, "resource schema_url #{@telemetry.resource.schema_url} != #{Spec::SCHEMA_URL}"
        end

        policy = @telemetry.policy

        # Check no secret attributes leaked into resource, spans, or logs
        check_attrs = lambda do |surface, attrs|
          next if attrs.nil?

          attrs.each_key do |k|
            cls = policy.lookup(k.to_s)
            raise AssertionError, "secret attribute #{k} leaked on #{surface}" if cls == Spec::Sensitivity::SECRET
          end
        end

        check_attrs.call("resource", res_attrs)
        spans.each do |s|
          check_attrs.call("span #{s.name}", s.attributes)
          s.events&.each { |ev| check_attrs.call("span event #{ev.name}", ev.attributes) }
          s.links&.each { |lk| check_attrs.call("span link", lk.attributes) }
        end
        logs.each do |lr|
          check_attrs.call("log #{lr.body}", lr.attributes)
          ev_name = lr.event_name || lr.attributes&.[](Spec::EVENT_NAME_KEY)
          next unless ev_name && (ev_info = Spec::EVENTS[ev_name])

          ev_info.required.each do |req_key|
            raise AssertionError, "event #{ev_name} missing required attribute #{req_key}" unless lr.attributes&.key?(req_key)
          end
          ev_info.required_templates.each do |prefix|
            found = lr.attributes&.keys&.any? { |k| k.start_with?("#{prefix}.") }
            raise AssertionError, "event #{ev_name} missing template attribute #{prefix}.*" unless found
          end
        end
        true
      end

      # Assert at least one log record shares trace_id and span_id with a finished span.
      def assert_correlated!
        span_pairs = spans.map { |s| [s.hex_trace_id, s.hex_span_id] }
        raise AssertionError, "no finished spans recorded" if span_pairs.empty?

        matched_log = logs.any? do |lr|
          tid = lr.trace_id&.unpack1("H*")
          sid = lr.span_id&.unpack1("H*")
          span_pairs.include?([tid, sid])
        end
        raise AssertionError, "no OTLP log record correlated with any recorded span" unless matched_log

        matched_console = console_records.any? do |rec|
          span_pairs.include?([rec["trace_id"], rec["span_id"]])
        end
        raise AssertionError, "no console log record correlated with any recorded span" unless matched_console

        true
      end

      # Assert full three-way reconciliation: span <-> log <-> metric exemplar on the same trace_id.
      def assert_triangle!
        assert_correlated!
        span_trace_ids = spans.map(&:hex_trace_id).uniq
        ex_list = exemplars
        matched_exemplar = ex_list.any? do |entry|
          ex = entry[:exemplar]
          tid = ex.trace_id&.unpack1("H*")
          span_trace_ids.include?(tid)
        end
        raise AssertionError, "no metric exemplar reconciled with any recorded trace" unless matched_exemplar

        true
      end

      def shutdown(timeout: 5.0)
        @telemetry.shutdown(timeout: timeout)
      end
    end

    def self.start_recorder(**)
      rec = Recorder.new(**)
      return rec unless block_given?

      begin
        yield rec
      ensure
        rec.shutdown
      end
    end

    # In-process OTLP/HTTP protobuf receiver for wire-level verification.
    class OtlpHttpReceiver
      attr_reader :port, :endpoint, :trace_requests, :metric_requests, :log_requests, :received_headers

      def initialize
        @mutex = Mutex.new
        @trace_requests = []
        @metric_requests = []
        @log_requests = []
        @received_headers = []
        @server = WEBrick::HTTPServer.new(
          BindAddress: "127.0.0.1",
          Port: 0,
          Logger: WEBrick::Log.new(File::NULL),
          AccessLog: []
        )
        @port = @server.config[:Port]
        @endpoint = "http://127.0.0.1:#{@port}"

        @server.mount_proc("/v1/traces") { |req, res| handle(req, res, :traces) }
        @server.mount_proc("/v1/metrics") { |req, res| handle(req, res, :metrics) }
        @server.mount_proc("/v1/logs") { |req, res| handle(req, res, :logs) }

        @thread = Thread.new { @server.start }
      end

      def stop
        @server.shutdown
        @thread.join(2)
      end

      private

      def handle(req, res, kind)
        raw = req.body.to_s
        raw = Zlib::GzipReader.new(StringIO.new(raw)).read if req["content-encoding"].to_s.downcase.include?("gzip")

        @mutex.synchronize do
          @received_headers << req.header.dup
          case kind
          when :traces
            @trace_requests << Opentelemetry::Proto::Collector::Trace::V1::ExportTraceServiceRequest.decode(raw)
          when :metrics
            @metric_requests << Opentelemetry::Proto::Collector::Metrics::V1::ExportMetricsServiceRequest.decode(raw)
          when :logs
            @log_requests << Opentelemetry::Proto::Collector::Logs::V1::ExportLogsServiceRequest.decode(raw)
          end
        end

        res.status = 200
        res["Content-Type"] = "application/x-protobuf"
        res.body = ""
      rescue StandardError => e
        res.status = 400
        res.body = e.message
      end
    end
  end
end
