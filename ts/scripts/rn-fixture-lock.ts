/**
 * Relocks the fixture Expo app's bun.lock for freshly packed tarballs. The fixture installs every
 * @libo11y/* package from .packs/<name>.tgz, whose bytes change with every package change, and
 * the lock records each tarball's integrity. Bun refuses a tarball whose integrity differs from the
 * lock when it is not cached, so scripts/rn-fixture.sh runs this before `bun install`.
 *
 *   bun scripts/rn-fixture-lock.ts FIXTURE_DIR
 *
 * Bun also caches a local tarball by its path and reinstalls the cached contents after the file
 * changes, so rn-fixture.sh extracts the tarballs over node_modules/@libo11y itself after the
 * install. This script only keeps the lock true to the tarballs.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The subresource integrity string of bytes, as lockfiles write it. */
export function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** An entry of a tarball under .packs: its file name, and the integrity at the end of its line. */
const ENTRY = /^(\s*"[^"]+": \["[^"]+@\.packs\/([^"]+)",.*, )"sha512-[^"]*"(\],?)$/;

/**
 * lock with the integrity of each .packs tarball entry replaced by integrity's value for its file
 * name. Throws when integrity names a tarball the lock does not list.
 */
export function relockPacks(lock: string, integrity: ReadonlyMap<string, string>): string {
  const seen = new Set<string>();
  const out = lock
    .split("\n")
    .map((line) => {
      const m = ENTRY.exec(line);
      const file = m?.[2];
      const value = file === undefined ? undefined : integrity.get(file);
      if (m === null || file === undefined || value === undefined) return line;
      seen.add(file);
      return `${m[1]}"${value}"${m[3]}`;
    })
    .join("\n");
  const missing = [...integrity.keys()].filter((f) => !seen.has(f));
  if (missing.length > 0) {
    throw new Error(
      `rn-fixture-lock: bun.lock lists no entry for ${missing.join(", ")}; add the package to the fixture and run bun install`,
    );
  }
  return out;
}

export function main(args: readonly string[]): number {
  const dir = args[0];
  if (dir === undefined) {
    console.error("usage: rn-fixture-lock.ts FIXTURE_DIR");
    return 2;
  }
  const packs = join(dir, ".packs");
  const integrity = new Map(
    readdirSync(packs)
      .filter((f) => f.endsWith(".tgz"))
      .map((f) => [f, sha512Integrity(readFileSync(join(packs, f)))] as const),
  );
  const lockFile = join(dir, "bun.lock");
  writeFileSync(lockFile, relockPacks(readFileSync(lockFile, "utf8"), integrity));
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
