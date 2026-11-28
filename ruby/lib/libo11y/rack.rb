# frozen_string_literal: true

require "uri"
require "opentelemetry"
require_relative "record"
require_relative "spec"
require_relative "internal/http_common"
require_relative "internal/path_match"

module Libo11y
  # Rack middleware (Rails, Sinatra, Hanami, Roda). It records a server span
  # with the stable HTTP semantic conventions and the
  # http.server.request.duration histogram, and can add a Server-Timing entry
  # and a canonical log line.
  module Rack
    HTTP_DURATION_BUCKETS = Internal::HttpCommon::DURATION_BUCKETS
    ROUTE_FIBER_KEY = :libo11y_http_route
    SCOPE_NAME = "libo11y.rack"

    # Sets the route template of the request this thread is serving, such as
    # "/orders/:id", for a router the middleware does not know.
    def self.set_route(route) # rubocop:disable Naming/AccessorMethodName -- the name every libo11y implementation gives it
      Thread.current[ROUTE_FIBER_KEY] = route.to_s
    end

    # Matches a path against an ignore pattern as Go's path.Match does: `*`
    # stays within one path segment, also when it is written twice, and it
    # matches a leading dot. A malformed pattern matches nothing.
    def self.match_glob?(pattern, path)
      Internal::PathMatch.match?(pattern, path)
    rescue Internal::PathMatch::BadPattern
      false
    end

    class Middleware
      # @param telemetry [Libo11y::Telemetry, nil] the handle to record
      #   through. Without one the middleware uses the global providers.
      # @param route [#call, nil] returns the route template for a Rack env
      # @param public_endpoint [Boolean] start a new trace and link the
      #   caller's span, for a server that untrusted clients reach
      # @param ignore_paths [Array<String>] patterns of paths to leave alone
      # @param filter [#call, nil] returns false for an env to leave alone
      # @param server_timing [Boolean] add a Server-Timing entry that names
      #   the server span to HTML responses
      # @param canonical_line [Boolean] emit one o11y.request.summary event
      #   per request. It needs telemetry.
      # @raise [ArgumentError] for canonical_line without telemetry
      def initialize(app, telemetry: nil, route: nil, public_endpoint: false, ignore_paths: [], filter: nil,
                     server_timing: false, canonical_line: false)
        if canonical_line && telemetry.nil?
          raise ArgumentError, "libo11y: canonical_line needs telemetry: the event is written through a Telemetry handle"
        end

        @app = app
        @telemetry = telemetry
        @route_fn = route
        @public_endpoint = public_endpoint
        @ignore_paths = Array(ignore_paths)
        @filter = filter
        @server_timing = server_timing
        @canonical_line = canonical_line
        @mutex = Mutex.new
        @duration = nil
      end

      def call(env)
        path = env["PATH_INFO"].to_s
        return @app.call(env) if ignored?(decode_path(path), env)

        previous_route = Thread.current[ROUTE_FIBER_KEY]
        Thread.current[ROUTE_FIBER_KEY] = nil
        begin
          serve(env, path)
        ensure
          Thread.current[ROUTE_FIBER_KEY] = previous_route
        end
      end

      private

      Request = Struct.new(:verb, :scheme, :path, :started, :status, :error)
      private_constant :Request

      def serve(env, path)
        method, original = Internal::HttpCommon.normalize_method(env["REQUEST_METHOD"].to_s)
        scheme = env["rack.url_scheme"].to_s
        request = Request.new(method, scheme.empty? ? "http" : scheme, path, Internal::HttpCommon.monotonic, 500, nil)
        parent, links = parent_context(env)
        route = resolve_route(env)

        attrs = { "http.request.method" => method, "url.path" => path, "url.scheme" => request.scheme }
        attrs["http.request.method_original"] = original if original
        attrs["http.route"] = route if route
        attrs["server.address"] = env["SERVER_NAME"].to_s unless env["SERVER_NAME"].to_s.empty?
        attrs["server.port"] = env["SERVER_PORT"].to_i unless env["SERVER_PORT"].to_s.empty?

        response = nil
        OpenTelemetry::Context.with_current(parent) do
          span = tracer.start_span(Internal::HttpCommon.span_name(method, route), attributes: attrs, links: links, kind: :server)
          begin
            OpenTelemetry::Trace.with_span(span) do
              Libo11y.start_record do |record|
                response = @app.call(env)
                request.status = response[0].to_i
              rescue StandardError => e
                request.error = e
                raise
              ensure
                finish(span, record, request, route || resolve_route(env))
              end
            end
            response = with_server_timing(response, span) if @server_timing
          ensure
            span.finish
          end
        end
        response
      end

      # Completes the span, records the duration and writes the canonical line.
      def finish(span, record, request, route)
        route = Thread.current[ROUTE_FIBER_KEY] || route
        route = nil if route.to_s.empty?
        if route
          span.set_attribute("http.route", route)
          span.name = Internal::HttpCommon.span_name(request.verb, route)
        end
        span.set_attribute("http.response.status_code", request.status)

        error_type = request.error.class.name if request.error
        error_type ||= request.status.to_s if request.status >= 500
        if error_type
          span.record_exception(request.error) if request.error
          span.set_attribute("error.type", error_type)
          span.status = OpenTelemetry::Trace::Status.error
        end

        elapsed = Internal::HttpCommon.monotonic - request.started
        metric_attrs = { "http.request.method" => request.verb, "http.response.status_code" => request.status, "url.scheme" => request.scheme }
        metric_attrs["http.route"] = route if route
        metric_attrs["error.type"] = error_type if error_type
        duration.record(elapsed, attributes: metric_attrs)

        return unless @canonical_line

        summary = record.attributes.merge(
          "http.request.method" => request.verb,
          "http.response.status_code" => request.status,
          "url.path" => request.path,
          Spec::ATTR_DURATION => elapsed,
          Spec::ATTR_OUTCOME => error_type ? Spec::Outcome::FAILURE : Spec::Outcome::SUCCESS
        )
        summary["http.route"] = route if route
        summary["error.type"] = error_type if error_type
        @telemetry.event(Spec::EVENT_REQUEST_SUMMARY, summary)
      end

      # The context the server span starts in, and its links. A public
      # endpoint starts a new trace and links the caller's span.
      def parent_context(env)
        propagator = @telemetry ? @telemetry.propagator : OpenTelemetry.propagation
        extracted = propagator.extract(request_headers(env), context: OpenTelemetry::Context.empty)
        return [extracted, nil] unless @public_endpoint

        remote = OpenTelemetry::Trace.current_span(extracted).context
        [OpenTelemetry::Context.empty, remote.valid? ? [OpenTelemetry::Trace::Link.new(remote)] : nil]
      end

      # Returns the response with a Server-Timing entry that names the server
      # span, when the response is HTML. An entry the application set stays,
      # and the new one goes after it. The application's own headers are not
      # changed.
      def with_server_timing(response, span)
        status, headers, body = response
        context = span.context
        return response unless headers.is_a?(Hash) && context.valid? && html?(headers)

        flags = context.trace_flags.sampled? ? "01" : "00"
        entry = "traceparent;desc=\"00-#{context.hex_trace_id}-#{context.hex_span_id}-#{flags}\""
        key = header_key(headers, "server-timing") || "server-timing"
        existing = headers[key]
        headers = headers.dup
        headers[key] = case existing
                       when nil, "" then entry
                       when Array then existing + [entry]
                       else "#{existing}, #{entry}"
                       end
        [status, headers, body]
      end

      # Whether the Content-Type's media type is text/html, whatever its parameters.
      def html?(headers)
        key = header_key(headers, "content-type")
        !key.nil? && Array(headers[key]).first.to_s.split(";", 2).first.to_s.strip.casecmp?("text/html")
      end

      # Rack 3 header names are lower case. Rack 2 applications use any case.
      def header_key(headers, name)
        headers.each_key.find { |key| key.to_s.casecmp?(name) }
      end

      def ignored?(decoded_path, env)
        return true if @ignore_paths.any? { |pattern| Rack.match_glob?(pattern, decoded_path) }

        !@filter.nil? && !@filter.call(env)
      end

      def decode_path(raw)
        URI.decode_www_form_component(raw.gsub("+", "%2B"))
      rescue ArgumentError
        raw
      end

      def request_headers(env)
        env.each_with_object({}) do |(key, value), headers|
          next unless key.is_a?(String) && key.start_with?("HTTP_")

          headers[key.delete_prefix("HTTP_").downcase.tr("_", "-")] = value.to_s
        end
      end

      def resolve_route(env)
        return @route_fn.call(env) if @route_fn.respond_to?(:call)

        # Sinatra and Rails
        env["sinatra.route"]&.split(" ", 2)&.last || env["action_dispatch.route_uri_pattern"]
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
              "http.server.request.duration", unit: "s", description: "Duration of HTTP server requests."
            )
          end
        end
      end
    end
  end
end
