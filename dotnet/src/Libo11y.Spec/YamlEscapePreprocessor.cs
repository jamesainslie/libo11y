using System.Globalization;
using System.Text;

namespace Libo11y.Spec;

/// <summary>
/// Brings double-quoted scalars in line with go-yaml v3 before YamlDotNet
/// reads the text. YamlDotNet accepts the YAML 1.2 escape <c>\/</c>, which
/// go-yaml rejects, and rejects <c>\'</c>, which go-yaml accepts as an
/// apostrophe. It also accepts a <c>\u</c> escape that names a surrogate.
/// </summary>
/// <remarks>
/// The rewrite must act only inside real double-quoted scalars, so this
/// scanner tracks the lexical context of every character: between tokens,
/// a plain scalar, a single-quoted or double-quoted scalar, a literal or
/// folded block scalar, and a comment. It does not validate the YAML.
/// Text that is not valid YAML is left for the parser to reject, and only
/// what valid YAML means has to come out right.
/// </remarks>
internal static class YamlEscapePreprocessor
{
    private enum Context
    {
        Between,
        Plain,
        SingleQuoted,
        DoubleQuoted,
        Comment,
        BlockScalar,
    }

    /// <summary>
    /// Returns <paramref name="text"/> with go-yaml's double-quoted escape
    /// rules applied.
    /// </summary>
    /// <param name="text">The YAML text.</param>
    /// <returns>The text YamlDotNet should parse.</returns>
    /// <exception cref="YamlV3SyntaxException">A double-quoted scalar holds an escape go-yaml rejects.</exception>
    public static string Rewrite(string text) => new Scanner(text).Run();

    private static bool IsBreak(char c) => c is '\n' or '\r' or '\u0085' or '\u2028' or '\u2029';

    private static bool IsBlank(char c) => c is ' ' or '\t';

    private static bool IsFlowIndicator(char c) => c is ',' or '[' or ']' or '{' or '}';

    private sealed class Scanner(string text)
    {
        private readonly StringBuilder _out = new(text.Length);
        private readonly int _len = text.Length;
        private int _i;

        private Context _ctx = Context.Between;
        private int _flowDepth;

        // The current line: where it starts and how many spaces indent it.
        private bool _atLineStart = true;
        private int _lineStart;
        private int _lineIndent;

        // Whether the current document has a node yet. A block scalar or a
        // plain scalar at the document root has no parent indentation.
        private bool _docHasContent;

        // The column of the block collection the next node belongs to: the
        // column of the last "-" or "?" indicator, or of the key before the
        // last ":" indicator, on this line.
        private int _collectionColumn = -1;
        private bool _nodeStartPending = true;
        private int _nodeStartColumn;

        // A block scalar ends at the first non-blank line indented no more
        // than this.
        private int _blockIndent;

        // A plain scalar that reached a line break continues on the next
        // non-blank line if that line is indented more than this (in block
        // context), or does not start with a flow indicator (in flow context).
        private bool _plainPending;
        private int _plainIndent;

        // The previous token was a quoted scalar or a closed flow collection,
        // after which ":" is a value indicator even without a following space.
        private bool _afterJsonLike;

        private bool InFlow => _flowDepth > 0;

        private int Column => _i - _lineStart;

        private char At(int index) => index < _len ? text[index] : '\0';

        private bool EndsToken(int index) => index >= _len || IsBlank(text[index]) || IsBreak(text[index]);

        public string Run()
        {
            while (_i < _len)
            {
                if (_atLineStart)
                {
                    _atLineStart = false;
                    if (StartLine())
                    {
                        continue;
                    }
                }

                char ch = text[_i];
                if (IsBreak(ch))
                {
                    Break();
                    continue;
                }

                switch (_ctx)
                {
                    case Context.Comment:
                        Copy();
                        break;
                    case Context.BlockScalar:
                        Copy();
                        break;
                    case Context.SingleQuoted:
                        SingleQuoted(ch);
                        break;
                    case Context.DoubleQuoted:
                        DoubleQuoted(ch);
                        break;
                    case Context.Plain:
                        Plain(ch);
                        break;
                    default:
                        Between(ch);
                        break;
                }
            }
            return _out.ToString();
        }

