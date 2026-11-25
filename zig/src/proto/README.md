# Vendored OTLP bindings

The Zig files under this directory are the OTLP protobuf bindings that
[open-telemetry/opentelemetry-zig](https://github.com/open-telemetry/opentelemetry-zig)
generates and commits. They are copied unchanged from its
`opentelemetry-proto/src/` directory at commit
`64627959e72480505bdb46dc25764a211ab498bc` (2026-11-23).

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

4. Run `make zig-check` from the repository root.

Do not edit the generated files by hand. The one change allowed is the
`@import("protobuf")` path, should the runtime module ever need another
name.
