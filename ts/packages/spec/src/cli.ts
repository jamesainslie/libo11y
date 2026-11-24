#!/usr/bin/env node
/// <reference types="node" />
/**
 * The libo11y command-line tool. `libo11y registry check FILE...` validates application attribute
 * registries against the libo11y policy rules, for use in a consumer's CI. It matches the Go binary
 * (go/cmd/libo11y).
 *
 * Exit status: 0 when every file is valid, 1 when a file breaks a policy rule, 2 on a usage, read, or
 * parse error. The highest status wins.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateAppRegistry } from "./appregistry.ts";
import { parseAppRegistryBytes } from "./yaml.ts";

const USAGE = "usage: libo11y registry check FILE...";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// GO_READ_ERRORS maps a Node file system error code to Go's os.ReadFile error: the operation that
// failed and the reason Go prints.
const GO_READ_ERRORS: Readonly<Record<string, readonly [string, string]>> = {
  ENOENT: ["open", "no such file or directory"],
  EACCES: ["open", "permission denied"],
  EPERM: ["open", "operation not permitted"],
  EISDIR: ["read", "is a directory"],
};

// readError renders a failed read the way the Go binary prints os.ReadFile's error.
function readError(path: string, err: unknown): string {
  const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
  const known = GO_READ_ERRORS[code];
  return known === undefined ? `open ${path}: ${message(err)}` : `${known[0]} ${path}: ${known[1]}`;
}

// checkFile validates one registry file and returns its exit status.
function checkFile(
  path: string,
  out: (line: string) => void,
  err: (line: string) => void,
  readFile: (path: string) => Uint8Array,
): number {
  let bytes: Uint8Array;
  try {
    bytes = readFile(path);
  } catch (e) {
    err(readError(path, e));
    return 2;
  }
  let reg: ReturnType<typeof parseAppRegistryBytes>;
  try {
    reg = parseAppRegistryBytes(bytes);
  } catch (e) {
    err(`${path}: ${message(e)}`);
    return 2;
  }
  const result = validateAppRegistry(reg);
  if (!result.ok) {
    for (const v of result.violations) out(`${path}: ${v.toString()}`);
    return 1;
  }
  const n = Object.keys(reg.attributes).length;
  out(`${path}: ok (${n} ${n === 1 ? "attribute" : "attributes"} in namespace ${reg.namespace})`);
  return 0;
}

/**
 * Runs the command line and returns the exit status. out and err each receive one line at a time,
 * without its newline. readFile returns a registry file's bytes and throws a Node file system error.
 */
export function run(
  args: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
  readFile: (path: string) => Uint8Array,
): number {
  if (args.length === 1 && (args[0] === "-h" || args[0] === "--help" || args[0] === "help")) {
    out(USAGE);
    return 0;
  }
  if (args.length < 3 || args[0] !== "registry" || args[1] !== "check") {
    err(USAGE);
    return 2;
  }
  let status = 0;
  for (const path of args.slice(2)) {
    status = Math.max(status, checkFile(path, out, err, readFile));
  }
  return status;
}

// isEntry reports whether this module is the program being run. It compares the resolved script path,
// which follows the bin symlink npm installs, because import.meta.main needs Node 24.2 or later.
function isEntry(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntry()) {
  process.exit(
    run(
      process.argv.slice(2),
      (line) => process.stdout.write(`${line}\n`),
      (line) => process.stderr.write(`${line}\n`),
      (path) => readFileSync(path),
    ),
  );
}
