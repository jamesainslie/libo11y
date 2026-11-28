/**
 * The native Expo modules the telemetry reads, replaced for jest: an in-memory file system behind
 * expo-file-system's File, Directory and Paths, an over-the-air launch for expo-updates, the app
 * version and a phone. global.__fixtureFiles exposes the files to the tests.
 */
jest.mock("expo-file-system", () => {
  const files = new Map();
  const dirs = new Set(["file:///document"]);
  const join = (parts) =>
    parts
      .map((p) => (typeof p === "string" ? p : p.uri))
      .join("/")
      .replace(/\/+/g, "/")
      .replace(":/", ":///");
  class Directory {
    constructor(...parts) {
      this.uri = join(parts);
    }
    get exists() {
      return dirs.has(this.uri);
    }
    create() {
      dirs.add(this.uri);
    }
    list() {
      if (!this.exists) throw new Error(`no directory ${this.uri}`);
      const prefix = `${this.uri}/`;
      return [...files.keys()]
        .filter((u) => u.startsWith(prefix) && !u.slice(prefix.length).includes("/"))
        .map((u) => new File(u));
    }
  }
  class File {
    constructor(...parts) {
      this.uri = join(parts);
    }
    get name() {
      return this.uri.slice(this.uri.lastIndexOf("/") + 1);
    }
    get exists() {
      return files.has(this.uri);
    }
    async text() {
      if (!files.has(this.uri)) throw new Error(`no file ${this.uri}`);
      return files.get(this.uri);
    }
    async write(content) {
      const dir = this.uri.slice(0, this.uri.lastIndexOf("/"));
      if (!dirs.has(dir)) throw new Error(`no directory ${dir}`);
      files.set(this.uri, content);
    }
    delete() {
      if (!files.delete(this.uri)) throw new Error(`no file ${this.uri}`);
    }
  }
  global.__fixtureFiles = files;
  return { Directory, File, Paths: { document: new Directory("file:///document") } };
});

jest.mock("expo-updates", () => ({
  isEnabled: true,
  isEmbeddedLaunch: false,
  updateId: "11111111-2222-4333-8444-555555555555",
}));

jest.mock("expo-application", () => ({ nativeApplicationVersion: "1.0.0" }));

jest.mock("expo-device", () => ({ deviceType: 1 }));

/**
 * React Native's jest preset replaces performance with { now: Date.now } and no timeOrigin, which a
 * device has (Performance.timeOrigin, read from native). OpenTelemetry adds timeOrigin to now for
 * every timestamp, so without it every span time is NaN and the trace export fails. now counts
 * from the epoch here, so the origin is 0.
 */
global.performance.timeOrigin = 0;

/**
 * The gateway: a fetch that records each request in global.__fixtureRequests, its body as text
 * (gunzipped when gzip-encoded: Node has CompressionStream, Hermes does not), and answers 200.
 * Installed here, before a test imports the telemetry, because @libo11y/web keeps the fetch it
 * finds when it loads for its own exports.
 */
const { gunzipSync } = require("node:zlib");

global.__fixtureRequests = [];
global.fetch = jest.fn(async (input, init = {}) => {
  const encoding = new Headers(init.headers).get("Content-Encoding");
  const raw = init.body ?? "";
  const body =
    encoding === "gzip"
      ? gunzipSync(Buffer.from(raw)).toString("utf8")
      : typeof raw === "string"
        ? raw
        : Buffer.from(raw).toString("utf8");
  global.__fixtureRequests.push({ url: String(input), body });
  return new Response(null, { status: 200 });
});
