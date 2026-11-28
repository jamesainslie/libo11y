# @libo11y/rum-replay

Privacy-first session replay for
[`@libo11y/rum`](https://github.com/jamesainslie/libo11y/tree/main/ts/packages/rum).
It records the page with rrweb's recorder
([`@rrweb/record`](https://www.npmjs.com/package/@rrweb/record) 2.2.2,
pinned exactly) and passes every event through libo11y's own scrubber
before anything is buffered. Text is masked by default, and input values
are never recorded.

## Status

The package is in development and has not shipped yet. It is not part of
`ts/v0.3.0` and first ships in the next TypeScript release, at the same
version as `@libo11y/rum`. This version holds the privacy core:
text masking, URL and CSS stripping, the event scrubber, the DOM-backed
scrub context and the remote configuration clamp. The `replay()`
collector, segments and upload come in a later change, so the package
records nothing yet.

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
| `title`, `alt`, `placeholder`, `aria-label`, `label`, `content` and other text attributes      | Masked like text                                                                                                                                                                               |
| `href`, `src`, `srcset`, `poster`, `xlink:href`                                                | Path kept, query reduced to RUM's `queryAllowList`, fragment and userinfo removed. Every scheme but `http` and `https` (`data:`, `blob:`, `javascript:`, `mailto:` and the rest) becomes empty |
| `url()` and URL strings in `style` and CSS                                                     | Stripped the same way                                                                                                                                                                          |
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
  attribute that holds personal data in a string, such as a custom property,
  keeps it.
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
