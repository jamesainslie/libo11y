# frozen_string_literal: true

require "json"

module Libo11y
  # Capture-time redaction helpers so sensitive values never leak through to_s, inspect, JSON, or logs.
  module Redact
    REDACTED = "REDACTED"
    VALID_TAGS = %i[mask redact omit confidential secret].freeze

    def self.mask_string(value)
      "X" * value.to_s.length
    end

    def self.normalize_tag(tag)
      sym = tag.is_a?(Symbol) ? tag : tag.to_s.to_sym
      case sym
      when :mask, :confidential then :mask
      when :redact, :secret then :redact
      when :omit then :omit
      else
        raise ArgumentError, "libo11y: unknown redact tag #{tag.inspect} (expected mask, redact, omit, confidential, or secret)"
      end
    end

    # Wraps a secret value; always renders as "REDACTED".
    class Secret
      def initialize(value)
        @value = value
      end

      def reveal
        @value
      end

      def to_s
        REDACTED
      end

      def inspect
        REDACTED.inspect
      end

      def to_json(*)
        REDACTED.to_json(*)
      end

      def as_redacted
        REDACTED
      end

      def ==(other)
        other.is_a?(Secret) && @value == other.reveal
      end
    end

    # Wraps a masked value; renders as same-length "X" string.
    class Masked
      def initialize(value)
        @value = value
      end

      def reveal
        @value
      end

      def to_s
        Redact.mask_string(@value)
      end

      def inspect
        to_s.inspect
      end

      def to_json(*)
        to_s.to_json(*)
      end

      def as_redacted
        to_s
      end

      def ==(other)
        other.is_a?(Masked) && @value == other.reveal
      end
    end

    # Mixin for structs/classes that declare field-level redaction policies at class definition time.
    module Fields
      def self.included(base)
        base.extend(ClassMethods)
      end

      module ClassMethods
        def o11y_redact_rules
          @o11y_redact_rules ||= {}
        end

        def redact_field(name, tag)
          o11y_redact_rules[name.to_sym] = Redact.normalize_tag(tag)
        end
      end

      def redacted_hash(seen = {})
        return "truncated" if seen[object_id]

        seen[object_id] = true
        begin
          rules = self.class.o11y_redact_rules
          out = {}
          members_list = respond_to?(:members) ? members : instance_variables.map { |iv| iv.to_s.delete_prefix("@").to_sym }
          members_list.each do |field|
            val = respond_to?(field) ? public_send(field) : instance_variable_get(:"@#{field}")
            tag = rules[field.to_sym]
            case tag
            when :omit
              next
            when :redact
              out[field.to_s] = REDACTED
            when :mask
              out[field.to_s] = Redact.mask_string(val)
            else
              out[field.to_s] = Redact.render(val, seen)
            end
          end
          out
        ensure
          seen.delete(object_id)
        end
      end

      def to_s
        redacted_hash.inspect
      end

      def inspect
        "#<#{self.class.name} #{redacted_hash.map { |k, v| "#{k}=#{v.inspect}" }.join(" ")}>"
      end

      def to_json(*)
        redacted_hash.to_json(*)
      end

      def as_redacted
        redacted_hash
      end
    end

    def self.redactable?(value)
      value.is_a?(Secret) || value.is_a?(Masked) || value.is_a?(Fields)
    end

    def self.render(value, seen = {})
      return value.as_redacted if value.is_a?(Secret) || value.is_a?(Masked)
      return value.redacted_hash(seen) if value.is_a?(Fields)

      case value
      when Hash
        return "truncated" if seen[value.object_id]

        seen[value.object_id] = true
        begin
          value.transform_values { |v| render(v, seen) }
        ensure
          seen.delete(value.object_id)
        end
      when Array
        return "truncated" if seen[value.object_id]

        seen[value.object_id] = true
        begin
          value.map { |v| render(v, seen) }
        ensure
          seen.delete(value.object_id)
        end
      else
        value
      end
    end

    def self.contains_redactable?(value, depth = 0, seen = {})
      return false if depth > 16
      return true if redactable?(value)

      case value
      when Hash
        return false if seen[value.object_id]

        seen[value.object_id] = true
        begin
          value.values.any? { |v| contains_redactable?(v, depth + 1, seen) }
        ensure
          seen.delete(value.object_id)
        end
      when Array
        return false if seen[value.object_id]

        seen[value.object_id] = true
        begin
          value.any? { |v| contains_redactable?(v, depth + 1, seen) }
        ensure
          seen.delete(value.object_id)
        end
      else
        false
      end
    end
  end
end
