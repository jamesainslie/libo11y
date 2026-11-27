/** Reads any thrown value into exception.type, exception.message and exception.stacktrace. */

const MAX_MESSAGE = 1024;

export interface NormalizedError {
  readonly type: string;
  readonly message: string;
  readonly stack?: string;
}

const cut = (s: string): string => (s.length > MAX_MESSAGE ? s.slice(0, MAX_MESSAGE) : s);

function text(v: unknown): string {
  try {
    return String(v);
  } catch {
    return "[object]";
  }
}

export function normalizeError(value: unknown): NormalizedError {
  if (value instanceof Error) {
    return {
      type: value.name || "Error",
      message: cut(text(value.message)),
      ...(typeof value.stack === "string" && value.stack !== "" ? { stack: value.stack } : {}),
    };
  }
  if (typeof value === "string") return { type: "Error", message: cut(value) };
  if (typeof value === "object" && value !== null && "message" in value) {
    const v = value as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      type: typeof v.name === "string" && v.name !== "" ? v.name : "Error",
      message: cut(text(v.message)),
      ...(typeof v.stack === "string" && v.stack !== "" ? { stack: v.stack } : {}),
    };
  }
  return { type: value === null ? "null" : typeof value, message: cut(text(value)) };
}
