/**
 * Parses an application registry file. This is the only `@libo11y/spec` module that depends on a YAML
 * parser, so `@libo11y/spec` itself stays dependency-free for browsers.
 *
 * Decoding follows Go's appregistry.Parse, which is yaml.v3 with KnownFields:
 * - Scalars read as strings. A plain scalar reads as its text, so `1.0` stays `1.0`, and a null scalar
 *   (`~`, `null`, empty) leaves its field empty. A null entry in `values` is dropped, and a null key is
 *   skipped.
 * - An unknown key, a duplicate key, or a value of the wrong YAML type is an error. When a document has
 *   several of these, a duplicate key outranks an unknown key, which outranks a type error.
 * - Problems in the first document outrank a second document, and a second document is an error even
 *   when it is empty, as a trailing `---` makes it.
 */
import {
  type Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  Scalar,
  type YAMLMap,
} from "yaml";
import type { AppRegistry, AppRegistryAttribute } from "./appregistry.ts";

export type { AppRegistry, AppRegistryAttribute } from "./appregistry.ts";

/** Why a registry file did not decode. The names match the conformance cases' `parse:` kinds. */
export type AppRegistryParseKind =
  | "empty"
  | "second-document"
  | "duplicate-key"
  | "unknown-key"
  | "type"
  | "syntax";

const MESSAGES: Readonly<Record<AppRegistryParseKind, string>> = {
  empty: "the file holds no YAML document",
  "second-document": "an application registry holds one YAML document, found a second",
  "duplicate-key": "a mapping repeats a key",
  "unknown-key": "a key the schema does not define",
  type: "a value of the wrong YAML type",
  syntax: "the file is not valid YAML",
};

/** Thrown by parseAppRegistry for a file that does not decode. */
export class AppRegistryParseError extends Error {
  readonly kind: AppRegistryParseKind;

  constructor(kind: AppRegistryParseKind, detail?: string) {
    super(`parsing application registry: ${kind}: ${detail ?? MESSAGES[kind]}`);
    this.name = "AppRegistryParseError";
    this.kind = kind;
  }
}

type Fields<T> = { -readonly [K in keyof T]?: T[K] };

// MergeError is yaml.v3's fatal "map merge requires map or sequence of maps", which Go reports as a
// syntax error, ahead of any collected problem.
class MergeError extends Error {}

const MERGE_TAGS: ReadonlySet<string | undefined> = new Set([undefined, "!", "tag:yaml.org,2002:merge"]);

// Decoder walks one document the way yaml.v3 decodes it into Go's Registry struct. Like yaml.v3, it
// collects problems and keeps going instead of stopping at the first.
class Decoder {
  readonly #doc: Document.Parsed;
  duplicate = false;
  unknown = false;
  wrongType = false;

  constructor(doc: Document.Parsed) {
    this.#doc = doc;
  }

  #resolve(node: unknown): unknown {
    return isAlias(node) ? node.resolve(this.#doc) : node;
  }

