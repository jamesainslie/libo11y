# frozen_string_literal: true

require "spec_helper"

# Ruby prints an object's instance variables when it is inspected, which is
# what an error message, a debugger or a stray log line does.
RSpec.describe "What inspecting libo11y's objects shows" do
  let(:key) { "hmac-key-#{"k" * 32}" }

  def capturing_processor(seen, read: true)
    Class.new do
      define_method(:on_start) { |*| nil }
      define_method(:on_finish) do |span|
        seen << span
        span.attributes if read
      end
      define_method(:force_flush) { |**| 0 }
      define_method(:shutdown) { |**| 0 }
    end.new
  end

  it "never shows the PII hash key" do
    options = Libo11y::Options.new(service_name: "s", environment: "test", env: Libo11y::HERMETIC, console_enabled: false,
                                   pii_mode: Libo11y::PIIMode::HASH, pii_hash_key: key)
    tel = Libo11y.init(options)

    expect(options.inspect).not_to include(key)
    expect(options.to_s).not_to include(key)
    expect(options.pii_hash_key).to eq(key)
    expect(tel.inspect).not_to include(key)
    expect(tel.policy.inspect).not_to include(key)
    expect(tel.logger.inspect).not_to include(key)
    tel.shutdown
  end

  it "shows an injected span processor the redacted span only" do
    seen = []
    Libo11y::Testing.start_recorder(span_processors: [capturing_processor(seen)], pii_mode: Libo11y::PIIMode::HASH,
                                    pii_hash_key: key) do |rec|
      rec.telemetry.tracer("t").in_span("s", attributes: { "http.request.header.cookie" => "sid=placeholder", "ok" => "1" }) do |span|
        span.add_event("e", attributes: { "http.request.header.authorization" => "Bearer placeholder" })
      end

      view = seen.first
      expect(view.inspect).not_to include("placeholder", key)
      expect(view.instance_variables.map { |name| view.instance_variable_get(name).inspect }.join).not_to include("placeholder", key)
      expect(view.attributes).to eq("ok" => "1")
      expect([view.name, view.kind, view.context.hex_span_id]).to eq(["s", :internal, rec.spans.first.hex_span_id])
      expect(view.to_span_data.events.map(&:attributes)).to eq([{}])
      expect(view).not_to be_recording
    end
  end

  it "counts a span's violations once, whichever injected processor reads the span" do
    reader = OpenTelemetry::SDK::Metrics::Export::InMemoryMetricPullExporter.new
    tel = Libo11y.init(service_name: "s", environment: "test", env: Libo11y::HERMETIC, console_enabled: false, runtime_metrics: false,
                       metric_reader: reader, span_processors: [capturing_processor([], read: false), capturing_processor([])])
    tel.tracer("t").in_span("s", attributes: { "http.request.header.cookie" => "sid=placeholder" }) { nil }

    reader.pull
    violations = reader.metric_snapshots.find { |m| m.name == Libo11y::Spec::METRIC_SCHEMA_VIOLATIONS }
    expect(violations.data_points.map { |dp| [dp.attributes["o11y.signal"], dp.value] }).to eq([["traces", 1]])
    tel.shutdown
  end
end
