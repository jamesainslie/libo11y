/**
 * Application attribute registries: the file in which a libo11y consumer declares its own namespaced
 * attributes with their type, sensitivity and cardinality. validateAppRegistry applies the same rules as
 * Go's appregistry.Validate, in the same order and with the same messages. Parsing the YAML file lives
 * in the `@libo11y/spec/yaml` subpath, so this module has no dependencies and runs in a browser.
 */
import { APP_REGISTRY_SCHEMA, APP_RESERVED_NAMESPACES, type Sensitivity } from "./generated/tables.ts";
import { goQuote } from "./goquote.ts";

/** One declared application attribute. */
export interface AppRegistryAttribute {
  readonly type: string;
  readonly sensitivity: string;
  readonly cardinality: string;
  readonly values?: readonly string[];
  readonly brief?: string;
}

/** A parsed application registry. */
export interface AppRegistry {
  readonly schema: string;
  readonly namespace: string;
  readonly attributes: Readonly<Record<string, AppRegistryAttribute>>;
}

/** One rule a registry breaks. attribute is undefined for a rule about the registry as a whole. */
export class AppRegistryViolation {
  readonly ruleId: string;
  readonly attribute: string | undefined;
  readonly detail: string;

  constructor(ruleId: string, attribute: string | undefined, detail: string) {
    this.ruleId = ruleId;
    this.attribute = attribute;
    this.detail = detail;
  }

  /** Renders the violation as Go's Violation.String does. */
  toString(): string {
    return this.attribute === undefined
      ? `${this.ruleId}: ${this.detail}`
      : `${this.ruleId}: attribute ${this.attribute}: ${this.detail}`;
  }
}

/** The result of validating a registry: the registry itself, or every violation in rule order. */
export type AppRegistryResult =
  | { readonly ok: true; readonly registry: AppRegistry }
  | { readonly ok: false; readonly violations: readonly AppRegistryViolation[] };

/** The build-time form of a valid registry: each attribute's sensitivity class. JSON-serializable. */
export interface CompiledAppRegistry {
  readonly namespace: string;
  readonly classes: Readonly<Record<string, Sensitivity>>;
  /** Where the registry came from, such as its file path, for error messages. */
  readonly source?: string;
}

/** Thrown by compileAppRegistry for a registry that breaks a rule. */
export class AppRegistryError extends Error {
  readonly violations: readonly AppRegistryViolation[];

  constructor(violations: readonly AppRegistryViolation[]) {
    super(`invalid application registry: ${violations.map((v) => v.toString()).join("; ")}`);
    this.name = "AppRegistryError";
    this.violations = violations;
  }
}

// One snake_case segment.
const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
// A dotted snake_case name with at least two segments (Go specrules.ValidName).
const NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$/;

const ATTRIBUTE_TYPES: ReadonlySet<string> = new Set([
  "string",
  "boolean",
  "int",
  "double",
  "string[]",
  "boolean[]",
  "int[]",
  "double[]",
]);
const SENSITIVITIES: ReadonlySet<string> = new Set(["public", "internal", "pii", "secret"]);
const CARDINALITIES: ReadonlySet<string> = new Set(["enum", "bounded", "unbounded"]);

// Go's strings.TrimSpace: the Unicode White_Space property, which includes U+0085 and excludes U+FEFF.
function trimSpace(s: string): string {
  return s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

// Orders strings by code point, which is UTF-8 byte order. The default sort compares UTF-16 code units.
function compareCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done === true) return y.done === true ? 0 : -1;
    if (y.done === true) return 1;
    const d = (x.value.codePointAt(0) ?? 0) - (y.value.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
}

type Fail = (rule: string, attr: string | undefined, detail: string) => void;

// The registry-level rules on the namespace.
function checkNamespace(namespace: string, fail: Fail): void {
  if (!NAMESPACE_PATTERN.test(namespace)) {
    fail(
      "libo11y_app_namespace_invalid",
      undefined,
      `namespace ${goQuote(namespace)} is not one snake_case segment`,
    );
  } else if (APP_RESERVED_NAMESPACES.has(namespace)) {
    fail(
      "libo11y_app_namespace_reserved",
      undefined,
      `namespace ${goQuote(namespace)} belongs to libo11y, OpenTelemetry, or semconv`,
    );
  }
}

function failEmpty(fail: Fail): void {
  fail("libo11y_app_attributes_empty", undefined, "the registry declares no attributes");
}

// The rules on an attribute's name.
function checkName(namespace: string, name: string, fail: Fail): void {
  if (!name.startsWith(`${namespace}.`)) {
    fail("libo11y_app_attr_outside_namespace", name, `not under the ${namespace} namespace`);
  }
  if (!NAME_PATTERN.test(name)) {
    fail("libo11y_attr_naming", name, "not a dotted snake_case name with at least two segments");
  }
}

// The rules on an attribute's sensitivity class.
function checkSensitivity(name: string, sensitivity: string, fail: Fail): void {
  if (sensitivity === "") {
    fail("libo11y_sensitivity_missing", name, "no sensitivity class");
  } else if (!SENSITIVITIES.has(sensitivity)) {
    fail("libo11y_sensitivity_unknown", name, `sensitivity ${goQuote(sensitivity)}`);
  }
}

