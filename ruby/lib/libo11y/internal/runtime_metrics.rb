# frozen_string_literal: true

require "etc"

module Libo11y
  module Internal
    # Zero-dependency Ruby runtime and semantic-convention process metrics.
    module RuntimeMetrics
      # The size of a memory page, which /proc/self/statm counts in. It is
      # 4 KiB on most hosts and 16 or 64 KiB on some arm64 kernels.
      PAGE_SIZE = Etc.sysconf(Etc::SC_PAGESIZE) || 4096

      module_function

      # Registers the observable instruments on the meter provider. A failure
      # to register is not allowed to stop the application from starting.
      def register(meter_provider)
        meter = meter_provider.meter("libo11y.runtime", version: Libo11y::VERSION)
        register_ruby(meter)
        register_process(meter)
      rescue StandardError
        nil
      end

      def register_ruby(meter)
        meter.create_observable_counter(
          "ruby.gc.count", unit: "{collection}", description: "Total Ruby garbage collections.", callback: -> { GC.count }
        )
        meter.create_observable_gauge(
          "ruby.gc.heap_live_slots", unit: "{slot}", description: "Live object slots on the Ruby heap.",
                                     callback: -> { GC.stat(:heap_live_slots) }
        )
      end

      def register_process(meter)
        meter.create_observable_gauge(
          "process.thread.count", unit: "{thread}", description: "Number of active Ruby threads.", callback: -> { Thread.list.size }
        )
        meter.create_observable_counter(
          "process.cpu.time", unit: "s", description: "Process CPU time in seconds.",
                              callback: -> { Process.times.then { |times| times.utime + times.stime } }
        )
        if File.readable?("/proc/self/statm")
          meter.create_observable_gauge(
            "process.memory.usage", unit: "By", description: "Resident set size in bytes.", callback: -> { read_rss_bytes }
          )
        end
        return unless File.directory?("/proc/self/fd")

        meter.create_observable_gauge(
          "process.unix.file_descriptor.count", unit: "{file_descriptor}", description: "Open file descriptors.",
                                                callback: -> { open_file_descriptors }
        )
      end

      def open_file_descriptors
        Dir.children("/proc/self/fd").size
      rescue SystemCallError
        0
      end

      def read_rss_bytes
        parts = File.read("/proc/self/statm").split
        return 0 if parts.length < 2

        parts[1].to_i * PAGE_SIZE
      rescue StandardError
        0
      end
    end
  end
end
