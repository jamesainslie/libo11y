# @libo11y/rum-replay

Privacy-first session replay for
[`@libo11y/rum`](https://github.com/jamesainslie/libo11y/tree/main/ts/packages/rum).
It records the page with rrweb's recorder
([`@rrweb/record`](https://www.npmjs.com/package/@rrweb/record) 2.2.2,
pinned exactly) and passes every event through libo11y's own scrubber
before anything is buffered. Text is masked by default, and input values
are never recorded.

## Status

The package first ships in `ts/v0.4.0`, and it releases with
`@libo11y/rum` at the same version. Neither is on npm yet. Until their
first npm publish, install both from the tarballs attached to the
[`ts/v0.4.0` GitHub Release](https://github.com/jamesainslie/libo11y/releases/tag/ts/v0.4.0),
whose notes list the exact URLs:

```sh
npm install \
  https://github.com/jamesainslie/libo11y/releases/download/ts/v0.4.0/libo11y-rum-0.4.0.tgz \
  https://github.com/jamesainslie/libo11y/releases/download/ts/v0.4.0/libo11y-rum-replay-0.4.0.tgz
```

The RUM gateway stores what it uploads from `go/o11yrum/v0.2.0` on, once
an app enables replay; see
[Session replay](../../../go/o11yrum/README.md#session-replay) in the
gateway's README.

## Usage

Installing the collector is the opt-in. It records only while RUM's
consent is `granted`.

```ts
import { errors, setupRum, views } from "@libo11y/rum";
import { replay } from "@libo11y/rum-replay";

const telemetry = await setupRum({
  serviceName: "shop",
  endpoint: "https://rum.example.com",
  consent: { initial: "pending" },
  rum: {
    clientToken: "pub-shop",
    collectors: [views(), errors(), replay({ privacy: { unmask: [".public"] } })],
  },
});
```

| Option              | Default                                      | Meaning                                                                                                                                |
| ------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `sampleRate`        | `1`                                          | The share of head-sampled sessions that record, 0 to 1                                                                                 |
| `onRetain`          | `false`                                      | Also record sessions that are not head-sampled, into memory only, and upload that lead-up if an error or frustration keeps the session |
| `privacy`           | `{}`                                         | `unmask`, `mask` and `block` selectors. See [Privacy model](#privacy-model)                                                            |
| `limits.sampleRate` | `[sampleRate, sampleRate]`                   | The range remote configuration may move `sampleRate` within                                                                            |
| `url`               | `new URL("/_o11y/v1/replay", location.href)` | The gateway's replay endpoint. RUM counts it as its own traffic, so its requests are never instrumented                                |

`replay()` throws `O11yError` with code `INVALID_OPTION` for an invalid
option.

## How it records

- **Which sessions.** A session records when replay is on and
  `fnv1a32("replay:" + session.id) / 2^32` is below `sampleRate`, so every
  tab of a session agrees. A head-sampled session records from its start
  and uploads as it goes. With `onRetain`, a session that is not
  head-sampled records into memory: the last two closed segments and the
  open one. If an error or frustration keeps the session, they upload and
  the rest of the session uploads as it goes. If the session ends unkept,
  they are dropped.
- **rrweb loads lazily.** `replay()` itself adds about 10 KB to the page,
  gzipped. rrweb's recorder, about 24 KB gzipped, is imported with a
  dynamic `import()` the first time a session will record, so a page whose
  session never records never downloads it. Bundlers emit it as a chunk of
  its own. Nothing is recorded until it has loaded. If it fails to load,
  replay stays off for the page, logs one warning and does not retry.
- **Segments.** Each segment is self-contained: it starts with a full
  snapshot, so a player can start at any segment and a lost upload loses
  only its own time. A segment closes after 30 seconds, at 1 MiB or
  10,000 events, when the page hides and when the session changes. An idle
  page sends nothing.
- **Upload.** A segment is gzipped and sent with
  `POST <url>?service=&session=&segment=&sent_at=&client_token=`, without
  credentials and uninstrumented, one at a time and in order. Segment
  numbers count per session across tabs, under a Web Lock. `429` and `503`
  retry after `Retry-After`, at most three attempts, and any other `4xx`
  drops the segment. At most 4 segments and 4 MiB wait to upload; the
  oldest goes first past either bound.
- **Errors point at the replay.** While a session uploads, its
  `o11y.rum.error` and `o11y.rum.frustration` events carry
  `o11y.rum.replay.segment`, the number of the segment being sent or last
  sent.
- **Consent.** Revoking consent stops the recorder, drops everything not
  yet sent and removes the shared segment counter.
- **Where it runs.** Replay records pages and extension pages. It refuses
  to start, with one warning, in an extension content script, which must
  not record the host page, and in a browser without Web Locks or
  `CompressionStream`.

## Privacy model

The scrubber is authoritative. rrweb's own masking options are only a
first line, and the scrubber does not rely on them. Everything is an
allow-list: an event type, incremental source, node field or attribute
the scrubber does not know is dropped, so a new rrweb field cannot leak.
The RUM gateway runs the same rules again before it stores a segment.
Both implementations run the shared vectors in
[`conformance/rum-replay`](../../../conformance/rum-replay).

| What                                                                                           | Recorded as                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text                                                                                           | Masked: every character except ASCII whitespace becomes `*`, so layout survives and content does not                                                                                           |
| Text under a `privacy.unmask` selector                                                         | Kept, unless a mask or block selector also covers it                                                                                                                                           |
| Text under `input`, `textarea`, `select`, `option`, `[contenteditable]` or `[data-o11y-mask]`  | Masked, whatever the unmask list says                                                                                                                                                          |
| Text in a `textarea` or editable content, and links, images and styles inside editable content | Dropped                                                                                                                                                                                        |
| Text in `script`                                                                               | Dropped                                                                                                                                                                                        |
| Comments                                                                                       | Dropped                                                                                                                                                                                        |
| Stylesheets                                                                                    | Kept, with URLs stripped, unless a mask covers them                                                                                                                                            |
| Elements under `[data-o11y-block]` or a `privacy.block` selector                               | Replaced by an empty placeholder of the same size. Nothing added inside them later is recorded                                                                                                 |
| `value`, `checked` and `selected` attributes                                                   | Never recorded                                                                                                                                                                                 |
| `title`, `alt`, `placeholder`, `aria-label`, `label`, `content` and other text attributes      | Masked like text. An unmasked `content` that holds a URL (`og:url`, `og:image`, a refresh) is stripped like a URL attribute                                                                    |
| `href`, `src`, `srcset`, `poster`, `xlink:href`                                                | Path kept, query reduced to RUM's `queryAllowList`, fragment and userinfo removed. Every scheme but `http` and `https` (`data:`, `blob:`, `javascript:`, `mailto:` and the rest) becomes empty |
| `url()`, URL strings and bare URLs in `style` and CSS                                          | Stripped the same way, also in custom properties (`--bg: https://cdn.example/a.png?token=1`)                                                                                                   |
| Every other attribute (`on*` handlers, `data-*`, `srcdoc` and the rest)                        | Removed                                                                                                                                                                                        |
| Input events, canvas, fonts, console logs, custom and plugin events                            | Never recorded                                                                                                                                                                                 |

Rules that cover an element also cover its shadow DOM and the document of
a same-origin iframe it holds. A mask on a shadow host masks the shadow
content, even an element inside it that the unmask list names.

### Unmasking

The unmask list, `privacy.unmask`, is empty by default and is set in code
only. Markup alone never unmasks: an element with `data-o11y-unmask` stays
masked unless the code lists `"[data-o11y-unmask]"`. Precedence is block,
then mask, then unmask, then the default mask.

```ts
import type { ReplayOptions } from "@libo11y/rum-replay";

const options: ReplayOptions = {
  privacy: {
    unmask: [".public", "[data-o11y-unmask]"],
    mask: [".price"],
    block: [".chat-widget"],
  },
};
```

Text the app shows the user can still be personal data. Unmask only parts
of the page that never show it.

### What masking does not cover

Some things the page shows are kept because replay needs them to draw the
page. Block the parts of a page where they carry personal data:

- **SVG geometry** (`d`, `points`, `transform`) is kept, so icons render. A
  signature pad or a drawing that renders to SVG records what the user drew.
  Block it.
- **CSS** is kept with its URLs stripped. A stylesheet or a `style`
  attribute that holds personal data in a string that is not a URL, such
  as a custom property, keeps it. A bare URL is found where a value or a
  word in it starts. One written right after other punctuation
  (`--x:=/a?token=1`), behind an escaped property name, or with a scheme
  outside the web ones (`ssh:`) keeps its query.
- **URL paths** are kept. Only the query and fragment are stripped, so a
  path that holds an email address or an account number keeps it.
- **`id`, `class` and `name`** are kept.

## Remote configuration

The gateway's configuration document may carry a `replay` object. Remote
configuration can only make replay stricter:

| Field             | Effect                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled: false`  | Switches replay off. `true` is ignored                                                                                                                                                     |
| `onRetain: false` | Switches the lead-up buffer off. `true` is ignored                                                                                                                                         |
| `sampleRate`      | Lowers the sample rate, never below the minimum of `limits.sampleRate` set in code and never above the code rate. The default limits are `[sampleRate, sampleRate]`, which allow no change |
| `mask`, `block`   | Selectors added after the fixed and code ones, which stay                                                                                                                                  |
| `unmask`          | Intersected with the code list, so it can only remove selectors                                                                                                                            |

A selector that does not parse is dropped, and so is any field not in the
table.

## Reading recordings back

The gateway serves stored segments on an internal read API, behind a
bearer token, for a player backend to call server side, and erases a
session on request. See
[The read API and erasure](../../../go/o11yrum/README.md#the-read-api-and-erasure).
A stored segment is the uploaded envelope after the gateway's own
scrubbing, with `service`, `session`, `segment`, `stored_at` and
`clock_offset_ms` added. Its `events` replay with
[`@rrweb/replay`](https://www.npmjs.com/package/@rrweb/replay) 2.2.2, and
each segment replays on its own because it starts with a full snapshot.
`make rum-e2e` proves the whole path in Chromium: it records a session,
stores it through a gateway built from the checkout, reads it back with a
token, replays it, and erases it.

## Budgets

- **Size.** `replay()` adds at most 11,264 bytes, gzipped, to the page's
  initial bundle over `setupRum`. The lazily loaded recorder chunk is at
  most 26,368 bytes gzipped. `make ts-size` checks both against
  `ts/size-budget.json`.
- **Main-thread time.** The `ts-bench` workflow measures what replay adds
  over RUM alone, with default options, in Chromium: at most 12 ms of
  main-thread task time per soft navigation and 4 ms per click, on a page
  that swaps 200 nodes per navigation and updates 50 per click. See the
  overhead benchmark in
  [CONVENTIONS.md](../../../docs/CONVENTIONS.md).
