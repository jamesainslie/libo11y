/**
 * The sensitivity policy: the one place every signal asks what to do with an attribute key. Secrets
 * are always dropped. PII is dropped, replaced by a keyed token, or kept, per the PII mode. The spec
 * table classifies first; application registries classify only keys the spec leaves unclassified.
 *
 * Classification is by key. Not covered, as in Go: values under unclassified keys, the members of
 * map-valued span and metric attributes, log bodies, span names, instrumentation scope attributes,
 * what an injected span processor reads in onStart, and baggage.
 */
import {
  type AppRegistry,
  type CompiledAppRegistry,
  compileAppRegistry,
  SENSITIVITY_OF,
  type Sensitivity,
  validateAppRegistry,
} from "@libo11y/spec";
import type { Attributes } from "@opentelemetry/api";
import {
  compareCodePoints,
  MAX_DEPTH,
  renderCanonical,
  renderCanonicalAttribute,
  WALK_BUDGET,
} from "./canonical.ts";
import { duplicateNamespaceError, invalidAppRegistryError, piiHashKeyError } from "./errors.ts";
import { hmacSha256 } from "./hmac.ts";
import { isError } from "./is-error.ts";
import type { LogAttributes, LogValue } from "./log-values.ts";
import { hexEncode, utf8Encode } from "./utf8.ts";

/** How PII-classified attributes are handled. */
export type PIIMode = "drop" | "hash" | "allow";

/** What the policy does to one attribute. */
export type Action = "keep" | "rewrite" | "drop";

/** The signals whose violations the policy counts. Metrics never count. */
export type PolicySignal = "traces" | "logs" | "resource";

/** Where the policy counts violations: o11y.schema.violations, by signal and rule. */
export interface ViolationSink {
  add(signal: string, rule: string, n: number): void;
}

/** The shortest key hash mode accepts: 256 bits. */
export const MIN_PII_HASH_KEY_LENGTH = 32;

/** The violation rule for an attribute of class that classification dropped or rewrote. */
export function ruleFor(sensitivity: Sensitivity | undefined): string {
  return sensitivity === "secret" ? "secret_attribute" : "pii_attribute";
}

/** Options for SensitivityPolicy.create. */
export interface PolicyOptions {
  readonly pii: PIIMode;
  /** The HMAC key, at least 32 bytes, required by hash mode. */
  readonly key?: Uint8Array;
  readonly registries: readonly CompiledAppRegistry[];
  /** A native HMAC-SHA256, such as the platform's. Defaults to the pure one in hmac.ts. */
  readonly hmac?: (key: Uint8Array, data: Uint8Array) => Uint8Array;
}

/**
 * Turns the registry option into compiled registries. A plain registry is validated first; one that
 * breaks a rule throws INVALID_APP_REGISTRY naming it as "registry N" (its 1-based position).
 */
export function compileRegistries(
  registry: AppRegistry | CompiledAppRegistry | readonly (AppRegistry | CompiledAppRegistry)[] | undefined,
): CompiledAppRegistry[] {
  if (registry === undefined) return [];
  const list: readonly (AppRegistry | CompiledAppRegistry)[] = Array.isArray(registry)
    ? registry
    : [registry as AppRegistry | CompiledAppRegistry];
  return list.map((reg, i) => {
    if ("classes" in reg) return reg;
    const result = validateAppRegistry(reg);
    if (!result.ok) {
      throw invalidAppRegistryError(
        `registry ${i + 1}`,
        result.violations.map((v) => v.toString()),
      );
    }
    return compileAppRegistry(reg);
  });
}

function isGroup(v: unknown): v is { readonly [key: string]: unknown } {
  return (
    typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array) && !isError(v)
  );
}

function holdsComposite(arr: readonly unknown[]): boolean {
  return arr.some((e) => Array.isArray(e) || isGroup(e));
}

/** The state of one composite walk: what is on the current path, and the nodes left to visit. */
class CompositeWalk {
  budget: number = WALK_BUDGET;
  readonly onPath: object[] = [];

  spend(): boolean {
    return --this.budget >= 0;
  }
}

/** The sensitivity policy. Immutable: withRecorder and silent return copies. */
export class SensitivityPolicy {
  private readonly pii: PIIMode;
  private readonly key: Uint8Array;
  private readonly app: ReadonlyMap<string, Sensitivity>;
  private readonly hmac: (key: Uint8Array, data: Uint8Array) => Uint8Array;
  private readonly recorder: ViolationSink | undefined;

