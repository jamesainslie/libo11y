/**
 * The rum-connect fixture: after window.__rumStart, a "Sign" button that calls the unary RPC
 * lor.signing.v1.SigningService/SignDocument through a connect-web transport in the JSON format,
 * under the base URL /connect. The spec answers the RPC with page.route. The service descriptor is
 * built at runtime, as generated code would embed it.
 */
import { create, createFileRegistry, type DescMethod, type DescMethodUnary } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema, file_google_protobuf_empty } from "@bufbuild/protobuf/wkt";
import { createConnectTransport } from "@connectrpc/connect-web";
import { actions, errors, setupRum, views } from "@libo11y/rum";
import { connectRequestNaming } from "@libo11y/rum-connect";

interface FixtureOptions {
  readonly endpoint: string;
}

const registry = createFileRegistry(
  create(FileDescriptorProtoSchema, {
    name: "lor/signing/v1/signing.proto",
    package: "lor.signing.v1",
    dependency: ["google/protobuf/empty.proto"],
    syntax: "proto3",
    service: [
      {
        name: "SigningService",
        method: [
          { name: "SignDocument", inputType: ".google.protobuf.Empty", outputType: ".google.protobuf.Empty" },
        ],
      },
    ],
  }),
  (name) => (name === "google/protobuf/empty.proto" ? file_google_protobuf_empty : undefined),
);
function unary(m: DescMethod | undefined): DescMethodUnary {
  if (m?.methodKind !== "unary") throw new Error("fixture: SignDocument is not a unary method");
  // DescMethod is not a discriminated union, so the check above does not narrow it.
  return m as DescMethodUnary;
}
const signDocument = unary(registry.getService("lor.signing.v1.SigningService")?.methods[0]);

const w = globalThis as unknown as Record<string, unknown>;
w.__rumStart = async (o: FixtureOptions): Promise<void> => {
  const telemetry = await setupRum({
    serviceName: "rum-connect-fixture",
    serviceVersion: "1.0.0",
    environment: "test",
    endpoint: o.endpoint,
    consent: { initial: "granted" },
    transport: { compression: "none" },
    rum: { collectors: [views(), actions(), errors()] },
  });
  connectRequestNaming(telemetry.rum, { services: ["lor.signing.v1.SigningService"] });
  w.__rum = { telemetry };
  const transport = createConnectTransport({ baseUrl: "/connect", useBinaryFormat: false });
  const out = document.createElement("p");
  const button = document.createElement("button");
  button.setAttribute("data-o11y", "Sign");
  button.textContent = "Sign";
  button.addEventListener("click", () => {
    void transport.unary(signDocument, undefined, undefined, undefined, {}).then(() => {
      out.textContent = "signed";
    });
  });
  document.body.append(button, out);
};
