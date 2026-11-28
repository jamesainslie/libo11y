# frozen_string_literal: true

require "uri"
require "opentelemetry"
require_relative "record"
require_relative "spec"

module Libo11y
  # Rack middleware (Rails, Sinatra, Hanami, Roda) emitting stable HTTP semconv spans,
  # http.server.request.duration histograms with exemplars, Server-Timing, and canonical lines.
  module Rack
    HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0].freeze
    ROUTE_FIBER_KEY = :libo11y_http_route

    def self.set_route(route)
      Thread.current[ROUTE_FIBER_KEY] = route.to_s
    end

    def self.match_glob?(pattern, path)
      File.fnmatch?(pattern, path, File::FNM_PATHNAME)
    end

    class Middleware
      def initialize(
        app,
        telemetry: nil,
        route: nil,
        public_endpoint: false,
        ignore_paths: [],
        filter: nil,
        server_timing: false,
        canonical_line: false
      )
        @app = app
        @telemetry = telemetry
        @route_fn = route
        @public_endpoint = public_endpoint
        @ignore_paths = Array(ignore_paths)
        @filter = filter
        @server_timing = server_timing
        @canonical_line = canonical_line
      end

      def call(env)
        raw_path = env["PATH_INFO"].to_s
        decoded_path = decode_path(raw_path)

        return @app.call(env) if ignored?(decoded_path, env)

        method = env["REQUEST_METHOD"].to_s.upcase
        scheme = env["rack.url_scheme"].to_s
        scheme = "http" if scheme.empty?

        propagator = @telemetry ? @telemetry.propagator : OpenTelemetry.propagation
        headers = extract_rack_headers(env)
        extracted_ctx = propagator.extract(headers, context: OpenTelemetry::Context.empty)

        parent_ctx = extracted_ctx
        links = nil
        if @public_endpoint
          remote_sc = OpenTelemetry::Trace.current_span(extracted_ctx).context
          links = [OpenTelemetry::Trace::Link.new(remote_sc)] if remote_sc.valid?
          parent_ctx = OpenTelemetry::Context.empty
        end

        resolved_route = resolve_route(env)
        span_name = resolved_route ? "#{method} #{resolved_route}" : method

        attrs = {
          "http.request.method" => method,
          "url.path" => raw_path,
          "url.scheme" => scheme
        }
        attrs["http.route"] = resolved_route if resolved_route
        attrs["server.address"] = env["SERVER_NAME"].to_s unless env["SERVER_NAME"].to_s.empty?
        attrs["server.port"] = env["SERVER_PORT"].to_i unless env["SERVER_PORT"].to_s.empty?

        tracer = @telemetry ? @telemetry.tracer("libo11y.rack", Libo11y::VERSION) : OpenTelemetry.tracer_provider.tracer("libo11y.rack", Libo11y::VERSION)
        meter = if @telemetry
                  @telemetry.meter("libo11y.rack",
                                   version: Libo11y::VERSION)
                else
                  OpenTelemetry.meter_provider.meter("libo11y.rack", version: Libo11y::VERSION)
                end
        @duration_hist ||= meter.create_histogram(
          "http.server.request.duration",
          unit: "s",
          description: "Duration of HTTP server requests.",
          explicit_bucket_boundaries: HTTP_DURATION_BUCKETS
        )

        started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        prev_route = Thread.current[ROUTE_FIBER_KEY]
        Thread.current[ROUTE_FIBER_KEY] = nil

        status = 500
        resp_headers = {}
        body = nil
        error = nil

        OpenTelemetry::Context.with_current(parent_ctx) do
          tracer.in_span(span_name, attributes: attrs, links: links, kind: :server) do |span|
            Libo11y.start_record do |rec|
              status, resp_headers, body = @app.call(env)
              status = status.to_i
            rescue StandardError => e
              error = e
              span.record_exception(e)
              span.status = OpenTelemetry::Trace::Status.error(e.message)
              span.set_attribute("error.type", e.class.name)
              raise
            ensure
              final_route = Thread.current[ROUTE_FIBER_KEY] || resolved_route || resolve_route(env)
              if final_route && !final_route.empty?
                span.set_attribute("http.route", final_route)
                span.name = "#{method} #{final_route}"
              end
              span.set_attribute("http.response.status_code", status)
              if status >= 500 && error.nil?
                span.status = OpenTelemetry::Trace::Status.error("HTTP #{status}")
                span.set_attribute("error.type", status.to_s)
              end

              duration = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started
              metric_attrs = {
                "http.request.method" => method,
                "http.response.status_code" => status,
                "url.scheme" => scheme
              }
              metric_attrs["http.route"] = final_route if final_route && !final_route.empty?
              metric_attrs["error.type"] = error ? error.class.name : status.to_s if error || status >= 500
              @duration_hist.record(duration, attributes: metric_attrs)

              if @server_timing && resp_headers.is_a?(Hash) && error.nil?
                sc = span.context
                if sc.valid?
                  flags = sc.trace_flags.sampled? ? "01" : "00"
                  tp = "00-#{sc.hex_trace_id}-#{sc.hex_span_id}-#{flags}"
                  resp_headers = resp_headers.dup
                  existing = resp_headers["server-timing"] || resp_headers["Server-Timing"]
                  entry = "traceparent;desc=\"#{tp}\""
                  resp_headers["server-timing"] = existing ? "#{existing}, #{entry}" : entry
                end
              end

              if @canonical_line && @telemetry
                summary_attrs = rec.attributes.merge(
                  "http.request.method" => method,
                  "http.response.status_code" => status,
                  "url.path" => raw_path,
                  Spec::ATTR_DURATION => duration,
                  Spec::ATTR_OUTCOME => error || status >= 500 ? Spec::Outcome::FAILURE : Spec::Outcome::SUCCESS
                )
                summary_attrs["http.route"] = final_route if final_route && !final_route.empty?
                summary_attrs["error.type"] = error.class.name if error
                @telemetry.event(Spec::EVENT_REQUEST_SUMMARY, summary_attrs)
              end
            end
          end
        end

        [status, resp_headers, body]
      ensure
        Thread.current[ROUTE_FIBER_KEY] = prev_route
      end

      private

      def ignored?(decoded_path, env)
        return true if @ignore_paths.any? { |pat| Rack.match_glob?(pat, decoded_path) }
        return true if @filter && !@filter.call(env)

        false
      end

      def decode_path(raw)
        URI.decode_www_form_component(raw.gsub("+", "%2B"))
      rescue StandardError
        raw
      end

      def extract_rack_headers(env)
        headers = {}
        env.each do |k, v|
          next unless k.is_a?(String) && k.start_with?("HTTP_")

          header_name = k.delete_prefix("HTTP_").downcase.tr("_", "-")
          headers[header_name] = v.to_s
        end
        headers
      end

      def resolve_route(env)
        return @route_fn.call(env) if @route_fn.respond_to?(:call)

        # Sinatra / Rails route conventions
        env["sinatra.route"]&.split(" ", 2)&.last || env["action_dispatch.route_uri_pattern"]
      end
    end
  end
end
