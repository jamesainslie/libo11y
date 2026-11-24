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
 * - What yaml.v3's reader, scanner and parser reject is `syntax`: a control character, an escape YAML 1.2
 *   added such as `\/`, a tag that does not fit its value, an unknown anchor, a `%YAML` version other
 *   than 1.1, and a document that aliases its way into excessive work. Like yaml.v3, it accepts the
 *   `\'` escape and reads `!!binary` as base64.
 */
import {
  type Alias,
  type Document,
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  Parser,
  parseAllDocuments,
  Scalar,
  type YAMLMap,
} from "yaml";
import type { AppRegistry, AppRegistryAttribute } from "./appregistry.ts";
import {
  checkCharacters,
  decodeInput,
  resolveScalar,
  type ScalarValue,
  scanEscapes,
  shortTag,
  YamlSyntaxError,
} from "./yamlv3.ts";

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

const OPTIONS = { uniqueKeys: false, keepSourceTokens: true } as const;

const MERGE_TAGS: ReadonlySet<string> = new Set(["", "!", "!!merge"]);

// yaml.v3's alias budget (decode.go allowedAliasRatio): past 1000 decodes and 100 alias-driven ones, the
// share of decodes driven by alias expansion may not exceed a ratio that falls from 0.99 to 0.10 as the
// document grows, so a small file cannot expand into an exponential amount of work.
const ALIAS_RATIO_LOW = 400_000;
const ALIAS_RATIO_HIGH = 4_000_000;

function allowedAliasRatio(decodes: number): number {
  if (decodes <= ALIAS_RATIO_LOW) return 0.99;
  if (decodes >= ALIAS_RATIO_HIGH) return 0.1;
  return 0.99 - 0.89 * ((decodes - ALIAS_RATIO_LOW) / (ALIAS_RATIO_HIGH - ALIAS_RATIO_LOW));
}

// isEmpty reports a document body with nothing in it: no value, tag or anchor.
function isEmpty(node: unknown): boolean {
  return (
    node === null ||
    node === undefined ||
    (isScalar(node) &&
      node.value === null &&
      node.source === "" &&
      node.tag === undefined &&
      node.anchor === undefined)
  );
}

// walk calls fn for every node under root in document order, keys before their values. It keeps its own
// stack: the `yaml` library's visit copies the path at every level, which is quadratic in the nesting.
function walk(root: unknown, fn: (node: unknown) => void): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || node === undefined) continue;
    if (isPair(node)) {
      stack.push(node.value, node.key);
      continue;
    }
    fn(node);
    if (isMap(node) || isSeq(node)) {
      for (let i = node.items.length - 1; i >= 0; i--) stack.push(node.items[i]);
    }
  }
}

// isPhantom reports the empty document the `yaml` library makes of an extra `...` end marker, which
// yaml.v3 skips.
function isPhantom(doc: Document.Parsed): boolean {
  return doc.directives.docStart !== true && doc.errors.length === 0 && isEmpty(doc.contents);
}

// versionDirectives returns, for each document, the versions its %YAML directives name. They come from
// the CST because the `yaml` library keeps only the last directive and accepts any version.
function versionDirectives(text: string, docs: readonly Document.Parsed[]): Map<Document.Parsed, string[]> {
  const out = new Map<Document.Parsed, string[]>(docs.map((doc) => [doc, []]));
  for (const token of new Parser().parse(text)) {
    if (token.type !== "directive" || !token.source.startsWith("%YAML")) continue;
    const doc = docs.find((d) => d.range[0] >= token.offset);
    out.get(doc ?? (docs[docs.length - 1] as Document.Parsed))?.push(token.source.slice(5).trim());
  }
  return out;
}

