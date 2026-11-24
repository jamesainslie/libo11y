import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { sanitizeEndpoint } from "./sanitize-endpoint.ts";

const vectors = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "..", "..", "..", "..", "conformance", "vectors", "endpoint-sanitize.json"),
    "utf8",
  ),
) as { in: string; want: string }[];

for (const v of vectors) {
  test(`sanitize: ${JSON.stringify(v.in)}`, () => {
    assert.equal(sanitizeEndpoint(v.in), v.want);
  });
}

// Further cases checked against Go 1.26's net/url (go run with url.Parse and the same steps).
test("sanitize follows Go's parser on hosts, ports and escapes", () => {
  const cases: [string, string][] = [
    ["https://[fe80::1%25en0]:4318/v1", "https://[fe80::1%25en0]:4318/v1"],
    ["https://[::ffff:10.0.0.1]/", "https://[::ffff:10.0.0.1]/"],
    ["https://[10.0.0.1]/", "unparseable"],
    ["https://[::1/", "unparseable"],
    ["https://x[::1]/", "unparseable"],
    ["https://host:43a8", "unparseable"],
    ["https://host:1:2", "unparseable"],
    ["otel://host:1:2", "otel://host:1:2"],
    ["https://host:", "https://host:"],
    ["https://ho%41st", "unparseable"],
    ["https://ho%C3%BCst/", "https://ho%C3%BCst/"],
    ["https://host/%7e%2Fa", "https://host/%7e%2Fa"],
    ["https://host/a?b#c", "https://host/a"],
    ["https://host/#%zz", "unparseable"],
    ["https://host/\u0007", "unparseable"],
    ["https://host/a%zz", "unparseable"],
    ["https:/path-only", "https:/path-only"],
    ["mailto:someone", "unparseable"],
    ["/relative", "unparseable"],
    ["https://user@", "unparseable"],
    ["https://us er:p@host", "unparseable"],
    ["https://u%zz:p@host", "unparseable"],
    ["HtTp://Host:80/", "http://Host:80/"],
    ["host:4317/v1/traces", "host:4317/v1/traces"],
    ["https://host/a:b", "https://host/a:b"],
    ["https://host/a;b,c=d\u0026e", "https://host/a;b,c=d\u0026e"],
    ["https://[::1%25]/", "unparseable"],
    ["https://[1::2::3]/", "unparseable"],
    ["https://[1:2:3:4:5:6:7:8:9]/", "unparseable"],
    ["https://[::1.2.3.4]/", "https://[::1.2.3.4]/"],
    ["https://[1:2:3:4:5:6:1.2.3.4]/", "https://[1:2:3:4:5:6:1.2.3.4]/"],
    ["https://[1:2:3:4:5:6:7:1.2.3.4]/", "unparseable"],
    ["https://[::01.2.3.4]/", "unparseable"],
    ["https://[12345::]/", "unparseable"],
    ["https://[1:2:3:4:5:6:7::]/", "https://[1:2:3:4:5:6:7::]/"],
    ["https://[1:2:3:4:5:6:7:8::]/", "unparseable"],
    ["https://[::]/", "https://[::]/"],
    ["https://[:1]/", "unparseable"],
    ["https://[1:]/", "unparseable"],
    ["https://[fe80::1%25%41]/", "https://[fe80::1%25A]/"],
    ["https://[fe80::1%25en%200]/", "https://[fe80::1%25en%200]/"],
    ["a b:1", "unparseable"],
    ["//x", "unparseable"],
    ["x:1/a:b", "x:1/a:b"],
    ["https://host/a%2fb%20c", "https://host/a%2fb%20c"],
    ["https://host/é", "https://host/%C3%A9"],
    ["https://host/%e9", "https://host/%e9"],
    ["https://host/*", "https://host/*"],
    ["*", "*"],
    ["https://host:80:", "unparseable"],
    ["h:1:2", "h:1:2"],
    ["https://[::1]x", "unparseable"],
  ];
  for (const [input, want] of cases) assert.equal(sanitizeEndpoint(input), want, input);
});
