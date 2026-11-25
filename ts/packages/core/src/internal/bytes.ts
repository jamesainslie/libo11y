/**
 * The one test for "this is bytes" that key material passes before it is used.
 *
 * A key that is not a Uint8Array must never be converted into one. `new Uint8Array("a 32-character
 * string")` is an empty array, `new Uint8Array("4096")` and `new Uint8Array(4096)` are 4096 zero
 * bytes, and `typedArray.set("1234")` writes the digits 1, 2, 3, 4. Each gives key material an
 * attacker can guess, and none of them throws.
 */

// %TypedArray%.prototype[Symbol.toStringTag] is a getter that reads the typed array's internal
// slot: the name of its type, or undefined for anything that is not a typed array. It runs no code
// of the value's, and an own or inherited Symbol.toStringTag on the value does not reach it.
const typedArrayName: ((this: unknown) => unknown) | undefined = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  Symbol.toStringTag,
)?.get;

/**
 * Whether value is a Uint8Array. A Node Buffer is one, and so is an instance of a subclass. A
 * string, a number, an array of numbers, an ArrayBuffer and every other view type are not.
 *
 * instanceof is not the test. It is false for a Uint8Array from another realm, such as a Buffer
 * seen by a library that a test runner loaded inside a vm context, and true for a plain object
 * created on Uint8Array.prototype. Should a runtime lack the getter, nothing is bytes, which
 * refuses every key instead of accepting a wrong one.
 */
export function isBytes(value: unknown): value is Uint8Array {
  return typedArrayName?.call(value) === "Uint8Array";
}
