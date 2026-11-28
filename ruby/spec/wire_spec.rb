# frozen_string_literal: true

require "spec_helper"
require "open3"
require "rbconfig"

RSpec.describe "What reaches the wire and the SDK" do
  def with_env(vars)
    original = vars.keys.to_h { |key| [key, ENV.fetch(key, nil)] }
    vars.each { |key, value| ENV[key] = value }
    yield
  ensure
    original.each { |key, value| value.nil? ? ENV.delete(key) : ENV[key] = value }
  end

  def bounds(rec, name)
    rec.metrics.find { |m| m.name == name }.data_points.first.explicit_bounds
  end

  describe "OTLP payloads" do
    it "carry the specification's schema URL on the resource of every signal" do
      receiver = Libo11y::Testing::OtlpHttpReceiver.new
      begin
        tel = Libo11y.init(service_name: "wire", environment: "test", env: { "OTEL_EXPORTER_OTLP_ENDPOINT" => receiver.endpoint },
                           console_enabled: false, runtime_metrics: false)
        tel.meter("m").create_counter("jobs").add(1)
        tel.tracer("t").in_span("s") { tel.logger.info("x") }
        expect(tel.shutdown(timeout: 5)).to be_ok

        urls = receiver.trace_requests.flat_map(&:resource_spans).map(&:schema_url) +
               receiver.metric_requests.flat_map(&:resource_metrics).map(&:schema_url) +
               receiver.log_requests.flat_map(&:resource_logs).map(&:schema_url)
        expect(urls.length).to be >= 3
        expect(urls.uniq).to eq([Libo11y::Spec::SCHEMA_URL])
      ensure
        receiver.stop
      end
    end
  end

  describe "histogram boundaries" do
    it "are the latency boundaries for the HTTP and DB duration histograms" do
      Libo11y::Testing.start_recorder do |rec|
        Libo11y::Rack::Middleware.new(->(_env) { [200, {}, []] }, telemetry: rec.telemetry)
                                 .call("REQUEST_METHOD" => "GET", "PATH_INFO" => "/")
        Libo11y::DB::Client.new(db_system: "sqlite", telemetry: rec.telemetry).execute("SELECT 1") { nil }

        expect(bounds(rec, "http.server.request.duration")).to eq(Libo11y::Rack::HTTP_DURATION_BUCKETS)
        expect(bounds(rec, "db.client.operation.duration")).to eq(Libo11y::DB::DB_DURATION_BUCKETS)
      end
    end

    it "come from histogram_buckets for the instruments it names, the library's own included" do
      buckets = { "http.server.request.duration" => [0.1, 0.3], "orders.size" => [1, 10] }
      Libo11y::Testing.start_recorder(histogram_buckets: buckets) do |rec|
        Libo11y::Rack::Middleware.new(->(_env) { [200, {}, []] }, telemetry: rec.telemetry)
                                 .call("REQUEST_METHOD" => "GET", "PATH_INFO" => "/")
        rec.telemetry.meter("m").create_histogram("orders.size").record(3)

        expect(bounds(rec, "http.server.request.duration")).to eq([0.1, 0.3])
        expect(bounds(rec, "orders.size")).to eq([1, 10])
      end
    end
  end

  describe "the views option" do
    it "registers each view with the meter provider" do
      aggregation = OpenTelemetry::SDK::Metrics::Aggregation::ExplicitBucketHistogram.new(boundaries: [5, 50])
      Libo11y::Testing.start_recorder(views: [{ name: "payload.size", type: :histogram, aggregation: aggregation }]) do |rec|
        rec.telemetry.meter("m").create_histogram("payload.size").record(7)

        expect(bounds(rec, "payload.size")).to eq([5, 50])
      end
    end

    it "refuses a view that is not a Hash with a name" do
      expect { Libo11y::Testing::Recorder.new(views: [{ type: :histogram }]) }.to raise_error(ArgumentError, /views/)
      expect { Libo11y::Testing::Recorder.new(views: ["payload.size"]) }.to raise_error(ArgumentError, /views/)
    end
  end

  describe "ambient environment variables" do
    let(:hostile) do
      {
        "OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT" => "1",
        "OTEL_SPAN_EVENT_COUNT_LIMIT" => "1",
        "OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT" => "1",
        "OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT" => "32",
        "OTEL_RUBY_EXPORTER_OTLP_SSL_VERIFY_NONE" => "true"
      }
    end

    it "do not set the limits of a hermetic recorder, even when set before the SDK loads" do
      script = <<~RUBY_SCRIPT
        require "libo11y"
        require "libo11y/testing"
        Libo11y::Testing.start_recorder do |rec|
          rec.telemetry.tracer("t").in_span("s", attributes: { "a" => "x" * 40, "b" => "2" }) do |span|
            span.add_event("one")
            span.add_event("two")
            rec.telemetry.logger.info("x", { "a" => "1", "b" => "2" })
          end
          span = rec.spans.first
          print [span.attributes.size, span.attributes["a"].length, span.events.size, rec.logs.first.attributes.size].join(",")
        end
      RUBY_SCRIPT
      output, status = Open3.capture2e(hostile, RbConfig.ruby, "-Ilib", "-e", script)

      expect(status).to be_success, output
      expect(output.lines.last).to eq("2,40,2,2")
    end

    it "are read from an explicit env only, never from the process" do
      with_env(hostile) do
        limits = Libo11y::Internal::Env.span_limits({ "OTEL_SPAN_EVENT_COUNT_LIMIT" => "7" })

        expect(limits.attribute_count_limit).to eq(128)
        expect(limits.attribute_length_limit).to be_nil
        expect(limits.event_count_limit).to eq(7)
        expect(Libo11y::Internal::Env.ssl_verify_mode({})).to eq(OpenSSL::SSL::VERIFY_PEER)
        expect(Libo11y::Internal::Env.ssl_verify_mode({ "OTEL_RUBY_EXPORTER_OTLP_SSL_VERIFY_NONE" => "true" }))
          .to eq(OpenSSL::SSL::VERIFY_NONE)
      end
    end

    it "do not turn off certificate verification for an exporter built from an explicit env" do
      with_env(hostile) do
        exporter = Libo11y::Internal::Bridges.build_otlp_trace_exporter({ "OTEL_EXPORTER_OTLP_ENDPOINT" => "https://collector.test" })

        expect(exporter.instance_variable_get(:@http).verify_mode).to eq(OpenSSL::SSL::VERIFY_PEER)
      end
    end
  end
end
