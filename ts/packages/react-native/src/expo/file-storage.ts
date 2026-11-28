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
  /**
   * Moves the file called from over the file called to. expo-file-system deletes the target first,
   * then moves the file in, so a crash between the two leaves from in place and to missing.
   */
  replace(from: string, to: string): void | Promise<void>;
}

/**
 * The suffix of the file a value is written to before it replaces the key's file. "." never
 * appears in a key's file name, so a temporary file is never taken for a key.
 */
const TEMPORARY = ".tmp";

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
 *
 * A value is written whole to a temporary file that then replaces the key's file, because neither
 * platform's write is atomic: an app killed during a write keeps the old value. Killed between the
 * replace's delete and move, the key reads the new value from the temporary file. The operations
 * on one key run one at a time, in call order.
 */
export function expoFileStorageWith(fs: FileSystemLike): KeyValueStorage {
  const pending = new Map<string, Promise<unknown>>();
  const inOrder = <T>(key: string, op: () => Promise<T>): Promise<T> => {
    const result = (pending.get(key) ?? Promise.resolve()).then(op, op);
    const settled = result.then(
      () => {},
      () => {},
    );
    pending.set(key, settled);
    void settled.then(() => {
      if (pending.get(key) === settled) pending.delete(key);
    });
    return result;
  };
  return {
    getItem: (key) =>
      inOrder(key, async () => {
        const name = fileNameOf(key);
        for (const f of [fs.file(name), fs.file(name + TEMPORARY)]) if (f.exists) return await f.text();
        return null;
      }),
    setItem: (key, value) =>
      inOrder(key, async () => {
        if (!fs.directoryExists()) fs.createDirectory();
        const name = fileNameOf(key);
        await fs.file(name + TEMPORARY).write(value);
        await fs.replace(name + TEMPORARY, name);
      }),
    removeItem: (key) =>
      inOrder(key, async () => {
        const name = fileNameOf(key);
        for (const f of [fs.file(name), fs.file(name + TEMPORARY)]) if (f.exists) f.delete();
      }),
    async getAllKeys() {
      if (!fs.directoryExists()) return [];
      const keys = new Set<string>();
      for (const file of fs.fileNames()) {
        const key = keyOf(file.endsWith(TEMPORARY) ? file.slice(0, -TEMPORARY.length) : file);
        if (key !== undefined) keys.add(key);
      }
      return [...keys];
    },
  };
}
