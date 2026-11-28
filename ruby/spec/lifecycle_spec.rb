# frozen_string_literal: true

require "spec_helper"
require_relative "support/rejecting_collector"

RSpec.describe "Telemetry lifecycle" do
  # The SDK logs every rejected export. These examples reject exports on purpose.
  around do |example|
    previous = OpenTelemetry.logger
    OpenTelemetry.logger = Logger.new(File::NULL)
    example.run
  ensure
    OpenTelemetry.logger = previous
  end

  # An exporter for any signal that answers every export with one result.
  class FixedResultExporter # rubocop:disable Lint/ConstantDefinitionInBlock
    attr_reader :exports

    def initialize(result)
      @result = result
      @exports = 0
    end

    def export(_data, timeout: nil) # rubocop:disable Lint/UnusedMethodArgument
      @exports += 1
      raise @result if @result.is_a?(Exception)

      @result
    end

    def force_flush(**) = 0
    def shutdown(**) = 0
  end

  def otlp_env(endpoint)
    {
      "OTEL_EXPORTER_OTLP_ENDPOINT" => endpoint,
      "OTEL_BSP_SCHEDULE_DELAY" => "60000",
      "OTEL_BLRP_SCHEDULE_DELAY" => "60000",
      "OTEL_METRIC_EXPORT_INTERVAL" => "60000"
    }
  end

  def init_with(env, **)
    Libo11y.init(service_name: "lifecycle", environment: "test", version: "1.0.0", env: env, runtime_metrics: false, **)
  end

  def console_events(io)
    io.string.lines.map { |line| JSON.parse(line) }.select { |rec| rec["event.name"] == "o11y.telemetry.dropped" }
  end

  describe "#shutdown" do
    it "refuses a timeout that is not a number and leaves the handle usable" do
      rec = Libo11y::Testing::Recorder.new

      expect { rec.telemetry.shutdown(timeout: "bad") }.to raise_error(ArgumentError)
      expect { rec.telemetry.shutdown(timeout: Object.new) }.to raise_error(ArgumentError)

      second = Thread.new { rec.telemetry.shutdown(timeout: 1) }
      expect(second.join(5)).not_to be_nil
      expect(second.value).to be_ok
    end

    it "gives every caller the report of the one shutdown" do
      rec = Libo11y::Testing::Recorder.new
      reports = Array.new(4) { Thread.new { rec.telemetry.shutdown } }.map(&:value)

      expect(reports.map(&:object_id).uniq.length).to eq(1)
      expect(rec.telemetry.shutdown).to equal(reports.first)
    end

    it "reports each signal whose final export the collector rejects, and says so on the console" do
      collector = RejectingCollector.new(status: 400)
      console = StringIO.new
      begin
        tel = init_with(otlp_env(collector.endpoint), console_writer: console)
        tel.meter("m").create_counter("jobs").add(1)
        tel.tracer("t").in_span("s") { tel.logger.info("x") }

        report = tel.shutdown(timeout: 5)

        expect(report).not_to be_ok
        expect(report.errors.keys).to contain_exactly(:traces, :metrics, :logs)
        expect(report.errors.values).to all(be_a(Libo11y::ExporterError))
        expect(report.traces_error.message).to start_with("o11y: shutdown traces: ")
        expect(console_events(console).map { |rec| rec["o11y.signal"] }).to contain_exactly("traces", "metrics", "logs")
        expect(console_events(console).map { |rec| rec["error.type"] }.uniq).to eq(["Libo11y::ExporterError"])
      ensure
        collector.stop
      end
    end

    it "reports nothing when every export succeeds" do
      receiver = Libo11y::Testing::OtlpHttpReceiver.new
      console = StringIO.new
      begin
        tel = init_with(otlp_env(receiver.endpoint), console_writer: console)
        tel.tracer("t").in_span("s") { tel.logger.info("x") }

        expect(tel.shutdown(timeout: 5)).to be_ok
        expect(console_events(console)).to be_empty
      ensure
        receiver.stop
      end
    end
  end

  describe "#force_flush" do
    it "returns true when every export succeeds and false when the collector rejects one" do
      receiver = Libo11y::Testing::OtlpHttpReceiver.new
      collector = RejectingCollector.new(status: 400)
      begin
        good = init_with(otlp_env(receiver.endpoint), console_enabled: false)
        bad = init_with(otlp_env(collector.endpoint), console_enabled: false)
        [good, bad].each { |tel| tel.tracer("t").in_span("s") { nil } }

        expect(good.force_flush(timeout: 5)).to be(true)
        expect(bad.force_flush(timeout: 5)).to be(false)
      ensure
        [good, bad].each { |tel| tel&.shutdown(timeout: 2) }
        receiver.stop
        collector.stop
      end
    end

    it "refuses a timeout that is not a number" do
      Libo11y::Testing.start_recorder do |rec|
        expect { rec.telemetry.force_flush(timeout: "bad") }.to raise_error(ArgumentError)
      end
    end
  end

  describe "Libo11y.setup" do
    def setup_with(**)
      Libo11y.setup(service_name: "lifecycle", environment: "test", version: "1.0.0", env: Libo11y::HERMETIC,
                    console_enabled: false, runtime_metrics: false, **)
    end

    it "fails with CanaryRejected when the log exporter answers the canary with a failure" do
      exporter = FixedResultExporter.new(OpenTelemetry::SDK::Logs::Export::FAILURE)
      before = OpenTelemetry.tracer_provider

      expect { setup_with(log_exporter: exporter) }.to raise_error(Libo11y::CanaryRejected, /startup canary rejected/)
      expect(exporter.exports).to eq(1)
      expect(OpenTelemetry.tracer_provider).to equal(before)
    end

    it "fails with CanaryRejected when the log exporter raises on the canary" do
      exporter = FixedResultExporter.new(IOError.new("sink closed"))

      expect { setup_with(log_exporter: exporter) }.to raise_error(Libo11y::CanaryRejected, /sink closed/)
    end

    it "can be called again after a rejected canary" do
      expect { setup_with(log_exporter: FixedResultExporter.new(1)) }.to raise_error(Libo11y::CanaryRejected)

      tel = setup_with
      expect(tel.shutdown).to be_ok
    end

    it "refuses a second call while the first is still starting" do
      entered = Queue.new
      release = Queue.new
      blocking_sink = lambda do |_record|
        entered << true
        release.pop
      end
      first = Thread.new { setup_with(extra_log_sinks: [blocking_sink]) }
      entered.pop

      begin
        expect { setup_with }.to raise_error(Libo11y::AlreadySetup)
      ensure
        release << true
        release << true
        first.value.shutdown
      end
    end
  end

  describe "a failed start" do
    def worker_threads
      Thread.list.count(&:alive?)
    end

    it "stops the workers it had started" do
      env = otlp_env("http://127.0.0.1:9").merge("OTEL_LOGS_EXPORTER" => "prometheus")
      before = worker_threads

      expect { init_with(env, console_enabled: false) }.to raise_error(Libo11y::UnsupportedProtocol)
      expect(worker_threads).to eq(before)
    end
  end
end
