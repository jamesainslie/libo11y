import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMessage, type MessageSchema, ProtoReader, WIRE_FIXED32, WIRE_LEN } from "./protowire.ts";
import { ProtoWriter } from "./test-support/proto-writer.ts";

test("the reader decodes varints, fixed widths and length-delimited fields", () => {
  const w = new ProtoWriter();
  w.tag(1, 0).varint(300n);
  w.tag(2, 1).fixed64(0x0102030405060708n);
  w.tag(3, 5).fixed32(0xdeadbeef);
  w.tag(4, 2).bytes(new Uint8Array([7, 8, 9]));
  const r = new ProtoReader(w.finish());
  assert.deepEqual(r.tag(), { field: 1, wireType: 0 });
  assert.equal(r.varint(), 300n);
  assert.deepEqual(r.tag(), { field: 2, wireType: 1 });
  assert.equal(r.fixed64(), 0x0102030405060708n);
  assert.deepEqual(r.tag(), { field: 3, wireType: WIRE_FIXED32 });
  assert.equal(r.fixed32(), 0xdeadbeef);
  assert.deepEqual(r.tag(), { field: 4, wireType: WIRE_LEN });
  assert.deepEqual([...r.bytes()], [7, 8, 9]);
  assert.equal(r.done(), true);
});

test("the reader refuses truncated input and unknown wire types", () => {
  assert.throws(() => new ProtoReader(new Uint8Array([0x80])).varint(), /protowire: truncated varint/);
  assert.throws(() => new ProtoReader(new Uint8Array([1, 2, 3])).fixed64(), /protowire: truncated fixed64/);
  assert.throws(() => new ProtoReader(new Uint8Array([5, 1])).bytes(), /protowire: truncated bytes/);
  assert.throws(() => new ProtoReader(new Uint8Array([0x0b])).skip(3), /protowire: unsupported wire type 3/);
});

const POINT: MessageSchema = {
  1: { name: "name", type: "string" },
  2: { name: "time", type: "time" },
  3: { name: "count", type: "fixed64" },
  4: { name: "signed", type: "int64" },
  5: { name: "zigzag", type: "sint32" },
  6: { name: "ratio", type: "double" },
  7: { name: "id", type: "hex" },
  8: { name: "blob", type: "base64" },
  9: { name: "on", type: "bool" },
  10: { name: "counts", type: "fixed64", repeated: true },
  11: { name: "bounds", type: "double", repeated: true },
  12: { name: "child", type: "message", message: "child" },
  13: { name: "children", type: "message", message: "child", repeated: true },
  14: { name: "flags", type: "fixed32" },
  15: { name: "small", type: "uint32" },
  16: { name: "signed64", type: "sfixed64" },
  17: { name: "varints", type: "uint64", repeated: true },
};
const SCHEMAS: Readonly<Record<string, MessageSchema>> = {
  point: POINT,
  child: { 1: { name: "v", type: "uint32" } },
};

test("decodeMessage maps fields onto their names and OTLP/JSON representations", () => {
  const w = new ProtoWriter();
  w.tag(1, 2).string("p");
  w.tag(2, 1).fixed64(1_700_000_000_123_456_789n);
  w.tag(3, 1).fixed64(2n ** 60n);
  w.tag(4, 0).varint(-5n);
  w.tag(5, 0).varint(3n); // zigzag 3 is -2
  w.tag(6, 1).double(0.25);
  w.tag(7, 2).bytes(new Uint8Array([0x0a, 0xf7]));
  w.tag(8, 2).bytes(new Uint8Array([104, 105]));
  w.tag(9, 0).varint(1n);
  w.tag(10, 2).packed((p) => p.fixed64(1n).fixed64(2n));
  w.tag(10, 1).fixed64(3n); // an unpacked element after a packed run
  w.tag(11, 2).packed((p) => p.double(0.5).double(1));
  w.tag(12, 2).message((m) => m.tag(1, 0).varint(7n));
  w.tag(13, 2).message((m) => m.tag(1, 0).varint(1n));
  w.tag(13, 2).message(() => {});
  w.tag(14, 5).fixed32(257);
  w.tag(15, 0).varint(9n);
  w.tag(16, 1).fixed64(2n ** 64n - 3n);
  w.tag(17, 2).packed((p) => p.varint(1n).varint(300n));
  w.tag(99, 2).string("unknown fields are skipped");
  w.tag(98, 5).fixed32(1);
  w.tag(97, 1).fixed64(1n);
  w.tag(96, 0).varint(1n);
  assert.deepEqual(decodeMessage(SCHEMAS, "point", w.finish()), {
    name: "p",
    time: "1700000000123456789",
    count: "1152921504606846976",
    signed: -5,
    zigzag: -2,
    ratio: 0.25,
    id: "0af7",
    blob: "aGk=",
    on: true,
    counts: [1, 2, 3],
    bounds: [0.5, 1],
    child: { v: 7 },
    children: [{ v: 1 }, {}],
    flags: 257,
    small: 9,
    signed64: -3,
    varints: [1, 300],
  });
});

