# frozen_string_literal: true

require "net/http"
require "uri"
require "opentelemetry"

module Libo11y
  # Instrumented Net::HTTP client helper that injects W3C headers without global monkey-patching.
  class HttpClient
    HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0].freeze

    def initialize(telemetry: nil, propagate_fn: nil, peer_service: nil)
      @telemetry = telemetry
      @propagate_fn = propagate_fn
      @peer_service = peer_service
    end

    def request(method, url, headers: {}, body: nil, open_timeout: 5, read_timeout: 15)
      uri = url.is_a?(URI) ? url : URI.parse(url.to_s)
      verb = method.to_s.upcase
      sanitized_url = strip_credentials(uri)

      attrs = {
        "http.request.method" => verb,
        "url.full" => sanitized_url,
        "server.address" => uri.host.to_s,
        "server.port" => uri.port
      }
      attrs["peer.service"] = @peer_service.to_s if @peer_service && !@peer_service.to_s.empty?

      tracer = @telemetry ? @telemetry.tracer("libo11y.http", Libo11y::VERSION) : OpenTelemetry.tracer_provider.tracer("libo11y.http", Libo11y::VERSION)
      meter = @telemetry ? @telemetry.meter("libo11y.http", version: Libo11y::VERSION) : OpenTelemetry.meter_provider.meter("libo11y.http", version: Libo11y::VERSION)
      @duration_hist ||= meter.create_histogram(
        "http.client.request.duration",
        unit: "s",
        description: "Duration of HTTP client requests.",
        explicit_bucket_boundaries: HTTP_DURATION_BUCKETS
      )

      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      tracer.in_span(verb, attributes: attrs, kind: :client) do |span|
        req_headers = headers.transform_keys(&:to_s).transform_values(&:to_s)
        if @propagate_fn.nil? || @propagate_fn.call(uri)
          propagator = @telemetry ? @telemetry.propagator : OpenTelemetry.propagation
          propagator.inject(req_headers)
        end

        http = Net::HTTP.new(uri.host, uri.port)
        http.use_ssl = uri.scheme == "https"
        http.open_timeout = open_timeout
        http.read_timeout = read_timeout

        req_class = Net::HTTP.const_get(verb.capitalize)
        req = req_class.new(uri.request_uri)
        req_headers.each { |k, v| req[k] = v }
        req.body = body unless body.nil?

        status = nil
        error = nil
        begin
          resp = http.request(req)
          status = resp.code.to_i
          span.set_attribute("http.response.status_code", status)
          if status >= 400
            span.status = OpenTelemetry::Trace::Status.error("HTTP #{status}")
            span.set_attribute("error.type", status.to_s)
          end
          resp
        rescue StandardError => e
          error = e
          span.record_exception(e)
          span.status = OpenTelemetry::Trace::Status.error(e.message)
          span.set_attribute("error.type", e.class.name)
          raise
        ensure
          duration = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started
          metric_attrs = {
            "http.request.method" => verb,
            "server.address" => uri.host.to_s,
            "server.port" => uri.port
          }
          metric_attrs["http.response.status_code"] = status if status
          metric_attrs["error.type"] = error ? error.class.name : status.to_s if error || (status && status >= 400)
          @duration_hist.record(duration, attributes: metric_attrs)
        end
      end
    end

    private

    def strip_credentials(uri)
      clean = uri.dup
      clean.user = nil
      clean.password = nil
      clean.to_s
    end
  end
end
