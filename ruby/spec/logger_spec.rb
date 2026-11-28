# frozen_string_literal: true

require "spec_helper"

RSpec.describe "The libo11y logger" do
  def bodies(rec)
    { console: rec.console_records.map { |r| r["msg"] }, otlp: rec.logs.map(&:body) }
  end

  it "is a Logger whose level gates the console, OTLP and the extra sinks alike" do
    extra = []
    Libo11y::Testing.start_recorder(extra_log_sinks: [->(record) { extra << record[:body] }]) do |rec|
      logger = rec.telemetry.logger
      expect(logger).to be_a(Logger)
      expect(logger.level).to eq(Logger::INFO)

      logger.debug("hidden")
      logger.level = Logger::ERROR
      logger.info("also hidden")
      logger.warn("still hidden", { "k" => 1 })
      logger.error("shown")

      expect(bodies(rec)).to eq(console: ["shown"], otlp: ["shown"])
      expect(extra).to eq(["shown"])
      expect(logger).not_to be_info
    end
  end

  it "takes its first level from the log_level option, as a constant or a name" do
    Libo11y::Testing.start_recorder(log_level: :warn) do |rec|
      rec.telemetry.logger.info("hidden")
      rec.telemetry.logger.warn("shown")

      expect(bodies(rec)).to eq(console: ["shown"], otlp: ["shown"])
      expect(rec.telemetry.effective_config).to include("o11y.config.level=WARN")
    end
    expect { Libo11y::Testing::Recorder.new(log_level: :loud) }.to raise_error(ArgumentError)
  end

  it "lets force_emit and events past the level" do
    Libo11y::Testing.start_recorder(log_level: Logger::FATAL) do |rec|
      Libo11y.force_emit { rec.telemetry.logger.info("audit") }
      rec.telemetry.event("order.placed", { "order.id" => "o-1" })

      expect(bodies(rec)).to eq(console: ["audit", "order.placed"], otlp: ["audit", "order.placed"])
    end
  end

  it "follows the Logger calling conventions" do
    Libo11y::Testing.start_recorder do |rec|
      logger = rec.telemetry.logger
      logger.info { "from a block" }
      logger.add(Logger::WARN, "from add")
      logger.add(Logger::INFO, nil, "from the third argument")
      logger << "raw"

      expect(bodies(rec)[:console]).to eq(["from a block", "from add", "from the third argument"])
    end
  end

  it "writes a float that JSON cannot hold as a string, and logs the record on every sink" do
    Libo11y::Testing.start_recorder do |rec|
      expect { rec.telemetry.logger.info("ratio", { "ratio" => Float::NAN, "up" => Float::INFINITY, "nested" => { "down" => -Float::INFINITY } }) }
        .not_to raise_error

      expect(rec.console_records.last).to include("ratio" => "NaN", "up" => "+Inf", "nested" => { "down" => "-Inf" })
      expect(rec.logs.last.attributes["ratio"]).to be_nan
    end
  end

  it "still reaches OTLP and the extra sinks when the console cannot be written" do
    broken = Object.new
    def broken.write(_line) = raise(IOError, "closed stream")
    extra = []
    exporter = OpenTelemetry::SDK::Logs::Export::InMemoryLogRecordExporter.new
    tel = Libo11y.init(service_name: "s", environment: "test", env: Libo11y::HERMETIC, console_writer: broken,
                       log_exporter: exporter, extra_log_sinks: [->(record) { extra << record[:body] }])

    expect { tel.logger.info("x") }.not_to raise_error
    expect(exporter.emitted_log_records.map(&:body)).to eq(["x"])
    expect(extra).to eq(["x"])
    tel.shutdown
  end

  it "logs through Logger#log, which is how some libraries call a logger" do
    Libo11y::Testing.start_recorder do |rec|
      rec.telemetry.logger.log(Logger::WARN, "via log")
      rec.telemetry.logger.log(Logger::DEBUG, "hidden")

      expect(bodies(rec)).to eq(console: ["via log"], otlp: ["via log"])
    end
  end

  it "keeps a record on OTLP when a float JSON cannot hold sits inside a list of hashes" do
    Libo11y::Testing.start_recorder do |rec|
      rec.telemetry.logger.info("nested", { "items" => [{ "ratio" => Float::NAN }, [Float::INFINITY]] })

      expect(rec.logs.map(&:body)).to eq(["nested"])
      expect(rec.logs.first.attributes["items"]).to eq(['{"ratio":"NaN"}', '["+Inf"]'])
    end
  end
end