  // isNull reports a scalar that resolves to null, which leaves a Go field at its zero value.
  #isNull(node: unknown): boolean {
    return node === null || node === undefined || (isScalar(node) && node.value === null);
  }

  // text is yaml.v3's Node.Value: the folded text of a plain scalar, the decoded value of any other.
  #text(node: Scalar): string {
    return node.type === Scalar.PLAIN || node.type === undefined
      ? (node.source ?? String(node.value))
      : String(node.value);
  }

  // identity is what yaml.v3 compares to find a duplicate key: the node kind and its value.
  #identity(node: unknown): string {
    if (isScalar(node)) return `scalar:${this.#text(node)}`;
    if (isAlias(node)) return `alias:${node.source}`;
    return isMap(node) ? "map:" : "seq:";
  }

  #isMergeKey(node: unknown): boolean {
    return isScalar(node) && node.type === Scalar.PLAIN && node.source === "<<" && MERGE_TAGS.has(node.tag);
  }

  // hasDuplicates checks a mapping before it is decoded, as yaml.v3 does for every mapping it decodes.
  #hasDuplicates(map: YAMLMap): boolean {
    const seen = new Set<string>();
    for (const pair of map.items) {
      const id = this.#identity(pair.key);
      if (seen.has(id)) {
        this.duplicate = true;
        return true;
      }
      seen.add(id);
    }
    return false;
  }

  // string decodes a node into a Go string: undefined for null, which leaves the field unset.
  string(raw: unknown): string | undefined {
    const node = this.#resolve(raw);
    if (this.#isNull(node)) return undefined;
    if (isScalar(node)) return this.#text(node);
    if (!(isMap(node) && this.#hasDuplicates(node))) this.wrongType = true;
    return undefined;
  }

  // strings decodes a node into a Go []string. Null entries are dropped.
  strings(raw: unknown): string[] | undefined {
    const node = this.#resolve(raw);
    if (this.#isNull(node)) return undefined;
    if (!isSeq(node)) {
      if (!(isMap(node) && this.#hasDuplicates(node))) this.wrongType = true;
      return undefined;
    }
    const out: string[] = [];
    for (const item of node.items) {
      const s = this.string(item);
      if (s !== undefined) out.push(s);
    }
    return out;
  }

  // mapping decodes a mapping key by key into a Go struct or map, calling onKey for each key. Keys
  // already in merged, the keys of the mapping that merges this one, are skipped. A merge key (<<) is
  // applied after the mapping's own keys, so they win, and the first merged mapping wins over later ones.
  mapping(raw: unknown, onKey: (name: string, value: unknown) => void, merged?: Set<string>): void {
    const node = this.#resolve(raw);
    if (this.#isNull(node)) return;
    if (!isMap(node)) {
      this.wrongType = true;
      return;
    }
    if (this.#hasDuplicates(node)) return;
    let mergeNode: unknown;
    let hasMerge = false;
    for (const pair of node.items) {
      if (this.#isMergeKey(pair.key)) {
        mergeNode = pair.value;
        hasMerge = true;
        continue;
      }
      const name = this.string(pair.key);
      if (name === undefined) continue;
      if (merged !== undefined) {
        if (merged.has(name)) continue;
        merged.add(name);
      }
      onKey(name, pair.value);
    }
    if (!hasMerge) return;
    const keys =
      merged ?? new Set(node.items.flatMap((pair) => (isScalar(pair.key) ? [this.#text(pair.key)] : [])));
    const source = this.#resolve(mergeNode);
    const sources = isSeq(source) ? source.items.map((item) => this.#resolve(item)) : [source];
    if (sources.some((s) => !isMap(s))) throw new MergeError("map merge requires map or sequence of maps");
    for (const s of sources) this.mapping(s, onKey, keys);
  }

  // struct decodes a mapping into a Go struct with the given fields.
  struct(raw: unknown, fields: ReadonlySet<string>, set: (field: string, value: unknown) => void): void {
    const done = new Set<string>();
    this.mapping(raw, (name, value) => {
      if (!fields.has(name)) {
        this.unknown = true;
        return;
      }
      // yaml.v3 reports "field already set", a type error, for two keys that decode to one name.
      if (done.has(name)) {
        this.wrongType = true;
        return;
      }
      done.add(name);
      set(name, value);
    });
  }

  attribute(raw: unknown): AppRegistryAttribute {
    const a: Fields<AppRegistryAttribute> = {};
    this.struct(raw, ATTRIBUTE_FIELDS, (field, value) => {
      if (field === "values") {
        const values = this.strings(value);
        if (values !== undefined) a.values = values;
        return;
      }
      const s = this.string(value);
      if (s !== undefined) a[field as "type" | "sensitivity" | "cardinality" | "brief"] = s;
    });
    const { type = "", sensitivity = "", cardinality = "", ...rest } = a;
    return { type, sensitivity, cardinality, ...rest };
  }

  attributes(raw: unknown): Record<string, AppRegistryAttribute> {
    const out: Record<string, AppRegistryAttribute> = Object.create(null);
    this.mapping(raw, (name, value) => {
      out[name] = this.attribute(value);
    });
    return out;
  }

  registry(raw: unknown): AppRegistry {
    let schema = "";
    let namespace = "";
    let attributes: Record<string, AppRegistryAttribute> = Object.create(null);
    this.struct(raw, REGISTRY_FIELDS, (field, value) => {
      if (field === "attributes") {
        attributes = this.attributes(value);
        return;
      }
      const s = this.string(value);
      if (s === undefined) return;
      if (field === "schema") schema = s;
      else namespace = s;
    });
    return { schema, namespace, attributes };
  }

  // problem is the kind Go's conformance test names for the collected problems, if any.
  problem(): AppRegistryParseKind | undefined {
    if (this.duplicate) return "duplicate-key";
    if (this.unknown) return "unknown-key";
    if (this.wrongType) return "type";
    return undefined;
  }
}

const REGISTRY_FIELDS: ReadonlySet<string> = new Set(["schema", "namespace", "attributes"]);
const ATTRIBUTE_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "sensitivity",
  "cardinality",
  "values",
  "brief",
]);

/**
 * Decodes a registry file strictly. It does not apply the policy rules; validateAppRegistry does.
 * Throws AppRegistryParseError when the file does not decode.
 */
export function parseAppRegistry(text: string): AppRegistry {
  const docs = parseAllDocuments(text, { uniqueKeys: false });
  const [first, second] = docs;
  if (first === undefined) {
    const streamErrors = "errors" in docs ? docs.errors : [];
    if (streamErrors.length > 0) throw new AppRegistryParseError("syntax", streamErrors[0]?.message);
    throw new AppRegistryParseError("empty");
  }
  if (first.errors.length > 0) throw new AppRegistryParseError("syntax", first.errors[0]?.message);
  const decoder = new Decoder(first);
  let reg: AppRegistry;
  try {
    reg = decoder.registry(first.contents);
  } catch (err) {
    if (err instanceof MergeError) throw new AppRegistryParseError("syntax", err.message);
    throw err;
  }
  const problem = decoder.problem();
  if (problem !== undefined) throw new AppRegistryParseError(problem);
  if (second !== undefined) {
    if (second.errors.length > 0) throw new AppRegistryParseError("syntax", second.errors[0]?.message);
    throw new AppRegistryParseError("second-document");
  }
  return reg;
}
