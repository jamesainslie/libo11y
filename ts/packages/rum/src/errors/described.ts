/** An Error-like value recordError reads as is, so the type, message and stack are exactly these. */
export class DescribedError extends Error {
  constructor(name: string, message: string, stack?: string) {
    super(message);
    this.name = name;
    this.stack = stack ?? "";
  }
}
