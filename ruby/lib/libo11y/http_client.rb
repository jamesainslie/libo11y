# frozen_string_literal: true

require "net/http"
require "uri"
require "opentelemetry"
require_relative "internal/http_common"

module Libo11y
  # An instrumented Net::HTTP client. It records a client span and the
  # http.client.request.duration histogram for each request and injects the
  # trace context into the request headers. It patches nothing globally.
  class HttpClient
    HTTP_DURATION_BUCKETS = Internal::HttpCommon::DURATION_BUCKETS
    SCOPE_NAME = "libo11y.http"

    # @param telemetry [Libo11y::Telemetry, nil] the handle to record
    #   through. Without one the client uses the global providers.
    # @param propagate_fn [#call, nil] returns false for a URI that must not
    #   receive the trace context, such as a third party's
    # @param peer_service [String, nil] the peer.service of the callee
    def initialize(telemetry: nil, propagate_fn: nil, peer_service: nil)
      @telemetry = telemetry
      @propagate_fn = propagate_fn
      @peer_service = peer_service
      @mutex = Mutex.new
      @duration = nil
    end

    # Sends one request and returns the Net::HTTPResponse.
    #
    # @param method [Symbol, String] the request method, such as :get. A
    #   method outside the standard set is sent as given and recorded as
    #   _OTHER.
    def request(method, url, headers: {}, body: nil, open_timeout: 5, read_timeout: 15)
      uri = url.is_a?(URI) ? url : URI.parse(url.to_s)
      verb = method.to_s.upcase
      normalized, original = Internal::HttpCommon.normalize_method(verb)

      attrs = { "http.request.method" => normalized, "server.address" => uri.host.to_s, "server.port" => uri.port }
      metric_attrs = attrs.dup
      attrs["http.request.method_original"] = original if original
      attrs["url.full"] = without_credentials(uri)
      attrs["peer.service"] = @peer_service.to_s unless @peer_service.to_s.empty?

      started = Internal::HttpCommon.monotonic
      span = tracer.start_span(Internal::HttpCommon.span_name(normalized), attributes: attrs, kind: :client)
      begin
        OpenTelemetry::Trace.with_span(span) do
          response = send_request(uri, verb, outbound_headers(headers, uri), body, open_timeout: open_timeout, read_timeout: read_timeout)
          status = response.code.to_i
          span.set_attribute("http.response.status_code", status)
          metric_attrs["http.response.status_code"] = status
          failed(span, metric_attrs, status.to_s) if status >= 400
          response
        rescue StandardError => e
          span.record_exception(e)
          failed(span, metric_attrs, e.class.name)
          raise
        end
      ensure
        duration.record(Internal::HttpCommon.monotonic - started, attributes: metric_attrs)
        span.finish
      end
    end

    private

    def failed(span, metric_attrs, error_type)
      span.set_attribute("error.type", error_type)
      span.status = OpenTelemetry::Trace::Status.error
      metric_attrs["error.type"] = error_type
    end

    # The caller's headers with the trace context of the active span. A
    # propagation header the caller passed, in any case, is replaced.
    def outbound_headers(headers, uri)
      out = headers.to_h { |key, value| [key.to_s, value.to_s] }
      return out unless @propagate_fn.nil? || @propagate_fn.call(uri)

      propagator = @telemetry ? @telemetry.propagator : OpenTelemetry.propagation
      injected = {}
      propagator.inject(injected)
      out.reject { |key, _| injected.keys.any? { |name| name.casecmp?(key) } }.merge(injected)
    end

    def send_request(uri, verb, headers, body, open_timeout:, read_timeout:)
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == "https"
      http.open_timeout = open_timeout
      http.read_timeout = read_timeout

      # A generic request, so a method Net::HTTP has no class for is sent too.
      request = Net::HTTPGenericRequest.new(verb, !body.nil?, verb != "HEAD", uri.request_uri, headers)
      http.request(request, body)
    end

    def without_credentials(uri)
      clean = uri.dup
      clean.user = nil
      clean.password = nil
      clean.to_s
    end

    def tracer
      provider = @telemetry ? @telemetry.tracer_provider : OpenTelemetry.tracer_provider
      provider.tracer(SCOPE_NAME, Libo11y::VERSION)
    end

    def duration
      @mutex.synchronize do
        @duration ||= begin
          provider = @telemetry ? @telemetry.meter_provider : OpenTelemetry.meter_provider
          provider.meter(SCOPE_NAME, version: Libo11y::VERSION).create_histogram(
            "http.client.request.duration", unit: "s", description: "Duration of HTTP client requests."
          )
        end
      end
    end
  end
end
