/**
 * WP1 (transport). gzip through CompressionStream.
 */

type CompressionStreamCtor = new (format: "gzip") => CompressionStream;

function compressionStream(): CompressionStreamCtor | undefined {
  const ctor = (globalThis as { CompressionStream?: CompressionStreamCtor }).CompressionStream;
  return typeof ctor === "function" ? ctor : undefined;
}

/** True when the runtime has CompressionStream with gzip. */
export function canGzip(): boolean {
  const Ctor = compressionStream();
  if (Ctor === undefined) return false;
  try {
    new Ctor("gzip");
    return true;
  } catch {
    return false;
  }
}

/** body gzip-compressed through CompressionStream, or undefined when the runtime cannot. Never rejects. */
export async function gzip(body: Uint8Array): Promise<Uint8Array | undefined> {
  const Ctor = compressionStream();
  if (Ctor === undefined) return undefined;
  try {
    const stream = new Blob([body as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new Ctor("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return undefined;
  }
}
