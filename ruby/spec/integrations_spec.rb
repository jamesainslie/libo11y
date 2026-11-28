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
        [200, { "content-type" => "text/plain" }, ["ok"]]
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
    it "emits spans only under a parent span and sanitizes SQL literals" do
      rec = Libo11y::Testing::Recorder.new
      db = described_class.new(db_system: "postgresql", db_namespace: "orders", telemetry: rec.telemetry)

      # No active parent span -> metric recorded, no span emitted
      db.execute("SELECT * FROM users WHERE email = 'alice@example.com' AND id = 42") { :ok }
      expect(rec.spans).to be_empty

      # Under parent span -> client span emitted with sanitized SQL
      rec.telemetry.tracer("t").in_span("parent") do
        db.execute("SELECT * FROM users WHERE email = 'alice@example.com' AND id = 42 -- secret") { :ok }
      end

      db_span = rec.spans.find { |s| s.name == "SELECT orders" }
      expect(db_span).not_to be_nil
      expect(db_span.attributes["db.query.text"]).to eq("SELECT * FROM users WHERE email = ? AND id = ?")
      expect(rec.metrics.any? { |m| m.name == "db.client.operation.duration" }).to be(true)
      rec.shutdown
    end
  end
end
