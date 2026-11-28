# frozen_string_literal: true

require "spec_helper"
require "open3"
require "rbconfig"

RSpec.describe "Deadlines and global installation" do
  def elapsed
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    value = yield
    [Process.clock_gettime(Process::CLOCK_MONOTONIC) - started, value]
  end

  # A span exporter whose calls take as long as it is told.
  class SlowExporter # rubocop:disable Lint/ConstantDefinitionInBlock
    def initialize(export: 0, shutdown: 0, result: 0)
      @export = export
      @shutdown = shutdown
      @result = result
    end

    def export(_spans, timeout: nil) # rubocop:disable Lint/UnusedMethodArgument
      sleep(@export)
      @result
    end

    def force_flush(**) = 0

    def shutdown(**)
      sleep(@shutdown)
      0
    end
  end

  def init(**)
    Libo11y.init(service_name: "s", environment: "test", env: Libo11y::HERMETIC, console_enabled: false, runtime_metrics: false, **)
  end

  describe "Telemetry#shutdown" do
    it "does not wait past its deadline for a slow sink of the dropped-telemetry event" do
      slow_sink = ->(record) { sleep(1) if record[:event_name] == "o11y.telemetry.dropped" }
      tel = init(span_exporter: SlowExporter.new(shutdown: 0.5), extra_log_sinks: [slow_sink])

      seconds, report = elapsed { tel.shutdown(timeout: 0.05) }

      expect(report.errors.keys).to eq([:traces])
      expect(seconds).to be < 0.4
    end

    it "lets a caller that waits on a shutdown in progress give up at its own deadline" do
      tel = init(span_exporter: SlowExporter.new(shutdown: 1))
      first = Thread.new { tel.shutdown(timeout: 3) }
      sleep(0.1)

      seconds, report = elapsed { tel.shutdown(timeout: 0.05) }

      expect(seconds).to be < 0.5
      expect(report).not_to be_ok
      expect(report.errors.values.map(&:message)).to all(include("shutdown is still in progress"))
      expect(first.value).to be_ok
      expect(tel.shutdown).to equal(first.value)
    end

    it "returns at once to a sink that calls shutdown from inside the shutdown" do
      tel = nil
      nested = nil
      sink = ->(record) { nested = tel.shutdown(timeout: 5) if record[:event_name] == "o11y.telemetry.dropped" }
      tel = init(span_exporter: SlowExporter.new(shutdown: 0.3), extra_log_sinks: [sink])

      seconds, report = elapsed { tel.shutdown(timeout: 0.05) }
      sleep(0.2)

      expect(seconds).to be < 0.5
      expect(report.errors.keys).to eq([:traces])
      expect(nested).not_to be_ok
    end
  end

  describe "Libo11y.shutdown_on_signals" do
    it "holds before_shutdown and the telemetry shutdown to one deadline" do
      script = <<~RUBY_SCRIPT
        require "libo11y"
        tel = Libo11y.init(service_name: "s", environment: "test", env: Libo11y::HERMETIC, console_enabled: false, runtime_metrics: false)
        Thread.new { sleep 0.2; Process.kill("TERM", Process.pid) }
        started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        report = Libo11y.shutdown_on_signals(tel, timeout: 0.3, before_shutdown: -> { sleep 5 })
        waited = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started
        print [report.class.name, waited < 1.5].join(",")
      RUBY_SCRIPT
      output, status = Open3.capture2e(RbConfig.ruby, "-Ilib", "-e", script)

      expect(status).to be_success, output
      expect(output.lines.last).to eq("Libo11y::ShutdownReport,true")
    end

    it "shuts telemetry down and then raises the error of a before_shutdown that raised" do
      script = <<~RUBY_SCRIPT
        require "libo11y"
        tel = Libo11y.init(service_name: "s", environment: "test", env: Libo11y::HERMETIC, console_enabled: false, runtime_metrics: false)
        Thread.new { sleep 0.2; Process.kill("TERM", Process.pid) }
        raised = begin
          Libo11y.shutdown_on_signals(tel, timeout: 2, before_shutdown: -> { raise IOError, "server stop failed" })
          "nothing"
        rescue IOError => e
          e.message
        end
        print [raised, tel.shutdown.ok?, tel.tracer("t").start_span("late").recording?].join(",")
      RUBY_SCRIPT
      output, status = Open3.capture2e(RbConfig.ruby, "-Ilib", "-e", script)

      expect(status).to be_success, output
      expect(output.lines.last).to eq("server stop failed,true,false")
    end
  end

  describe "Libo11y.setup" do
    it "upgrades a meter and an instrument that were created before it" do
      script = <<~RUBY_SCRIPT
        require "libo11y"
        early = OpenTelemetry.meter_provider.meter("early").create_counter("early.count")
        histogram = OpenTelemetry.meter_provider.meter("early").create_histogram("early.size")
        reader = OpenTelemetry::SDK::Metrics::Export::InMemoryMetricPullExporter.new
        tel = Libo11y.setup(service_name: "s", environment: "test", env: Libo11y::HERMETIC, console_enabled: false,
                            runtime_metrics: false, metric_reader: reader)
        early.add(2, attributes: { "http.request.header.cookie" => "sid=placeholder", "ok" => "1" })
        histogram.record(3)
        reader.pull
        point = reader.metric_snapshots.find { |m| m.name == "early.count" }.data_points.first
        print [point.value, point.attributes.keys.join("+"), reader.metric_snapshots.map(&:name).include?("early.size")].join(",")
        tel.shutdown
      RUBY_SCRIPT
      output, status = Open3.capture2e(RbConfig.ruby, "-Ilib", "-e", script)

      expect(status).to be_success, output
      expect(output.lines.last).to eq("2,ok,true")
    end

    it "puts the globals back when one of them cannot be installed" do
      before = [OpenTelemetry.tracer_provider, OpenTelemetry.meter_provider, OpenTelemetry.logger_provider, OpenTelemetry.propagation]
      allow(OpenTelemetry).to receive(:propagation=).and_wrap_original do |original, value|
        raise "cannot install" unless before.include?(value)

        original.call(value)
      end

      expect { Libo11y.setup(service_name: "s", environment: "test", env: Libo11y::HERMETIC, console_enabled: false) }
        .to raise_error(RuntimeError, "cannot install")
      expect([OpenTelemetry.tracer_provider, OpenTelemetry.meter_provider, OpenTelemetry.logger_provider, OpenTelemetry.propagation])
        .to eq(before)

      RSpec::Mocks.space.proxy_for(OpenTelemetry).reset
      tel = Libo11y.setup(service_name: "s", environment: "test", env: Libo11y::HERMETIC, console_enabled: false)
      expect(tel.shutdown).to be_ok
    end
  end
end
