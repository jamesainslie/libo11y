# @libo11y/spec

The libo11y telemetry specification for TypeScript. It holds the attribute
keys, enums, event and metric names, and sensitivity tables generated from
the libo11y spec registry, and a validator for application attribute
registries. It runs on Node, Bun and in browsers. The root entry point has
no dependencies.

```sh
npm install @libo11y/spec
```

## Spec constants

```ts
import { ATTR_OUTCOME, SCHEMA_URL, SENSITIVITY_OF } from "@libo11y/spec";

SENSITIVITY_OF.get("o11y.tenant.id"); // "internal"
```

## Application registries

An application registry declares an application's own namespaced
attributes with their type, sensitivity and cardinality:

```yaml
schema: libo11y.app-registry/v1
namespace: shop
attributes:
  shop.order.id: { type: string, sensitivity: internal, cardinality: unbounded }
```

`validateAppRegistry` applies the libo11y policy rules with the same rule
IDs and messages as the Go implementation. `compileAppRegistry` turns a
valid registry into a frozen table of sensitivity classes, which a browser
build can embed as JSON:

```ts
import { compileAppRegistry, validateAppRegistry } from "@libo11y/spec";

const result = validateAppRegistry(registry);
if (!result.ok) for (const v of result.violations) console.error(v.toString());
const compiled = compileAppRegistry(registry); // throws AppRegistryError when invalid
```

The `@libo11y/spec/yaml` subpath reads a registry file. It decodes the
YAML exactly as the Go implementation does, and it is the only module that
depends on a YAML parser:

```ts
import { parseAppRegistryBytes } from "@libo11y/spec/yaml";
import { readFileSync } from "node:fs";

const registry = parseAppRegistryBytes(readFileSync("o11y-registry.yaml"));
```

A file that does not decode throws `AppRegistryParseError`, whose `kind`
names the problem: `empty`, `second-document`, `duplicate-key`,
`unknown-key`, `type` or `syntax`.

## The libo11y command

`libo11y registry check FILE...` validates registry files, for use in CI.
It prints the same lines and exits with the same status as the Go binary:
0 when every file is valid, 1 when a file breaks a policy rule, and 2 on a
usage, read or parse error.

```sh
npx libo11y registry check o11y-registry.yaml
```

## Reference

The specification itself is
[docs/SPEC.md](https://github.com/jamesainslie/libo11y/blob/main/docs/SPEC.md).
