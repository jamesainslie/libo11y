# frozen_string_literal: true

module Libo11y
  module Signals
    module_function

    # Blocks until SIGINT or SIGTERM arrives, restores the previous handlers,
    # then runs before_shutdown and the telemetry shutdown under one shared
    # deadline, and returns the ShutdownReport.
    #
    # before_shutdown is where the application stops taking work, such as
    # stopping its HTTP server. When it is still running at the deadline,
    # telemetry shuts down without waiting for it. When it raises, telemetry
    # still shuts down, and the error is raised afterwards.
    #
    # @param timeout [Numeric, nil] seconds for both steps together. nil
    #   uses the handle's shutdown_timeout.
    def shutdown_on_signals(telemetry, timeout: nil, signals: %w[INT TERM], before_shutdown: nil)
      secs = Float(timeout || telemetry.shutdown_timeout)
      wait_for_signal(signals)

      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + secs
      error = run_before_shutdown(before_shutdown, secs)
      remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
      report = telemetry.shutdown(timeout: [remaining, 0.001].max)
      raise error if error

      report
    end

    # Signal handlers may not take locks, so they write one byte to a pipe
    # that this method reads.
    def wait_for_signal(signals)
      read_io, write_io = IO.pipe
      previous = signals.to_h do |name|
        handler = Signal.trap(name) do
          write_io.write_nonblock("x")
        rescue IOError, SystemCallError
          nil
        end
        [name, handler]
      end
      read_io.read(1)
    ensure
      previous&.each { |name, handler| Signal.trap(name, handler || "DEFAULT") }
      read_io&.close
      write_io&.close
    end

    # Runs the callback for at most secs seconds. Returns the error it raised, if any.
    def run_before_shutdown(callback, secs)
      return nil if callback.nil?

      error = nil
      worker = Thread.new do
        callback.call
      rescue StandardError => e
        error = e
      end
      worker.report_on_exception = false
      worker.join(secs)
      error
    end
  end
end
