#!/usr/bin/env bash
# ruby-hygiene.sh: fail on debugging leftovers in the Ruby library code.
#
# Usage: ruby-hygiene.sh [DIR]   (DIR defaults to ruby/lib)
#
# It reads every .rb file under DIR, outside generated/ directories, with
# Ruby's own lexer, so a word in a comment, a string, a symbol or a heredoc
# is never a finding. Findings, one line each on stderr as
# FILE:LINE: WHAT in library code:
#   puts, pp               a write to standard output, on any receiver
#   binding.pry, binding.irb, debugger, byebug
#   rescue Exception       it also catches SignalException and SystemExit
# A method defined with one of those names is not a finding. Exits 0 with a
# summary line when there are none, 1 when there are findings or a file does
# not parse, and 2 when DIR is not a directory. Needs ruby.
set -euo pipefail

root="${1:-ruby/lib}"
if [[ ! -d "$root" ]]; then
	echo "ruby-hygiene: $root is not a directory" >&2
	exit 2
fi

ruby -rripper - "$root" <<'RUBY'
root = ARGV.fetch(0)
CALLS = %w[puts pp debugger byebug].freeze
BLANK = %i[on_sp on_ignored_nl on_comment].freeze

# The findings of one file's tokens, as [line, what] pairs.
def findings(tokens)
  code = tokens.reject { |token| BLANK.include?(token[1]) }
  found = []
  code.each_with_index do |(position, type, text), index|
    previous = index.zero? ? nil : code[index - 1]
    following = code[index + 1]
    if type == :on_ident && CALLS.include?(text)
      # Not a call: the name of a method being defined, or a symbol.
      named = previous && ((previous[1] == :on_kw && previous[2] == "def") || previous[1] == :on_symbeg)
      found << [position[0], text] unless named
    elsif type == :on_ident && text == "binding" && following && following[1] == :on_period
      debugger = code[index + 2]
      found << [position[0], "binding.#{debugger[2]}"] if debugger && %w[pry irb].include?(debugger[2])
    elsif type == :on_kw && text == "rescue"
      found << [position[0], "rescue Exception"] if rescues_exception?(code, index + 1)
    end
  end
  found
end

# Whether the rescue clause that starts at index lists ::Exception itself.
# Timeout::Exception is another class.
def rescues_exception?(code, index)
  while (token = code[index])
    _, type, text = token
    return false if %i[on_nl on_semicolon].include?(type) || (type == :on_op && text == "=>") || (type == :on_kw && text == "then")

    if type == :on_const && text == "Exception"
      scope = code[index - 1]
      owner = code[index - 2]
      namespaced = scope && scope[1] == :on_op && scope[2] == "::" && owner && owner[1] == :on_const
      return true unless namespaced
    end
    index += 1
  end
  false
end

failed = false
files = Dir.glob(File.join(root, "**", "*.rb")).reject { |path| path.split(File::SEPARATOR).include?("generated") }.sort
files.each do |path|
  source = File.read(path)
  if Ripper.sexp(source).nil?
    warn "ruby-hygiene: #{path}: does not parse"
    failed = true
    next
  end
  findings(Ripper.lex(source)).each do |line, what|
    warn "ruby-hygiene: #{path}:#{line}: #{what} in library code"
    failed = true
  end
end
exit 1 if failed

puts "ruby-hygiene: no forbidden constructs in #{files.length} files under #{root}"
RUBY
