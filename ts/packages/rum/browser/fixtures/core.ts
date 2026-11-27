/** The R3a fixture: setupRum with no collectors, driven by window.__rumStart. */
import { setupRum } from "@libo11y/rum";
import { runtimeOf } from "@libo11y/rum/internal";

interface FixtureOptions {
  readonly endpoint: string;
  readonly consent?: "pending" | "granted";
  readonly sessionSampleRate?: number;
  readonly queryAllowList?: readonly string[];
  readonly clientToken?: string;
}

const w = globalThis as unknown as Record<string, unknown>;
w.__rumStart = async (o: FixtureOptions): Promise<void> => {
  const telemetry = await setupRum({
    serviceName: "rum-fixture",
    serviceVersion: "1.0.0",
    environment: "test",
    endpoint: o.endpoint,
    consent: { initial: o.consent ?? "granted" },
    transport: { compression: "none" },
    rum: {
      ...(o.sessionSampleRate === undefined ? {} : { sessionSampleRate: o.sessionSampleRate }),
      ...(o.queryAllowList === undefined ? {} : { queryAllowList: o.queryAllowList }),
      ...(o.clientToken === undefined ? {} : { clientToken: o.clientToken }),
    },
  });
  w.__rum = { telemetry, runtime: runtimeOf(telemetry) };
};
