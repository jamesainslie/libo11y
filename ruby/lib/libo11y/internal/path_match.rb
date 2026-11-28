# frozen_string_literal: true

module Libo11y
  module Internal
    # Go's path.Match, so an ignore pattern means in Ruby what it means in
    # every other libo11y implementation. `*` matches any run of characters
    # other than `/`, `?` one such character, `[...]` a character class
    # (negated with `^`, ranges with `-`), and a backslash escapes the next
    # character. The pattern must match the whole name. Ruby's File.fnmatch
    # differs: it gives `**` a recursive meaning.
    module PathMatch
      # A malformed pattern, such as an unclosed character class.
      class BadPattern < ArgumentError; end

      module_function

      # @raise [BadPattern] for a malformed pattern, also when the match has
      #   already failed
      def match?(pattern, name)
        until pattern.empty?
          star, chunk, pattern = scan_chunk(pattern)
          # A trailing star matches the rest of name unless it has a slash.
          return !name.include?("/") if star && chunk.empty?

          rest = match_chunk(chunk, name)
          # The last chunk must exhaust name, or the star may still find a later match.
          if rest && (rest.empty? || !pattern.empty?)
            name = rest
            next
          end
          skipped = star ? match_after_star(chunk, name, last: pattern.empty?) : nil
          if skipped
            name = skipped
            next
          end
          # Before reporting no match, check that the rest of the pattern is well formed.
          until pattern.empty?
            _, chunk, pattern = scan_chunk(pattern)
            match_chunk(chunk, "")
          end
          return false
        end
        name.empty?
      end

      # Whether the pattern is well formed. Matching the empty name reads the
      # whole pattern.
      def valid?(pattern)
        match?(pattern, "")
        true
      rescue BadPattern
        false
      end

      # Matches chunk after skipping one or more characters of name, never a slash.
      def match_after_star(chunk, name, last:)
        name.each_char.with_index do |char, index|
          break if char == "/"

          rest = match_chunk(chunk, name[(index + 1)..])
          return rest if rest && !(last && !rest.empty?)
        end
        nil
      end

      # Splits off the next run of pattern characters without a star, and
      # says whether stars came before it.
      def scan_chunk(pattern)
        stripped = pattern.sub(/\A\*+/, "")
        star = stripped.length != pattern.length
        in_range = false
        index = 0
        while index < stripped.length
          case stripped[index]
          when "\\" then index += 1 if index + 1 < stripped.length # a trailing backslash is reported by match_chunk
          when "[" then in_range = true
          when "]" then in_range = false
          when "*" then return [star, stripped[0, index], stripped[index..]] unless in_range
          end
          index += 1
        end
        [star, stripped, ""]
      end

      # Matches a chunk without stars against the start of name and returns
      # what is left of name, or nil. After a mismatch it keeps reading the
      # chunk, so a malformed chunk raises whatever name is.
      def match_chunk(chunk, name)
        failed = false
        until chunk.empty?
          failed ||= name.empty?
          case chunk[0]
          when "["
            char = failed ? "" : name[0]
            name = name[1..] unless failed
            matched, chunk = match_class(chunk[1..], char)
            failed ||= !matched
            next
          when "?"
            unless failed
              failed = name[0] == "/"
              name = name[1..]
            end
            chunk = chunk[1..]
            next
          when "\\"
            chunk = chunk[1..]
            raise BadPattern, "libo11y: a pattern ends in a backslash" if chunk.empty?
          end
          unless failed
            failed = chunk[0] != name[0]
            name = name[1..]
          end
          chunk = chunk[1..]
        end
        failed ? nil : name
      end

      # Reads a character class after its opening bracket. Returns whether
      # char is in it and the pattern after the closing bracket.
      def match_class(chunk, char)
        negated = chunk.start_with?("^")
        chunk = chunk[1..] if negated
        matched = false
        ranges = 0
        loop do
          return [matched != negated, chunk[1..]] if chunk.start_with?("]") && ranges.positive?

          low, chunk = class_char(chunk)
          high = low
          high, chunk = class_char(chunk[1..]) if chunk[0] == "-"
          matched ||= !char.empty? && low <= char && char <= high
          ranges += 1
        end
      end

      # Reads one character of a class, which a backslash may escape.
      def class_char(chunk)
        raise BadPattern, "libo11y: malformed character class in a pattern" if chunk.empty? || ["-", "]"].include?(chunk[0])

        chunk = chunk[1..] if chunk[0] == "\\"
        raise BadPattern, "libo11y: malformed character class in a pattern" if chunk.empty? || chunk.length == 1

        [chunk[0], chunk[1..]]
      end
    end
  end
end
