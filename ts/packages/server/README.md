# @libo11y/server

The libo11y server platform for TypeScript on Bun and Node. It supplies
what `@libo11y/core` needs from a server runtime: an `AsyncLocalStorage`
context manager, resource detection, OTLP exporters built from the
`OTEL_*` variables, and the protobuf metric serializer that carries
exemplars.

```sh
npm install @libo11y/server
```

## Context

`createContextManager()` returns OpenTelemetry's `AsyncLocalStorage`
context manager. On Bun 1.3.x it loses the active context in three places:

- an async generator used as a `Bun.serve` response body
  ([oven-sh/bun#24199](https://github.com/oven-sh/bun/issues/24199));
  use a `ReadableStream` body instead;
- a thenable returned from an async function after an `await`
  ([oven-sh/bun#34266](https://github.com/oven-sh/bun/issues/34266));
- `unhandledRejection` listeners
  ([oven-sh/bun#40223](https://github.com/oven-sh/bun/issues/40223)).
