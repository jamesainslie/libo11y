# frozen_string_literal: true

require "spec_helper"

RSpec.describe Libo11y::Testing::Recorder do
  def traced(rec, name, &block)
    rec.telemetry.tracer("t").in_span(name, &block)
  end

  describe "#assert_triangle!" do
    it "passes when one trace has a span, a log record and an exemplar" do
      Libo11y::Testing.start_recorder do |rec|
        counter = rec.telemetry.meter("m").create_counter("orders")
        traced(rec, "checkout") do
          rec.telemetry.logger.info("placed")
          counter.add(1)
        end

        expect(rec.assert_triangle!).to be(true)
        expect(rec.assert_triangle!("orders")).to be(true)
      end
    end

    it "fails when the log record and the exemplar are on different traces" do
      Libo11y::Testing.start_recorder do |rec|
        counter = rec.telemetry.meter("m").create_counter("orders")
        traced(rec, "logs only") { rec.telemetry.logger.info("placed") }
        traced(rec, "metric only") { counter.add(1) }

        expect { rec.assert_triangle! }
          .to raise_error(Libo11y::Testing::AssertionError, /no trace has a span, a log record and a metric exemplar/)
      end
    end

    it "fails when the named metric has no exemplar on the trace" do
      Libo11y::Testing.start_recorder do |rec|
        counter = rec.telemetry.meter("m").create_counter("orders")
        traced(rec, "checkout") do
          rec.telemetry.logger.info("placed")
          counter.add(1)
        end

        expect { rec.assert_triangle!("refunds") }.to raise_error(Libo11y::Testing::AssertionError, /"refunds"/)
      end
    end
  end

  describe "#assert_conforms!" do
    it "passes for telemetry with no secret" do
      Libo11y::Testing.start_recorder do |rec|
        traced(rec, "checkout") { rec.telemetry.logger.info("placed", { "order.id" => "o-1" }) }

        expect(rec.assert_conforms!).to be(true)
      end
    end

    it "fails when the code under test emitted a secret, although it was redacted" do
      Libo11y::Testing.start_recorder do |rec|
        traced(rec, "checkout") { rec.telemetry.logger.info("placed", { "http.request.header.authorization" => "Bearer x" }) }

        expect { rec.assert_conforms! }.to raise_error(
          Libo11y::Testing::AssertionError,
          /emitted secret-classified attributes on logs \(1 redaction\(s\) counted\).*secrets must never be emitted/
        )
      end
    end

    it "names every signal a secret was emitted on" do
      Libo11y::Testing.start_recorder do |rec|
        rec.telemetry.tracer("t").in_span("s", attributes: { "http.request.header.cookie" => "sid=1" }) do
          rec.telemetry.logger.info("x", { "http.request.header.cookie" => "sid=1" })
        end

        expect { rec.assert_conforms! }.to raise_error(Libo11y::Testing::AssertionError) do |error|
          expect(error.message).to include("on logs", "on traces")
        end
      end
    end

    it "fails for a secret key on a metric data point that did not pass the policy" do
      Libo11y::Testing.start_recorder do |rec|
        raw_meter = rec.telemetry.meter_provider.sdk_provider.meter("raw")
        raw_meter.create_counter("leaky").add(1, attributes: { "http.request.header.cookie" => "sid=1" })

        expect { rec.assert_conforms! }
          .to raise_error(Libo11y::Testing::AssertionError, /metric "leaky" carries secret-classified attribute "http.request.header.cookie"/)
      end
    end

    it "fails for a registered event that lacks a required attribute" do
      Libo11y::Testing.start_recorder do |rec|
        rec.telemetry.event(Libo11y::Spec::EVENT_REQUEST_SUMMARY, { "http.request.method" => "GET" })

        expect { rec.assert_conforms! }.to raise_error(Libo11y::Testing::AssertionError, /o11y.request.summary missing required attribute/)
      end
    end
  end
end
