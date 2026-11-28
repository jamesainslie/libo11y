# frozen_string_literal: true

require "spec_helper"
require "timeout"
require_relative "support/sql_text_cases"

# The sanitize and summarize vectors are the table tests of
# go/o11ysql/internal/sqltext/sqltext_test.go, byte for byte.
RSpec.describe Libo11y::Internal::SqlText do
  describe ".sanitize" do
    SqlTextCases::SANITIZE_CASES.each do |name, input, want, dialect|
      it "handles #{name} (#{dialect})" do
        expect(described_class.sanitize(input, dialect)).to eq(want)
      end
    end

    it "keeps bytes that are not UTF-8 without raising" do
      input = "SELECT \xFF FROM t WHERE a = 'x'".b
      expect(described_class.sanitize(input, :standard).b).to eq("SELECT \xFF FROM t WHERE a = ?".b)
    end

    it "rejects an unknown dialect" do
      expect { described_class.sanitize("SELECT 1", :oracle) }.to raise_error(ArgumentError, /unknown SQL dialect/)
    end
  end

  describe ".summarize" do
    SqlTextCases::SUMMARIZE_CASES.each do |input, operation, collection|
      it "summarizes #{input.inspect}" do
        expect(described_class.summarize(input)).to eq([operation, collection])
      end
    end

    it "returns UTF-8 text for a table name outside ASCII" do
      operation, collection = described_class.summarize("SELECT * FROM café")
      expect([operation, collection]).to eq(%w[SELECT café])
      expect([operation.encoding, collection.encoding]).to eq([Encoding::UTF_8, Encoding::UTF_8])
    end

    it "drops a collection name longer than 128 bytes" do
      expect(described_class.summarize("SELECT * FROM #{"t" * 200}")).to eq(["SELECT", ""])
    end

    it "takes linear time on a long run of TABLE IF" do
      query = "CREATE#{" TABLE IF" * 50_000} EXISTS t"
      Timeout.timeout(5) { described_class.summarize(query) }
    end
  end

  describe ".truncate" do
    it "returns text within the limit unchanged" do
      expect(described_class.truncate("SELECT ?", 4096)).to eq("SELECT ?")
    end

    it "cuts on a character boundary" do
      text = "é" * 3000
      cut = described_class.truncate(text, 4096)
      expect(cut.bytesize).to eq(4096)
      expect(cut).to be_valid_encoding
      expect(described_class.truncate("aé", 2)).to eq("a")
    end
  end

  # Go's property test: a marker planted in any literal or comment never
  # survives sanitizing, whatever special characters surround it.
  describe "literals and comments" do
    marker = "SECRET"
    noise = ["a", "Z", " ", "'", '"', "`", "\\", "-", "/", "*", "$", "#", "\n", ":", "?", "1", "e", "é", "(", ";", "*/", "/*", "--",
             "$t$", "[", "]"].freeze

    body = lambda do |rng|
      n = rng.rand(8)
      at = rng.rand(n + 1)
      out = +""
      (0..n).each do |i|
        out << marker if i == at
        out << noise[rng.rand(noise.length)] if i < n
      end
      out
    end

    quoted = lambda do |rng, quote, backslash|
      s = body.call(rng)
      s = s.gsub("\\") { "\\\\" } if backslash
      escape = backslash && rng.rand(2).zero? ? "\\#{quote}" : quote * 2
      "#{quote}#{s.gsub(quote) { escape }}#{quote}"
    end

    literal_for = {
      standard: lambda do |rng|
        case rng.rand(3)
        when 0 then quoted.call(rng, "'", false)
        when 1 then "E#{quoted.call(rng, "'", true)}"
        else
          tag = ["$$", "$t$", "$tag_1$"][rng.rand(3)]
          inner = body.call(rng)
          inner = body.call(rng) while inner.include?(tag) || (tag == "$$" && inner.end_with?("$"))
          "#{tag}#{inner}#{tag}"
        end
      end,
      mysql: lambda do |rng|
        quoted.call(rng, ["'", '"'][rng.rand(2)], true)
      end,
      sqlite: lambda do |rng|
        quoted.call(rng, ["'", '"'][rng.rand(2)], false)
      end
    }.freeze

    literal_for.each do |dialect, literal|
      it "removes every #{dialect} string literal" do
        rng = Random.new(20_261_128)
        2000.times do
          lit = literal.call(rng)
          query = "SELECT a FROM t WHERE b = #{lit} AND c = 1"
          got = described_class.sanitize(query, dialect)
          expect(got).not_to include(marker), "#{query.inspect} sanitized to #{got.inspect}"
        end
      end

      it "removes every #{dialect} line comment" do
        rng = Random.new(20_261_129)
        500.times do
          text = body.call(rng).delete("\n")
          query = "SELECT a -- #{text}\nFROM t"
          got = described_class.sanitize(query, dialect)
          expect(got).not_to include(marker), "#{query.inspect} sanitized to #{got.inspect}"
        end
      end
    end
  end
end
