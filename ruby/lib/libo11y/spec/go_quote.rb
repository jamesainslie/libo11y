# frozen_string_literal: true

require_relative "generated/goprint"

module Libo11y
  module Spec
    module GoQuote
      SHORT_ESCAPES = {
        "\a" => '\a',
        "\b" => '\b',
        "\f" => '\f',
        "\n" => '\n',
        "\r" => '\r',
        "\t" => '\t',
        "\v" => '\v'
      }.freeze

      module_function

      def printable?(codepoint)
        ranges = GO_PRINT_RANGES
        lo = 0
        hi = ranges.length
        while lo < hi
          mid = (lo + hi) >> 1
          if ranges[mid] < codepoint
            lo = mid + 1
          else
            hi = mid
          end
        end
        lo < ranges.length && (lo.odd? || ranges[lo] == codepoint)
      end

      def quote(str)
        out = +"\""
        str.each_char do |ch|
          cp = ch.ord
          if ["\"", "\\"].include?(ch)
            out << "\\" << ch
          elsif printable?(cp)
            out << ch
          elsif (short = SHORT_ESCAPES[ch])
            out << short
          elsif cp < 0x20 || cp == 0x7F
            out << format("\\x%02x", cp)
          elsif cp < 0x10000
            out << format("\\u%04x", cp)
          else
            out << format("\\U%08x", cp)
          end
        end
        out << "\""
        out
      end
    end
  end
end
