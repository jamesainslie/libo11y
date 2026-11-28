/**
 * A FileSystemLike over a Map for tests: one directory of files, plus subdirectory names and stray
 * files a test can add. It records whether the directory was created, and can hold writes, tear
 * the next write, or stop the next replace halfway, as an app killed mid-write would. Never built.
 */
import type { FileLike, FileSystemLike } from "../expo/file-storage.ts";

export interface FakeFileSystem extends FileSystemLike {
  /** The files in the directory by name, for tests to read and change directly. */
  readonly files: Map<string, string>;
  /** The names of subdirectories in the directory. */
  readonly directories: Set<string>;
  /** Whether createDirectory ran. */
  directoryCreated(): boolean;
  /** Makes every later write wait until the returned function is called. */
  holdWrites(): () => void;
  /** The next write saves only the first half of its content, then rejects. */
  tearNextWrite(): void;
  /** The next replace deletes its target, then rejects before moving the file in. */
  stopNextReplace(): void;
}

export function fakeFileSystem(o: { readonly exists?: boolean } = {}): FakeFileSystem {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  let exists = o.exists === true;
  let created = false;
  let held: Promise<void> | undefined;
  let tear = false;
  let stop = false;
  const requireDirectory = (): void => {
    if (!exists) throw new Error("fake fs: the directory does not exist");
  };
  const file = (name: string): FileLike => ({
    get exists() {
      return files.has(name);
    },
    text: async () => {
      const v = files.get(name);
      if (v === undefined) throw new Error(`fake fs: no file ${name}`);
      return v;
    },
    write: async (content) => {
      requireDirectory();
      if (held !== undefined) await held;
      if (tear) {
        tear = false;
        files.set(name, content.slice(0, Math.floor(content.length / 2)));
        throw new Error("fake fs: torn write");
      }
      files.set(name, content);
    },
    delete: () => {
      if (!files.delete(name)) throw new Error(`fake fs: no file ${name}`);
    },
  });
  return {
    files,
    directories,
    directoryExists: () => exists,
    createDirectory: () => {
      created = true;
      exists = true;
    },
    fileNames: () => {
      requireDirectory();
      return [...files.keys()];
    },
    file,
    replace: async (from, to) => {
      // Both platforms delete the target first, then move the file in.
      const v = files.get(from);
      if (v === undefined) throw new Error(`fake fs: no file ${from}`);
      files.delete(to);
      if (stop) {
        stop = false;
        throw new Error("fake fs: stopped between delete and move");
      }
      files.delete(from);
      files.set(to, v);
    },
    directoryCreated: () => created,
    holdWrites: () => {
      let release: () => void = () => {};
      held = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        held = undefined;
        release();
      };
    },
    tearNextWrite: () => {
      tear = true;
    },
    stopNextReplace: () => {
      stop = true;
    },
  };
}
