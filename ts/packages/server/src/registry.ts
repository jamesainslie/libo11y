/**
 * Loading an application registry file: read, parse, validate and compile, failing with Go's
 * messages (WithAppRegistry, appregistry.go loadAppRegistries) under the code INVALID_APP_REGISTRY.
 */
import { readFile } from "node:fs/promises";
import { O11yError } from "@libo11y/core";
import { type CompiledAppRegistry, compileAppRegistry, validateAppRegistry } from "@libo11y/spec";
import { AppRegistryParseError, parseAppRegistryBytes } from "@libo11y/spec/yaml";

// GO_READ_ERRORS maps a Node file system error code to the operation and reason Go's os.ReadFile
// reports, as the libo11y CLI does.
const GO_READ_ERRORS: Readonly<Record<string, readonly [string, string]>> = {
  ENOENT: ["open", "no such file or directory"],
  EACCES: ["open", "permission denied"],
  EPERM: ["open", "operation not permitted"],
  EISDIR: ["read", "is a directory"],
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readError(path: string, err: unknown): string {
  const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
  const known = GO_READ_ERRORS[code];
  return known === undefined ? `open ${path}: ${message(err)}` : `${known[0]} ${path}: ${known[1]}`;
}

// parseMessage is Go's Parse error for the two failures whose wording Go fixes, and the parse
// class with its detail for the others, whose wording is yaml.v3's in Go.
function parseMessage(err: unknown): string {
  if (err instanceof AppRegistryParseError) {
    if (err.kind === "empty") return "application registry is empty";
    if (err.kind === "second-document") {
      return "parsing application registry: an application registry holds one YAML document, found a second";
    }
  }
  return message(err);
}

/**
 * Reads, parses and validates the registry file at path and compiles it, with path as its source.
 * Rejects with O11yError INVALID_APP_REGISTRY: "o11y: reading application registry: ..." when the
 * file cannot be read, "o11y: <path>: ..." when it does not parse, and
 * "o11y: invalid application registry: <path>: <violation>; ..." when it breaks a rule.
 */
export async function loadAppRegistry(path: string): Promise<CompiledAppRegistry> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (err) {
    throw new O11yError(
      "INVALID_APP_REGISTRY",
      `o11y: reading application registry: ${readError(path, err)}`,
      {
        cause: err,
      },
    );
  }
  let parsed: ReturnType<typeof parseAppRegistryBytes>;
  try {
    parsed = parseAppRegistryBytes(bytes);
  } catch (err) {
    throw new O11yError("INVALID_APP_REGISTRY", `o11y: ${path}: ${parseMessage(err)}`, { cause: err });
  }
  const result = validateAppRegistry(parsed);
  if (!result.ok) {
    const violations = result.violations.map((v) => v.toString()).join("; ");
    throw new O11yError("INVALID_APP_REGISTRY", `o11y: invalid application registry: ${path}: ${violations}`);
  }
  return { ...compileAppRegistry(result.registry), source: path };
}
