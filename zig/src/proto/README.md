# Vendored OTLP bindings

The Zig files under this directory are the OTLP protobuf bindings that
[open-telemetry/opentelemetry-zig](https://github.com/open-telemetry/opentelemetry-zig)
generates and commits. They are copied from its `opentelemetry-proto/src/` directory at commit
`64627959e72480505bdb46dc25764a211ab498bc` (2026-11-23), unchanged except
for one rename described below.

- **Origin and license.** The files come from opentelemetry-zig under the
  Apache License 2.0. Its license text is in [LICENSE](LICENSE). The
  bindings are generated from the
  [opentelemetry-proto](https://github.com/open-telemetry/opentelemetry-proto)
  definitions at tag `v1.11.0` (commit
  `790608c4d51e6ffc12210b541e8514cbed9e91a4`), which are also Apache-2.0.
- **Generator.** protoc-gen-zig from
  [zig-protobuf](https://github.com/Arwalk/zig-protobuf) at commit
  `e9e18c7664b8c950e5fc679259c968dd66ccc48b`, which is the commit
  opentelemetry-zig pins.
- **Runtime.** The files import the module `protobuf`. libo11y builds them
  against zig-protobuf at commit `94b9e065dae3dd7ee6f0d75d59e8f1505a3a70fe`,
  the pin in `zig/build.zig.zon`, which carries the decoder hardening the
  older commit lacks. `zig/src/proto_roundtrip_test.zig` checks that every
  OTLP export request libo11y sends round-trips through this pairing.
- **Why vendored.** Depending on opentelemetry-zig made every consumer
  fetch about 6 MB, including a prebuilt protoc binary, to use these few
  files. libo11y uses nothing else from that package.

## The one change: `logs` becomes `log`

Upstream keeps the logs bindings in directories named `logs`
(`opentelemetry/proto/logs/` and `opentelemetry/proto/collector/logs/`).
Common global gitignore files ignore every directory named `logs`, which
silently left those files out of a commit. Here the two directories are
named `log`, and the three imports that name them are changed to match:
two in `root.zig` and one in `opentelemetry/proto/collector/log/v1.pb.zig`.
The module names (`logs_v1`, `collector_logs_v1`) and the file contents
are otherwise as generated.

## Regenerating

Regenerate only to move to a newer opentelemetry-zig commit or OTLP
release, and update the commits above in the same change.

1. Clone opentelemetry-zig and check out the new commit.
2. Optionally regenerate there with `zig build proto-generate`, which
   needs `protoc` and fetches the pinned `.proto` sources. Upstream
   commits the generated files, so a plain checkout already has them.
3. Replace everything here except this README and LICENSE with the
   contents of upstream's `opentelemetry-proto/src/`:

   ```sh
   rsync -a --delete --exclude README.md --exclude LICENSE \
     <opentelemetry-zig>/opentelemetry-proto/src/ zig/src/proto/
   cp <opentelemetry-zig>/LICENSE zig/src/proto/LICENSE
   ```

4. Rename the two `logs` directories to `log` and fix the three imports,
   as described above:

   ```sh
   cd zig/src/proto
   mv opentelemetry/proto/logs opentelemetry/proto/log
   mv opentelemetry/proto/collector/logs opentelemetry/proto/collector/log
   sed -i.bak -e 's|proto/collector/logs/|proto/collector/log/|' -e 's|proto/logs/|proto/log/|' root.zig
   sed -i.bak 's|"../../logs/v1.pb.zig"|"../../log/v1.pb.zig"|' opentelemetry/proto/collector/log/v1.pb.zig
   rm root.zig.bak opentelemetry/proto/collector/log/v1.pb.zig.bak
   ```

5. Check that `git status` lists every generated file, then run
   `make zig-check` from the repository root.

Do not edit the generated files by hand beyond the rename above. The
only other change allowed is the `@import("protobuf")` path, should the
runtime module ever need another name.
