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

Each file is validated on its own, as in the Go and TypeScript tools. Two
files that declare the same namespace both pass when each is valid.

Exit statuses (when checking multiple files, the highest status wins):

- `0`: every file is valid (or help was requested with `-h`, `--help`, or `help`).
- `1`: at least one file breaks a policy rule.
- `2`: usage error, file read error, or YAML parse error.
