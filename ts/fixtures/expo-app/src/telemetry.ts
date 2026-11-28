import { screens } from "@libo11y/rum-react-native";
import { setupRumExpo } from "@libo11y/rum-react-native/expo";

/** The fixture's telemetry. EXPO_PUBLIC_O11Y_ENDPOINT points it at a gateway; tests replace fetch. */
export const telemetryReady = setupRumExpo({
  serviceName: "libo11y-fixture",
  environment: "test",
  endpoint: process.env.EXPO_PUBLIC_O11Y_ENDPOINT ?? "https://gateway.invalid/_o11y",
  consent: { initial: "granted" },
  instrumentations: { propagateTo: ["https://api.fixture.test"] },
  rum: { clientToken: "pub-fixture", collectors: [screens()] },
});
