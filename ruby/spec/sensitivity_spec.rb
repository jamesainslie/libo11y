# frozen_string_literal: true

require "spec_helper"

RSpec.describe "Sensitivity classification on every signal" do
  # A span processor that keeps what its on_finish argument exposes.
  class ViewCapture # rubocop:disable Lint/ConstantDefinitionInBlock
    attr_reader :views

    def initialize
      @views = []
    end

    def on_start(_span, _parent_context); end

    def on_finish(span)
      @views << {
        attributes: span.attributes,
        events: span.events.to_a.map(&:attributes),
        links: span.links.to_a.map(&:attributes),
        data_events: span.to_span_data.events.to_a.map(&:attributes),
        name: span.name
      }
    end

    def force_flush(**) = 0
    def shutdown(**) = 0
  end

  # A log record processor that keeps the attributes of every record it sees.
  class LogCapture # rubocop:disable Lint/ConstantDefinitionInBlock
    attr_reader :attributes

    def initialize
      @attributes = []
    end

    def on_emit(log_record, _context)
      @attributes << log_record.attributes.dup
    end

    def force_flush(**) = 0
    def shutdown(**) = 0
  end

  def violations(rec)
    metric = rec.metrics.find { |m| m.name == Libo11y::Spec::METRIC_SCHEMA_VIOLATIONS }
    return {} if metric.nil?

    metric.data_points.to_h { |dp| [[dp.attributes["o11y.signal"], dp.attributes["o11y.rule"]], dp.value] }
  end

  describe "an injected span processor" do
    it "receives the redacted span through every accessor at on_finish" do
      capture = ViewCapture.new
      Libo11y::Testing.start_recorder(span_processors: [capture]) do |rec|
        tracer = rec.telemetry.tracer("t")
        linked = tracer.start_span("other")
        linked.finish
        link = OpenTelemetry::Trace::Link.new(linked.context, { "http.request.header.cookie" => "sid=link", "ok" => "link" })
        tracer.in_span("s", attributes: { "http.request.header.authorization" => "Bearer A", "ok" => "span" }, links: [link]) do |span|
          span.add_event("e", attributes: { "http.request.header.cookie" => "sid=event", "ok" => "event" })
        end

        view = capture.views.find { |v| v[:name] == "s" }
        expect(view[:attributes]).to eq("ok" => "span")
        expect(view[:events]).to eq([{ "ok" => "event" }])
        expect(view[:data_events]).to eq([{ "ok" => "event" }])
        expect(view[:links]).to eq([{ "ok" => "link" }])
      end
    end

    it "does not count a span's violations again when an exporter also counts them" do
      Libo11y::Testing.start_recorder(span_processors: [ViewCapture.new]) do |rec|
        rec.telemetry.tracer("t").in_span("s", attributes: { "http.request.header.authorization" => "Bearer A" }) { nil }
        rec.spans

        expect(violations(rec)).to eq(%w[traces secret_attribute] => 1)
      end
    end
  end

  describe "observable instruments" do
    it "classifies attributes added to the instrument" do
      Libo11y::Testing.start_recorder do |rec|
        gauge = rec.telemetry.meter("m").create_observable_gauge("queue.depth", callback: -> { 7 })
        gauge.add_attributes("http.request.header.cookie" => "sid=1", "host.ip" => "10.0.0.1", "queue" => "jobs")

        points = rec.metrics.find { |m| m.name == "queue.depth" }.data_points
        expect(points.map(&:attributes)).to eq([{ "queue" => "jobs" }])
      end
    end

    it "classifies attributes passed to observe" do
      Libo11y::Testing.start_recorder do |rec|
        gauge = rec.telemetry.meter("m").create_observable_gauge("queue.depth", callback: -> { 7 })
        gauge.observe(attributes: { "http.request.header.authorization" => "Bearer B", "queue" => "jobs" })

        points = rec.metrics.find { |m| m.name == "queue.depth" }.data_points
        expect(points.map(&:attributes)).to include({ "queue" => "jobs" })
        expect(points.flat_map { |dp| dp.attributes.keys }).not_to include("http.request.header.authorization")
      end
    end

    it "accepts no callback, a list of callbacks and a callback registered later, as the SDK does" do
      Libo11y::Testing.start_recorder do |rec|
        meter = rec.telemetry.meter("m")
        later = meter.create_observable_counter("jobs.done")
        later.register_callback(-> { 3 })
        listed = meter.create_observable_up_down_counter("jobs.active", callback: [-> { 2 }])

        expect(rec.metrics.find { |m| m.name == "jobs.done" }.data_points.map(&:value)).to eq([3])
        expect(rec.metrics.find { |m| m.name == "jobs.active" }.data_points.map(&:value)).to eq([2])
        expect(listed).to respond_to(:unregister)
      end
    end
  end

  describe "PII under PIIMode::HASH" do
    let(:key) { "k" * 32 }

    it "writes one token for one value on the console, on OTLP logs and on spans" do
      Libo11y::Testing.start_recorder(pii_mode: Libo11y::PIIMode::HASH, pii_hash_key: key) do |rec|
        rec.telemetry.tracer("t").in_span("s", attributes: { "host.ip" => "10.0.0.1" }) do
          rec.telemetry.logger.info("x", { "host.ip" => "10.0.0.1" })
        end

        want = "hmac-sha256:#{OpenSSL::HMAC.hexdigest("SHA256", key, "10.0.0.1")[0, 32]}"
        expect(rec.console_records.last["host.ip"]).to eq(want)
        expect(rec.logs.last.attributes["host.ip"]).to eq(want)
        expect(rec.spans.last.attributes["host.ip"]).to eq(want)
      end
    end

    it "counts one violation for one log record, whatever the number of sinks" do
      sink = ->(_record) {}
      Libo11y::Testing.start_recorder(pii_mode: Libo11y::PIIMode::HASH, pii_hash_key: key, extra_log_sinks: [sink]) do |rec|
        rec.telemetry.logger.info("x", { "host.ip" => "10.0.0.1" })
        rec.logs

        expect(violations(rec)).to eq(%w[logs pii_attribute] => 1)
      end
    end

    it "classifies a record from the OpenTelemetry Logs API once, with several processors" do
      first = LogCapture.new
      second = LogCapture.new
      Libo11y::Testing.start_recorder(pii_mode: Libo11y::PIIMode::HASH, pii_hash_key: key, log_processors: [first, second]) do |rec|
        rec.telemetry.logger_provider.logger(name: "direct").on_emit(
          body: "direct", attributes: { "host.ip" => "10.0.0.1", "http.request.header.cookie" => "sid=1" }
        )

        want = { "host.ip" => "hmac-sha256:#{OpenSSL::HMAC.hexdigest("SHA256", key, "10.0.0.1")[0, 32]}" }
        expect(first.attributes).to eq([want])
        expect(second.attributes).to eq([want])
        expect(rec.logs.last.attributes).to eq(want)
        expect(violations(rec)).to eq(%w[logs pii_attribute] => 1, %w[logs secret_attribute] => 1)
      end
    end
  end

  describe "composite log values" do
    def classify(attrs)
      Libo11y::Internal::SensitivityPolicy.new.classify_log_attributes(attrs)
    end

    it "judges a nested member on its dotted key" do
      expect(classify("http" => { "request" => { "header" => { "cookie" => "sid=1", "accept" => "*/*" } } }))
        .to eq("http" => { "request" => { "header" => { "accept" => "*/*" } } })
    end

    it "drops a reference back into the value it is part of" do
      cyclic = { "name" => "a" }
      cyclic["self"] = cyclic
      expect(classify("nested" => cyclic)).to eq("nested" => { "name" => "a" })
    end

    it "drops a reference back to the attributes themselves" do
      attrs = { "ok" => 1 }
      attrs["self"] = attrs
      expect(classify(attrs)).to eq("ok" => 1)
    end

    it "does not enter a mapping whose key has more than 16 parts" do
      deep = "leaf"
      17.times { deep = { "k" => deep } }
      shallow = "leaf"
      16.times { shallow = { "k" => shallow } }

      expect(classify("a" => deep).to_s).not_to include("leaf")
      expect(classify("a" => shallow).to_s).to include("leaf")
      expect(classify("a" => deep).to_s).not_to include("truncated")
    end

    it "does not enter a list nested more than 16 deep" do
      deep = ["leaf"]
      16.times { deep = [deep] }
      expect(classify("a" => deep).to_s).not_to include("leaf")
    end

    it "drops what a budget of 2048 nodes did not reach" do
      wide = (0...3000).to_h { |i| ["k#{i}", i] }
      got = classify("wide" => wide, "after" => "x")

      expect(got["wide"].size).to be < 2048
      expect(got["wide"].size).to be > 2000
      expect(got).not_to have_key("after")
    end

    it "spends the budget before it renders a redacted value" do
      rendered = 0
      probe = Struct.new(:value) do
        include Libo11y::Redact::Fields

        define_method(:value) do
          rendered += 1
          "v"
        end
      end
      classify("items" => Array.new(3000) { probe.new })

      expect(rendered).to be_positive

      expect(rendered).to be < 2048
    end

    it "drops a mapping that classification emptied" do
      expect(classify("http.request.header" => { "cookie" => "sid=1" }, "ok" => 1)).to eq("ok" => 1)
    end
  end

  describe Libo11y::Redact do
    let(:account) do
      Struct.new(:id, :ssn, :token, :note) do
        include Libo11y::Redact::Fields

        redact_field :ssn, :mask
        redact_field :token, :secret
        redact_field :note, :omit
      end
    end

    it "applies a parent's field rules to a subclass" do
      child = Class.new(account)
      rendered = child.new(1, "1234", "abc", "hide")

      expect(rendered.redacted_hash).to eq("id" => 1, "ssn" => "XXXX", "token" => "REDACTED")
      expect(rendered.to_json).to eq('{"id":1,"ssn":"XXXX","token":"REDACTED"}')
      expect(rendered.inspect).not_to include("abc")
      expect("#{rendered}").not_to include("1234") # rubocop:disable Style/RedundantInterpolation
    end

    it "lets a subclass add a rule without changing its parent" do
      child = Class.new(account) { redact_field :id, :secret }

      expect(child.new(1, "1234", "abc", "x").redacted_hash["id"]).to eq("REDACTED")
      expect(account.new(1, "1234", "abc", "x").redacted_hash["id"]).to eq(1)
    end

    it "keeps the stricter protection when a masked field holds a secret" do
      holder = Struct.new(:value) do
        include Libo11y::Redact::Fields

        redact_field :value, :mask
      end

      expect(holder.new(Libo11y::Redact::Secret.new("pw")).redacted_hash).to eq("value" => "REDACTED")
      expect(holder.new(Libo11y::Redact::Masked.new("pw")).redacted_hash).to eq("value" => "XX")
    end

    it "masks the members of a nested struct and keeps its stricter rules" do
      holder = Struct.new(:inner) do
        include Libo11y::Redact::Fields

        redact_field :inner, :mask
      end

      expect(holder.new(account.new(42, "1234", "abc", "hide")).redacted_hash)
        .to eq("inner" => { "id" => "XX", "ssn" => "XXXX", "token" => "REDACTED" })
    end

    it "masks every member of a list or a hash under a masked field" do
      holder = Struct.new(:items) do
        include Libo11y::Redact::Fields

        redact_field :items, :mask
      end

      expect(holder.new(["ab", 12, { "k" => true }]).redacted_hash).to eq("items" => ["XX", "XX", { "k" => "XXXX" }])
    end

    it "redacts past 32 levels of nesting without overflowing the stack" do
      deep = Libo11y::Redact::Secret.new("pw")
      40.times { deep = [deep] }
      very_deep = "leaf"
      20_000.times { very_deep = [very_deep] }

      expect(described_class.render(deep).flatten).to eq(["REDACTED"])
      expect(described_class.render(very_deep).to_s).not_to include("leaf")
    end

    it "redacts a reference back into the value it is part of" do
      cyclic = [Libo11y::Redact::Secret.new("pw")]
      cyclic << cyclic

      expect(described_class.render(cyclic)).to eq(%w[REDACTED REDACTED])
    end
  end

  describe "reserved log keys" do
    it "cannot be brought back by the attribute replacer" do
      replacer = ->(_groups, key, value) { key == "alias" ? ["trace_id", value] : [key, value] }
      Libo11y::Testing.start_recorder(attr_replacer: replacer) do |rec|
        rec.telemetry.logger.info("x", { "alias" => "forged", "span_id" => "forged", "ok" => 1 })

        expect(rec.console_records.last).not_to include("trace_id", "span_id")
        expect(rec.logs.last.attributes).to eq("ok" => 1)
      end
    end
  end
end
