# frozen_string_literal: true

require "spec_helper"
require "stringio"
require "tempfile"

RSpec.describe "Libo11y core" do
  describe "setup and init identity validation" do
    it "refuses missing service_name when strict_identity is true" do
      expect do
        Libo11y.init(environment: Libo11y::Spec::Environment::PRODUCTION, env: Libo11y::HERMETIC)
      end.to raise_error(Libo11y::NoServiceName)
    end

    it "refuses unknown_service" do
      expect do
        Libo11y.init(service_name: "unknown_service", environment: "production", env: Libo11y::HERMETIC)
      end.to raise_error(Libo11y::NoServiceName)
    end

    it "refuses missing or invalid environment" do
      expect do
        Libo11y.init(service_name: "checkout", env: Libo11y::HERMETIC)
      end.to raise_error(Libo11y::NoEnvironment)

      expect do
        Libo11y.init(service_name: "checkout", environment: "qa", env: Libo11y::HERMETIC)
      end.to raise_error(Libo11y::InvalidEnvironment)
    end

    it "allows custom environments via extra_environments" do
      tel = Libo11y.init(
        service_name: "checkout",
        environment: "canary",
        extra_environments: ["canary"],
        env: Libo11y::HERMETIC,
        runtime_metrics: false
      )
      expect(tel.resource.attributes["deployment.environment.name"]).to eq("canary")
      expect(tel.resource.attributes["service.version"]).to eq("0.0.0-unknown")
      expect(tel.resource.schema_url).to eq(Libo11y::Spec::SCHEMA_URL)
      expect(tel.shutdown.ok?).to be(true)
    end

    it "counts unmet identity requirements instead of raising when strict_identity: false" do
      rec = Libo11y::Testing::Recorder.new(service_name: "", environment: "", strict_identity: false)
      metrics = rec.metrics
      violations = metrics.find { |m| m.name == Libo11y::Spec::METRIC_SCHEMA_VIOLATIONS }
      expect(violations).not_to be_nil
      rec.shutdown
    end

    it "rejects double global setup with AlreadySetup" do
      io = StringIO.new
      tel = Libo11y.setup(
        service_name: "checkout",
        environment: "production",
        env: Libo11y::HERMETIC,
        console_writer: io,
        runtime_metrics: false
      )
      expect do
        Libo11y.setup(service_name: "checkout", environment: "production", env: Libo11y::HERMETIC)
      end.to raise_error(Libo11y::AlreadySetup)

      # Canary event emitted on setup
      records = io.string.lines.map { |l| JSON.parse(l) }
      canary = records.find { |r| r["event.name"] == Libo11y::Spec::EVENT_TELEMETRY_CONFIGURED }
      expect(canary).not_to be_nil
      expect(canary["service.name"]).to eq("checkout")

      expect(tel.shutdown.ok?).to be(true)
    end

    it "fails setup with CanaryRejected when a sink raises synchronously" do
      bad_sink = ->(_rec) { raise "sink broken" }
      expect do
        Libo11y.setup(
          service_name: "checkout",
          environment: "production",
          env: Libo11y::HERMETIC,
          console_enabled: false,
          extra_log_sinks: [bad_sink],
          runtime_metrics: false
        )
      end.to raise_error(Libo11y::CanaryRejected)
    end

    it "supports hostile OTEL_* env isolation in HERMETIC mode" do
      hostile = {
        "OTEL_SDK_DISABLED" => "true",
        "OTEL_TRACES_EXPORTER" => "prometheus",
        "OTEL_EXPORTER_OTLP_PROTOCOL" => "grpc",
        "OTEL_METRICS_EXEMPLAR_FILTER" => "always_off"
      }
      original = hostile.keys.to_h { |k| [k, ENV.fetch(k, nil)] }
      begin
        hostile.each { |k, v| ENV[k] = v }
        rec = Libo11y::Testing::Recorder.new
        expect(rec.telemetry.effective_config).to include("o11y.config.traces=injected", "o11y.config.logs=injected")
        rec.telemetry.tracer("t").in_span("s") { rec.telemetry.logger.info("hi") }
        expect(rec.spans.length).to eq(1)
        expect(rec.logs.length).to eq(1)
        rec.shutdown
      ensure
        original.each { |k, v| v.nil? ? ENV.delete(k) : ENV[k] = v }
      end
    end

    it "honors OTEL_SDK_DISABLED=true over code options in non-hermetic mode" do
      span_exp = OpenTelemetry::SDK::Trace::Export::InMemorySpanExporter.new
      tel = Libo11y.init(
        service_name: "checkout",
        environment: "production",
        env: { "OTEL_SDK_DISABLED" => "true" },
        span_exporter: span_exp,
        runtime_metrics: false
      )
      tel.tracer("t").in_span("op") { :ok }
      tel.shutdown
      expect(span_exp.finished_spans).to be_empty
    end

    it "rejects unsupported exporters like prometheus" do
      expect do
        Libo11y.init(
          service_name: "checkout",
          environment: "production",
          env: { "OTEL_METRICS_EXPORTER" => "prometheus" }
        )
      end.to raise_error(Libo11y::UnsupportedProtocol)
    end
  end

  describe "sensitivity policy and redaction" do
    let(:hash_key) { "0123456789abcdef0123456789abcdef" }

    it "rejects PIIHash mode with key shorter than 32 bytes" do
      expect do
        Libo11y.init(
          service_name: "checkout",
          environment: "test",
          env: Libo11y::HERMETIC,
          pii_mode: Libo11y::PIIMode::HASH,
          pii_hash_key: "short"
        )
      end.to raise_error(Libo11y::PIIHashKey)
    end

    it "drops secrets and drops/hashes/allows PII across spans, logs, metrics, and resource" do
      app_yaml = <<~YAML
        schema: libo11y.app-registry/v1
        namespace: acme
        attributes:
          acme.user.email: {type: string, sensitivity: pii, cardinality: unbounded}
          acme.api.token:  {type: string, sensitivity: secret, cardinality: unbounded}
          acme.tier:       {type: string, sensitivity: public, cardinality: bounded}
      YAML

      rec = Libo11y::Testing::Recorder.new(
        pii_mode: Libo11y::PIIMode::HASH,
        pii_hash_key: hash_key,
        app_registries: [app_yaml],
        resource_attributes: {
          "acme.api.token" => "top-secret",
          "acme.user.email" => "res@example.com",
          "acme.tier" => "gold"
        }
      )

      # Resource
      expect(rec.telemetry.resource.attributes).not_to have_key("acme.api.token")
      expect(rec.telemetry.resource.attributes["acme.user.email"]).to start_with("hmac-sha256:")
      expect(rec.telemetry.resource.attributes["acme.tier"]).to eq("gold")

      # Spans + Logs + Metrics
      counter = rec.telemetry.meter("m").create_counter("orders")
      rec.telemetry.tracer("t").in_span("op", attributes: {
                                          "acme.api.token" => "tok",
                                          "acme.user.email" => "alice@example.com",
                                          "acme.tier" => "gold"
                                        }) do
        rec.telemetry.logger.info("hello", {
                                    "acme.api.token" => "tok",
                                    "acme.user.email" => "alice@example.com",
                                    "acme.tier" => "gold"
                                  })
        counter.add(1, attributes: {
                      "acme.api.token" => "tok",
                      "acme.user.email" => "alice@example.com",
                      "acme.tier" => "gold"
                    })
      end

      span = rec.spans.first
      expect(span.attributes).not_to have_key("acme.api.token")
      expect(span.attributes["acme.user.email"]).to start_with("hmac-sha256:")
      expect(span.attributes["acme.tier"]).to eq("gold")

      log = rec.logs.first
      expect(log.attributes).not_to have_key("acme.api.token")
      expect(log.attributes["acme.user.email"]).to start_with("hmac-sha256:")
      expect(log.attributes["acme.tier"]).to eq("gold")

      # Metrics drop PII even in HASH mode
      orders_metric = rec.metrics.find { |m| m.name == "orders" }
      dp = orders_metric.data_points.first
      expect(dp.attributes).not_to have_key("acme.api.token")
      expect(dp.attributes).not_to have_key("acme.user.email")
      expect(dp.attributes["acme.tier"]).to eq("gold")

      # The secret was redacted on every signal, and emitting it is still a conformance failure.
      expect { rec.assert_conforms! }.to raise_error(Libo11y::Testing::AssertionError, /secrets must never be emitted/)
      rec.shutdown
    end

    it "protects capture-time Redact::Secret, Redact::Masked, and Redact::Fields" do
      secret = Libo11y::Redact::Secret.new("s3cr3t")
      masked = Libo11y::Redact::Masked.new("4111-1111")
      expect(secret.to_s).to eq("REDACTED")
      expect(JSON.generate(secret)).to eq('"REDACTED"')
      expect(masked.to_s).to eq("XXXXXXXXX")

      klass = Struct.new(:id, :ssn, :token, :internal, keyword_init: true) do
        include Libo11y::Redact::Fields

        redact_field :ssn, :mask
        redact_field :token, :secret
        redact_field :internal, :omit
      end
      obj = klass.new(id: 42, ssn: "1234", token: "abc", internal: "hide")
      expect(obj.redacted_hash).to eq({ "id" => 42, "ssn" => "XXXX", "token" => "REDACTED" })

      expect do
        Class.new do
          include Libo11y::Redact::Fields

          redact_field :foo, :bogus_tag
        end
      end.to raise_error(ArgumentError)
    end

    it "runs attr_replacer before policy so renaming to a secret key still drops it" do
      replacer = ->(_groups, k, v) { k == "alias_key" ? ["http.request.header.authorization", v] : [k, v] }
      rec = Libo11y::Testing::Recorder.new(attr_replacer: replacer)
      rec.telemetry.logger.info("check", { "alias_key" => "Bearer xyz", "ok" => "1" })
      log = rec.logs.first
      expect(log.attributes).not_to have_key("http.request.header.authorization")
      expect(log.attributes["ok"]).to eq("1")
      rec.shutdown
    end

    it "drops a cyclic member of a log attribute on the console and on OTLP" do
      rec = Libo11y::Testing::Recorder.new
      cyclic = { "name" => "a" }
      cyclic["self"] = cyclic
      rec.telemetry.logger.info("cycle", { "nested" => cyclic })
      expect(rec.console_records.first["nested"]).to eq("name" => "a")
      expect(rec.logs.first.attributes).to eq("nested.name" => "a")
      rec.shutdown
    end
  end

  describe "force_emit, events, wide records, and idempotent shutdown" do
    it "bypasses console level gate with force_emit and emits wide records" do
      rec = Libo11y::Testing::Recorder.new(log_level: Logger::ERROR)
      rec.telemetry.logger.info("dropped_normal")
      expect(rec.console_records).to be_empty

      Libo11y.force_emit do
        rec.telemetry.logger.info("audit_line", { Libo11y::Spec::ATTR_RECORD_CLASS => Libo11y::Spec::RecordClass::AUDIT })
      end
      expect(rec.console_records.length).to eq(1)
      expect(rec.console_records.first["msg"]).to eq("audit_line")

      Libo11y.start_record do |r|
        r.set("order.id", "ord-1").add("order.items", 3)
        expect(Libo11y.current_record).to eq(r)
        r.emit_event(rec.telemetry, Libo11y::Spec::EVENT_REQUEST_SUMMARY, { Libo11y::Spec::ATTR_OUTCOME => "ok" })
      end
      expect(Libo11y.current_record).to be_nil
      expect(rec.console_records.last["event.name"]).to eq(Libo11y::Spec::EVENT_REQUEST_SUMMARY)
      expect(rec.console_records.last["order.items"]).to eq(3)

      # Concurrent & repeated shutdown returns identical report
      r1 = rec.shutdown
      r2 = rec.shutdown
      expect(r1).to equal(r2)
      expect(r1.ok?).to be(true)
    end
  end

  describe "propagation, detached work, and child process carriers" do
    it "filters baggage egress, links detached work, and propagates TRACEPARENT without baggage to child env" do
      rec = Libo11y::Testing::Recorder.new(
        baggage_egress_allow: ->(k) { k == "tenant" }
      )

      carrier = nil
      child_env = nil
      ctx = OpenTelemetry::Baggage.set_value("tenant", "acme")
      ctx = OpenTelemetry::Baggage.set_value("secret_bag", "nope", context: ctx)

      OpenTelemetry::Context.with_current(ctx) do
        rec.telemetry.tracer("t").in_span("origin") do
          carrier = Libo11y::Detached.capture(telemetry: rec.telemetry)
          child_env = Libo11y::Proc.child_env({ "EXISTING" => "1" })
        end
      end

      wire = carrier.marshal_text
      restored = Libo11y::Detached::Carrier.unmarshal_text(wire)
      expect(restored.baggage).to include("tenant=acme")
      expect(restored.baggage).not_to include("secret_bag")

      Libo11y::Detached.start_linked(restored, "job.run", telemetry: rec.telemetry) do
        expect(OpenTelemetry::Baggage.value("tenant")).to eq("acme")
      end

      expect(child_env["TRACEPARENT"]).to match(/\A00-[0-9a-f]{32}-[0-9a-f]{16}-01\z/)
      expect(child_env).not_to have_key("BAGGAGE")

      extracted = Libo11y::Proc.extract_env(child_env)
      expect(OpenTelemetry::Trace.current_span(extracted).context).to be_valid

      job_span = rec.spans.find { |s| s.name == "job.run" }
      origin_span = rec.spans.find { |s| s.name == "origin" }
      expect(job_span.links.first.span_context.trace_id).to eq(origin_span.trace_id)

      rec.shutdown
    end
  end
end
