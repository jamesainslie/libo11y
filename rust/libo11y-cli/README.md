# libo11y-cli

The `libo11y` command-line tool for Rust consumers. It validates application
attribute registries (`o11y-registry.yaml`) against the libo11y policy rules,
matching the Go (`go/cmd/libo11y`) and TypeScript (`@libo11y/spec`) binaries.

## Installation

```sh
cargo install libo11y-cli
```

## Usage

```sh
libo11y registry check o11y-registry.yaml [MORE_FILES...]
```

Exit statuses (when checking multiple files, the highest status wins):

- `0`: every file is valid (or help was requested with `-h`, `--help`, or `help`).
- `1`: at least one file breaks a policy rule or repeats a namespace already
  declared by an earlier file in the same invocation.
- `2`: usage error, file read error, or YAML parse error.
