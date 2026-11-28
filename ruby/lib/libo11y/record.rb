# frozen_string_literal: true

module Libo11y
  # Wide event accumulator attached to the current Fiber/execution context.
  class Record
    def initialize
      @mutex = Mutex.new
      @attrs = {}
    end

    def set(key, value)
      @mutex.synchronize { @attrs[key.to_s] = value }
      self
    end

    def set_all(hash)
      return self if hash.nil?

      @mutex.synchronize do
        hash.each { |k, v| @attrs[k.to_s] = v }
      end
      self
    end

    def add(key, delta = 1)
      k = key.to_s
      @mutex.synchronize do
        cur = @attrs[k]
        @attrs[k] = (cur.is_a?(Numeric) ? cur : 0) + delta
      end
      self
    end

    def attributes
      @mutex.synchronize { @attrs.dup }
    end

    def emit_event(telemetry, name, extra = nil)
      merged = attributes
      extra&.each { |k, v| merged[k.to_s] = v }
      telemetry.event(name, merged)
    end
  end

  RECORD_FIBER_KEY = :libo11y_current_record

  def self.current_record
    Thread.current[RECORD_FIBER_KEY]
  end

  # Runs the block with a new Record as the current one, and yields it.
  # Returns the block's value.
  #
  # @raise [ArgumentError] without a block
  def self.start_record
    raise ArgumentError, "libo11y: start_record needs a block" unless block_given?

    record = Record.new
    previous = Thread.current[RECORD_FIBER_KEY]
    Thread.current[RECORD_FIBER_KEY] = record
    begin
      yield record
    ensure
      Thread.current[RECORD_FIBER_KEY] = previous
    end
  end
end
