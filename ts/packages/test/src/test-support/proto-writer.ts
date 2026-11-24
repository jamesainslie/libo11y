/**
 * A minimal protobuf writer for the tests: it builds payloads the upstream serializers never emit,
 * such as exemplars and wire-type edge cases. Test-only: the build excludes src/test-support, and the
 * package decodes, it never encodes.
 */
/** Writes protobuf wire format into a growing byte array. */
export class ProtoWriter {
  private readonly out: number[] = [];

  tag(field: number, wireType: number): this {
    return this.varint(BigInt((field << 3) | wireType));
  }

  /** Writes v as a varint; a negative v is written as its 64-bit two's complement. */
  varint(v: bigint): this {
    let n = BigInt.asUintN(64, v);
    while (n > 0x7fn) {
      this.out.push(Number(n & 0x7fn) | 0x80);
      n >>= 7n;
    }
    this.out.push(Number(n));
    return this;
  }

  fixed64(v: bigint): this {
    let n = BigInt.asUintN(64, v);
    for (let i = 0; i < 8; i++) {
      this.out.push(Number(n & 0xffn));
      n >>= 8n;
    }
    return this;
  }

  fixed32(v: number): this {
    for (let i = 0; i < 4; i++) this.out.push((v >>> (8 * i)) & 0xff);
    return this;
  }

  double(v: number): this {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) this.out.push(view.getUint8(i));
    return this;
  }

  bytes(b: Uint8Array): this {
    this.varint(BigInt(b.length));
    this.out.push(...b);
    return this;
  }

  string(s: string): this {
    return this.bytes(new TextEncoder().encode(s));
  }

  /** Writes a length-delimited embedded message built by fn. */
  message(fn: (w: ProtoWriter) => void): this {
    const inner = new ProtoWriter();
    fn(inner);
    return this.bytes(inner.finish());
  }

  /** Writes a packed repeated run built by fn. */
  packed(fn: (w: ProtoWriter) => void): this {
    return this.message(fn);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}