        private void Copy()
        {
            _out.Append(text[_i]);
            _i++;
        }

        private void Break()
        {
            char ch = text[_i];
            Copy();
            if (ch == '\r' && At(_i) == '\n')
            {
                Copy();
            }
            _atLineStart = true;
            _lineStart = _i;

            switch (_ctx)
            {
                case Context.Comment:
                    _ctx = Context.Between;
                    break;
                case Context.Plain:
                    _ctx = Context.Between;
                    _plainPending = true;
                    break;
            }
        }

        private bool IsDocumentMarker(int index) =>
            index == _lineStart &&
            index + 2 < _len &&
            ((text[index] == '-' && text[index + 1] == '-' && text[index + 2] == '-') ||
             (text[index] == '.' && text[index + 1] == '.' && text[index + 2] == '.')) &&
            EndsToken(index + 3);

        // StartLine runs at the first character of every line. It returns
        // true when it consumed the whole line.
        private bool StartLine()
        {
            _lineIndent = 0;
            while (At(_lineStart + _lineIndent) == ' ')
            {
                _lineIndent++;
            }
            int first = _lineStart;
            while (first < _len && IsBlank(text[first]))
            {
                first++;
            }
            bool blank = first >= _len || IsBreak(text[first]);
            bool marker = IsDocumentMarker(_lineStart);

            if (_ctx == Context.BlockScalar)
            {
                if (!marker && (blank || _lineIndent > _blockIndent))
                {
                    while (_i < _len && !IsBreak(text[_i]))
                    {
                        Copy();
                    }
                    return true;
                }
                _ctx = Context.Between;
            }

            if (_ctx != Context.Between)
            {
                return false;
            }

            _nodeStartPending = true;
            _collectionColumn = _lineIndent - 1;

            if (_plainPending && !blank)
            {
                _plainPending = false;
                char c = text[first];
                bool continues;
                if (c == '#' || marker)
                {
                    continues = false;
                }
                else if (InFlow)
                {
                    continues = !IsFlowIndicator(c) && !(c == ':' && (EndsToken(first + 1) || IsFlowIndicator(At(first + 1))));
                }
                else
                {
                    continues = _lineIndent > _plainIndent;
                }
                if (continues)
                {
                    while (_i < first)
                    {
                        Copy();
                    }
                    _ctx = Context.Plain;
                }
            }
            return false;
        }

        private void StartNode()
        {
            if (_nodeStartPending)
            {
                _nodeStartPending = false;
                _nodeStartColumn = Column;
            }
        }

