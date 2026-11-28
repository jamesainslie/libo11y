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
  library's error text. A syntax error in the first document wins over
  everything else, and an error in the first document wins over a second
  document. Within the first document, yaml.v3 collects every decode
  problem, and the kinds rank `duplicate-key`, then `unknown-key`, then
  `type`.

Three Go behaviours are part of the contract:
- **Quoting.** A quoted value in a detail uses Go's `%q` quoting: `\a`
  for U+0007, `\u0085` for U+0085, and printable non-ASCII as is.
  "Printable" is Go's `unicode.IsPrint` in the Unicode version of the Go
  toolchain that generated the specification artifacts (Unicode 15.0.0
  for Go 1.26), not the Unicode version of another runtime. specgen
  writes the printable ranges for TypeScript to
  `ts/packages/spec/src/generated/goprint.ts`, for Rust to
  `rust/libo11y-spec/src/generated/goprint.rs` and for Zig to
  `zig/src/spec/generated/goprint.zig`.
- **Whitespace.** "Whitespace" in `libo11y_enum_value_whitespace` is
  Go's `strings.TrimSpace`, the Unicode White_Space property. It includes
  U+0085 and excludes U+FEFF. JavaScript's `trim()` differs on both.
- **Enum values.** An enum value can be any YAML scalar. It reads as its
  source text, so `1.0` stays `1.0`. A null entry is dropped, so
  `values: [~]` declares no values and fails
  `libo11y_app_enum_values_missing`.

The cases are hand-written. The Go test is
`go/internal/appregistry/conformance_test.go`. The Zig suite,
`zig/src/conformance_test.zig`, checks these cases and the vectors below.
`zig build test` reads them from `-Dconformance-dir`, which defaults to
this directory.

## `vectors/`

Values the Go implementation computes. `go/vectors_internal_test.go`
fails if a committed file differs from what the code produces. After a
deliberate change, regenerate the files:

```sh
cd go && go test -run TestVectors -update-vectors .
```

The flag exists only in the root package, so give it with `.` as shown.
Do not combine it with `./...`.

`go/o11yrum` keeps its own vectors, because the gateway is a separate
module. Regenerate them from that module:

```sh
cd go/o11yrum && go test -run TestVectors -update-vectors .
```

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
  A scalar array is one node, and each element is a node of its own. The
  `string array at the walk budget` case has 2047 one-character elements,
  which with the array itself spend the whole budget, so nothing is
  truncated. The `string array past the walk budget` case has 2048, so
  its last element renders as `truncated`.

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

### `rum-view-summary-metrics.json`

The metrics the RUM gateway derives from `o11y.rum.view.summary` events,
as the "Derived metrics" and "Vital ratings" sections of
[SPEC.md](../docs/SPEC.md) define them. The file has four fields:
- `scope` is the instrumentation scope of the derived metrics.
- `bounds` maps a unit to the histogram bucket bounds of the vitals with
  that unit: `s` for LCP, INP, FCP and TTFB, and `1` for CLS. Every rating
  threshold is one of the bounds.
- `thresholds` maps each vital metric to its good and poor bounds.
- `cases` lists the cases.

Each case has these fields:
- `name` describes the case.
- `service` is the `service.name` of the app the gateway admitted the
  request for.
- `resource` holds the resource attributes of the request, including any
  the gateway filled in, such as `o11y.rum.browser.family` and
  `geo.country.iso_code`.
- `summaries` lists the view summaries the request carried, in order.
- `metrics` lists every data point a fresh gateway holds after deriving
  from those summaries.

Summary and resource values are plain JSON. A reader converts each value
to the registry type of its key: `int` keys to integers, `double` keys to
floats, and every other key to a string.

Each metric has a `name`, a `kind` (`sum` or `histogram`), a `unit`, its
`attributes` and a `sum`. A histogram also has `count`, `min`, `max` and
`bucket_counts`, against the bounds for its unit. Points are cumulative.
Bucket `i` holds values above bound `i-1` and at or below bound `i`, and
the last bucket holds values above the last bound.

The rules the cases pin down:
- Every point carries the `service.name` of the app, whatever the
  resource says.
- A metric takes only the labels the specification lists for it. A label
  the summary and resource do not carry is left out, not set empty.
- `o11y.rum.views` counts a summary only when `o11y.rum.summary.seq` is 0.
- Counts of zero and absent counts add no point.
- The gateway computes `o11y.rum.vital.rating`. A value at the good bound
  is `good`, a value at the poor bound is `needs-improvement`, and a value
  above it is `poor`.

Metrics within a case are sorted by name, then by the attribute set's
encoding: `key=value` pairs sorted by key and joined by commas, with any
`,`, `=` or `\` in a value escaped by a backslash. The strings compare
byte by byte.

RUM clients can use the `summaries` arrays as golden view summaries.

## `rum-replay/`

Hand-written session replay scrubbing cases: text masking, URL, srcset and
CSS stripping, and rrweb event lists with the scrubbed output they must
produce. `rum-replay/README.md` describes the format and the two modes the
gateway runs them in. The TypeScript suite is
`ts/packages/rum-replay/src/conformance.test.ts`, and the gateway's Go suite runs
the same files.

## `rum-summary/`

Hand-written view summary timelines and the `o11y.rum.view.summary`
records they must produce. `rum-summary/README.md` describes the format.
The TypeScript suite, `ts/packages/rum/src/summary/conformance.test.ts`,
checks them.
