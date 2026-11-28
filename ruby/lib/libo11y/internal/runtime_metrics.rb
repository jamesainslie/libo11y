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

      def register(meter_provider)
        meter = meter_provider.meter("libo11y.runtime", version: Libo11y::VERSION)

        meter.create_observable_counter(
          "ruby.gc.count",
          unit: "{collection}",
          description: "Total Ruby garbage collections.",
          callback: lambda do
            GC.count
          end
        )

        meter.create_observable_gauge(
          "ruby.gc.heap_live_slots",
          unit: "{slot}",
          description: "Live object slots on the Ruby heap.",
          callback: lambda do
            GC.stat(:heap_live_slots)
          end
        )

        meter.create_observable_gauge(
          "process.thread.count",
          unit: "{thread}",
          description: "Number of active Ruby threads.",
          callback: lambda do
            Thread.list.size
          end
        )

        meter.create_observable_counter(
          "process.cpu.time",
          unit: "s",
          description: "Process CPU time in seconds.",
          callback: lambda do
            t = Process.times
            t.utime + t.stime
          end
        )

        if File.readable?("/proc/self/statm")
          meter.create_observable_gauge(
            "process.memory.usage",
            unit: "By",
            description: "Resident set size in bytes.",
            callback: lambda do
              read_rss_bytes
            end
          )
        end

        return unless File.directory?("/proc/self/fd")

        meter.create_observable_gauge(
          "process.unix.file_descriptor.count",
          unit: "{file_descriptor}",
          description: "Open file descriptors.",
          callback: lambda do
            Dir.children("/proc/self/fd").size
          rescue StandardError
            0
          end
        )
      rescue StandardError
        nil
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
