/**
 * A KeyValueStorage with one file per key in one directory, over the slice of expo-file-system's
 * File and Directory API (SDK 54 and later) it uses. expo.ts passes the real module; tests pass a
 * fake, so this module imports nothing from expo-file-system.
 */
import type { KeyValueStorage } from "../contracts/storage.ts";

/** The part of expo-file-system's File the storage uses. */
export interface FileLike {
  /** Whether the file exists. */
  readonly exists: boolean;
  /** The file's text. */
  text(): Promise<string>;
  /** Replaces the file's content, creating the file when it does not exist. */
  write(content: string): void | Promise<void>;
  /** Deletes the file. */
  delete(): void;
}

/** The storage's directory, and its files by name. */
export interface FileSystemLike {
  /** Whether the directory exists. */
  directoryExists(): boolean;
  /** Creates the directory and any missing parents, succeeding when it exists already. */
  createDirectory(): void;
  /** The names of the files directly in the directory, without subdirectories. */
  fileNames(): readonly string[];
  /** The file called name in the directory, which need not exist. */
  file(name: string): FileLike;
}

/** Characters a file name keeps as they are: lowercase, so no two names differ only in case. */
const PLAIN = /^[a-z0-9_-]$/;

/**
 * The file name of key: every character other than a lowercase letter, a digit, "_" and "-" is
 * percent-encoded as UTF-8 with lowercase hex. So no name is "." or "..", none holds a path
 * separator, and keys that differ only in case get different names on a case-insensitive file
 * system, such as iOS's.
 */
function fileNameOf(key: string): string {
  let name = "";
  for (const ch of key) {
    if (PLAIN.test(ch)) {
      name += ch;
      continue;
    }
    for (const byte of new TextEncoder().encode(ch)) name += `%${byte.toString(16).padStart(2, "0")}`;
  }
  return name;
}

/** The key whose file name is name, or undefined for a file this storage did not write. */
function keyOf(name: string): string | undefined {
  let key: string;
  try {
    key = decodeURIComponent(name);
  } catch {
    return undefined;
  }
  return fileNameOf(key) === name ? key : undefined;
}

/**
 * A KeyValueStorage with one file per key in fs's directory. Reads, removes and getAllKeys create
 * nothing; the directory is created on the first setItem, so nothing is written to the device
 * before the first write, which the delivery makes only once consent is granted. getAllKeys lists
 * only the keys of files this storage wrote, never subdirectories or other files.
 */
export function expoFileStorageWith(fs: FileSystemLike): KeyValueStorage {
  return {
    async getItem(key) {
      const f = fs.file(fileNameOf(key));
      return f.exists ? await f.text() : null;
    },
    async setItem(key, value) {
      if (!fs.directoryExists()) fs.createDirectory();
      await fs.file(fileNameOf(key)).write(value);
    },
    async removeItem(key) {
      const f = fs.file(fileNameOf(key));
      if (f.exists) f.delete();
    },
    async getAllKeys() {
      if (!fs.directoryExists()) return [];
      return fs.fileNames().flatMap((name) => {
        const key = keyOf(name);
        return key === undefined ? [] : [key];
      });
    },
  };
}