// documentAliases checks one document for the problems yaml.v3's scanner and parser report, which Go
// names `syntax` wherever they occur, and returns what each alias refers to. first says whether this is
// the stream's first document, which yaml.v3 reads without a `---` marker.
function documentAliases(
  doc: Document.Parsed,
  first: boolean,
  versions: readonly string[],
): Map<Alias, unknown> {
  const [error] = doc.errors;
  if (error !== undefined) throw new YamlSyntaxError(error.message);
  // yaml.v3 reads YAML 1.1 only.
  if (versions.length > 1) throw new YamlSyntaxError("found duplicate %YAML directive");
  const [version] = versions;
  if (version !== undefined && !/^0*1\.0*1(?:\s|#|$)/.test(version)) {
    throw new YamlSyntaxError("found incompatible YAML document");
  }
  if (doc.directives.docStart !== true && (!first || isEmpty(doc.contents))) {
    throw new YamlSyntaxError(
      first ? "did not find expected node content" : "did not find expected <document start>",
    );
  }
  // yaml.v3 registers an anchor when its node starts, so an alias can only refer back, and an alias
  // inside its own anchored node refers to that node.
  const anchors = new Map<string, unknown>();
  const targets = new Map<Alias, unknown>();
  walk(doc.contents, (node) => {
    if (isAlias(node)) {
      if (!anchors.has(node.source)) throw new YamlSyntaxError(`unknown anchor '${node.source}' referenced`);
      targets.set(node, anchors.get(node.source));
      return;
    }
    if (!isScalar(node) && !isMap(node) && !isSeq(node)) return;
    if (node.anchor !== undefined) anchors.set(node.anchor, node);
    if (isScalar(node) && node.type === Scalar.QUOTE_DOUBLE) {
      const token = node.srcToken;
      if (token !== undefined && "source" in token) scanEscapes(token.source);
    }
  });
  return targets;
}

// withoutQuoteEscapes drops the backslash of every `\'` escape in a double-quoted scalar. yaml.v3 reads
// `\'` as a quote, the `yaml` library rejects it, and a bare quote means the same inside double quotes.
function withoutQuoteEscapes(text: string, docs: readonly Document.Parsed[]): string {
  const offsets: number[] = [];
  // Only a document the `yaml` library rejected for an escape can hold one. Skipping the rest also keeps
  // a document it rejected for nesting too deeply from being walked.
  for (const doc of docs.filter((d) => d.errors.some((e) => e.code === "BAD_DQ_ESCAPE"))) {
    walk(doc.contents, (node) => {
      if (!isScalar(node) || node.type !== Scalar.QUOTE_DOUBLE) return;
      const token = node.srcToken;
      if (token === undefined || !("source" in token)) return;
      try {
        for (const i of scanEscapes(token.source)) offsets.push(token.offset + i);
      } catch {
        // An escape yaml.v3 rejects is reported when the document is checked.
      }
    });
  }
  if (offsets.length === 0) return text;
  offsets.sort((a, b) => a - b);
  let out = "";
  let from = 0;
  for (const offset of offsets) {
    out += text.slice(from, offset);
    from = offset + 1;
  }
  return out + text.slice(from);
}

// Decoder walks one document the way yaml.v3 decodes it into Go's Registry struct. Like yaml.v3, it
// collects problems and keeps going instead of stopping at the first. Problems yaml.v3 treats as fatal
// throw YamlSyntaxError.
class Decoder {
  readonly #targets: ReadonlyMap<Alias, unknown>;
  readonly #expanding = new Set<Alias>();
  #decodes = 0;
  #aliasDecodes = 0;
  #aliasDepth = 0;
  duplicate = false;
  unknown = false;
  wrongType = false;

  constructor(targets: ReadonlyMap<Alias, unknown>) {
    this.#targets = targets;
  }

  // count is the bookkeeping at the top of yaml.v3's decoder.unmarshal, once per node decoded.
  count(): void {
    this.#decodes++;
    if (this.#aliasDepth > 0) this.#aliasDecodes++;
    if (
      this.#aliasDecodes > 100 &&
      this.#decodes > 1000 &&
      this.#aliasDecodes / this.#decodes > allowedAliasRatio(this.#decodes)
    ) {
      throw new YamlSyntaxError("document contains excessive aliasing");
    }
  }

  // decode counts raw as one decoded node and passes it to fn, following an alias to its node first.
  #decode<T>(raw: unknown, fn: (node: unknown) => T): T {
    this.count();
    if (!isAlias(raw)) return fn(raw);
    if (this.#expanding.has(raw)) throw new YamlSyntaxError(`anchor '${raw.source}' value contains itself`);
    this.#expanding.add(raw);
    this.#aliasDepth++;
    try {
      return this.#decode(this.#targets.get(raw), fn);
    } finally {
      this.#aliasDepth--;
      this.#expanding.delete(raw);
    }
  }

  #scalar(node: Scalar): ScalarValue {
    return resolveScalar(node.tag, node.source ?? String(node.value), node.type !== Scalar.PLAIN);
  }

  // isNull reports a node that decodes to null, which leaves a Go map, slice or struct at its zero value.
  // Any other scalar is a type error there.
  #nullOrWrongScalar(node: unknown): boolean {
    if (node === null || node === undefined) return true;
    if (!isScalar(node)) return false;
    if (!this.#scalar(node).isNull) this.wrongType = true;
    return true;
  }

  // identity is what yaml.v3 compares to find a duplicate key: the node kind and its value.
  #identity(node: unknown): string {
    if (isScalar(node)) return `scalar:${node.source ?? ""}`;
    if (isAlias(node)) return `alias:${node.source}`;
    return isMap(node) ? "map:" : "seq:";
  }

  #isMergeKey(node: unknown): boolean {
    return (
      isScalar(node) &&
      node.type === Scalar.PLAIN &&
      node.source === "<<" &&
      MERGE_TAGS.has(shortTag(node.tag))
    );
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
    return this.#decode(raw, (node) => {
      if (node === null || node === undefined) return undefined;
      if (isScalar(node)) {
        const v = this.#scalar(node);
        return v.isNull ? undefined : v.text;
      }
      if (!(isMap(node) && this.#hasDuplicates(node))) this.wrongType = true;
      return undefined;
    });
  }

  // strings decodes a node into a Go []string. Null entries are dropped.
  strings(raw: unknown): string[] | undefined {
    return this.#decode(raw, (node) => {
      if (this.#nullOrWrongScalar(node)) return undefined;
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
    });
  }

  // mapping decodes a mapping key by key into a Go struct or map, calling onKey for each key. Keys
  // already in merged, the keys of the mapping that merges this one, are skipped. A merge key (<<) is
  // applied after the mapping's own keys, so they win, and the first merged mapping wins over later ones.
  mapping(raw: unknown, onKey: (name: string, value: unknown) => void, merged?: Set<string>): void {
    this.#decode(raw, (node) => {
      if (this.#nullOrWrongScalar(node)) return;
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
      if (hasMerge) this.#merge(node, mergeNode, onKey, merged);
    });
  }

  // merge is yaml.v3's decoder.merge. The first merge at a level collects the merging mapping's keys,
  // decoded as a Go interface{} would hold them, so only string keys shadow merged ones.
  #merge(
    parent: YAMLMap,
    source: unknown,
    onKey: (name: string, value: unknown) => void,
    merged?: Set<string>,
  ): void {
    const keys = merged ?? new Set<string>();
    if (merged === undefined) {
      for (const pair of parent.items) {
        const key = this.#decode(pair.key, (node) => {
          if (!isScalar(node)) return undefined;
          const v = this.#scalar(node);
          return !v.isNull && v.isString ? v.text : undefined;
        });
        if (key !== undefined) keys.add(key);
      }
    }
    const isMapping = (node: unknown): boolean => isMap(isAlias(node) ? this.#targets.get(node) : node);
    const fail = (): never => {
      throw new YamlSyntaxError("map merge requires map or sequence of maps as the value");
    };
    if (isSeq(source)) {
      for (const item of source.items) {
        if (!isMapping(item)) fail();
        this.mapping(item, onKey, keys);
      }
      return;
    }
    if (!isMapping(source)) fail();
    this.mapping(source, onKey, keys);
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

function parse(text: string): AppRegistry {
  checkCharacters(text);
  let docs = parseAllDocuments(text, OPTIONS);
  const rewritten = withoutQuoteEscapes(text, docs);
  if (rewritten !== text) docs = parseAllDocuments(rewritten, OPTIONS);
  const versions = versionDirectives(rewritten, docs);
  const [first, ...rest] = docs;
  if (first === undefined) {
    const [error] = "errors" in docs ? docs.errors : [];
    if (error !== undefined) throw new YamlSyntaxError(error.message);
    throw new AppRegistryParseError("empty");
  }
  const decoder = new Decoder(documentAliases(first, true, versions.get(first) ?? []));
  decoder.count(); // yaml.v3 decodes the document node, then its content.
  const reg = decoder.registry(first.contents);
  const problem = decoder.problem();
  if (problem !== undefined) throw new AppRegistryParseError(problem);
  const second = rest.find((doc) => !isPhantom(doc));
  if (second !== undefined) {
    documentAliases(second, false, versions.get(second) ?? []);
    throw new AppRegistryParseError("second-document");
  }
  return reg;
}

/**
 * Decodes a registry file strictly. It does not apply the policy rules; validateAppRegistry does.
 * Throws AppRegistryParseError when the file does not decode.
 */
export function parseAppRegistry(text: string): AppRegistry {
  try {
    return parse(text);
  } catch (err) {
    if (err instanceof YamlSyntaxError) throw new AppRegistryParseError("syntax", err.message);
    // A document nested deeply enough to exhaust the stack. yaml.v3 stops at a nesting depth of 10000.
    if (err instanceof RangeError) throw new AppRegistryParseError("syntax", "the document nests too deeply");
    throw err;
  }
}

/**
 * Decodes registry file bytes: UTF-8, or UTF-16 after a byte order mark, as yaml.v3 reads them. Invalid
 * encoding is a `syntax` error.
 */
export function parseAppRegistryBytes(bytes: Uint8Array): AppRegistry {
  let text: string;
  try {
    text = decodeInput(bytes);
  } catch (err) {
    if (err instanceof YamlSyntaxError) throw new AppRegistryParseError("syntax", err.message);
    throw err;
  }
  return parseAppRegistry(text);
}
