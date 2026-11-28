# frozen_string_literal: true

require "spec_helper"

RSpec.describe "Libo11y::Testing harness and OTLP wire verification" do
  it "verifies three-way reconciliation triangle in-memory" do
    Libo11y::Testing.start_recorder do |rec|
      hist = rec.telemetry.meter("checkout").create_histogram("checkout.duration", unit: "s")
      rec.telemetry.tracer("checkout").in_span("POST /checkout") do
        rec.telemetry.logger.info("order placed", { "order.id" => "ord-1" })
        hist.record(0.125, attributes: { "region" => "us-west" })
      end

      rec.assert_conforms!
      rec.assert_triangle!
    end
  end

  it "names the webrick gem when OtlpHttpReceiver starts without it" do
    allow(Libo11y::Testing::OtlpHttpReceiver).to receive(:require).with("webrick").and_raise(LoadError, "cannot load such file -- webrick")

    expect { Libo11y::Testing::OtlpHttpReceiver.new }
      .to raise_error(LoadError, /OtlpHttpReceiver needs the webrick gem.*gem "webrick"/)
  end

  it "exports real OTLP/HTTP protobuf payloads for traces, metrics, and logs to OtlpHttpReceiver" do
    receiver = Libo11y::Testing::OtlpHttpReceiver.new
    begin
      tel = Libo11y.init(
        service_name: "wire-service",
        environment: "staging",
        version: "2.0.0",
        env: {
          "OTEL_EXPORTER_OTLP_ENDPOINT" => receiver.endpoint,
          "OTEL_EXPORTER_OTLP_PROTOCOL" => "http/protobuf",
          "OTEL_EXPORTER_OTLP_HEADERS" => "x-api-key=secret-header",
          "OTEL_BSP_SCHEDULE_DELAY" => "100",
          "OTEL_BLRP_SCHEDULE_DELAY" => "100",
          "OTEL_METRIC_EXPORT_INTERVAL" => "100"
        },
        console_enabled: false,
        runtime_metrics: true
      )

      counter = tel.meter("wire").create_counter("wire.requests")
      tel.tracer("wire").in_span("wire.op", attributes: { "http.request.header.authorization" => "Bearer nope" }) do
        tel.logger.info("wire log", { "http.request.header.cookie" => "sid=123", "ok" => "yes" })
        counter.add(1, attributes: { "http.request.header.authorization" => "Bearer nope", "ok" => "yes" })
      end

      report = tel.shutdown(timeout: 5.0)
      expect(report.ok?).to be(true)

      expect(receiver.trace_requests).not_to be_empty
      expect(receiver.metric_requests).not_to be_empty
      expect(receiver.log_requests).not_to be_empty

      # Verify secret redaction over the real wire
      span_attrs = receiver.trace_requests.flat_map(&:resource_spans)
                           .flat_map(&:scope_spans)
                           .flat_map(&:spans)
                           .flat_map(&:attributes)
                           .map(&:key)
      expect(span_attrs).not_to include("http.request.header.authorization")

      log_attrs = receiver.log_requests.flat_map(&:resource_logs)
                          .flat_map(&:scope_logs)
                          .flat_map(&:log_records)
                          .flat_map(&:attributes)
                          .map(&:key)
      expect(log_attrs).not_to include("http.request.header.cookie")
      expect(log_attrs).to include("ok")

      # Verify runtime metrics shipped over OTLP
      metric_names = receiver.metric_requests.flat_map(&:resource_metrics)
                             .flat_map(&:scope_metrics)
                             .flat_map(&:metrics)
                             .map(&:name)
      expect(metric_names).to include("wire.requests", "ruby.gc.count")
    ensure
      receiver.stop
    end
  end
end