test("a repeated singular message merges, as protobuf requires", () => {
  const w = new ProtoWriter();
  w.tag(12, 2).message((m) => m.tag(1, 0).varint(1n));
  w.tag(12, 2).message(() => {});
  assert.deepEqual(decodeMessage(SCHEMAS, "point", w.finish()), { child: { v: 1 } });
});

test("a field with the wrong wire type is refused", () => {
  const w = new ProtoWriter();
  w.tag(1, 0).varint(1n);
  assert.throws(() => decodeMessage(SCHEMAS, "point", w.finish()), /protowire: point\.name: wire type 0/);
});

test("the test writer encodes varints and fixed widths little-endian", () => {
  assert.deepEqual([...new ProtoWriter().varint(300n).finish()], [0xac, 0x02]);
  assert.equal(new ProtoWriter().varint(-1n).finish().length, 10);
  assert.deepEqual([...new ProtoWriter().fixed32(1).finish()], [1, 0, 0, 0]);
  assert.deepEqual([...new ProtoWriter().tag(2, 2).string("a").finish()], [0x12, 1, 0x61]);
});

const MERGING: Readonly<Record<string, MessageSchema>> = {
  node: {
    1: { name: "a", type: "uint32" },
    2: { name: "list", type: "uint32", repeated: true },
    3: { name: "child", type: "message", message: "node" },
    4: { name: "s", type: "string", oneof: "v" },
    5: { name: "n", type: "uint32", oneof: "v" },
    6: { name: "m", type: "message", message: "node", oneof: "v" },
  },
};

test("the last member of a oneof wins", () => {
  const w = new ProtoWriter();
  w.tag(4, 2).string("first");
  w.tag(5, 0).varint(5n);
  assert.deepEqual(decodeMessage(MERGING, "node", w.finish()), { n: 5 });
  w.tag(6, 2).message((m) => m.tag(1, 0).varint(1n));
  w.tag(6, 2).message((m) => m.tag(2, 0).varint(2n));
  assert.deepEqual(decodeMessage(MERGING, "node", w.finish()), { m: { a: 1, list: [2] } });
  w.tag(4, 2).string("last");
  assert.deepEqual(decodeMessage(MERGING, "node", w.finish()), { s: "last" });
});

test("a repeated occurrence of a singular message merges: lists append, scalars last-wins, recursively", () => {
  const w = new ProtoWriter();
  w.tag(3, 2).message((m) => {
    m.tag(1, 0).varint(1n);
    m.tag(2, 0).varint(1n);
    m.tag(3, 2).message((c) => c.tag(1, 0).varint(5n));
    m.tag(4, 2).string("x");
  });
  w.tag(3, 2).message((m) => {
    m.tag(1, 0).varint(3n);
    m.tag(2, 0).varint(2n);
    m.tag(3, 2).message((c) => c.tag(2, 0).varint(9n));
    m.tag(5, 0).varint(7n);
  });
  assert.deepEqual(decodeMessage(MERGING, "node", w.finish()), {
    child: { a: 3, list: [1, 2], child: { a: 5, list: [9] }, n: 7 },
  });
});

function nested(depth: number): Uint8Array {
  let inner = new ProtoWriter().tag(1, 0).varint(1n).finish();
  for (let i = 1; i < depth; i++) inner = new ProtoWriter().tag(3, 2).bytes(inner).finish();
  return inner;
}

test("messages may nest 100 deep, and deeper is refused", () => {
  assert.doesNotThrow(() => decodeMessage(MERGING, "node", nested(100)));
  assert.throws(
    () => decodeMessage(MERGING, "node", nested(101)),
    /protowire: messages nested deeper than 100/,
  );
});

test("field number 0 is refused", () => {
  assert.throws(
    () => decodeMessage(MERGING, "node", new Uint8Array([0x02, 0])),
    /protowire: invalid field number 0/,
  );
});
