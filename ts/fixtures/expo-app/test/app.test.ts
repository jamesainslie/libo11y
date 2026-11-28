/**
 * The fixture app itself: expo-router renders the home route from src/app, and the root layout's
 * import of src/telemetry.ts sets up telemetry with the Expo resource.
 */
import { renderRouter, screen } from "expo-router/testing-library";
import { telemetryReady } from "../src/telemetry";

test("the app renders home, and its telemetry is set up with the Expo resource", async () => {
  const t = await telemetryReady;
  try {
    await renderRouter("./src/app");
    expect(await screen.findByText("home")).toBeTruthy();
    expect(t.resource.attributes["service.name"]).toBe("libo11y-fixture");
    expect(t.resource.attributes["o11y.rum.app.update_id"]).toBe("11111111-2222-4333-8444-555555555555");
    expect(t.consent.state()).toBe("granted");
  } finally {
    // renderRouter turns on fake timers; the shutdown flush needs real ones.
    jest.useRealTimers();
    await t.shutdown();
  }
});
