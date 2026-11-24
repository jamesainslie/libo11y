/**
 * Runs fn with process.env changed, then restores every variable it touched, even when fn throws.
 * A value of undefined deletes the variable for the duration. Upstream's exporters and detectors read
 * process.env themselves, so tests of them have to set it.
 */
export async function withEnv<T>(
  vars: Readonly<Record<string, string | undefined>>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Every OTEL_* variable in the ambient environment, mapped to undefined, so withEnv clears them. */
export function clearedOtelEnv(): Record<string, undefined> {
  return Object.fromEntries(
    Object.keys(process.env)
      .filter((k) => k.startsWith("OTEL_"))
      .map((k) => [k, undefined]),
  );
}
