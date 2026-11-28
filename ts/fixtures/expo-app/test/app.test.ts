/**
 * The fixture app itself: expo-router renders the home route from src/app, the root layout's
 * import of src/telemetry.ts sets up RUM with the Expo resource, and the home screen reaches the
 * React Native handle through rum-react's provider.
 */
import { runtimeOf } from "@libo11y/rum-react-native/internal";
import { renderRouter, screen, waitFor } from "expo-router/testing-library";
import { telemetryReady } from "../src/telemetry";

test("the app renders home, and its telemetry is set up with the Expo resource", async () => {
  const t = await telemetryReady;
  try {
    await renderRouter("./src/app");
    expect(await screen.findByText("home")).toBeTruthy();
    expect(t.resource.attributes["service.name"]).toBe("libo11y-fixture");
    expect(t.resource.attributes["o11y.rum.app.update_id"]).toBe("11111111-2222-4333-8444-555555555555");
    expect(t.consent.state()).toBe("granted");
    // The home screen names itself through rum-react's useRum, inside the layout's RumProvider.
    await waitFor(() => expect(runtimeOf(t)?.views.current()?.name).toBe("/"));
  } finally {
    // renderRouter turns on fake timers; the shutdown flush needs real ones.
    jest.useRealTimers();
    await t.shutdown();
  }
});
