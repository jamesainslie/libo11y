# frozen_string_literal: true

require_relative "libo11y/version"
require_relative "libo11y/errors"
require_relative "libo11y/options"
require_relative "libo11y/spec"
require_relative "libo11y/redact"
require_relative "libo11y/record"
require_relative "libo11y/detached"
require_relative "libo11y/proc"
require_relative "libo11y/signals"
require_relative "libo11y/telemetry"
require_relative "libo11y/rack"
require_relative "libo11y/http_client"
require_relative "libo11y/db"

module Libo11y
  # Global one-call initialization: installs global providers and propagator, runs startup canary.
  # If a block is given, yields telemetry and guarantees bounded shutdown when the block exits.
  def self.setup(options = nil, **)
    tel = Builder.build(options, is_global: true, **)
    return tel unless block_given?

    begin
      yield tel
    ensure
      tel.shutdown
    end
  end

  # Non-global initialization for tests, dependency injection, and multi-tenant processes.
  def self.init(options = nil, **)
    tel = Builder.build(options, is_global: false, **)
    return tel unless block_given?

    begin
      yield tel
    ensure
      tel.shutdown
    end
  end

  def self.shutdown_on_signals(telemetry, **)
    Signals.shutdown_on_signals(telemetry, **)
  end
end
