/**
 * A realm-safe Error check. instanceof Error fails for an error from another realm (an iframe, a
 * vm context, a worker's structured clone), so core uses Error.isError where the runtime has it,
 * and otherwise a structural test.
 */

type ErrorConstructorWithIsError = { isError?: (value: unknown) => boolean };

/**
 * The fallback check: an object with a string name and message, and either a string stack or an
 * Error prototype chain (by instanceof, or by its [object Error] tag).
 */
export function isErrorLike(value: unknown): value is Error {
  if (value instanceof Error) return true;
  if (typeof value !== "object" || value === null) return false;
  const v = value as { name?: unknown; message?: unknown; stack?: unknown };
  if (typeof v.name !== "string" || typeof v.message !== "string") return false;
  return typeof v.stack === "string" || Object.prototype.toString.call(value) === "[object Error]";
}

const native = (Error as unknown as ErrorConstructorWithIsError).isError;

/** Reports whether value is an Error, from this realm or another. */
export function isError(value: unknown): value is Error {
  return typeof native === "function" ? native(value) : isErrorLike(value);
}
