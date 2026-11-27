# RUM view summary vectors

Hand-written cases for the `o11y.rum.view.summary` event (spec 1.3.0). Each
file drives a view summary accumulator through a timeline and lists the
summary records it must emit, in order.

A file is a JSON object:

```json
{
  "description": "what the case pins",
  "platform": "web",
  "steps": [],
  "want": []
}
```

Each step has `at`, the `performance.now()` value at the step in
milliseconds, and `do`, one of:

| `do` | Fields | Meaning |
|---|---|---|
| `open` | `view: { id, name, kind, sessionId }` | Track the view as the current view. |
| `close` | `viewId` | Send the view's summary and stop its clock. |
| `count` | `key`, optional `n` (default 1) | Add to a count of the current view, such as `errors.uncaught` or `requests`. |
| `vital` | `viewId`, `name`, `value` | Record a vital of a view (`lcp`, `inp`, `cls`, `fcp` or `ttfb`). |
| `hide` | | The page is hidden, then every view with unsent data is flushed. |
| `show` | | The page is visible again. |
| `flush` | | Flush every view with unsent data. |

The page starts visible. Each `want` entry is the full attribute set of one
summary record. A key that is absent must not be on the record: a zero count
is omitted.

The rules the vectors pin:
- A view emits on `close`, and on a flush when it has never emitted, or has
  a nonzero count, unsent visible time or an unsent vital.
- Counts and `o11y.rum.summary.time_on_view` are deltas since the view's
  previous summary. `o11y.rum.summary.seq` starts at 0 and increments per
  summary of the view.
- Time on view runs only while the page is visible.
- A vital is accepted once per view and name. It goes out in the next
  summary of that view, even after the view closed.

Times are seconds with no rounding beyond IEEE doubles. Consumers compare
numbers with a tolerance of 1e-9.

The TypeScript suite is the first consumer:
`ts/packages/rum/src/summary/conformance.test.ts`. The RUM gateway's
aggregator tests read the `want` records as input.
