# frozen_string_literal: true

require "spec_helper"

# The cases are the table of Go's path/match_test.go. A nil result is
# path.ErrBadPattern.
RSpec.describe Libo11y::Internal::PathMatch do
  cases = [
    ["abc", "abc", true], ["*", "abc", true], ["*c", "abc", true], ["a*", "a", true], ["a*", "abc", true],
    ["a*", "ab/c", false], ["a*/b", "abc/b", true], ["a*/b", "a/c/b", false],
    ["a*b*c*d*e*/f", "axbxcxdxe/f", true], ["a*b*c*d*e*/f", "axbxcxdxexxx/f", true],
    ["a*b*c*d*e*/f", "axbxcxdxe/xxx/f", false], ["a*b*c*d*e*/f", "axbxcxdxexxx/fff", false],
    ["a*b?c*x", "abxbbxdbxebxczzx", true], ["a*b?c*x", "abxbbxdbxebxczzy", false],
    ["ab[c]", "abc", true], ["ab[b-d]", "abc", true], ["ab[e-g]", "abc", false], ["ab[^c]", "abc", false],
    ["ab[^b-d]", "abc", false], ["ab[^e-g]", "abc", true], ["a\\*b", "a*b", true], ["a\\*b", "ab", false],
    ["a?b", "a☺b", true], ["a[^a]b", "a☺b", true], ["a???b", "a☺b", false], ["a[^a][^a][^a]b", "a☺b", false],
    ["[a-ζ]*", "α", true], ["*[a-ζ]", "A", false], ["a?b", "a/b", false], ["a*b", "a/b", false],
    ["[\\]a]", "]", true], ["[\\-]", "-", true], ["[x\\-]", "x", true], ["[x\\-]", "-", true], ["[x\\-]", "z", false],
    ["[\\-x]", "x", true], ["[\\-x]", "-", true], ["[\\-x]", "a", false],
    ["[]a]", "]", nil], ["[-]", "-", nil], ["[x-]", "x", nil], ["[x-]", "-", nil], ["[x-]", "z", nil],
    ["[-x]", "x", nil], ["[-x]", "-", nil], ["[-x]", "a", nil], ["\\", "a", nil], ["[a-b-c]", "a", nil],
    ["[", "a", nil], ["[^", "a", nil], ["[^bc", "a", nil], ["a[", "a", nil], ["a[", "ab", nil], ["a[", "x", nil],
    ["a/b[", "x", nil], ["*x", "xxx", true]
  ].freeze

  cases.each do |pattern, name, want|
    it "matches #{pattern.inspect} against #{name.inspect} as Go does" do
      if want.nil?
        expect { described_class.match?(pattern, name) }.to raise_error(described_class::BadPattern)
      else
        expect(described_class.match?(pattern, name)).to be(want)
      end
    end
  end

  it "gives two stars the meaning of one, so they stay within a path segment" do
    expect(described_class.match?("/a/**/z", "/a/b/c/z")).to be(false)
    expect(described_class.match?("/a/**/z", "/a/b/z")).to be(true)
    expect(described_class.match?("/**", "/a/b")).to be(false)
  end

  it "treats a malformed pattern as one that never matches, in an ignore list" do
    expect(Libo11y::Rack.match_glob?("/health[", "/health[")).to be(false)
    expect(Libo11y::Rack.match_glob?("/*", "/.well-known")).to be(true)
    expect(Libo11y::Rack.match_glob?("/a/**/z", "/a/b/c/z")).to be(false)
  end
end
