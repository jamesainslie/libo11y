# frozen_string_literal: true

require "json"

module Libo11y
  # Capture-time redaction, so a sensitive value never reaches to_s, inspect,
  # JSON or a log record in the clear. Three protections exist: mask (a run of
  # X as long as the value), redact (the literal REDACTED) and omit (the field
  # is absent). The strictest protection wins through nesting.
  module Redact
    REDACTED = "REDACTED"
    VALID_TAGS = %i[mask redact omit confidential secret].freeze

    # Nesting deeper than this renders as REDACTED.
    MAX_DEPTH = 32

    PASSTHROUGH = 0
    MASK = 1
    REDACT = 2
    OMIT = 3
    LEVELS = { mask: MASK, confidential: MASK, redact: REDACT, secret: REDACT, omit: OMIT }.freeze
    TAG_OF = { MASK => :mask, REDACT => :redact, OMIT => :omit }.freeze
    private_constant :PASSTHROUGH, :MASK, :REDACT, :OMIT, :LEVELS, :TAG_OF

    def self.mask_string(value)
      "X" * value.to_s.length
    end

    # Returns the protection a tag names: :mask, :redact or :omit.
    # confidential is a synonym of mask and secret of redact.
    def self.normalize_tag(tag)
      TAG_OF.fetch(level_for(tag))
    end

    # @api private
    def self.level_for(tag)
      sym = tag.is_a?(Symbol) ? tag : tag.to_s.to_sym
      LEVELS.fetch(sym) do
        raise ArgumentError, "libo11y: unknown redact tag #{tag.inspect} (expected mask, redact, omit, confidential, or secret)"
      end
    end

    # Wraps a secret value. It always renders as "REDACTED".
    class Secret
      def initialize(value)
        @value = value
      end

      # Returns the wrapped value.
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

    # Wraps a value that renders as a run of X of the same length.
    class Masked
      def initialize(value)
        @value = value
      end

      # Returns the wrapped value.
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

    # Mixin for a Struct or class that declares a protection per field when
    # the class is defined:
    #
    #   Account = Struct.new(:id, :ssn, :token) do
    #     include Libo11y::Redact::Fields
    #
    #     redact_field :ssn, :mask
    #     redact_field :token, :secret
    #   end
    #
    # A subclass keeps its parent's rules. It can add rules and make one
    # stricter, and it cannot make one weaker.
    module Fields
      def self.included(base)
        base.extend(ClassMethods)
      end

      module ClassMethods
        # Declares the protection of one field. An unknown tag raises
        # ArgumentError here, when the class is defined.
        def redact_field(name, tag)
          level = Redact.level_for(tag)
          (@o11y_redact_levels ||= {})[name.to_sym] = level
        end

        # The protection of every declared field, the parent's included, as
        # :mask, :redact or :omit.
        def o11y_redact_rules
          o11y_redact_levels.transform_values { |level| TAG_OF.fetch(level) }
        end

        # @api private
        def o11y_redact_levels
          inherited = superclass.respond_to?(:o11y_redact_levels) ? superclass.o11y_redact_levels : {}
          inherited.merge(@o11y_redact_levels || {}) { |_name, parent, own| [parent, own].max }
        end
      end

      # The fields as a Hash with string keys, with each field's protection
      # applied.
      def redacted_hash
        Redact.render(self)
      end

      def to_s
        redacted_hash.inspect
      end

      def inspect
        "#<#{self.class.name || "struct"} #{redacted_hash.map { |k, v| "#{k}=#{v.inspect}" }.join(" ")}>"
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

    # Returns value with every Secret, Masked and Fields object inside it
    # rendered. Hashes and Arrays are walked. Nesting past MAX_DEPTH and a
    # reference back into the value being walked render as REDACTED.
    def self.render(value)
      protect(value, PASSTHROUGH, 0, {}.compare_by_identity)
    end

    # floor is the strictest protection of the fields that hold value.
    def self.protect(value, floor, depth, active)
      return REDACTED if floor >= REDACT || depth > MAX_DEPTH

      case value
      when nil then nil
      when Secret then REDACTED
      when Masked then value.to_s
      when Fields, Hash, Array then protect_composite(value, floor, depth, active)
      else floor == MASK ? mask_string(value) : value
      end
    end

    def self.protect_composite(value, floor, depth, active)
      return REDACTED if active.key?(value)

      active[value] = true
      begin
        case value
        when Fields then protect_fields(value, floor, depth, active)
        when Hash then value.to_h { |k, v| [k.to_s, protect(v, floor, depth + 1, active)] }
        else value.map { |v| protect(v, floor, depth + 1, active) }
        end
      ensure
        active.delete(value)
      end
    end

    def self.protect_fields(value, floor, depth, active)
      levels = value.class.o11y_redact_levels
      names = value.respond_to?(:members) ? value.members : value.instance_variables.map { |iv| iv.to_s.delete_prefix("@").to_sym }
      names.each_with_object({}) do |name, out|
        level = [levels.fetch(name.to_sym, PASSTHROUGH), floor].max
        next if level == OMIT

        out[name.to_s] = if level == REDACT
                           REDACTED
                         else
                           field = value.respond_to?(name) ? value.public_send(name) : value.instance_variable_get(:"@#{name}")
                           protect(field, level, depth + 1, active)
                         end
      end
    end
    private_class_method :protect, :protect_composite, :protect_fields
  end
end