/**
 * Applies the policy rules and returns every violation: registry-level rules first, then each attribute
 * in name order, each attribute's rules in a fixed order.
 */
export function validateAppRegistry(reg: AppRegistry): AppRegistryResult {
  const violations: AppRegistryViolation[] = [];
  const fail: Fail = (rule, attr, detail) => {
    violations.push(new AppRegistryViolation(rule, attr, detail));
  };

  if (reg.schema !== APP_REGISTRY_SCHEMA) {
    fail(
      "libo11y_app_schema_unknown",
      undefined,
      `schema ${goQuote(reg.schema)}, want ${goQuote(APP_REGISTRY_SCHEMA)}`,
    );
  }
  checkNamespace(reg.namespace, fail);
  const names = Object.keys(reg.attributes).sort(compareCodePoints);
  if (names.length === 0) failEmpty(fail);

  for (const name of names) {
    const a = reg.attributes[name] as AppRegistryAttribute;
    const values = a.values ?? [];
    checkName(reg.namespace, name, fail);
    if (!ATTRIBUTE_TYPES.has(a.type)) {
      fail("libo11y_app_type_unknown", name, `type ${goQuote(a.type)}`);
    }
    checkSensitivity(name, a.sensitivity, fail);
    if (a.cardinality === "") {
      fail("libo11y_cardinality_missing", name, "no cardinality budget");
    } else if (!CARDINALITIES.has(a.cardinality)) {
      fail("libo11y_cardinality_unknown", name, `cardinality ${goQuote(a.cardinality)}`);
    }
    if (a.cardinality === "enum" && values.length === 0) {
      fail("libo11y_app_enum_values_missing", name, "an enum declares its values");
    } else if (a.cardinality !== "enum" && values.length > 0) {
      fail("libo11y_app_values_without_enum", name, "values need cardinality enum");
    }
    const seen = new Set<string>();
    for (const v of values) {
      const trimmed = trimSpace(v);
      if (v !== trimmed) {
        fail("libo11y_enum_value_whitespace", name, `value ${goQuote(v)}`);
      }
      if (seen.has(trimmed)) {
        fail("libo11y_enum_duplicate_value", name, `value ${goQuote(v)}`);
      }
      seen.add(trimmed);
    }
  }
  return violations.length === 0 ? { ok: true, registry: reg } : { ok: false, violations };
}

/** The result of validating a compiled registry: the registry itself, or every violation in rule order. */
export type CompiledAppRegistryResult =
  | { readonly ok: true; readonly registry: CompiledAppRegistry }
  | { readonly ok: false; readonly violations: readonly AppRegistryViolation[] };

/**
 * Applies the rules that still apply to the compiled form, in validateAppRegistry's order and with its
 * messages: the namespace, then each key in name order for its namespace, its naming and its class. A
 * compiled registry is a plain structural type, so one built by hand or read from JSON may break them.
 * A classes member that is not an object, or is empty, declares no attributes. Anything
 * compileAppRegistry returned passes.
 */
export function validateCompiledAppRegistry(reg: CompiledAppRegistry): CompiledAppRegistryResult {
  const violations: AppRegistryViolation[] = [];
  const fail: Fail = (rule, attr, detail) => {
    violations.push(new AppRegistryViolation(rule, attr, detail));
  };
  // The input may be deserialized, so nothing about its shape is assumed.
  const namespace: unknown = reg.namespace;
  const ns = typeof namespace === "string" ? namespace : "";
  checkNamespace(ns, fail);
  const classes: unknown = reg.classes;
  const isObject = typeof classes === "object" && classes !== null && !Array.isArray(classes);
  const names = isObject ? Object.keys(classes).sort(compareCodePoints) : [];
  if (names.length === 0) failEmpty(fail);
  for (const name of names) {
    checkName(ns, name, fail);
    const sensitivity: unknown = (classes as Record<string, unknown>)[name];
    checkSensitivity(
      name,
      sensitivity === undefined || sensitivity === null ? "" : String(sensitivity),
      fail,
    );
  }
  return violations.length === 0 ? { ok: true, registry: reg } : { ok: false, violations };
}

/**
 * Validates reg and returns each attribute's sensitivity class, the form a browser build embeds. The
 * classes object has no prototype, so a lookup never reaches Object.prototype, and both objects are
 * frozen. Throws AppRegistryError when reg breaks a rule.
 */
export function compileAppRegistry(reg: AppRegistry): CompiledAppRegistry {
  const result = validateAppRegistry(reg);
  if (!result.ok) throw new AppRegistryError(result.violations);
  const classes: Record<string, Sensitivity> = Object.create(null);
  for (const name of Object.keys(reg.attributes).sort(compareCodePoints)) {
    // Validation guarantees every class is a known sensitivity.
    classes[name] = (reg.attributes[name] as AppRegistryAttribute).sensitivity as Sensitivity;
  }
  return Object.freeze({ namespace: reg.namespace, classes: Object.freeze(classes) });
}
