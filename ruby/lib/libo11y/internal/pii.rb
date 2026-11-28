# frozen_string_literal: true

require "openssl"

module Libo11y
  module Internal
    module PII
      MAX_COMPOSITE_DEPTH = 16
      MAX_COMPOSITE_NODES = 2048
      CANONICAL_TRUNCATED = "truncated"
      MIN_PII_HASH_KEY_LEN = 32

      class Walk
        def initialize
          @remaining = MAX_COMPOSITE_NODES
          @active = {}
        end

        def spend?
          return false if @remaining <= 0

          @remaining -= 1
          true
        end

        def enter?(obj)
          oid = obj.object_id
          return false if @active.key?(oid)

          @active[oid] = true
          true
        end

        def leave(obj)
          @active.delete(obj.object_id)
        end
      end

      module_function

      def canonical_float(value)
        return "NaN" if value.nan?
        return value.positive? ? "+Inf" : "-Inf" if value.infinite?
        if value.zero?
          return (1.0 / value).negative? ? "-0" : "0"
        end

        neg = value.negative?
        abs_val = neg ? -value : value
        s = abs_val.to_s
        if s.include?("e") || s.include?("E")
          mant, exp_str = s.downcase.split("e", 2)
          exp = exp_str.to_i
        else
          mant = s
          exp = 0
        end

        if mant.include?(".")
          int_part, frac_part = mant.split(".", 2)
          digits_raw = int_part + frac_part
          stripped = digits_raw.sub(/\A0+/, "")
          leading_zeros = digits_raw.length - stripped.length
          if int_part == "0"
            exp -= leading_zeros
          else
            exp += int_part.length - 1
          end
          digits = stripped.sub(/0+\z/, "")
        else
          exp += mant.length - 1
          digits = mant.sub(/0+\z/, "")
        end

        return neg ? "-0" : "0" if digits.empty?

        prefix = neg ? "-" : ""
        if exp < -4 || exp >= 6
          body = digits.length == 1 ? digits : "#{digits[0]}.#{digits[1..]}"
          sign = exp >= 0 ? "+" : "-"
          abs_exp = exp.abs
          exp_fmt = abs_exp < 100 ? format("%02d", abs_exp) : abs_exp.to_s
          return "#{prefix}#{body}e#{sign}#{exp_fmt}"
        end

        if exp.negative?
          "#{prefix}0.#{"0" * (-exp - 1)}#{digits}"
        elsif exp + 1 >= digits.length
          "#{prefix}#{digits}#{"0" * (exp + 1 - digits.length)}"
        else
          split = exp + 1
          "#{prefix}#{digits[0, split]}.#{digits[split..]}"
        end
      end

      def encode_json_string(str)
        out = +"\""
        str.each_char do |ch|
          cp = ch.ord
          out << case ch
                 when "\"" then "\\\""
                 when "\\" then "\\\\"
                 when "\b" then "\\b"
                 when "\f" then "\\f"
                 when "\n" then "\\n"
                 when "\r" then "\\r"
                 when "\t" then "\\t"
                 when "<" then "\\u003c"
                 when ">" then "\\u003e"
                 when "&" then "\\u0026"
                 else
                   if cp == 0x2028
                     "\\u2028"
                   elsif cp == 0x2029
                     "\\u2029"
                   elsif cp < 0x20
                     format("\\u%04x", cp)
                   else
                     ch
                   end
                 end
        end
        out << "\""
        out
      end

      def render_json_node(node)
        case node
        when String
          encode_json_string(node)
        when Array
          "[#{node.map { |el| render_json_node(el) }.join(",")}]"
        when Hash
          items = node.map { |k, v| "#{encode_json_string(k)}:#{render_json_node(v)}" }
          "{#{items.join(",")}}"
        else
          encode_json_string(node.to_s)
        end
      end

      def build_node(value, depth, walk)
        return CANONICAL_TRUNCATED if depth > MAX_COMPOSITE_DEPTH || !walk.spend?

        case value
        when true then "true"
        when false then "false"
        when Float then canonical_float(value)
        when String
          if value.encoding == Encoding::BINARY
            [value].pack("m0")
          else
            value
          end
        when Hash
          return CANONICAL_TRUNCATED unless walk.enter?(value)

          begin
            pairs = value.map do |k, v|
              ks = k.is_a?(String) ? k : k.to_s
              [ks.encode(Encoding::UTF_8, invalid: :replace, undef: :replace).b, ks, v]
            end
            pairs.sort_by!(&:first)
            obj = {}
            pairs.each do |_, ks, v|
              obj[ks] = build_node(v, depth + 1, walk)
            end
            obj
          ensure
            walk.leave(value)
          end
        when Array
          return CANONICAL_TRUNCATED unless walk.enter?(value)

          begin
            value.map { |el| build_node(el, depth + 1, walk) }
          ensure
            walk.leave(value)
          end
        else
          value.to_s
        end
      end

      def canonical_value(value)
        node = build_node(value, 0, Walk.new)
        return node if node.is_a?(String)

        render_json_node(node)
      end

      def token(key, value)
        canonical = canonical_value(value)
        digest = OpenSSL::HMAC.digest("SHA256", key, canonical.encode(Encoding::UTF_8).b)
        "hmac-sha256:#{digest.byteslice(0, 16).unpack1("H*")}"
      end
    end
  end
end
