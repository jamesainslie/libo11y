# frozen_string_literal: true

require "spec_helper"
require "webrick"

RSpec.describe "HTTP instrumentation" do
  def env(method: "GET", path: "/", **extra)
    { "REQUEST_METHOD" => method, "PATH_INFO" => path, "rack.url_scheme" => "http" }.merge(extra)
  end

  def duration_points(rec, name)
    rec.metrics.find { |m| m.name == name }.data_points
  end

  describe Libo11y::Rack::Middleware do
    def middleware(rec, app = nil, **, &block)
      described_class.new(app || block, telemetry: rec.telemetry, **)
    end

    it "puts an unknown request method on telemetry as _OTHER and keeps the original on the span" do
      Libo11y::Testing.start_recorder do |rec|
        app = middleware(rec) { |_env| [200, {}, []] }
        app.call(env(method: "BREW"))
        app.call(env(method: "get"))

        brew, get = rec.spans
        expect(brew.name).to eq("HTTP")
        expect(brew.attributes).to include("http.request.method" => "_OTHER", "http.request.method_original" => "BREW")
        expect(get.name).to eq("GET")
        expect(get.attributes).to include("http.request.method" => "GET", "http.request.method_original" => "get")
        expect(duration_points(rec, "http.server.request.duration").map { |dp| dp.attributes["http.request.method"] })
          .to contain_exactly("_OTHER", "GET")
      end
    end

    it "adds Server-Timing to an HTML response only, after an entry the application set" do
      Libo11y::Testing.start_recorder do |rec|
        responses = {
          "/html" => [200, { "content-type" => "text/html; charset=utf-8" }, ["<p>"]],
          "/json" => [200, { "content-type" => "application/json" }, ["{}"]],
          "/none" => [204, {}, []],
          "/listed" => [200, { "content-type" => "text/html", "server-timing" => ["db;dur=5", "cache;dur=1"] }, ["<p>"]],
          "/single" => [200, { "Content-Type" => "TEXT/HTML", "Server-Timing" => "db;dur=5" }, ["<p>"]]
        }
        app = middleware(rec, server_timing: true) { |e| responses.fetch(e["PATH_INFO"]) }
        headers = responses.keys.to_h { |path| [path, app.call(env(path: path))[1]] }
        entry = /\Atraceparent;desc="00-[0-9a-f]{32}-[0-9a-f]{16}-01"\z/

        expect(headers["/html"]["server-timing"]).to match(entry)
        expect(headers["/json"]).not_to include("server-timing")
        expect(headers["/none"]).not_to include("server-timing")
        expect(headers["/listed"]["server-timing"][0, 2]).to eq(["db;dur=5", "cache;dur=1"])
        expect(headers["/listed"]["server-timing"][2]).to match(entry)
        expect(headers["/single"].keys.grep(/server-timing/i)).to eq(["Server-Timing"])
        expect(headers["/single"]["Server-Timing"]).to match(/\Adb;dur=5, traceparent;desc="00-/)
        expect(responses["/listed"][1]["server-timing"].length).to eq(2)
      end
    end

    it "leaves the route of an enclosing request alone when it ignores a request" do
      Libo11y::Testing.start_recorder do |rec|
        inner = middleware(rec, ignore_paths: ["/*"]) { |_env| [200, {}, []] }
        outer = middleware(rec) do |e|
          Libo11y::Rack.set_route("/orders/:id")
          inner.call(e)
        end
        outer.call(env(path: "/.well-known"))

        expect(rec.spans.map(&:name)).to eq(["GET /orders/:id"])
      end
    end

    it "matches ignore patterns as Go's path.Match does, a leading dot included" do
      expect(Libo11y::Rack.match_glob?("/*", "/.well-known")).to be(true)
      expect(Libo11y::Rack.match_glob?("/*", "/a/b")).to be(false)
      expect(Libo11y::Rack.match_glob?("/health*", "/healthz")).to be(true)
    end

    it "records a raised error once, without its message in the status" do
      Libo11y::Testing.start_recorder do |rec|
        app = middleware(rec, canonical_line: true) { |_env| raise ArgumentError, "card 4111 declined" }

        expect { app.call(env) }.to raise_error(ArgumentError)

        span = rec.spans.first
        expect(span.events.map(&:name)).to eq(["exception"])
        expect(span.status.code).to eq(OpenTelemetry::Trace::Status::ERROR)
        expect(span.status.description).to eq("")
        expect(span.attributes).to include("error.type" => "ArgumentError", "http.response.status_code" => 500)
        summary = rec.logs.find { |r| r.event_name == Libo11y::Spec::EVENT_REQUEST_SUMMARY }
        expect(summary.attributes).to include("error.type" => "ArgumentError", "o11y.outcome" => "failure")
      end
    end

    it "names the status as the error type of a 5xx response in the span, the metric and the canonical line" do
      Libo11y::Testing.start_recorder do |rec|
        middleware(rec, canonical_line: true) { |_env| [503, {}, []] }.call(env)

        expect(rec.spans.first.attributes["error.type"]).to eq("503")
        expect(duration_points(rec, "http.server.request.duration").first.attributes["error.type"]).to eq("503")
        summary = rec.logs.find { |r| r.event_name == Libo11y::Spec::EVENT_REQUEST_SUMMARY }
        expect(summary.attributes).to include("error.type" => "503", "o11y.outcome" => "failure")
      end
    end

    it "refuses canonical_line without a telemetry handle to write it through" do
      expect { described_class.new(->(_env) { [200, {}, []] }, canonical_line: true) }
        .to raise_error(ArgumentError, /canonical_line needs telemetry:/)
    end

    it "creates its histogram once when threads share the middleware" do
      Libo11y::Testing.start_recorder do |rec|
        app = middleware(rec) { |_env| [200, {}, []] }
        Array.new(8) { Thread.new { 25.times { app.call(env) } } }.each(&:join)

        expect(duration_points(rec, "http.server.request.duration").sum(&:count)).to eq(200)
      end
    end
  end

  describe Libo11y::HttpClient do
    around do |example|
      @requests = []
      server = WEBrick::HTTPServer.new(BindAddress: "127.0.0.1", Port: 0, Logger: WEBrick::Log.new(File::NULL), AccessLog: [])
      server.mount_proc("/") do |req, res|
        @requests << { method: req.request_method, traceparent: req.header["traceparent"], body: req.body }
        res.status = req.path == "/missing" ? 404 : 200
        res.body = "ok"
      end
      thread = Thread.new { server.start }
      @base = "http://127.0.0.1:#{server.config[:Port]}"
      example.run
    ensure
      server.shutdown
      thread.join(2)
    end

    it "sends a method Net::HTTP has no class for and records it as _OTHER" do
      # WEBrick answers 405 to a method it does not know, so this server reads the request line itself.
      listener = TCPServer.new("127.0.0.1", 0)
      request_line = nil
      server = Thread.new do
        client = listener.accept
        request_line = client.gets
        nil while client.gets.to_s.strip != ""
        client.write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        client.close
      end

      Libo11y::Testing.start_recorder do |rec|
        response = described_class.new(telemetry: rec.telemetry).request("PURGE", "http://127.0.0.1:#{listener.addr[1]}/cache")
        server.join(2)

        expect(response.code).to eq("200")
        expect(request_line).to start_with("PURGE /cache HTTP/1.1")
        span = rec.spans.first
        expect(span.name).to eq("HTTP")
        expect(span.attributes).to include("http.request.method" => "_OTHER", "http.request.method_original" => "PURGE")
        expect(duration_points(rec, "http.client.request.duration").first.attributes["http.request.method"]).to eq("_OTHER")
      end
    ensure
      listener&.close
    end

    it "replaces a traceparent the caller passed in any case, and sends it once" do
      Libo11y::Testing.start_recorder do |rec|
        described_class.new(telemetry: rec.telemetry).request(:post, "#{@base}/x", headers: { "TraceParent" => "stale" }, body: "b")

        span = rec.spans.first
        expect(@requests.last).to include(method: "POST", body: "b", traceparent: ["00-#{span.hex_trace_id}-#{span.hex_span_id}-01"])
      end
    end

    it "does not inject when propagate_fn says no" do
      Libo11y::Testing.start_recorder do |rec|
        described_class.new(telemetry: rec.telemetry, propagate_fn: ->(_uri) { false }).request(:get, "#{@base}/x")

        expect(@requests.last[:traceparent]).to eq([])
      end
    end

    it "marks a 4xx response and a failed connection as errors, without the error's message" do
      Libo11y::Testing.start_recorder do |rec|
        client = described_class.new(telemetry: rec.telemetry)
        client.request(:get, "#{@base}/missing")
        expect { client.request(:get, "http://127.0.0.1:9/", open_timeout: 1) }.to raise_error(SystemCallError)

        missing, refused = rec.spans
        expect(missing.attributes).to include("http.response.status_code" => 404, "error.type" => "404")
        expect(refused.attributes["error.type"]).to eq("Errno::ECONNREFUSED")
        expect(refused.events.map(&:name)).to eq(["exception"])
        expect(refused.status.description).to eq("")
        expect(duration_points(rec, "http.client.request.duration").map { |dp| dp.attributes["error.type"] })
          .to contain_exactly("404", "Errno::ECONNREFUSED")
      end
    end
  end

  describe "the client's duration measurement" do
    it "is recorded inside the client span, so its exemplar names that span" do
      server = WEBrick::HTTPServer.new(BindAddress: "127.0.0.1", Port: 0, Logger: WEBrick::Log.new(File::NULL), AccessLog: [])
      server.mount_proc("/") { |_req, res| res.status = 200 }
      thread = Thread.new { server.start }
      Libo11y::Testing.start_recorder do |rec|
        Libo11y::HttpClient.new(telemetry: rec.telemetry).request(:get, "http://127.0.0.1:#{server.config[:Port]}/")

        span = rec.spans.first
        exemplars = rec.exemplars("http.client.request.duration").map { |entry| entry[:exemplar] }
        expect(exemplars.map { |exemplar| exemplar.span_id.unpack1("H*") }).to eq([span.hex_span_id])
      end
    ensure
      server&.shutdown
      thread&.join(2)
    end
  end

  describe "the Server-Timing media type check" do
    it "takes text/html with any parameters and nothing that only starts with it" do
      Libo11y::Testing.start_recorder do |rec|
        types = { "/a" => "text/html", "/b" => "Text/HTML ; charset=utf-8", "/c" => "text/html5", "/d" => "text/htmlx; q=1" }
        app = Libo11y::Rack::Middleware.new(->(e) { [200, { "content-type" => types.fetch(e["PATH_INFO"]) }, []] },
                                            telemetry: rec.telemetry, server_timing: true)
        timed = types.keys.select { |path| app.call(env(path: path))[1].key?("server-timing") }

        expect(timed).to eq(%w[/a /b])
      end
    end
  end
end
