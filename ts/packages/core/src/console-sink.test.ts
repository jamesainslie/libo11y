import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsoleSink, formatJsonLine, formatTextLine, goQuoteText, rfc3339Nano } from "./console-sink.ts";

const TIME = new Date(Date.UTC(2026, 10, 24, 12, 34, 56, 120));

test("rfc3339Nano trims trailing zeros as Go's RFC3339Nano does", () => {
  assert.equal(rfc3339Nano(TIME), "2026-11-24T12:34:56.12Z");
  assert.equal(rfc3339Nano(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 0))), "2026-01-02T03:04:05Z");
  assert.equal(rfc3339Nano(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 7))), "2026-01-02T03:04:05.007Z");
});

test("the JSON line has Go's key order: time, level, msg, trace_id, span_id, then attributes", () => {
  const line = formatJsonLine({
    time: TIME,
    level: "info",
    msg: "hello",
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    attributes: { b: 1, a: "x" },
  });
  assert.equal(
    line,
    '{"time":"2026-11-24T12:34:56.12Z","level":"INFO","msg":"hello","trace_id":"0af7651916cd43dd8448eb211c80319c","span_id":"b7ad6b7169203331","b":1,"a":"x"}',
  );
});

test("JSON values: groups nest, bytes are base64, bigints decimal strings, non-finite floats strings", () => {
  const line = formatJsonLine({
    time: TIME,
    level: "warn",
    msg: "m",
    attributes: {
      g: { k: "v", n: { deep: true } },
      empty: {},
      bytes: Uint8Array.of(1, 2, 3),
      big: 12345678901234567890n,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      ninf: Number.NEGATIVE_INFINITY,
      f: 1.5,
      tiny: 1e-7,
      huge: 1e21,
      negzero: -0,
      nil: null,
      list: [1, "two", { three: 3 }],
      err: new TypeError("boom"),
    },
  });
  assert.equal(
    line,
    '{"time":"2026-11-24T12:34:56.12Z","level":"WARN","msg":"m","g":{"k":"v","n":{"deep":true}},"bytes":"AQID",' +
      '"big":"12345678901234567890","nan":"NaN","inf":"+Inf","ninf":"-Inf","f":1.5,"tiny":1e-7,"huge":1e+21,' +
      '"negzero":0,"nil":null,"list":[1,"two",{"three":3}],"err":"TypeError: boom"}',
  );
});

test("JSON strings are escaped as slog escapes them, without HTML escaping", () => {
  const line = formatJsonLine({
    time: TIME,
    level: "info",
    msg: 'a"b\\c\nd\re\tf\u0001g h<&>\u007f\ud800',
    attributes: {},
  });
  assert.equal(
    line,
    '{"time":"2026-11-24T12:34:56.12Z","level":"INFO","msg":"a\\"b\\\\c\\nd\\re\\tf\\u0001g\\u2028h<&>\u007f\\ufffd"}',
  );
});

test("the text line is logfmt with slog's quoting and dotted groups", () => {
  const line = formatTextLine({
    time: TIME,
    level: "error",
    msg: "hello world",
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    attributes: {
      plain: "v",
      spaced: "a b",
      eq: "a=b",
      g: { k: 1.5, n: { x: true } },
      nil: null,
      f: 1e21,
      big: 7n,
    },
  });
  assert.equal(
    line,
    'time=2026-11-24T12:34:56.120Z level=ERROR msg="hello world" trace_id=0af7651916cd43dd8448eb211c80319c ' +
      'span_id=b7ad6b7169203331 plain=v spaced="a b" eq="a=b" g.k=1.5 g.n.x=true nil=<nil> f=1e+21 big=7',
  );
});

test("goQuoteText quotes only what slog quotes, as strconv.Quote does", () => {
  assert.equal(goQuoteText("abc"), "abc");
  assert.equal(goQuoteText(""), '""');
  assert.equal(goQuoteText("a\\b"), "a\\b");
  assert.equal(goQuoteText('a"b'), '"a\\"b"');
  assert.equal(goQuoteText("tab\there"), '"tab\\there"');
  assert.equal(goQuoteText("\u0001"), '"\\x01"');
  assert.equal(goQuoteText("café"), "café");
  assert.equal(goQuoteText("nb sp"), '"nb\\u00a0sp"');
  assert.equal(goQuoteText("\u{e0001}"), '"\\U000e0001"');
});

test("ConsoleSink writes one line per record and propagates write errors", () => {
  const lines: string[] = [];
  new ConsoleSink("json", (l) => lines.push(l)).write({
    time: TIME,
    level: "debug",
    msg: "x",
    attributes: {},
  });
  assert.deepEqual(lines, ['{"time":"2026-11-24T12:34:56.12Z","level":"DEBUG","msg":"x"}']);
  const failing = new ConsoleSink("text", () => {
    throw new Error("stdout closed");
  });
  assert.throws(
    () => failing.write({ time: TIME, level: "info", msg: "x", attributes: {} }),
    /stdout closed/,
  );
});
