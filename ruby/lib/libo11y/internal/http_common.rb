# frozen_string_literal: true

require_relative "histogram_buckets"

module Libo11y
  module Internal
    # What the HTTP server and client instrumentation share.
    module HttpCommon
      # The request methods the semantic conventions name. Any other method
      # is recorded as _OTHER, so a caller cannot grow the metric's series.
      KNOWN_METHODS = %w[CONNECT DELETE GET HEAD OPTIONS PATCH POST PUT TRACE].freeze
      METHOD_OTHER = "_OTHER"
      DURATION_BUCKETS = HistogramBuckets::HTTP

      module_function

      # Maps a request method onto the known set. Returns the value for
      # http.request.method and, when the method was not already written
      # that way, the method as given, for http.request.method_original.
      def normalize_method(raw)
        return [raw, nil] if KNOWN_METHODS.include?(raw)
        return [METHOD_OTHER, nil] if raw.empty?

        upper = raw.upcase
        [KNOWN_METHODS.include?(upper) ? upper : METHOD_OTHER, raw]
      end

      # The span name: the method, or HTTP for _OTHER, and the route when one is known.
      def span_name(method, route = nil)
        prefix = method == METHOD_OTHER ? "HTTP" : method
        route.nil? || route.empty? ? prefix : "#{prefix} #{route}"
      end

      def monotonic
        Process.clock_gettime(Process::CLOCK_MONOTONIC)
      end
    end
  end
end
