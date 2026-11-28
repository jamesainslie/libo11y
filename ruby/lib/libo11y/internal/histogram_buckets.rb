# frozen_string_literal: true

module Libo11y
  module Internal
    # Bucket boundaries, in seconds, of the duration histograms libo11y
    # records. The SDK's default boundaries start at 0, 5, 10, which suits
    # milliseconds and puts nearly every request in the first bucket.
    module HistogramBuckets
      HTTP = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0].freeze
      DB = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0].freeze

      # By instrument name. The SDK ignores the boundaries an instrument
      # advises, so the builder registers a view for each of these.
      DEFAULTS = {
        "http.server.request.duration" => HTTP,
        "http.client.request.duration" => HTTP,
        "db.client.operation.duration" => DB
      }.freeze
    end
  end
end
