# frozen_string_literal: true

require "psych"

module Libo11y
  module Spec
    # yaml.v3-compatible YAML event composer and scalar resolver for application registries.
    module YamlV3
      class SyntaxError < StandardError; end

      INVALID_CHAR_RE = /[^\t\n\r\x20-\x7e\u0085\u00a0-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/

      ScalarNode = Struct.new(:tag, :value, :quoted_or_block, :anchor, keyword_init: true)
      SequenceNode = Struct.new(:tag, :items, :anchor, keyword_init: true)
      MappingNode = Struct.new(:tag, :pairs, :anchor, keyword_init: true)
      AliasNode = Struct.new(:anchor, keyword_init: true)
      Document = Struct.new(:root, :explicit_start, :version, :aliases, keyword_init: true)
      ScalarValue = Data.define(:is_null, :text, :is_string)

      LONG_TAG_PREFIX = "tag:yaml.org,2002:"
      TAG_NULL = "!!null"
      TAG_BOOL = "!!bool"
      TAG_STR = "!!str"
      TAG_INT = "!!int"
      TAG_FLOAT = "!!float"
      TAG_TIMESTAMP = "!!timestamp"
      TAG_BINARY = "!!binary"
      TAG_MERGE = "!!merge"

      RESOLVABLE_TAGS = ["", TAG_STR, TAG_BOOL, TAG_INT, TAG_FLOAT, TAG_NULL, TAG_TIMESTAMP].to_h { |t| [t, true] }.freeze
      MERGE_TAGS = ["", "!", TAG_MERGE].to_h { |t| [t, true] }.freeze

      RESOLVE_MAP = {
        "true" => TAG_BOOL, "True" => TAG_BOOL, "TRUE" => TAG_BOOL,
        "false" => TAG_BOOL, "False" => TAG_BOOL, "FALSE" => TAG_BOOL,
        "" => TAG_NULL, "~" => TAG_NULL, "null" => TAG_NULL, "Null" => TAG_NULL, "NULL" => TAG_NULL,
        ".nan" => TAG_FLOAT, ".NaN" => TAG_FLOAT, ".NAN" => TAG_FLOAT,
        ".inf" => TAG_FLOAT, ".Inf" => TAG_FLOAT, ".INF" => TAG_FLOAT,
        "+.inf" => TAG_FLOAT, "+.Inf" => TAG_FLOAT, "+.INF" => TAG_FLOAT,
        "-.inf" => TAG_FLOAT, "-.Inf" => TAG_FLOAT, "-.INF" => TAG_FLOAT,
        "<<" => TAG_MERGE
      }.freeze

      INT64_MAX = (1 << 63) - 1
      UINT64_MAX = (1 << 64) - 1
      YAML_STYLE_FLOAT_RE = /\A[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?\z/
      DOT_FLOAT_RE = /\A\.[0-9]+([eE][-+]?[0-9]+)?\z/
      BASE64_RE = %r{\A(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\z}
      TIMESTAMP_RES = [
        /\A(\d{4})-(\d\d?)-(\d\d?)T(\d\d?):(\d\d?):(\d\d?)(?:[.,]\d+)?(Z|[+-](\d\d):(\d\d))\z/,
        /\A(\d{4})-(\d\d?)-(\d\d?)t(\d\d?):(\d\d?):(\d\d?)(?:[.,]\d+)?(Z|[+-](\d\d):(\d\d))\z/,
        /\A(\d{4})-(\d\d?)-(\d\d?) (\d\d?):(\d\d?):(\d\d?)(?:[.,]\d+)?\z/,
        /\A(\d{4})-(\d\d?)-(\d\d?)\z/
      ].freeze

      ALIAS_RATIO_LOW = 400_000.0
      ALIAS_RATIO_HIGH = 4_000_000.0
      MAX_DEPTH = 10_000

      class Handler < Psych::Handler
        attr_reader :docs

        def initialize
          super
          @docs = []
          @stack = []
          @anchors = {}
          @aliases = {}
          @doc_explicit = false
          @doc_version = nil
          @doc_root = nil
        end

        def start_document(version, _tag_directives, implicit)
          raise SyntaxError, "found incompatible YAML document" if version && !version.empty? && version != [1, 1]

          @doc_version = version && !version.empty? ? version : nil
          @doc_explicit = !implicit
          @anchors = {}
          @aliases = {}
          @stack = []
          @doc_root = nil
        end

        def end_document(_implicit)
          @docs << Document.new(
            root: @doc_root,
            explicit_start: @doc_explicit,
            version: @doc_version,
            aliases: @aliases
          )
        end

        def scalar(value, anchor, tag, plain, quoted, style)
          quoted_or_block = quoted || !plain || (style != Psych::Nodes::Scalar::PLAIN)
          node = ScalarNode.new(tag: tag, value: value, quoted_or_block: quoted_or_block, anchor: anchor)
          @anchors[anchor] = node if anchor
          attach(node)
        end

        def alias(anchor)
          target = @anchors[anchor]
          raise SyntaxError, "unknown anchor '#{anchor}' referenced" unless target

          node = AliasNode.new(anchor: anchor)
          @aliases[node.object_id] = target
          attach(node)
        end

        def start_sequence(anchor, tag, _implicit, _style)
          raise SyntaxError, "the document nests too deeply" if @stack.length >= MAX_DEPTH

          node = SequenceNode.new(tag: tag, items: [], anchor: anchor)
          @anchors[anchor] = node if anchor
          attach(node)
          @stack << [:seq, node]
        end

        def end_sequence
          @stack.pop
        end

        def start_mapping(anchor, tag, _implicit, _style)
          raise SyntaxError, "the document nests too deeply" if @stack.length >= MAX_DEPTH

          node = MappingNode.new(tag: tag, pairs: [], anchor: anchor)
          @anchors[anchor] = node if anchor
          attach(node)
          @stack << [:map, node, nil]
        end

        def end_mapping
          @stack.pop
        end

        private

        def attach(node)
          if @stack.empty?
            @doc_root = node
            return
          end
          top = @stack.last
          if top[0] == :seq
            top[1].items << node
          elsif top[2].nil?
            top[2] = node
          else
            top[1].pairs << [top[2], node]
            top[2] = nil
          end
        end
      end

      module_function

      def decode_input(raw)
        bytes = raw.b
        text = if bytes.start_with?("\xFF\xFE".b)
                 decode_utf(bytes.byteslice(2, bytes.bytesize - 2), Encoding::UTF_16LE)
               elsif bytes.start_with?("\xFE\xFF".b)
                 decode_utf(bytes.byteslice(2, bytes.bytesize - 2), Encoding::UTF_16BE)
               elsif bytes.start_with?("\xEF\xBB\xBF".b)
                 decode_utf(bytes.byteslice(3, bytes.bytesize - 3), Encoding::UTF_8)
               else
                 decode_utf(bytes, Encoding::UTF_8)
               end
        check_characters(text)
        text
      end

      def decode_utf(bytes, enc)
        str = bytes.dup.force_encoding(enc)
        raise SyntaxError, "invalid #{enc.name} input" unless str.valid_encoding?

        str.encode(Encoding::UTF_8)
      rescue Encoding::InvalidByteSequenceError, Encoding::UndefinedConversionError
        raise SyntaxError, "invalid #{enc.name} input"
      end

      def check_characters(text)
        return unless (m = INVALID_CHAR_RE.match(text))

        cp = m[0].ord
        raise SyntaxError, format("control characters are not allowed: U+%04X", cp)
      end

      # Adjust libyaml's YAML 1.1 double-quoted escapes to match Go's yaml.v3:
      # - Reject `\/` (yaml.v3 rejects escaped slash; libyaml accepts it)
      # - Rewrite `\'` inside double-quoted strings to `'` (yaml.v3 accepts it; libyaml rejects it)
      # - Reject `\uD800`-`\uDFFF` surrogate escapes
      def preprocess_double_quoted_escapes(text)
        out = String.new(encoding: Encoding::UTF_8, capacity: text.bytesize)
        i = 0
        len = text.length
        in_single = false
        in_double = false
        in_comment = false

        while i < len
          ch = text[i]
          if in_comment
            out << ch
            in_comment = false if ["\n", "\r"].include?(ch)
            i += 1
          elsif in_single
            out << ch
            if ch == "'"
              if i + 1 < len && text[i + 1] == "'"
                out << "'"
                i += 2
              else
                in_single = false
                i += 1
              end
            else
              i += 1
            end
          elsif in_double
            if ch == "\\"
              raise SyntaxError, "unterminated escape in double-quoted scalar" if i + 1 >= len

              nxt = text[i + 1]
              if nxt == "/"
                raise SyntaxError, "found unknown escape character '/'"
              elsif nxt == "'"
                out << "'"
                i += 2
              elsif nxt == "u" && i + 5 < len
                hex = text[i + 2, 4]
                if /\A[0-9a-fA-F]{4}\z/.match?(hex)
                  cp = hex.to_i(16)
                  raise SyntaxError, "found invalid Unicode character escape code" if cp.between?(0xD800, 0xDFFF)
                end
                out << ch << nxt
                i += 2
              else
                out << ch << nxt
                i += 2
              end
            else
              out << ch
              in_double = false if ch == "\""
              i += 1
            end
          else
            if ch == "#" && (i.zero? || text[i - 1] == " " || text[i - 1] == "\t" || text[i - 1] == "\n" || text[i - 1] == "\r")
              in_comment = true
            elsif ch == "'"
              in_single = true
            elsif ch == "\""
              in_double = true
            end
            out << ch
            i += 1
          end
        end
        out
      end

      def parse_documents(text)
        check_characters(text)
        normalized = preprocess_double_quoted_escapes(text)
        handler = Handler.new
        parser = Psych::Parser.new(handler)
        parser.parse(normalized)
        handler.docs
      rescue Psych::Exception => e
        raise SyntaxError, e.message
      end

      def short_tag(tag)
        return "" if tag.nil?
        return "!!#{tag.delete_prefix(LONG_TAG_PREFIX)}" if tag.start_with?(LONG_TAG_PREFIX)

        tag
      end

      def hint(s)
        return "N" if s.empty?

        c = s[0]
        return "S" if ["+", "-"].include?(c)
        return "D" if c.between?("0", "9")
        return "M" if "yYnNtTfFoO~".include?(c)

        c == "." ? "." : ""
      end

      def parse_digits(s, base)
        return nil if s.empty?

        n = 0
        s.each_byte do |b|
          d = if b.between?(0x30, 0x39)
                b - 0x30
              elsif b.between?(0x61, 0x7A)
                b - 0x61 + 10
              elsif b.between?(0x41, 0x5A)
                b - 0x41 + 10
              else
                return nil
              end
          return nil if d >= base

          n = (n * base) + d
        end
        n
      end

      def go_parse_uint(s, base)
        return nil if s.empty?

        b = base
        digits = s
        if base.zero?
          b = 10
          if s[0] == "0"
            p = s.length > 1 ? s[1].downcase : ""
            if s.length >= 3 && p == "b"
              b = 2
              digits = s[2..]
            elsif s.length >= 3 && p == "o"
              b = 8
              digits = s[2..]
            elsif s.length >= 3 && p == "x"
              b = 16
              digits = s[2..]
            else
              b = 8
              digits = s[1..]
              return 0 if digits.empty? && s == "0"
            end
          end
        end
        n = parse_digits(digits, b)
        return nil if n.nil? || n > UINT64_MAX

        n
      end

      def go_parse_int(s, base)
        return nil if s.empty?

        negative = s[0] == "-"
        body = ["+", "-"].include?(s[0]) ? s[1..] : s
        n = go_parse_uint(body, base)
        return nil if n.nil?

        limit = negative ? INT64_MAX + 1 : INT64_MAX
        return nil if n > limit

        negative ? -n : n
      end

      def finite_float?(s)
        Float(s).finite?
      rescue ArgumentError
        false
      end

      def days_in(month, year)
        if month == 2
          return (year % 4).zero? && (!(year % 100).zero? || (year % 400).zero?) ? 29 : 28
        end

        [4, 6, 9, 11].include?(month) ? 30 : 31
      end

      def parse_timestamp?(s)
        return false if s.length < 5 || !/\A\d{4}-/.match?(s)

        TIMESTAMP_RES.each do |pattern|
          m = pattern.match(s)
          next unless m

          year = m[1].to_i
          month = m[2].to_i
          day = m[3].to_i
          hour = m.size > 4 && m[4] ? m[4].to_i : 0
          minute = m.size > 5 && m[5] ? m[5].to_i : 0
          second = m.size > 6 && m[6] ? m[6].to_i : 0
          next unless month.between?(1, 12) && day >= 1 && day <= days_in(month, year)
          next if hour > 23 || minute > 59 || second > 59
          next if m.size > 9 && m[8] && m[9] && (m[8].to_i > 24 || m[9].to_i > 60)

          return true
        end
        false
      end

      def classify(tag, s)
        h = hint(s)
        return [TAG_STR, false] if h.empty? || tag == TAG_STR

        mapped = RESOLVE_MAP[s]
        return [mapped, false] if mapped

        return [TAG_FLOAT, false] if h == "." && DOT_FLOAT_RE.match?(s) && finite_float?(s)

        if %w[D S].include?(h)
          return [TAG_TIMESTAMP, false] if (tag.empty? || tag == TAG_TIMESTAMP) && parse_timestamp?(s)

          plain = s.delete("_")
          return [TAG_INT, false] unless go_parse_int(plain, 0).nil?
          return [TAG_INT, true] unless go_parse_uint(plain, 0).nil?
          return [TAG_FLOAT, false] if YAML_STYLE_FLOAT_RE.match?(plain) && finite_float?(plain)

          if plain.start_with?("0b")
            return [TAG_INT, false] unless go_parse_int(plain[2..], 2).nil?
            return [TAG_INT, true] unless go_parse_uint(plain[2..], 2).nil?
          elsif plain.start_with?("-0b") && !go_parse_int("-#{plain[3..]}", 2).nil?
            return [TAG_INT, false]
          end
          if plain.start_with?("0o")
            return [TAG_INT, false] unless go_parse_int(plain[2..], 8).nil?
            return [TAG_INT, true] unless go_parse_uint(plain[2..], 8).nil?
          elsif plain.start_with?("-0o") && !go_parse_int("-#{plain[3..]}", 8).nil?
            return [TAG_INT, false]
          end
        end
        [TAG_STR, false]
      end

      def decode_base64(s)
        compact = s.delete("\r\n")
        raise SyntaxError, "!!binary value contains invalid base64 data" unless BASE64_RE.match?(compact)

        raw = compact.unpack1("m0")
        raw.force_encoding(Encoding::UTF_8).encode(Encoding::UTF_8, invalid: :replace, undef: :replace)
      end

      def resolve_scalar(tag, value, quoted_or_block)
        short = short_tag(tag)
        if short == TAG_STR || ((short.empty? || short == "!") && quoted_or_block)
          return ScalarValue.new(is_null: false, text: value, is_string: true)
        end

        unless RESOLVABLE_TAGS[short]
          return ScalarValue.new(is_null: false, text: decode_base64(value), is_string: true) if short == TAG_BINARY

          return ScalarValue.new(is_null: false, text: value, is_string: true)
        end

        resolved_tag, unsigned = classify(short, value)
        resolved_tag = TAG_FLOAT if short == TAG_FLOAT && resolved_tag == TAG_INT && !unsigned
        raise SyntaxError, "cannot decode #{resolved_tag} `#{value}` as a #{short}" if !short.empty? && short != resolved_tag
        return ScalarValue.new(is_null: true, text: "", is_string: false) if resolved_tag == TAG_NULL

        ScalarValue.new(is_null: false, text: value, is_string: [TAG_STR, TAG_MERGE].include?(resolved_tag))
      end

      def allowed_alias_ratio(decodes)
        return 0.99 if decodes <= ALIAS_RATIO_LOW
        return 0.10 if decodes >= ALIAS_RATIO_HIGH

        0.99 - (0.89 * ((decodes - ALIAS_RATIO_LOW) / (ALIAS_RATIO_HIGH - ALIAS_RATIO_LOW)))
      end

      def merge_key?(node)
        node.is_a?(ScalarNode) &&
          !node.quoted_or_block &&
          node.value == "<<" &&
          MERGE_TAGS[short_tag(node.tag)]
      end
    end
  end
end
