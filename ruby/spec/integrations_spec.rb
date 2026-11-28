# frozen_string_literal: true

require "spec_helper"
require "webrick"

RSpec.describe "Libo11y integrations" do
  describe Libo11y::Rack::Middleware do
    it "records stable HTTP semconv span, duration histogram with exemplars, Server-Timing, and canonical line" do
      rec = Libo11y::Testing::Recorder.new
      inner = lambda do |_env|
        Libo11y::Rack.set_route("/orders/:id")
        Libo11y.current_record&.set("order.id", "ord-99")
        rec.telemetry.logger.info("handling order")
        [200, { "content-type" => "text/html" }, ["ok"]]
      end

      mw = described_class.new(
        inner,
        telemetry: rec.telemetry,
        ignore_paths: ["/healthz"],
        server_timing: true,
        canonical_line: true
      )

      # Ignored path produces no span
      status, = mw.call("REQUEST_METHOD" => "GET", "PATH_INFO" => "/healthz", "rack.url_scheme" => "http")
      expect(status).to eq(200)
      expect(rec.spans).to be_empty

      # Active request produces correlated span, log, canonical line, metric + exemplar
      status, headers, = mw.call(
        "REQUEST_METHOD" => "GET",
        "PATH_INFO" => "/orders/99",
        "rack.url_scheme" => "http",
        "SERVER_NAME" => "localhost",
        "SERVER_PORT" => "8080"
      )
      expect(status).to eq(200)
      expect(headers["server-timing"]).to match(/\Atraceparent;desc="00-[0-9a-f]{32}-[0-9a-f]{16}-01"\z/)

      span = rec.spans.first
      expect(span.name).to eq("GET /orders/:id")
      expect(span.attributes["http.route"]).to eq("/orders/:id")
      expect(span.attributes["http.response.status_code"]).to eq(200)

      rec.assert_conforms!
      rec.assert_triangle!
      rec.shutdown
    end
  end

  describe Libo11y::HttpClient do
    it "injects W3C traceparent and strips URL credentials" do
      rec = Libo11y::Testing::Recorder.new
      received_tp = nil
      server = WEBrick::HTTPServer.new(BindAddress: "127.0.0.1", Port: 0, Logger: WEBrick::Log.new(File::NULL), AccessLog: [])
      server.mount_proc("/ping") do |req, res|
        received_tp = req["traceparent"]
        res.status = 200
        res.body = "pong"
      end
      t = Thread.new { server.start }

      begin
        client = described_class.new(telemetry: rec.telemetry, peer_service: "inventory")
        resp = client.request(:get, "http://user:pass@127.0.0.1:#{server.config[:Port]}/ping")
        expect(resp.code).to eq("200")
        expect(received_tp).to match(/\A00-[0-9a-f]{32}-[0-9a-f]{16}-01\z/)

        span = rec.spans.first
        expect(span.attributes["url.full"]).not_to include("user:pass")
        expect(span.attributes["peer.service"]).to eq("inventory")
      ensure
        server.shutdown
        t.join(2)
        rec.shutdown
      end
    end
  end

  describe Libo11y::DB::Client do
    def db_span(rec)
      rec.spans.find { |s| s.kind == :client }
    end

    def duration_points(rec)
      rec.metrics.find { |m| m.name == "db.client.operation.duration" }.data_points
    end

    it "records the duration but no span without an active parent span" do
      Libo11y::Testing.start_recorder do |rec|
        db = described_class.new(db_system: "postgresql", telemetry: rec.telemetry)

        expect(db.execute("SELECT * FROM users WHERE id = 42") { :ok }).to eq(:ok)

        expect(rec.spans).to be_empty
        expect(duration_points(rec).map(&:attributes)).to eq(
          [{ "db.system.name" => "postgresql", "db.operation.name" => "SELECT", "db.collection.name" => "users" }]
        )
      end
    end

    it "names the span after the operation and table and records the sanitized statement" do
      Libo11y::Testing.start_recorder do |rec|
        db = described_class.new(db_system: "postgresql", db_namespace: "orders", server_address: "db.internal",
                                 server_port: 5432, telemetry: rec.telemetry)

        rec.telemetry.tracer("t").in_span("parent") do
          db.execute("SELECT * FROM users WHERE email = 'alice@example.com' AND id = 42 -- secret") { :ok }
        end

        span = db_span(rec)
        expect(span.name).to eq("SELECT users")
        expect(span.attributes).to eq(
          "db.system.name" => "postgresql",
          "db.namespace" => "orders",
          "db.operation.name" => "SELECT",
          "db.collection.name" => "users",
          "server.address" => "db.internal",
          "server.port" => 5432,
          "db.query.text" => "SELECT * FROM users WHERE email = ? AND id = ?  "
        )
        expect(span.status.code).to eq(OpenTelemetry::Trace::Status::UNSET)
      end
    end

    it "removes dialect-specific literals from the statement" do
      Libo11y::Testing.start_recorder do |rec|
        statements = {
          "postgresql" => "SELECT $$s3cret$$, $tag$s3cret$tag$, E'it\\'s s3cret' FROM t",
          "mysql" => "SELECT * FROM t WHERE a = \"s3cret\" AND b = 'x\\' OR s3cret' # s3cret",
          "mariadb" => "SELECT /*!50000 's3cret' */ 1 FROM t",
          "sqlite" => "SELECT * FROM t WHERE name = \"s3cret\" /* /* */ AND a = 's3cret'"
        }
        rec.telemetry.tracer("t").in_span("parent") do
          statements.each do |system, sql|
            described_class.new(db_system: system, telemetry: rec.telemetry).execute(sql) { :ok }
          end
        end

        texts = rec.spans.select { |s| s.kind == :client }.map { |s| s.attributes["db.query.text"] }
        expect(texts.length).to eq(4)
        expect(texts).to all(be_a(String))
        expect(texts.join).not_to include("s3cret")
      end
    end

    it "records no statement text for a system whose dialect it does not know" do
      Libo11y::Testing.start_recorder do |rec|
        db = described_class.new(db_system: "oracle", telemetry: rec.telemetry)
        rec.telemetry.tracer("t").in_span("parent") { db.execute("SELECT * FROM users WHERE a = q'[s3cret]'") { :ok } }

        span = db_span(rec)
        expect(span.name).to eq("SELECT users")
        expect(span.attributes).not_to have_key("db.query.text")
      end
    end

    it "records no statement text when query_text is off" do
      Libo11y::Testing.start_recorder do |rec|
        db = described_class.new(db_system: "postgresql", query_text: false, telemetry: rec.telemetry)
        rec.telemetry.tracer("t").in_span("parent") { db.execute("SELECT * FROM users WHERE id = 1") { :ok } }

        expect(db_span(rec).attributes).not_to have_key("db.query.text")
      end
    end

    it "caps the statement text at 4096 bytes on a character boundary" do
      Libo11y::Testing.start_recorder do |rec|
        db = described_class.new(db_system: "postgresql", telemetry: rec.telemetry)
        rec.telemetry.tracer("t").in_span("parent") { db.execute("SELECT #{"é" * 3000} FROM t") { :ok } }

        text = db_span(rec).attributes["db.query.text"]
        expect(text.bytesize).to be <= 4096
        expect(text).to be_valid_encoding
      end
    end

    it "replaces bytes that are not UTF-8 so the statement text exports" do
      Libo11y::Testing.start_recorder do |rec|
        db = described_class.new(db_system: "postgresql", telemetry: rec.telemetry)
        rec.telemetry.tracer("t").in_span("parent") { db.execute("SELECT \xFF FROM t".b) { :ok } }

        text = db_span(rec).attributes["db.query.text"]
        expect(text).to eq("SELECT � FROM t")
      end
    end

    it "uses the system as the span name for a statement it cannot summarize" do
      Libo11y::Testing.start_recorder do |rec|
        db = described_class.new(db_system: "postgresql", telemetry: rec.telemetry)
        rec.telemetry.tracer("t").in_span("parent") { db.execute("WITH x AS (SELECT 1) SELECT * FROM x") { :ok } }

        span = db_span(rec)
        expect(span.name).to eq("postgresql")
        expect(span.attributes).not_to have_key("db.operation.name")
      end
    end

    it "takes the operation name from the caller for a call with no statement" do
      Libo11y::Testing.start_recorder do |rec|
        db = described_class.new(db_system: "postgresql", telemetry: rec.telemetry)
        rec.telemetry.tracer("t").in_span("parent") { db.execute(nil, operation: "COMMIT") { :ok } }

        span = db_span(rec)
        expect(span.name).to eq("COMMIT")
        expect(span.attributes).to eq("db.system.name" => "postgresql", "db.operation.name" => "COMMIT")
      end
    end

    it "marks a failed call without recording the driver's message" do
      error_class = Class.new(StandardError)
      stub_const("FakeDriverError", error_class)

      Libo11y::Testing.start_recorder do |rec|
        db = described_class.new(db_system: "postgresql", telemetry: rec.telemetry)
        rec.telemetry.tracer("t").in_span("parent") do
          expect do
            db.execute("INSERT INTO users (email) VALUES ('s3cret@example.com')") do
              raise FakeDriverError, "duplicate key value (email)=(s3cret@example.com)"
            end
          end.to raise_error(FakeDriverError)
        rescue FakeDriverError
          nil
        end

        span = db_span(rec)
        expect(span.status.code).to eq(OpenTelemetry::Trace::Status::ERROR)
        expect(span.status.description).to eq("")
        expect(span.events.to_a).to be_empty
        expect(span.attributes["error.type"]).to eq("FakeDriverError")
        expect(duration_points(rec).map { |dp| dp.attributes["error.type"] }).to eq(["FakeDriverError"])
        expect(rec.spans.map { |s| s.to_h.to_s }.join).not_to include("s3cret")
      end
    end

    it "reports the SQLSTATE as the error type when the driver's error carries one" do
      error_class = Class.new(StandardError) do
        def sqlstate
          "23505"
        end
      end
      stub_const("FakeSqlStateError", error_class)

      Libo11y::Testing.start_recorder do |rec|
        db = described_class.new(db_system: "postgresql", telemetry: rec.telemetry)
        rec.telemetry.tracer("t").in_span("parent") do
          db.execute("SELECT 1") { raise FakeSqlStateError, "boom" }
        rescue FakeSqlStateError
          nil
        end

        expect(db_span(rec).attributes["error.type"]).to eq("23505")
      end
    end

    it "makes the client span current while the block runs" do
      Libo11y::Testing.start_recorder do |rec|
        db = described_class.new(db_system: "sqlite", telemetry: rec.telemetry)
        inner = nil
        rec.telemetry.tracer("t").in_span("parent") do
          db.execute("SELECT 1") { inner = OpenTelemetry::Trace.current_span.context.hex_span_id }
        end

        expect(inner).to eq(db_span(rec).hex_span_id)
      end
    end

    it "creates its histogram once when threads share a client" do
      Libo11y::Testing.start_recorder do |rec|
        db = described_class.new(db_system: "sqlite", telemetry: rec.telemetry)
        Array.new(8) { Thread.new { 25.times { db.execute("SELECT 1") { :ok } } } }.each(&:join)

        expect(duration_points(rec).sum(&:count)).to eq(200)
      end
    end
  end
end