  private constructor(
    pii: PIIMode,
    key: Uint8Array,
    app: ReadonlyMap<string, Sensitivity>,
    hmac: (key: Uint8Array, data: Uint8Array) => Uint8Array,
    recorder: ViolationSink | undefined,
  ) {
    this.pii = pii;
    this.key = key;
    this.app = app;
    this.hmac = hmac;
    this.recorder = recorder;
  }

  /**
   * Builds a policy. Throws PII_HASH_KEY when hash mode has no key of at least 32 bytes, and
   * INVALID_APP_REGISTRY when two registries declare one namespace.
   */
  static create(opts: PolicyOptions): SensitivityPolicy {
    if (opts.pii === "hash" && (opts.key === undefined || opts.key.length < MIN_PII_HASH_KEY_LENGTH)) {
      throw piiHashKeyError();
    }
    const app = new Map<string, Sensitivity>();
    const declaredBy = new Map<string, string>();
    opts.registries.forEach((reg, i) => {
      const source = reg.source ?? `registry ${i + 1}`;
      const first = declaredBy.get(reg.namespace);
      if (first !== undefined) throw duplicateNamespaceError(first, source, reg.namespace);
      declaredBy.set(reg.namespace, source);
      for (const name of Object.keys(reg.classes)) {
        const cls = reg.classes[name];
        if (cls !== undefined) app.set(name, cls);
      }
    });
    return new SensitivityPolicy(
      opts.pii,
      new Uint8Array(opts.key ?? new Uint8Array(0)),
      app,
      opts.hmac ?? hmacSha256,
      undefined,
    );
  }

  /** A copy that counts violations on rec. */
  withRecorder(rec: ViolationSink): SensitivityPolicy {
    return new SensitivityPolicy(this.pii, this.key, this.app, this.hmac, rec);
  }

  /** A copy that decides the same but counts nothing, for a second pass over data already counted. */
  silent(): SensitivityPolicy {
    return new SensitivityPolicy(this.pii, this.key, this.app, this.hmac, undefined);
  }

  /** The class of key: the spec table first, then the application registries. */
  classOf(key: string): Sensitivity | undefined {
    return SENSITIVITY_OF.get(key) ?? this.app.get(key);
  }

  /** What the policy does to a key of the given class, without counting. */
  actionForClass(sensitivity: Sensitivity | undefined): Action {
    switch (sensitivity) {
      case "secret":
        return "drop";
      case "pii":
        return this.pii === "allow" ? "keep" : this.pii === "hash" ? "rewrite" : "drop";
      default:
        return "keep";
    }
  }

  /** What the policy does to key, without counting. */
  actionFor(key: string): Action {
    return this.actionForClass(this.classOf(key));
  }

  /** The token for a canonical rendering: "hmac-sha256:" and the hex of the first 16 MAC bytes. */
  token(canonical: string): string {
    return `hmac-sha256:${hexEncode(this.hmac(this.key, utf8Encode(canonical)).subarray(0, 16))}`;
  }

  /** The token for value, rendered canonically with the log walk's bounds. */
  tokenOf(value: unknown): string {
    return this.token(renderCanonical(value));
  }

  /** Counts n violations of rule on signal. */
  record(signal: PolicySignal, rule: string, n = 1): void {
    if (n > 0) this.recorder?.add(signal, rule, n);
  }

  // decide classifies key, counts any drop or rewrite, and returns the action.
  private decide(signal: PolicySignal, key: string): Action {
    const cls = this.classOf(key);
    const act = this.actionForClass(cls);
    if (act !== "keep") this.record(signal, ruleFor(cls));
    return act;
  }

  /**
   * Classifies flat attributes, as spans, the resource and bridge logs carry them: a map value is
   * judged on its own key, its members are not walked. Returns attrs itself when nothing changes.
   */
  attributes(signal: PolicySignal, attrs: Attributes): Attributes {
    let out: Record<string, unknown> | undefined;
    const keys = Object.keys(attrs);
    keys.forEach((k, i) => {
      const act = this.decide(signal, k);
      if (act === "keep" && out === undefined) return;
      if (out === undefined) {
        out = {};
        for (const prev of keys.slice(0, i)) out[prev] = attrs[prev];
      }
      if (act === "keep") out[k] = attrs[k];
      else if (act === "rewrite") out[k] = this.token(renderCanonicalAttribute(attrs[k]));
    });
    return out ?? attrs;
  }

