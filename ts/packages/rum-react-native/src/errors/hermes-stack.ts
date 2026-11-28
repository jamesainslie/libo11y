/**
 * Hermes stacks rewritten for symbolication (decision N12). A frame in the app's JavaScript bundle
 * names a path that changes per install and per update (Documents/.expo-internal/<asset> for an
 * EAS Update, the app container for the embedded bundle), so its file becomes the platform's fixed
 * bundle URL, under which `@libo11y/sourcemaps` uploads each map with the update ID; the gateway's
 * source map key (service.version, update ID, script path) then needs no change. A bytecode frame
 * ("address at <file>:1:<offset>") carries a 0-based bytecode offset, which the .hbc.map maps as a
 * 0-based column; the gateway looks columns up 1-based, so the offset gains 1. Development server
 * URLs, native frames, Hermes's own InternalBytecode.js and every line that is not a frame are
 * left alone.
 */

/** The URL every frame in the app's bundle gets, per Platform.OS. */
export const BUNDLE_URLS: Readonly<Record<string, string>> = Object.freeze({
  ios: "app:///main.jsbundle",
  android: "app:///index.android.bundle",
});

/** The bundle URL of a platform, or undefined for one without a Hermes bundle (web). */
export function bundleUrlOf(os: string): string | undefined {
  return Object.hasOwn(BUNDLE_URLS, os) ? BUNDLE_URLS[os] : undefined;
}

/**
 * The mapStack of a platform: stacks rewritten to its bundle URL, or undefined where it has none.
 * A rewrite that throws leaves the stack as it was, because RUM's core calls it unguarded.
 */
export function stackMapperOf(os: string): ((stack: string) => string) | undefined {
  const url = bundleUrlOf(os);
  if (url === undefined) return undefined;
  return (stack) => {
    try {
      return mapHermesStack(stack, url);
    } catch {
      return stack;
    }
  };
}

/** "at", an optional "fn (", an optional "address at", the file, line, column and ")". */
const FRAME = /^(\s*at\s+(?:.*?\s+\()?)(address at\s+)?([^()\s][^()]*?):(\d+):(\d+)(\)?)\s*$/;

/** A URL with a scheme other than file:, such as the development server's http:. */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function inAppBundle(file: string): boolean {
  if (SCHEME.test(file) && !file.startsWith("file://")) return false;
  if (file.endsWith("InternalBytecode.js")) return false;
  return (
    file.startsWith("/") ||
    file.startsWith("file://") ||
    /\.(?:jsbundle|bundle|hbc)$/.test(file) ||
    file.includes(".expo-internal/")
  );
}

/** stack with every frame in the app's bundle pointing at bundleUrl. */
export function mapHermesStack(stack: string, bundleUrl: string): string {
  return stack
    .split("\n")
    .map((line) => {
      const m = FRAME.exec(line);
      if (m === null) return line;
      const [, head = "", address, file = "", lineNo = "", col = "", close = ""] = m;
      if (!inAppBundle(file)) return line;
      const column = address === undefined ? Number(col) : Number(col) + 1;
      return `${head}${bundleUrl}:${lineNo}:${column}${close}`;
    })
    .join("\n");
}
