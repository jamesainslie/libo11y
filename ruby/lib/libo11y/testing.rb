# frozen_string_literal: true

require "json"
require "stringio"
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

      # Asserts that the recorded telemetry conforms to the specification,
      # and raises an AssertionError that lists every problem:
      #
      # - a required tier-0 attribute missing from the resource, or a
      #   resource without the specification's schema URL
      # - a secret-classified attribute that the code under test emitted. It
      #   was redacted, and the library counted the redaction, but secrets
      #   must never be emitted.
      # - a secret-classified key in the clear on the resource, a span, a
      #   span event or link, a log record or a metric data point
      # - a registered event that lacks a required attribute
      #
      # Call it before the recorder shuts down, because it collects metrics.
      def assert_conforms!
        problems = resource_problems + violation_problems + cleartext_problems + event_problems
        raise AssertionError, problems.join("\n") unless problems.empty?

        true
      end

      # Assert at least one log record shares trace_id and span_id with a finished span.
      def assert_correlated!
        span_pairs = spans.map { |s| [s.hex_trace_id, s.hex_span_id] }
        raise AssertionError, "no finished spans recorded" if span_pairs.empty?

        matched_log = logs.any? { |lr| span_pairs.include?([hex(lr.trace_id), hex(lr.span_id)]) }
        raise AssertionError, "no OTLP log record correlated with any recorded span" unless matched_log

        matched_console = console_records.any? do |rec|
          span_pairs.include?([rec["trace_id"], rec["span_id"]])
        end
        raise AssertionError, "no console log record correlated with any recorded span" unless matched_console

        true
      end

      # Asserts that one trace holds all three signals: a finished span, a
      # log record written inside one of the trace's spans, and a metric
      # exemplar recorded inside one of them. With a metric name, only that
      # metric's exemplars count.
      def assert_triangle!(metric_name = nil)
        assert_correlated!
        span_ids = spans.group_by(&:hex_trace_id).transform_values { |list| list.map(&:hex_span_id) }
        in_trace = ->((trace_id, span_id)) { span_ids.fetch(trace_id, []).include?(span_id) }

        logged = logs.map { |lr| [hex(lr.trace_id), hex(lr.span_id)] }.select(&in_trace).map(&:first)
        measured = exemplars(metric_name).map { |e| [hex(e[:exemplar].trace_id), hex(e[:exemplar].span_id)] }.select(&in_trace).map(&:first)
        return true if logged.intersect?(measured)

        metric = metric_name ? "an exemplar of metric #{metric_name.inspect}" : "a metric exemplar"
        raise AssertionError, "no trace has a span, a log record and #{metric}"
      end

      private

      def hex(id)
        id&.unpack1("H*")
      end

      def resource_problems
        resource = @telemetry.resource
        problems = Spec::REQUIRED_TIER0.select { |key| resource.attributes[key].to_s.empty? }
                                       .map { |key| "resource missing required tier-0 attribute #{key.inspect}" }
        if resource.respond_to?(:schema_url) && resource.schema_url != Spec::SCHEMA_URL
          problems << "resource schema_url #{resource.schema_url.inspect} is not #{Spec::SCHEMA_URL.inspect}"
        end
        problems
      end

      # One problem per signal on which the policy counted a redacted secret.
      def violation_problems
        @telemetry.force_flush
        metric = metrics.find { |m| m.name == Spec::METRIC_SCHEMA_VIOLATIONS }
        return [] if metric.nil?

        counts = Hash.new(0)
        metric.data_points.each do |dp|
          counts[dp.attributes[Spec::ATTR_SIGNAL]] += dp.value if dp.attributes[Spec::ATTR_RULE] == "secret_attribute"
        end
        counts.sort.map do |signal, count|
          source = if signal == Spec::Signal::RESOURCE
                     "the recorder's options put a secret-classified attribute on the resource"
                   else
                     "the code under test emitted secret-classified attributes on #{signal}"
                   end
          "#{source} (#{count} redaction(s) counted); they were redacted, but secrets must never be emitted"
        end
      end

      def cleartext_problems
        surfaces = [["resource", @telemetry.resource.attributes]]
        spans.each do |span|
          surfaces << ["span #{span.name.inspect}", span.attributes]
          span.events&.each { |event| surfaces << ["span event #{event.name.inspect}", event.attributes] }
          span.links&.each { |link| surfaces << ["a link of span #{span.name.inspect}", link.attributes] }
        end
        logs.each { |record| surfaces << ["log record #{record.body.inspect}", record.attributes] }
        metrics.each do |metric|
          Array(metric.data_points).each { |dp| surfaces << ["metric #{metric.name.inspect}", dp.attributes] }
        end

        surfaces.flat_map do |surface, attributes|
          (attributes || {}).keys.select { |key| Spec::SENSITIVITY_OF[key.to_s] == Spec::Sensitivity::SECRET }
                            .map { |key| "#{surface} carries secret-classified attribute #{key.to_s.inspect} in the clear" }
        end
      end

      def event_problems
        logs.flat_map do |record|
          attributes = record.attributes || {}
          name = record.event_name || attributes[Spec::EVENT_NAME_KEY]
          contract = name && Spec::EVENTS[name]
          next [] unless contract

          missing = contract.required.reject { |key| attributes.key?(key) }
          missing += contract.required_templates.reject { |prefix| attributes.keys.any? { |key| key.start_with?("#{prefix}.") } }
                             .map { |prefix| "#{prefix}.*" }
          missing.map { |key| "event #{name} missing required attribute #{key}" }
        end
      end

      public

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

    # In-process OTLP/HTTP protobuf receiver for wire-level verification. It
    # serves through WEBrick, which libo11y does not depend on, so that a
    # production bundle carries no web server. Add `gem "webrick"` to the
    # Gemfile group that runs the tests.
    class OtlpHttpReceiver
      attr_reader :port, :endpoint

      # What has arrived so far, as copies taken under the lock the server
      # thread writes under.
      %i[trace_requests metric_requests log_requests received_headers].each do |name|
        define_method(name) { @mutex.synchronize { instance_variable_get(:"@#{name}").dup } }
      end

      def self.load_webrick
        require "webrick"
      rescue LoadError => e
        raise LoadError, "Libo11y::Testing::OtlpHttpReceiver needs the webrick gem, which libo11y does not depend on. " \
                         "Add `gem \"webrick\"` to the test group of your Gemfile (#{e.message})"
      end

      def initialize
        self.class.load_webrick
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
