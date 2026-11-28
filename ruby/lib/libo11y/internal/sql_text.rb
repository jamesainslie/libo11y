# frozen_string_literal: true

module Libo11y
  module Internal
    # SQL statement text for telemetry: a lexer that removes every literal and
    # comment, and a summary of the statement's operation and table. It is a
    # port of go/o11ysql/internal/sqltext and works on bytes as that does, so
    # both give the same text for the same statement.
    module SqlText
      DIALECTS = %i[standard mysql sqlite].freeze
      MAX_COLLECTION_BYTES = 128
      MAX_QUERY_TEXT_BYTES = 4096

      OPERATIONS = Set.new(
        %w[
          SELECT INSERT UPDATE DELETE MERGE REPLACE UPSERT CREATE ALTER DROP TRUNCATE CALL EXEC EXECUTE
          BEGIN COMMIT ROLLBACK SAVEPOINT RELEASE PRAGMA VACUUM ANALYZE EXPLAIN SHOW SET
        ]
      ).freeze
      UPDATE_CLAUSE = Set.new(%w[FOR KEY DO THEN OR BEFORE AFTER OF]).freeze
      TABLE_MODIFIERS = Set.new(%w[ONLY LOW_PRIORITY IGNORE]).freeze

      QUOTE = "'".ord
      DQUOTE = '"'.ord
      BACKTICK = "`".ord
      BACKSLASH = "\\".ord
      DOLLAR = "$".ord
      DOT = ".".ord
      STAR = "*".ord
      SLASH = "/".ord
      DASH = "-".ord
      HASH = "#".ord
      COLON = ":".ord
      QUESTION = "?".ord
      LPAREN = "(".ord
      RPAREN = ")".ord
      LBRACKET = "[".ord
      RBRACKET = "]".ord
      BANG = "!".ord
      PLUS = "+".ord
      AT = "@".ord
      UNDERSCORE = "_".ord
      NEWLINE = "\n".ord
      SPACE = " ".ord
      private_constant :QUOTE, :DQUOTE, :BACKTICK, :BACKSLASH, :DOLLAR, :DOT, :STAR, :SLASH, :DASH, :HASH, :COLON,
                       :QUESTION, :LPAREN, :RPAREN, :LBRACKET, :RBRACKET, :BANG, :PLUS, :AT, :UNDERSCORE, :NEWLINE, :SPACE

      module_function

      # Returns query with every literal replaced by "?" and every comment by
      # one space. Names, placeholders and operators stay. The result has the
      # encoding of query, and bytes that are not UTF-8 pass through as part
      # of a name.
      def sanitize(query, dialect = :standard)
        raise ArgumentError, "libo11y: unknown SQL dialect #{dialect.inspect}" unless DIALECTS.include?(dialect)

        s = query.b
        out = +"".b
        mysql = dialect == :mysql
        sqlite = dialect == :sqlite
        pg = !mysql && !sqlite
        in_versioned = false # inside a MySQL /*! ... */ comment, whose body is SQL
        i = 0
        n = s.bytesize
        while i < n
          c = s.getbyte(i)
          nx = s.getbyte(i + 1)
          if c == QUOTE
            i, = skip_quoted(s, i, QUOTE, mysql)
            out << "?"
          elsif pg && [69, 101].include?(c) && nx == QUOTE # E'...' escape string
            i, = skip_quoted(s, i + 1, QUOTE, true)
            out << "?"
          elsif c == DQUOTE && !pg
            i, = skip_quoted(s, i, DQUOTE, mysql)
            out << "?"
          elsif c == DQUOTE || (c == BACKTICK && !pg) || (c == LBRACKET && sqlite)
            finish, closed = skip_quoted_name(s, i)
            # An unterminated name may hold anything.
            out << (closed ? s.byteslice(i, finish - i) : "?")
            i = finish
          elsif (c == DASH && nx == DASH && (!mysql || mysql_dash_comment?(s, i))) || (c == HASH && mysql)
            i = skip_line(s, i)
            out << " "
          elsif c == SLASH && nx == STAR
            finish = mysql ? skip_versioned_open(s, i) : nil
            if finish
              in_versioned = true
              i = finish
            else
              i = skip_block(s, i, pg)
            end
            out << " "
          elsif in_versioned && c == STAR && nx == SLASH
            in_versioned = false
            i += 2
            out << " "
          elsif pg && c == DOLLAR
            finish = skip_dollar_quoted(s, i)
            if finish
              out << "?"
            else
              finish = skip_digits(s, i + 1) # $1 placeholder, or a lone $
              out << s.byteslice(i, finish - i)
            end
            i = finish
          elsif sqlite && [DOLLAR, AT, COLON, HASH].include?(c)
            finish, plain = skip_sqlite_parameter(s, i)
            out << if finish == i + 1
                     c.chr # no name follows, so not a parameter
                   elsif plain
                     s.byteslice(i, finish - i)
                   else
                     "?" # a $name(...) suffix may hold anything
                   end
            i = finish
          elsif sqlite && c == QUESTION
            finish = skip_digits(s, i + 1) # ?1 placeholder
            out << s.byteslice(i, finish - i)
            i = finish
          elsif ident_start?(c) || (mysql && c == DOLLAR)
            finish = skip_ident(s, i)
            out << s.byteslice(i, finish - i)
            i = finish
          elsif digit?(c) || (c == DOT && digit?(nx))
            i = skip_number(s, i)
            out << "?"
          else
            out << c.chr
            i += 1
          end
        end
        out.force_encoding(query.encoding)
      end

      # Returns [operation, collection] for sanitized statement text. The
      # operation is the first keyword, upper case, when it is a known one.
      # The collection is the one table the statement names, and is empty for
      # a join of different tables, a subquery, or a table function. Both are
      # empty when the statement starts with anything else.
      def summarize(sanitized)
        toks = tokenize(sanitized.b)
        return ["", ""] if toks.empty?

        operation = toks[0].upcase.force_encoding(Encoding::UTF_8)
        return ["", ""] unless OPERATIONS.include?(operation)
        return [operation, ""] if operation == "SHOW"

        subquery = [] # per open parenthesis: whether it holds a subquery
        collection = ""
        last = toks.length
        (0...(last - 1)).each do |k|
          tok = toks[k]
          if tok == "("
            subquery << %w[SELECT WITH].include?(toks[k + 1].upcase)
            next
          elsif tok == ")"
            subquery.pop
            next
          end
          next if !subquery.empty? && !subquery.last # inside a call or a column list

          keyword = tok.upcase
          next unless names_table?(keyword, toks, k)

          j = k + 1
          j = skip_if_exists(toks, j) if keyword == "TABLE"
          j += 2 if keyword == "UPDATE" && toks[j].casecmp?("OR") # SQLite's UPDATE OR IGNORE t
          j += 1 while j < last && TABLE_MODIFIERS.include?(toks[j].upcase)
          # A subquery or something unrecognized.
          return [operation, ""] if j >= last || !name_start?(toks[j].getbyte(0))
          # A list of tables, or a table function.
          return [operation, ""] if j + 1 < last && (toks[j + 1] == "," || (toks[j + 1] == "(" && %w[FROM JOIN].include?(keyword)))

          name = unquote_name(toks[j])
          return [operation, ""] if !collection.empty? && collection != name

          collection = name
        end
        return [operation, ""] if collection.bytesize > MAX_COLLECTION_BYTES

        [operation, String.new(collection, encoding: Encoding::UTF_8).scrub]
      end

      # Returns the longest prefix of text that has at most max_bytes bytes
      # and ends on a character boundary. Cutting sanitized text cannot expose
      # a literal, because every literal is already gone.
      def truncate(text, max_bytes = MAX_QUERY_TEXT_BYTES)
        return text if text.bytesize <= max_bytes

        cut = max_bytes
        cut -= 1 while cut.positive? && (text.getbyte(cut) & 0xC0) == 0x80
        text.byteslice(0, cut)
      end

      def names_table?(keyword, toks, k)
        prev = k.positive? ? toks[k - 1].upcase : ""
        case keyword
        when "JOIN", "INTO", "TABLE" then true
        when "FROM" then prev != "DISTINCT" # a IS DISTINCT FROM b compares values
        when "UPDATE" then !UPDATE_CLAUSE.include?(prev)
        else false
        end
      end

      def skip_if_exists(toks, j)
        last = toks.length
        return j if j >= last || !toks[j].casecmp?("IF")

        j += 1
        j += 1 if j < last && toks[j].casecmp?("NOT")
        return j + 1 if j < last && toks[j].casecmp?("EXISTS")

        last
      end

      def unquote_name(tok)
        return tok.dup unless tok.include?('"') || tok.include?("`")

        out = +"".b
        i = 0
        n = tok.bytesize
        while i < n
          q = tok.getbyte(i)
          if q != DQUOTE && q != BACKTICK
            out << q.chr
            i += 1
            next
          end
          finish, closed = skip_quoted(tok, i, q, false)
          inner = tok.byteslice(i + 1, (closed ? finish - 1 : finish) - (i + 1))
          out << inner.gsub(q.chr * 2, q.chr)
          i = finish
        end
        out
      end

      def tokenize(s)
        toks = []
        i = 0
        n = s.bytesize
        while i < n
          c = s.getbyte(i)
          if [SPACE, 9, 10, 13].include?(c)
            i += 1
          elsif name_start?(c)
            finish = skip_name(s, i)
            toks << s.byteslice(i, finish - i)
            i = finish
          else
            toks << c.chr
            i += 1
          end
        end
        toks
      end

      def skip_name(s, i)
        n = s.bytesize
        loop do
          c = s.getbyte(i)
          i = if [DQUOTE, BACKTICK].include?(c)
                skip_quoted(s, i, c, false).first
              else
                skip_ident(s, i)
              end
          return i unless i + 1 < n && s.getbyte(i) == DOT && name_start?(s.getbyte(i + 1))

          i += 1
        end
      end

      def name_start?(c)
        ident_start?(c) || c == DQUOTE || c == BACKTICK
      end

      def ident_start?(c)
        return false if c.nil?

        c == UNDERSCORE || c.between?(97, 122) || c.between?(65, 90) || c >= 0x80
      end

      def ident_part?(c)
        ident_start?(c) || digit?(c)
      end

      def ident_cont?(c)
        ident_part?(c) || c == DOLLAR
      end

      def digit?(c)
        !c.nil? && c.between?(48, 57)
      end

      def space?(c)
        [SPACE, 9, 10, 12, 13].include?(c)
      end

      def skip_ident(s, i)
        i += 1
        n = s.bytesize
        i += 1 while i < n && ident_cont?(s.getbyte(i))
        i
      end

      def skip_digits(s, i)
        n = s.bytesize
        i += 1 while i < n && digit?(s.getbyte(i))
        i
      end

      # Returns the index after the literal that opens at i, and whether it
      # was closed. A doubled quote is an escaped quote. With backslash, a
      # backslash escapes the next byte.
      def skip_quoted(s, i, quote, backslash)
        n = s.bytesize
        j = i + 1
        while j < n
          c = s.getbyte(j)
          if c == BACKSLASH
            j += 1 if backslash
          elsif c == quote
            return [j + 1, true] unless j + 1 < n && s.getbyte(j + 1) == quote

            j += 1
          end
          j += 1
        end
        [n, false]
      end

      def skip_quoted_name(s, i)
        return skip_quoted(s, i, s.getbyte(i), false) unless s.getbyte(i) == LBRACKET

        close = s.index("]".b, i + 1)
        close ? [close + 1, true] : [s.bytesize, false]
      end

      # MySQL reads -- as a comment only before whitespace or a control byte.
      def mysql_dash_comment?(s, i)
        return true if i + 2 >= s.bytesize

        c = s.getbyte(i + 2)
        c <= SPACE || c == 0x7f
      end

      def skip_line(s, i)
        s.index("\n".b, i) || s.bytesize
      end

      def skip_block(s, i, nested)
        depth = 0
        j = i
        n = s.bytesize
        while j + 1 < n
          a = s.getbyte(j)
          b = s.getbyte(j + 1)
          if a == SLASH && b == STAR && (nested || depth.zero?)
            depth += 1
            j += 2
          elsif a == STAR && b == SLASH
            depth -= 1
            j += 2
            return j if depth.zero?
          else
            j += 1
          end
        end
        n
      end

      # Returns the index after a MySQL /*!12345 or MariaDB /*M!12345 opener,
      # or nil when the comment at i is an ordinary one.
      def skip_versioned_open(s, i)
        j = i + 2
        j += 1 if s.getbyte(j) == 77
        return nil unless s.getbyte(j) == BANG

        skip_digits(s, j + 1)
      end

      # Returns the index after the dollar-quoted string that opens at i, or
      # nil when the $ opens none. An unterminated one runs to the end.
      def skip_dollar_quoted(s, i)
        n = s.bytesize
        j = i + 1
        if j < n && ident_start?(s.getbyte(j))
          j += 1
          j += 1 while j < n && ident_part?(s.getbyte(j))
        end
        return nil unless s.getbyte(j) == DOLLAR

        tag = s.byteslice(i, j + 1 - i)
        close = s.index(tag, j + 1)
        close ? close + tag.bytesize : n
      end

      # Returns the index after the SQLite parameter that opens at i, and
      # whether it is a plain name. A $name(...) suffix is not plain.
      def skip_sqlite_parameter(s, i)
        n = s.bytesize
        j = i + 1
        count = 0
        while j < n
          c = s.getbyte(j)
          if ident_cont?(c)
            count += 1
            j += 1
          elsif c == LPAREN && count.positive?
            j += 1
            j += 1 while j < n && s.getbyte(j) != RPAREN && !space?(s.getbyte(j))
            j += 1 if s.getbyte(j) == RPAREN
            return [j, false]
          elsif c == COLON && s.getbyte(j + 1) == COLON
            j += 2
          else
            break
          end
        end
        count.zero? ? [i + 1, true] : [j, true]
      end

      def skip_number(s, i)
        hex = s.getbyte(i) == 48 && [120, 88].include?(s.getbyte(i + 1))
        n = s.bytesize
        i += 1
        while i < n
          c = s.getbyte(i)
          exponent = [101, 69].include?(c)
          # 1E'...' is a number and then an escape string.
          return i if !hex && exponent && s.getbyte(i + 1) == QUOTE

          signed = [PLUS, DASH].include?(c) && [101, 69].include?(s.getbyte(i - 1)) && digit?(s.getbyte(i + 1))
          return i unless ident_part?(c) || c == DOT || signed

          i += 1
        end
        i
      end
    end
  end
end
