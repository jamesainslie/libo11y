/** Temporary directories for tests, removed when the test file finishes. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

/**
 * Returns a function that creates empty directories under the system temporary directory, and
 * removes them after the calling file's tests. Call it once at the top of each test file: Bun runs
 * every file in one process, so a hook registered when this module first loads would only clean up
 * after the first file.
 */
export function tempDirs(): (prefix: string) => string {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  return (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
}
