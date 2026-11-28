/**
 * A FileSystemLike over a Map for tests: one directory of files, plus subdirectory names and stray
 * files a test can add. It records whether the directory was created. Never built.
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
}

export function fakeFileSystem(o: { readonly exists?: boolean } = {}): FakeFileSystem {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  let exists = o.exists === true;
  let created = false;
  let held: Promise<void> | undefined;
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
  };
}
