# frozen_string_literal: true

module Libo11y
  module Internal
    module Endpoint
      WITHHELD = "unparseable"

      HEX_UPPER = "0123456789ABCDEF"
      HOST_OK = "!$&'()*+,;=:<>\"[]"
      GEN_DELIMS = "$&+,/:;=?@"
      UNRESERVED_PUNCT = "-_.~"
      FRAG_OK = "!()*"
      USERINFO_PUNCT = "-._:~!$&'()*+,;=%@"
      VALID_ENC_EXTRA = "!$&'()*+,;=:@[]%"

      HOST_OK_BYTES = HOST_OK.bytes.to_h { |b| [b, true] }.freeze
      GEN_DELIMS_BYTES = GEN_DELIMS.bytes.to_h { |b| [b, true] }.freeze
      UNRESERVED_BYTES = UNRESERVED_PUNCT.bytes.to_h { |b| [b, true] }.freeze
      FRAG_OK_BYTES = FRAG_OK.bytes.to_h { |b| [b, true] }.freeze
      USERINFO_BYTES = USERINFO_PUNCT.bytes.to_h { |b| [b, true] }.freeze
      VALID_ENC_BYTES = VALID_ENC_EXTRA.bytes.to_h { |b| [b, true] }.freeze

      class InvalidURLError < StandardError; end

      ParsedUrl = Struct.new(:scheme, :opaque_text, :has_user, :host, :path, :raw_path, :omit_host)

      module_function

      def alnum?(c)
        c.between?(0x30, 0x39) || c.between?(0x41, 0x5A) || c.between?(0x61, 0x7A)
      end

      def hex?(c)
        c.between?(0x30, 0x39) || c.between?(0x41, 0x46) || c.between?(0x61, 0x66)
      end

      def unhex(c)
        return c - 0x30 if c.between?(0x30, 0x39)
        return c - 0x61 + 10 if c.between?(0x61, 0x66)

        c - 0x41 + 10
      end

      def should_escape?(c, mode)
        return false if alnum?(c)
        return false if %i[host zone].include?(mode) && HOST_OK_BYTES[c]
        return false if UNRESERVED_BYTES[c]

        if GEN_DELIMS_BYTES[c]
          return c == 0x3F if mode == :path
          return [0x40, 0x2F, 0x3F, 0x3A].include?(c) if mode == :user_password

          return mode != :fragment
        end

        !(mode == :fragment && FRAG_OK_BYTES[c])
      end

      def unescape(s, mode)
        n = 0
        i = 0
        len = s.bytesize
        while i < len
          c = s.getbyte(i)
          if c == 0x25
            n += 1
            raise InvalidURLError if i + 2 >= len || !hex?(s.getbyte(i + 1)) || !hex?(s.getbyte(i + 2))

            pct25 = s.byteslice(i, 3) == "%25"
            raise InvalidURLError if mode == :host && unhex(s.getbyte(i + 1)) < 8 && !pct25

            if mode == :zone
              v = (unhex(s.getbyte(i + 1)) << 4) | unhex(s.getbyte(i + 2))
              raise InvalidURLError if !pct25 && v != 0x20 && should_escape?(v, :host)
            end
            i += 3
          else
            raise InvalidURLError if %i[host zone].include?(mode) && c < 0x80 && should_escape?(c, mode)

            i += 1
          end
        end
        return s if n.zero?

        out = String.new(encoding: Encoding::BINARY, capacity: len - (2 * n))
        i = 0
        while i < len
          if s.getbyte(i) == 0x25
            out << ((unhex(s.getbyte(i + 1)) << 4) | unhex(s.getbyte(i + 2)))
            i += 3
          else
            out << s.getbyte(i)
            i += 1
          end
        end
        out
      end

      def escape(s, mode)
        count = 0
        s.each_byte { |c| count += 1 if should_escape?(c, mode) }
        return s if count.zero?

        out = String.new(encoding: Encoding::BINARY, capacity: s.bytesize + (2 * count))
        s.each_byte do |c|
          if should_escape?(c, mode)
            out << 0x25 << HEX_UPPER.getbyte(c >> 4) << HEX_UPPER.getbyte(c & 0x0F)
          else
            out << c
          end
        end
        out
      end

      def valid_encoded?(s, mode)
        s.each_byte do |c|
          next if VALID_ENC_BYTES[c]
          return false if should_escape?(c, mode)
        end
        true
      end

      def valid_optional_port?(port)
        return true if port.empty?
        return false unless port.getbyte(0) == 0x3A

        i = 1
        while i < port.bytesize
          c = port.getbyte(i)
          return false unless c.between?(0x30, 0x39)

          i += 1
        end
        true
      end

      def valid_userinfo?(s)
        s.each_byte do |c|
          return false unless alnum?(c) || USERINFO_BYTES[c]
        end
        true
      end

      def get_scheme(raw)
        i = 0
        len = raw.bytesize
        while i < len
          c = raw.getbyte(i)
          if c.between?(0x41, 0x5A) || c.between?(0x61, 0x7A)
            i += 1
            next
          elsif c.between?(0x30, 0x39) || c == 0x2B || c == 0x2D || c == 0x2E
            return ["".b, raw] if i.zero?

            i += 1
            next
          elsif c == 0x3A
            raise InvalidURLError if i.zero?

            return [raw.byteslice(0, i), raw.byteslice(i + 1, len - i - 1)]
          else
            return ["".b, raw]
          end
        end
        ["".b, raw]
      end

      def valid_ipv4?(s)
        val = 0
        pos = 0
        dig_len = 0
        len = s.bytesize
        i = 0
        while i < len
          c = s.getbyte(i)
          if c.between?(0x30, 0x39)
            return false if dig_len == 1 && val.zero?

            val = (val * 10) + (c - 0x30)
            dig_len += 1
            return false if val > 255
          elsif c == 0x2E
            return false if i.zero? || i == len - 1 || s.getbyte(i - 1) == 0x2E
            return false if pos == 3

            pos += 1
            val = 0
            dig_len = 0
          else
            return false
          end
          i += 1
        end
        pos == 3
      end

      def parse_ipv6?(data)
        s = data
        pct = s.index("%".b)
        if pct
          return false if pct + 1 == s.bytesize

          s = s.byteslice(0, pct)
        end
        ellipsis = nil
        if s.bytesize >= 2 && s.getbyte(0) == 0x3A && s.getbyte(1) == 0x3A
          ellipsis = 0
          s = s.byteslice(2, s.bytesize - 2)
          return true if s.empty?
        end
        i = 0
        while i < 16
          off = 0
          acc = 0
          while off < s.bytesize
            c = s.getbyte(off)
            break unless hex?(c)

            acc = (acc << 4) + unhex(c)
            return false if off > 3 || acc > 0xFFFF

            off += 1
          end
          return false if off.zero?

          if off < s.bytesize && s.getbyte(off) == 0x2E
            return false if ellipsis.nil? && i != 12
            return false if i + 4 > 16 || !valid_ipv4?(s)

            s = "".b
            i += 4
            break
          end
          i += 2
          s = s.byteslice(off, s.bytesize - off)
          break if s.empty?
          return false if s.getbyte(0) != 0x3A || s.bytesize == 1

          s = s.byteslice(1, s.bytesize - 1)
          next unless s.getbyte(0) == 0x3A
          return false unless ellipsis.nil?

          ellipsis = i
          s = s.byteslice(1, s.bytesize - 1)
          break if s.empty?
        end
        return false unless s.empty?

        (i < 16) == !ellipsis.nil?
      end

      def ipv6_literal?(s)
        s.each_byte do |c|
          return false if [0x2E, 0x25].include?(c)
          return parse_ipv6?(s) if c == 0x3A
        end
        false
      end

      def parse_host(scheme, host)
        open_idx = host.rindex("[".b)
        if open_idx
          raise InvalidURLError if open_idx.positive?

          close_idx = host.rindex("]".b)
          raise InvalidURLError unless close_idx

          colon_port = host.byteslice(close_idx + 1, host.bytesize - close_idx - 1)
          raise InvalidURLError unless valid_optional_port?(colon_port)

          port = unescape(colon_port, :host)
          hostname = host.byteslice(1, close_idx - 1)
          zone = hostname.index("%25".b)
          unescaped = if zone
                        unescape(hostname.byteslice(0, zone), :host) +
                          unescape(hostname.byteslice(zone, hostname.bytesize - zone), :zone)
                      else
                        unescape(hostname, :host)
                      end
          raise InvalidURLError unless ipv6_literal?(unescaped)

          return "[".b + unescaped + "]".b + port
        end

        first = host.index(":".b)
        if first
          idx = first
          last = host.rindex(":".b)
          idx = last if last != first && scheme != "http" && scheme != "https"
          raise InvalidURLError unless valid_optional_port?(host.byteslice(idx, host.bytesize - idx))
        end
        unescape(host, :host)
      end

      def parse_authority(url, authority)
        at = authority.rindex("@".b)
        host_part = at ? authority.byteslice(at + 1, authority.bytesize - at - 1) : authority
        url.host = parse_host(url.scheme, host_part)
        return unless at

        userinfo = authority.byteslice(0, at)
        raise InvalidURLError unless valid_userinfo?(userinfo)

        colon = userinfo.index(":".b)
        if colon
          unescape(userinfo.byteslice(0, colon), :user_password)
          unescape(userinfo.byteslice(colon + 1, userinfo.bytesize - colon - 1), :user_password)
        else
          unescape(userinfo, :user_password)
        end
        url.has_user = true
      end

      def parse_reference(raw)
        raw.each_byte { |c| raise InvalidURLError if c < 0x20 || c == 0x7F }
        url = ParsedUrl.new("", "".b, false, "".b, "".b, "".b, false)
        if raw == "*".b
          url.path = "*".b
          return url
        end
        scheme_bytes, rest = get_scheme(raw)
        url.scheme = scheme_bytes.force_encoding(Encoding::US_ASCII).downcase
        if rest.end_with?("?".b) && rest.count("?".b) == 1
          rest = rest.byteslice(0, rest.bytesize - 1)
        elsif (q = rest.index("?".b))
          rest = rest.byteslice(0, q)
        end
        unless rest.start_with?("/".b)
          unless url.scheme.empty?
            url.opaque_text = rest
            return url
          end
          slash = rest.index("/".b)
          segment = slash ? rest.byteslice(0, slash) : rest
          raise InvalidURLError if segment.include?(":".b)
        end
        if (!url.scheme.empty? || !rest.start_with?("///".b)) && rest.start_with?("//".b)
          authority = rest.byteslice(2, rest.bytesize - 2)
          rest = "".b
          if (slash = authority.index("/".b))
            rest = authority.byteslice(slash, authority.bytesize - slash)
            authority = authority.byteslice(0, slash)
          end
          parse_authority(url, authority)
        elsif !url.scheme.empty? && rest.start_with?("/".b)
          url.omit_host = true
        end
        url.path = unescape(rest, :path)
        escaped = escape(url.path, :path)
        url.raw_path = rest == escaped ? "".b : rest
        url
      end

      def parse(raw)
        h = raw.index("#".b)
        url = parse_reference(h ? raw.byteslice(0, h) : raw)
        unescape(raw.byteslice(h + 1, raw.bytesize - h - 1), :fragment) if h && h + 1 < raw.bytesize
        url
      end

      def escaped_path(url)
        if !url.raw_path.empty? && valid_encoded?(url.raw_path, :path)
          begin
            p = unescape(url.raw_path, :path)
          rescue InvalidURLError
            p = nil
          end
          return url.raw_path if p == url.path
        end
        return "*".b if url.path == "*".b

        escape(url.path, :path)
      end

      def format_url(url)
        out = "".b
        out << url.scheme.b << ":".b unless url.scheme.empty?
        unless url.opaque_text.empty?
          out << url.opaque_text
          return out
        end
        if (!url.scheme.empty? || !url.host.empty?) && !(url.omit_host && url.host.empty?)
          out << "//".b if !url.host.empty? || !url.path.empty?
          out << escape(url.host, :host) unless url.host.empty?
        end
        path = escaped_path(url)
        out << "/".b if !path.empty? && path.getbyte(0) != 0x2F && !url.host.empty?
        if out.empty?
          slash = path.index("/".b)
          segment = slash ? path.byteslice(0, slash) : path
          out << "./".b if segment.include?(":".b)
        end
        out << path
        out
      end

      def sanitize(raw)
        sanitize_bytes(raw.to_s.encode(Encoding::UTF_8).b)
      end

      def sanitize_bytes(raw)
        schemeless = !raw.include?("://".b)
        data = schemeless ? "//".b + raw : raw
        begin
          url = parse(data)
        rescue InvalidURLError
          return WITHHELD
        end
        return WITHHELD if url.host.empty?

        ats = data.count("@".b)
        return WITHHELD if ats > 1 || (ats == 1 && !url.has_user)

        out = format_url(url)
        return WITHHELD if out.include?("@".b)

        out = out.byteslice(2, out.bytesize - 2) if schemeless && out.start_with?("//".b)
        out.force_encoding(Encoding::US_ASCII)
      end
    end
  end
end