  /**
   * Classifies metric attributes: secrets and PII are dropped (PII is kept only in allow mode, never
   * tokenized, because a token per value multiplies series). Never counted. Returns attrs itself
   * when nothing changes.
   */
  metricAttributes(attrs: Attributes): Attributes {
    let out: Record<string, unknown> | undefined;
    const keys = Object.keys(attrs);
    keys.forEach((k, i) => {
      const cls = this.classOf(k);
      const keep = cls !== "secret" && (cls !== "pii" || this.pii === "allow");
      if (keep && out === undefined) return;
      if (out === undefined) {
        out = {};
        for (const prev of keys.slice(0, i)) out[prev] = attrs[prev];
      }
      if (keep) out[k] = attrs[k];
    });
    return out ?? attrs;
  }

  /**
   * Classifies log attributes. Group members (plain objects) are judged on their dotted keys, arrays
   * holding groups are walked on the holder's key, and a value under a classified key is judged
   * whole. The walk fails closed: past depth 16, on a cycle, or once 2048 nodes are spent, what
   * remains is dropped. A group or array emptied by classification is dropped. Each drop or rewrite
   * counts once on the logs signal. Returns attrs itself when nothing changes.
   */
  logAttributes(attrs: LogAttributes): LogAttributes {
    const walk = new CompositeWalk();
    const result = this.classifyMembers([], attrs, 0, walk, false);
    return result.changed ? (result.value as LogAttributes) : attrs;
  }

  // classifyMembers classifies the members of a group at path. The top level is not a composite
  // node, so it spends no budget and is never dropped for being empty.
  private classifyMembers(
    path: readonly string[],
    group: { readonly [key: string]: unknown },
    depth: number,
    walk: CompositeWalk,
    nested: boolean,
  ): { value: { [key: string]: unknown }; keep: boolean; changed: boolean } {
    // Members are visited in UTF-8 key order, as Go visits map members, so truncation is
    // deterministic. The output keeps the group's own order.
    const keys = Object.keys(group);
    const visit = nested ? [...keys].sort(compareCodePoints) : keys;
    const kept = new Map<string, unknown>();
    let changed = false;
    for (const k of visit) {
      if (nested && !walk.spend()) {
        changed = true; // the budget is spent: drop the remaining members
        break;
      }
      const r = this.classifyEntry(path, k, group[k], depth, walk);
      changed ||= r.changed;
      if (r.keep) kept.set(k, r.value);
    }
    if (!changed) return { value: group as { [key: string]: unknown }, keep: true, changed: false };
    const out: { [key: string]: unknown } = {};
    for (const k of keys) if (kept.has(k)) out[k] = kept.get(k);
    return { value: out, keep: !nested || Object.keys(out).length > 0, changed: true };
  }

  private classifyEntry(
    path: readonly string[],
    key: string,
    value: unknown,
    depth: number,
    walk: CompositeWalk,
  ): { value: unknown; keep: boolean; changed: boolean } {
    // Empty segments are skipped: an empty-keyed group is inlined into its parent, so its members
    // are judged on the parent's path.
    const effective = [...path, key].filter((segment) => segment !== "").join(".");
    switch (this.decide("logs", effective)) {
      case "drop":
        return { value: undefined, keep: false, changed: true };
      case "rewrite":
        return { value: this.tokenOf(value), keep: true, changed: true };
    }
    if (isGroup(value) || (Array.isArray(value) && holdsComposite(value))) {
      return this.classifyComposite([...path, key], value, depth, walk);
    }
    return { value, keep: true, changed: false };
  }

  // classifyComposite walks a group or an array that holds one, held at path.
  private classifyComposite(
    path: readonly string[],
    value: object,
    depth: number,
    walk: CompositeWalk,
  ): { value: unknown; keep: boolean; changed: boolean } {
    if (depth >= MAX_DEPTH || path.length > MAX_DEPTH || !walk.spend() || walk.onPath.includes(value)) {
      return { value: undefined, keep: false, changed: true };
    }
    walk.onPath.push(value);
    try {
      if (!Array.isArray(value)) {
        return this.classifyMembers(
          path,
          value as { readonly [key: string]: unknown },
          depth + 1,
          walk,
          true,
        );
      }
      const out: unknown[] = [];
      let changed = false;
      for (const e of value as readonly LogValue[]) {
        if (!walk.spend()) {
          changed = true; // the budget is spent: drop the remaining elements
          break;
        }
        if (!(isGroup(e) || (Array.isArray(e) && holdsComposite(e)))) {
          out.push(e);
          continue;
        }
        const r = this.classifyComposite(path, e, depth + 1, walk);
        changed ||= r.changed;
        if (r.keep) out.push(r.value);
      }
      if (!changed) return { value, keep: true, changed: false };
      return { value: out, keep: out.length > 0, changed: true };
    } finally {
      walk.onPath.pop();
    }
  }
}
