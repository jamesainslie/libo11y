/**
 * A minimal XMLHttpRequest for tests, and a fetch built over it the way bare React Native's
 * whatwg-fetch is: it opens and sends the XHR inside its own call. Never built.
 */

/** Just enough of XMLHttpRequest: open, setRequestHeader, send, events, status and readyState. */
export class FakeXhr extends EventTarget {
  /** Every FakeXhr sent, in send order. */
  static sent: FakeXhr[] = [];
  readyState = 0;
  status = 0;
  method = "";
  url = "";
  headers: [string, string][] = [];

  open(method: string, url: string | URL): void {
    this.method = method;
    this.url = String(url);
    this.readyState = 1;
    this.headers = [];
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.push([name, value]);
  }

  send(_body?: unknown): void {
    FakeXhr.sent.push(this);
  }

  header(name: string): string | undefined {
    return this.headers.find(([k]) => k.toLowerCase() === name)?.[1];
  }

  respond(status: number): void {
    this.status = status;
    this.readyState = 4;
    this.dispatchEvent(new Event("load"));
    this.dispatchEvent(new Event("loadend"));
  }
}

/**
 * Installs FakeXhr as globalThis.XMLHttpRequest and returns the function that restores the global
 * and FakeXhr's prototype.
 */
export function installFakeXhr(): () => void {
  const before = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
  const { open, send, setRequestHeader } = FakeXhr.prototype;
  FakeXhr.sent = [];
  Object.defineProperty(globalThis, "XMLHttpRequest", { value: FakeXhr, configurable: true, writable: true });
  return () => {
    FakeXhr.prototype.open = open;
    FakeXhr.prototype.send = send;
    FakeXhr.prototype.setRequestHeader = setRequestHeader;
    if (before !== undefined) Object.defineProperty(globalThis, "XMLHttpRequest", before);
    else delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  };
}

/**
 * A fetch over globalThis.XMLHttpRequest, as whatwg-fetch: the XHR is opened and sent before the
 * call returns, and the response comes when the test calls respond on it.
 */
export function xhrFetch(): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      const Xhr = (globalThis as unknown as { XMLHttpRequest: typeof FakeXhr }).XMLHttpRequest;
      const xhr = new Xhr();
      xhr.open(init?.method ?? "GET", input instanceof Request ? input.url : String(input));
      for (const [k, v] of new Headers(init?.headers)) xhr.setRequestHeader(k, v);
      xhr.addEventListener("loadend", () => resolve(new Response(null, { status: xhr.status })));
      xhr.send(init?.body);
    })) as typeof fetch;
}
