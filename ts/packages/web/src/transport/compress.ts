/**
 * WP1 (transport). gzip through CompressionStream.
 */

/** True when the runtime has CompressionStream with gzip. */
export function canGzip(): boolean {
  throw new Error("not implemented");
}

/** body gzip-compressed through CompressionStream, or undefined when the runtime cannot. Never rejects. */
export function gzip(body: Uint8Array): Promise<Uint8Array | undefined> {
  void body;
  throw new Error("not implemented");
}
