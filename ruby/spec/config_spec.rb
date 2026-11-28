# frozen_string_literal: true

require "spec_helper"

RSpec.describe "Resolved configuration" do
  def init(env: Libo11y::HERMETIC, **)
    Libo11y.init(service_name: "checkout", environment: "test", version: "1.2.0", env: env, console_enabled: false,
                 runtime_metrics: false, **)
  end

  describe "the startup summary" do
    let(:log_exporter) { OpenTelemetry::SDK::Logs::Export::InMemoryLogRecordExporter.new }

    def canary
      log_exporter.emitted_log_records.find { |r| r.event_name == Libo11y::Spec::EVENT_TELEMETRY_CONFIGURED }
    end

    it "carries the registry's attributes and nothing else" do
      tel = Libo11y.setup(service_name: "checkout", environment: "test", version: "1.2.0", env: Libo11y::HERMETIC,
                          console_enabled: false, log_exporter: log_exporter)

      expect(canary.attributes).to eq(
        "event.name" => "o11y.telemetry.configured",
        "service.name" => "checkout",
        "service.version" => "1.2.0",
        "o11y.config.traces" => "none",
        "o11y.config.metrics" => "none",
        "o11y.config.logs" => "injected",
        "o11y.config.console" => "off",
        "o11y.config.level" => "INFO",
        "o11y.config.sampler" => "parentbased_always_on",
        "o11y.config.propagators" => "traceparent,tracestate,baggage",
        "o11y.config.runtime_metrics" => "true"
      )
      tel.shutdown
    end

    it "is also the effective configuration, as one line" do
      tel = init(log_level: Logger::WARN)

      expect(tel.effective_config).to eq(
        "service.name=checkout service.version=1.2.0 o11y.config.traces=none o11y.config.metrics=none " \
        "o11y.config.logs=none o11y.config.console=off o11y.config.level=WARN o11y.config.sampler=parentbased_always_on " \
        "o11y.config.propagators=traceparent,tracestate,baggage o11y.config.runtime_metrics=false"
      )
      expect(tel.effective_config).to be_frozen
      tel.shutdown
    end

    it "names an injected sampler, a console that is on and a version that fell back" do
      tel = Libo11y.init(service_name: "checkout", environment: "test", env: Libo11y::HERMETIC, console_writer: StringIO.new,
                         sampler: OpenTelemetry::SDK::Trace::Samplers::ALWAYS_OFF,
                         propagators: [OpenTelemetry::Trace::Propagation::TraceContext.text_map_propagator])

      expect(tel.effective_config).to include(
        "service.version=0.0.0-unknown", "o11y.config.console=json", "o11y.config.sampler=AlwaysOffSampler",
        "o11y.config.propagators=traceparent,tracestate ", "o11y.config.service_version_fallback=true"
      )
      tel.shutdown
    end

    it "reports the exporters and the sanitized endpoints of the environment" do
      env = {
        "OTEL_EXPORTER_OTLP_ENDPOINT" => "http://user:pw@127.0.0.1:9/base?token=abc",
        "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT" => "http://127.0.0.1:9/custom/logs",
        "OTEL_TRACES_EXPORTER" => " Console ",
        "OTEL_METRICS_EXPORTER" => "none",
        "OTEL_TRACES_SAMPLER" => "TraceIdRatio",
        "OTEL_TRACES_SAMPLER_ARG" => "0.5"
      }
      tel = init(env: env)

      expect(tel.effective_config).to include(
        "o11y.config.traces=console", "o11y.config.metrics=none", "o11y.config.logs=otlp", "o11y.config.sampler=traceidratio",
        "o11y.config.endpoint=http://127.0.0.1:9/base", "o11y.config.logs_endpoint=http://127.0.0.1:9/custom/logs"
      )
      expect(tel.effective_config).not_to include("pw", "token", "traces_endpoint")
      tel.shutdown(timeout: 1)
    end

    it "reports every signal as none when OTEL_SDK_DISABLED is true" do
      tel = init(env: { "OTEL_SDK_DISABLED" => "true" }, span_exporter: OpenTelemetry::SDK::Trace::Export::InMemorySpanExporter.new,
                 runtime_metrics: true)

      expect(tel.effective_config).to include("o11y.config.traces=none", "o11y.config.metrics=none", "o11y.config.logs=none",
                                              "o11y.config.runtime_metrics=false")
      tel.shutdown
    end
  end

  describe "OTEL_SDK_DISABLED=true" do
    it "records no span and mints no trace identity" do
      console = StringIO.new
      tel = Libo11y.init(service_name: "checkout", environment: "test", env: { "OTEL_SDK_DISABLED" => "true" }, console_writer: console)

      tel.tracer("t").in_span("s") do |span|
        expect(span).not_to be_recording
        expect(span.context).not_to be_valid
        tel.logger.info("x")
      end
      expect(JSON.parse(console.string.lines.last)).not_to include("trace_id")
      expect(tel.shutdown).to be_ok
      expect(tel.force_flush).to be(true)
    end

    it "still carries an inbound trace context" do
      tel = init(env: { "OTEL_SDK_DISABLED" => "true" })
      inbound = tel.extract({ "traceparent" => "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" })

      outbound = {}
      OpenTelemetry::Context.with_current(inbound) { tel.tracer("t").in_span("s") { tel.inject(outbound) } }

      expect(outbound["traceparent"]).to eq("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")
      tel.shutdown
    end
  end

  describe "the resource" do
    def attributes(env: {}, **)
      tel = Libo11y.init(env: env, console_enabled: false, runtime_metrics: false, **)
      tel.resource.attributes
    ensure
      tel&.shutdown(timeout: 1)
    end

    let(:hostile) do
      {
        "OTEL_SERVICE_NAME" => "env-name",
        "OTEL_RESOURCE_ATTRIBUTES" => "service.name=env-attr,deployment.environment.name=production,service.version=9.9.9,team=env",
        "OTEL_TRACES_EXPORTER" => "none", "OTEL_METRICS_EXPORTER" => "none", "OTEL_LOGS_EXPORTER" => "none"
      }
    end

    it "prefers an option, then resource_attributes, then OTEL_SERVICE_NAME, then OTEL_RESOURCE_ATTRIBUTES" do
      from_option = attributes(env: hostile, service_name: "opt", environment: "test", version: "1.0.0",
                               resource_attributes: { "service.name" => "attr", "team" => "code" })
      from_attrs = attributes(env: hostile, resource_attributes: { "service.name" => "attr", "deployment.environment.name" => "staging" })
      from_env = attributes(env: hostile)
      from_env_attrs = attributes(env: hostile.except("OTEL_SERVICE_NAME"))

      expect(from_option).to include("service.name" => "opt", "deployment.environment.name" => "test", "service.version" => "1.0.0",
                                     "team" => "code")
      expect(from_attrs).to include("service.name" => "attr", "deployment.environment.name" => "staging", "service.version" => "9.9.9")
      expect(from_env).to include("service.name" => "env-name", "deployment.environment.name" => "production", "team" => "env")
      expect(from_env_attrs).to include("service.name" => "env-attr")
    end

    it "decodes percent escapes in OTEL_RESOURCE_ATTRIBUTES as UTF-8" do
      env = hostile.merge("OTEL_RESOURCE_ATTRIBUTES" => "deployment.environment.name=test,team=caf%C3%A9%20one,odd=100%,bad=%FF")

      got = attributes(env: env)
      expect(got).to include("team" => "café one", "odd" => "100%")
      expect(got["bad"]).to be_valid_encoding
    end

    it "names the value and the allowed set when the environment is not allowed" do
      expect { attributes(service_name: "s", environment: "prod", env: Libo11y::HERMETIC) }.to raise_error(
        Libo11y::InvalidEnvironment,
        'o11y: deployment environment not in the allowed set: "prod" (allowed: development, production, staging, test)'
      )
    end
  end

  describe "per-signal OTLP variables" do
    it "fall back to the general variable when they are empty" do
      env = { "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL" => "", "OTEL_EXPORTER_OTLP_PROTOCOL" => "grpc" }
      expect { init(env: env) }.to raise_error(Libo11y::UnsupportedProtocol, /grpc/)

      env = { "OTEL_EXPORTER_OTLP_TRACES_COMPRESSION" => " ", "OTEL_EXPORTER_OTLP_COMPRESSION" => "zstd" }
      expect { init(env: env) }.to raise_error(Libo11y::UnsupportedProtocol, /zstd/)

      map = { "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT" => "", "OTEL_EXPORTER_OTLP_TIMEOUT" => "2500",
              "OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE" => "", "OTEL_EXPORTER_OTLP_CERTIFICATE" => "/ca.pem" }
      expect(Libo11y::Internal::Env.signal_timeout(map, "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT")).to eq(2.5)
      expect(Libo11y::Internal::Env.signal_tls(map, "OTEL_EXPORTER_OTLP_TRACES")).to include(certificate_file: "/ca.pem")
    end
  end
end