        private void Between(char ch)
        {
            if (IsBlank(ch))
            {
                Copy();
                return;
            }

            if (Column == 0 && IsDocumentMarker(_i))
            {
                Copy();
                Copy();
                Copy();
                _flowDepth = 0;
                _docHasContent = false;
                _plainPending = false;
                _nodeStartPending = true;
                _collectionColumn = -1;
                _afterJsonLike = false;
                return;
            }

            bool jsonLike = _afterJsonLike;
            _afterJsonLike = false;

            switch (ch)
            {
                case '#':
                    _ctx = Context.Comment;
                    Copy();
                    return;
                case '%' when Column == 0 && !_docHasContent:
                    // A directive line: nothing in it is a scalar.
                    _ctx = Context.Comment;
                    Copy();
                    return;
                case '"':
                    StartNode();
                    _docHasContent = true;
                    _ctx = Context.DoubleQuoted;
                    Copy();
                    return;
                case '\'':
                    StartNode();
                    _docHasContent = true;
                    _ctx = Context.SingleQuoted;
                    Copy();
                    return;
                case '[' or '{':
                    StartNode();
                    _docHasContent = true;
                    _flowDepth++;
                    Copy();
                    return;
                case ']' or '}':
                    _flowDepth = Math.Max(0, _flowDepth - 1);
                    _afterJsonLike = true;
                    Copy();
                    return;
                case ',':
                    Copy();
                    return;
                case '!' or '&' or '*':
                    StartNode();
                    if (ch == '*')
                    {
                        _docHasContent = true;
                    }
                    while (_i < _len && !EndsToken(_i) && !(InFlow && IsFlowIndicator(text[_i])))
                    {
                        Copy();
                    }
                    return;
                case '-' or '?' when EndsToken(_i + 1):
                    _docHasContent = true;
                    if (!InFlow)
                    {
                        _collectionColumn = Column;
                        _nodeStartPending = true;
                    }
                    Copy();
                    return;
                case ':' when EndsToken(_i + 1) || (InFlow && (jsonLike || IsFlowIndicator(At(_i + 1)))):
                    _docHasContent = true;
                    if (!InFlow)
                    {
                        _collectionColumn = _nodeStartPending ? Column : _nodeStartColumn;
                        _nodeStartPending = false;
                    }
                    Copy();
                    return;
                case '|' or '>' when !InFlow && IsBlockScalarHeader(_i):
                    _blockIndent = _docHasContent ? _collectionColumn : -1;
                    _ctx = Context.BlockScalar;
                    Copy();
                    return;
            }

            StartNode();
            _plainIndent = _docHasContent ? _collectionColumn : -1;
            _docHasContent = true;
            _ctx = Context.Plain;
            Copy();
        }

        // IsBlockScalarHeader reports whether the rest of the line at index
        // is a block scalar header: "|" or ">", optional chomping and
        // indentation indicators, then blanks and an optional comment.
        private bool IsBlockScalarHeader(int index)
        {
            int j = index + 1;
            int indicators = 0;
            while (j < _len && indicators < 2 && (text[j] is '-' or '+' || text[j] is >= '1' and <= '9'))
            {
                j++;
                indicators++;
            }
            return EndsToken(j);
        }

        private void Plain(char ch)
        {
            if (IsBlank(ch) && At(_i + 1) == '#')
            {
                _ctx = Context.Between;
                return;
            }
            if (ch == ':' && (EndsToken(_i + 1) || (InFlow && IsFlowIndicator(At(_i + 1)))))
            {
                _ctx = Context.Between;
                return;
            }
            if (InFlow && IsFlowIndicator(ch))
            {
                _ctx = Context.Between;
                return;
            }
            Copy();
        }

        private void SingleQuoted(char ch)
        {
            Copy();
            if (ch != '\'')
            {
                return;
            }
            if (At(_i) == '\'')
            {
                Copy();
                return;
            }
            _ctx = Context.Between;
            _afterJsonLike = true;
        }

        private void DoubleQuoted(char ch)
        {
            if (ch == '"')
            {
                Copy();
                _ctx = Context.Between;
                _afterJsonLike = true;
                return;
            }
            if (ch != '\\')
            {
                Copy();
                return;
            }
            if (_i + 1 >= _len)
            {
                throw new YamlV3SyntaxException("unterminated escape in double-quoted scalar");
            }
            char next = text[_i + 1];
            if (next == '/')
            {
                throw new YamlV3SyntaxException("found unknown escape character '/'");
            }
            if (next == '\'')
            {
                _out.Append('\'');
                _i += 2;
                return;
            }
            if (next == 'u' && _i + 5 < _len)
            {
                var hex = text.AsSpan(_i + 2, 4);
                if (int.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out int cp) &&
                    cp >= 0xD800 && cp <= 0xDFFF)
                {
                    throw new YamlV3SyntaxException("found invalid Unicode character escape code");
                }
            }
            Copy();
            if (!IsBreak(next))
            {
                // The escaped character is copied as is. An escaped line
                // break is left for Break, which tracks the new line.
                Copy();
            }
        }
    }
}
