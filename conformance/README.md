# Cross-language conformance

Every libo11y implementation must produce exactly the outputs in this
directory. The Go implementation generates them, and each language's own
test suite checks them, so two languages cannot drift apart on these
behaviours.

## `appregistry/`

Application registry cases. Each case is a pair of files:
- `<case>.yaml` is a registry file.
- `<case>.want` is what a validator must make of that file.

A `.want` file holds one of three things:
- `ok <attributes> <namespace>` for a valid registry, such as `ok 5 lor`.
- One violation per line, in the validator's order. Each line has the
  form `<rule_id>: <detail>` or `<rule_id>: attribute <name>: <detail>`,
  as Go's `appregistry.Violation.String()` renders it.
- `parse: <kind>` when the file does not decode. The kinds are:
  - `empty`: no YAML document.
  - `second-document`: more than one document. A trailing `---` counts.
  - `duplicate-key`: a mapping repeats a key.
  - `unknown-key`: a key the schema does not define.
  - `type`: a value of the wrong YAML type.
  - `syntax`: anything else.

  A kind is named rather than quoted, so no case depends on one YAML
  library's error text. When a file has several decode problems, the
  first one the decoder meets wins.

Three Go behaviours are part of the contract:
- **Quoting.** A quoted value in a detail uses Go's `%q` quoting: `\a`
  for U+0007, `\u0085` for U+0085, and printable non-ASCII as is.
- **Whitespace.** "Whitespace" in `libo11y_enum_value_whitespace` is
  Go's `strings.TrimSpace`, the Unicode White_Space property. It includes
  U+0085 and excludes U+FEFF. JavaScript's `trim()` differs on both.
- **Enum values.** An enum value can be any YAML scalar. It reads as its
  source text, so `1.0` stays `1.0`, and null reads as the empty string.

The cases are hand-written. The Go test is
`go/internal/appregistry/conformance_test.go`.

## `vectors/`

Values the Go implementation computes. `go/vectors_internal_test.go`
fails if a committed file differs from what the code produces. After a
deliberate change, regenerate the files:

```sh
cd go && go test -run TestVectors -update-vectors .
```

The flag exists only in the root package, so give it with `.` as shown.
Do not combine it with `./...`.

### `pii-hash.json`

PII tokens under the hash mode. It has two fields:
- `key_hex` is the 32-byte HMAC key.
- Each case has a `name`, a `kind`, an input `value`, the `canonical`
  rendering that is hashed, and the `token`.

The canonical rendering is the one Go's sensitivity policy uses:
- Scalars render as text, with floats in Go's shortest `'g'` form, such as
  `1e-05` and `1.2345675e+06`.
- Byte strings render as standard base64. A `bytes` case gives its input
  as base64 in `value`.
- Arrays and maps render as JSON of their members' canonical forms. Map
  keys are sorted by UTF-8 byte order, so `"10"` comes before `"2"`, and
  U+FF61 comes before U+1F600. A port must not trust `JSON.stringify`'s
  key order or a UTF-16 sort. The JSON escapes characters the way Go's
  `encoding/json` does: `<`, `>` and `&` as `\u003c`, `\u003e` and
  `\u0026`, U+2028 and U+2029 as `\u2028` and `\u2029`, `\b` and `\f`
  as themselves, and other control characters as `\u00XX`.
- The walk is bounded. The root is depth 0, and a node at depth 17 or
  deeper renders as `truncated`. The walk also spends one unit of a
  2048-node budget per node, depth first, in sorted key order. Once the
  budget is gone, every remaining node renders as `truncated`.

The token is `hmac-sha256:` followed by the lowercase hex of the first
16 bytes of HMAC-SHA256 over the UTF-8 canonical rendering.

JavaScript has one number type. An implementation renders a number that
is a safe integer the way Go renders an `int64`, and any other number the
way Go renders a `float64`. Because of that, the `float` cases all have
fractions or lie outside the safe range. Go renders the float `1234567.0`
as `1.234567e+06`, but JavaScript cannot tell it apart from the integer
`1234567`. Two consequences follow:
- Negative zero is a safe integer, so it renders as `0`. Go's `float64`
  gives `-0`.
- JSON cannot hold NaN or the infinities, so no vector covers them. An
  implementation renders them as Go does: `NaN`, `+Inf` and `-Inf`.

### `instance-id.json`

The `service.instance.id` derived from Kubernetes pod identity:
- From the pod UID, it is a UUIDv5 of the UID.
- Otherwise it is a UUIDv5 of `<namespace>/<pod name>`.

The UUIDv5 namespace is `4d63009a-8d0f-11ee-aad7-4c796ed8e320`. With no
pod identity, the ID is a random UUIDv4, so that case has no vector.

### `endpoint-sanitize.json`

How the startup summary reports an OTLP endpoint. It removes userinfo, the
query and the fragment. Anything ambiguous becomes `unparseable`, so a
credential is never echoed. The output is Go's `url.URL.String()`. It
lowercases only the scheme and escapes the path, and it normalizes nothing
else. A WHATWG `URL` parser would lowercase the host, drop default ports,
resolve dot segments and apply IDNA, so a port must not use one.
