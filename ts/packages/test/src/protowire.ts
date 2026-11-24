/**
 * A dependency-free protobuf wire decoder for wire types 0 (varint), 1 (64-bit), 2 (length
 * delimited) and 5 (32-bit), driven by a schema table. It decodes into OTLP/JSON-shaped objects,
 * matching how upstream's JSON serializers represent each value:
 * - bytes named as IDs are lowercase hex, other bytes are standard base64;
 * - a "time" (a fixed64 nanosecond timestamp) is a decimal string;
 * - other 64-bit integers are numbers when they are safe integers, else decimal strings;
 * - enums are their numbers, and absent fields are absent (proto3 has no presence for scalars).
 * Unknown fields are skipped. A repeated scalar accepts packed and unpacked encodings, and a
 * singular embedded message seen twice is merged, as protobuf requires.
 */

export const WIRE_VARINT = 0;
export const WIRE_I64 = 1;
export const WIRE_LEN = 2;
export const WIRE_FIXED32 = 5;

/** How a field's value is represented. */
export type FieldType =
  | "string"
  | "bool"
  | "uint32"
  | "int32"
  | "sint32"
  | "uint64"
  | "int64"
  | "fixed32"
  | "fixed64"
  | "sfixed64"
  | "double"
  | "time"
  | "hex"
  | "base64"
  | "message";

/** One field of a message schema. */
export interface FieldSchema {
  /** The OTLP/JSON (lowerCamelCase) name. */
  readonly name: string;
  readonly type: FieldType;
  /** The schema name of an embedded message. */
  readonly message?: string;
  readonly repeated?: boolean;
}

/** A message schema: its fields by field number. */
export type MessageSchema = Readonly<Record<number, FieldSchema>>;

/** Reads protobuf wire format from bytes. */
export class ProtoReader {
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /** Reports whether every byte has been read. */
  done(): boolean {
    return this.pos >= this.buf.length;
  }

  tag(): { field: number; wireType: number } {
    const key = this.varint();
    return { field: Number(key >> 3n), wireType: Number(key & 7n) };
  }

  /** A varint as an unsigned 64-bit value. */
  varint(): bigint {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (this.pos >= this.buf.length) throw new Error("protowire: truncated varint");
      const b = this.buf[this.pos++] as number;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return BigInt.asUintN(64, result);
    }
    throw new Error("protowire: varint longer than 10 bytes");
  }

  private need(n: number, what: string): void {
    if (this.pos + n > this.buf.length) throw new Error(`protowire: truncated ${what}`);
  }

  /** A little-endian 64-bit value, unsigned. */
  fixed64(): bigint {
    this.need(8, "fixed64");
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** A little-endian 64-bit IEEE 754 double. */
  double(): number {
    this.need(8, "double");
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** A little-endian 32-bit value, unsigned. */
  fixed32(): number {
    this.need(4, "fixed32");
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** A length-delimited field's bytes, as a view into the input. */
  bytes(): Uint8Array {
    const n = Number(this.varint());
    this.need(n, "bytes");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Skips one value of wireType. */
  skip(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_I64:
        this.need(8, "fixed64");
        this.pos += 8;
        return;
      case WIRE_LEN:
        this.bytes();
        return;
      case WIRE_FIXED32:
        this.need(4, "fixed32");
        this.pos += 4;
        return;
      default:
        throw new Error(`protowire: unsupported wire type ${wireType}`);
    }
  }
}

/** The wire type a field of type carries when it is not packed. */
function wireTypeOf(type: FieldType): number {
  switch (type) {
    case "fixed64":
    case "sfixed64":
    case "double":
    case "time":
      return WIRE_I64;
    case "fixed32":
      return WIRE_FIXED32;
    case "string":
    case "hex":
    case "base64":
    case "message":
      return WIRE_LEN;
    default:
      return WIRE_VARINT;
  }
}

/** A 64-bit integer as a number when it is safe, else its decimal string. */
function int64Value(v: bigint): number | string {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(v)
    : v.toString();
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += BASE64[(n >> 18) & 63];
    out += BASE64[(n >> 12) & 63];
    out += b === undefined ? "=" : BASE64[(n >> 6) & 63];
    out += c === undefined ? "=" : BASE64[n & 63];
  }
  return out;
}

const UTF8 = new TextDecoder("utf-8");

// scalar reads one non-message value of type, whose wire type has been checked.
function scalar(r: ProtoReader, type: FieldType): unknown {
  switch (type) {
    case "string":
      return UTF8.decode(r.bytes());
    case "hex":
      return hex(r.bytes());
    case "base64":
      return base64(r.bytes());
    case "bool":
      return r.varint() !== 0n;
    case "uint32":
      return Number(BigInt.asUintN(32, r.varint()));
    case "int32":
      return Number(BigInt.asIntN(32, r.varint()));
    case "sint32": {
      const n = Number(BigInt.asUintN(32, r.varint()));
      return (n >>> 1) ^ -(n & 1);
    }
    case "uint64":
      return int64Value(r.varint());
    case "int64":
      return int64Value(BigInt.asIntN(64, r.varint()));
    case "fixed32":
      return r.fixed32();
    case "fixed64":
      return int64Value(r.fixed64());
    case "sfixed64":
      return int64Value(BigInt.asIntN(64, r.fixed64()));
    case "double":
      return r.double();
    case "time":
      return r.fixed64().toString();
    default:
      throw new Error(`protowire: ${type} is not a scalar`);
  }
}

// listOf returns the list out[name] holds, creating it first.
function listOf(out: Record<string, unknown>, name: string): unknown[] {
  const list = out[name];
  if (Array.isArray(list)) return list;
  const created: unknown[] = [];
  out[name] = created;
  return created;
}

/** Decodes bytes as the message schemas[type] describes. */
export function decodeMessage(
  schemas: Readonly<Record<string, MessageSchema>>,
  type: string,
  bytes: Uint8Array,
): Record<string, unknown> {
  const schema = schemas[type];
  if (schema === undefined) throw new Error(`protowire: no schema for ${type}`);
  const out: Record<string, unknown> = {};
  const r = new ProtoReader(bytes);
  while (!r.done()) {
    const { field, wireType } = r.tag();
    const spec = schema[field];
    if (spec === undefined) {
      r.skip(wireType);
      continue;
    }
    const expected = wireTypeOf(spec.type);
    if (spec.repeated === true && wireType === WIRE_LEN && expected !== WIRE_LEN) {
      // A packed run of scalars.
      const run = new ProtoReader(r.bytes());
      const list = listOf(out, spec.name);
      while (!run.done()) list.push(scalar(run, spec.type));
      continue;
    }
    if (wireType !== expected) {
      throw new Error(`protowire: ${type}.${spec.name}: wire type ${wireType}, want ${expected}`);
    }
    let value: unknown;
    if (spec.type === "message") {
      if (spec.message === undefined) throw new Error(`protowire: ${type}.${spec.name}: no message type`);
      value = decodeMessage(schemas, spec.message, r.bytes());
    } else {
      value = scalar(r, spec.type);
    }
    if (spec.repeated === true) {
      listOf(out, spec.name).push(value);
    } else if (spec.type === "message" && typeof out[spec.name] === "object") {
      Object.assign(out[spec.name] as object, value);
    } else {
      out[spec.name] = value;
    }
  }
  return out;
}
