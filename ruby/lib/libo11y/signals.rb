# frozen_string_literal: true

module Libo11y
  module Signals
    module_function

    # Block until SIGINT or SIGTERM arrives, restore default handlers, run optional
    # before_shutdown callback, and flush telemetry under one shared deadline.
    def shutdown_on_signals(telemetry, timeout: nil, signals: %w[INT TERM], before_shutdown: nil)
      deadline_secs = timeout || telemetry.shutdown_timeout
      read_io, write_io = IO.pipe
      previous = {}

      signals.each do |sig|
        previous[sig] = Signal.trap(sig) do
          write_io.write_nonblock("x")
        rescue StandardError
          nil
        end
      end

      begin
        read_io.read(1)
      ensure
        previous.each do |sig, handler|
          Signal.trap(sig, handler || "DEFAULT")
        rescue StandardError
          nil
        end
        read_io.close unless read_io.closed?
        write_io.close unless write_io.closed?
      end

      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      if before_shutdown
        begin
          before_shutdown.call
        rescue StandardError
          nil
        end
      end
      elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started
      remaining = [deadline_secs - elapsed, 0.05].max
      telemetry.shutdown(timeout: remaining)
    end
  end
end
