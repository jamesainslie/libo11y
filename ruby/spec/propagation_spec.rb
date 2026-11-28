# frozen_string_literal: true

require "spec_helper"
require "rbconfig"

RSpec.describe "Propagation beyond a request" do
  let(:traceparent) { "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" }

  def carrier(text)
    Libo11y::Detached::Carrier.unmarshal_text(text)
  end

  describe Libo11y::Detached::Carrier do
    it "writes the URL-encoded form Go writes, keys in order" do
      text = "baggage=c%3D3%2Ca%3D1%2Cb%3D2&traceparent=#{traceparent}&tracestate=vendor%3Dx~y"

      expect(carrier(text).marshal_text).to eq(text)
      expect(carrier(text).to_s).to eq(text)
      expect(carrier("traceparent=#{traceparent}").marshal_text).to eq("traceparent=#{traceparent}")
    end

    it "escapes as Go's url.QueryEscape does" do
      got = carrier("traceparent=#{traceparent}&baggage=k%3Da%2520b%2A%7E%2C%20j%3Dw").marshal_text

      expect(got).to eq("baggage=k%3Da%2520b%2A~%2C+j%3Dw&traceparent=#{traceparent}")
    end

    it "reads back what it wrote" do
      original = carrier("traceparent=#{traceparent}&tracestate=a%3D1&baggage=tenant%3Dacme")
      copy = carrier(original.marshal_text)

      expect(copy).to eq(original)
      expect(copy.span_context.hex_trace_id).to eq("0af7651916cd43dd8448eb211c80319c")
      expect(copy.span_context.hex_span_id).to eq("b7ad6b7169203331")
      expect(copy.span_context.tracestate.to_s).to eq("a=1")
      expect(copy.baggage).to eq("tenant=acme")
    end

    it "reads empty text as the zero carrier, which writes empty text" do
      zero = carrier("")

      expect(zero).to be_zero
      expect(zero.marshal_text).to eq("")
      expect(zero.span_context).not_to be_valid
    end

    it "refuses text with no valid traceparent, text that is too long and text that is not a query" do
      {
        "traceparent=00-xyz" => /no valid traceparent/,
        "baggage=a%3Db" => /no valid traceparent/,
        "{}" => /no valid traceparent/,
        "traceparent=#{"a" * (40 << 10)}" => /exceeds the 32768 byte limit/,
        "traceparent=%zz" => /invalid URL escape/,
        "traceparent=#{traceparent};baggage=a%3Db" => /invalid semicolon separator/
      }.each do |text, message|
        expect { carrier(text) }.to raise_error(Libo11y::InvalidCarrier, message)
      end
      expect { carrier(nil) }.to raise_error(Libo11y::InvalidCarrier)
    end

    it "keeps the valid members of a baggage value and drops the rest" do
      got = carrier("traceparent=#{traceparent}&baggage=c%3D3%2Ca%3D1%2C%3D%3D%3D%2Cb%3D2")

      expect(got.baggage).to eq("c=3,a=1,b=2")
      expect(carrier("traceparent=#{traceparent}&baggage=%3D%3D%3D").baggage).to eq("")
    end
  end

  describe "Libo11y::Detached" do
    it "captures the zero carrier outside a span" do
      Libo11y::Testing.start_recorder do |rec|
        context = OpenTelemetry::Baggage.set_value("tenant", "acme")

        expect(Libo11y::Detached.capture(telemetry: rec.telemetry, context: context)).to be_zero
      end
    end

    it "captures the span, its trace state and the baggage the egress filter allows" do
      Libo11y::Testing.start_recorder(baggage_egress_allow: ->(key) { key == "tenant" }) do |rec|
        context = OpenTelemetry::Baggage.set_value("tenant", "acme")
        context = OpenTelemetry::Baggage.set_value("internal", "x", context: context)
        captured = nil
        OpenTelemetry::Context.with_current(context) do
          rec.telemetry.tracer("t").in_span("origin") { captured = Libo11y::Detached.capture(telemetry: rec.telemetry) }
        end

        origin = rec.spans.first
        expect(captured.traceparent).to eq("00-#{origin.hex_trace_id}-#{origin.hex_span_id}-01")
        expect(captured.baggage).to eq("tenant=acme")
      end
    end

    it "drops the trace state, then the baggage, to keep a capture within 32 KiB" do
      Libo11y::Testing.start_recorder do |rec|
        context = OpenTelemetry::Baggage.set_value("big", "v" * (33 << 10))
        captured = nil
        OpenTelemetry::Context.with_current(context) do
          rec.telemetry.tracer("t").in_span("origin") { captured = Libo11y::Detached.capture(telemetry: rec.telemetry) }
        end

        expect(captured).not_to be_zero
        expect(captured.baggage).to eq("")
        expect(captured.marshal_text.bytesize).to be < (32 << 10)
      end
    end

    it "starts a linked root span and merges the carrier's baggage into the caller's" do
      Libo11y::Testing.start_recorder do |rec|
        from_job = carrier("traceparent=#{traceparent}&baggage=tenant%3Dacme")
        seen = nil
        caller_context = OpenTelemetry::Baggage.set_value("queue", "jobs")
        OpenTelemetry::Context.with_current(caller_context) do
          rec.telemetry.tracer("t").in_span("worker loop") do
            Libo11y::Detached.start_linked(from_job, "job.run", telemetry: rec.telemetry) do
              seen = OpenTelemetry::Baggage.values
            end
          end
        end

        job = rec.spans.find { |s| s.name == "job.run" }
        expect(seen).to eq("queue" => "jobs", "tenant" => "acme")
        expect(job.parent_span_id).to eq(OpenTelemetry::Trace::INVALID_SPAN_ID)
        expect(job.hex_trace_id).not_to eq("0af7651916cd43dd8448eb211c80319c")
        expect(job.links.map { |l| l.span_context.hex_span_id }).to eq(["b7ad6b7169203331"])
        expect(job.kind).to eq(:internal)
      end
    end

    it "starts an unlinked root span for the zero carrier" do
      Libo11y::Testing.start_recorder do |rec|
        Libo11y::Detached.start_linked(carrier(""), "job.run", telemetry: rec.telemetry) { nil }

        expect(rec.spans.first.links.to_a).to be_empty
      end
    end
  end

  describe Libo11y::Proc do
    it "gives a child process the current trace and no stale trace state" do
      Libo11y::Testing.start_recorder do |rec|
        stale = { "TRACEPARENT" => "00-11111111111111111111111111111111-2222222222222222-01", "TRACESTATE" => "stale=1" }
        script = 'print [ENV["TRACEPARENT"], ENV["TRACESTATE"].inspect, ENV["BAGGAGE"].inspect].join(" ")'
        output = nil
        original = stale.keys.to_h { |k| [k, ENV.fetch(k, nil)] }
        begin
          stale.each { |k, v| ENV[k] = v }
          OpenTelemetry::Context.with_current(OpenTelemetry::Baggage.set_value("tenant", "acme")) do
            rec.telemetry.tracer("t").in_span("parent") do
              output = IO.popen([described_class.child_env, RbConfig.ruby, "-e", script], &:read)
            end
          end
        ensure
          original.each { |k, v| v.nil? ? ENV.delete(k) : ENV[k] = v }
        end

        parent = rec.spans.first
        expect(output).to eq("00-#{parent.hex_trace_id}-#{parent.hex_span_id}-01 nil nil")
      end
    end

    it "removes an inherited trace when there is no active span" do
      env = described_class.child_env({ "TRACEPARENT" => "00-x", "TRACESTATE" => "a=1", "KEEP" => "1" })

      expect(env).to eq("TRACEPARENT" => nil, "TRACESTATE" => nil, "KEEP" => "1")
    end
  end

  describe "the baggage egress filter" do
    it "keeps the metadata of the members it lets through" do
      Libo11y::Testing.start_recorder(baggage_egress_allow: ->(key) { key == "tenant" }) do |rec|
        context = OpenTelemetry::Baggage.set_value("tenant", "acme", metadata: "tier=gold")
        context = OpenTelemetry::Baggage.set_value("internal", "x", context: context)

        expect(rec.telemetry.inject({}, context: context)).to eq("baggage" => "tenant=acme;tier=gold")
      end
    end
  end
end
