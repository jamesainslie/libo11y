/**
 * What an Expo app knows about itself: the native app version (expo-application), the over-the-air
 * update it runs (expo-updates) and the kind of device (expo-device). expo.ts passes the real
 * modules; tests pass plain objects, so this module imports nothing from Expo.
 */

/** The parts of expo-application, expo-updates and expo-device the telemetry reads. */
export interface ExpoModulesLike {
  readonly application: { readonly nativeApplicationVersion: string | null };
  readonly updates: {
    readonly isEnabled: boolean;
    readonly isEmbeddedLaunch: boolean;
    readonly updateId: string | null;
  };
  /** expo-device's deviceType: 0 unknown, 1 phone, 2 tablet, 3 desktop, 4 TV. */
  readonly device: { readonly deviceType: number | null };
}

/**
 * What the telemetry takes from Expo.
 */
export interface ExpoAppInfo {
  /** expo-application's nativeApplicationVersion, such as "1.0.0". */
  readonly serviceVersion?: string;
  /**
   * The ID of the over-the-air update the app runs, from expo-updates. Absent for the bundle
   * embedded in the build, in development and when updates are disabled.
   */
  readonly updateId?: string;
  /** The device class expo-device reports. Absent when it does not know. */
  readonly deviceClass?: "mobile" | "tablet" | "desktop" | "tv";
}

const DEVICE_CLASSES: ReadonlyMap<number, NonNullable<ExpoAppInfo["deviceClass"]>> = new Map([
  [1, "mobile"],
  [2, "tablet"],
  [3, "desktop"],
  [4, "tv"],
]);

/** read(), or undefined when it throws, as a native module that is not linked does. */
function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * The app version, the update ID only for an over-the-air launch (updates enabled, not the
 * embedded bundle, a non-empty ID) and the device class. A field a module cannot give is left out.
 */
export function expoAppInfoFrom(m: ExpoModulesLike): ExpoAppInfo {
  const version = safely(() => m.application.nativeApplicationVersion);
  const updateId = safely(() => {
    const u = m.updates;
    return u.isEnabled && !u.isEmbeddedLaunch && typeof u.updateId === "string" && u.updateId !== ""
      ? u.updateId
      : undefined;
  });
  const deviceType = safely(() => m.device.deviceType);
  const deviceClass = typeof deviceType === "number" ? DEVICE_CLASSES.get(deviceType) : undefined;
  return {
    ...(typeof version === "string" && version !== "" ? { serviceVersion: version } : {}),
    ...(updateId === undefined ? {} : { updateId }),
    ...(deviceClass === undefined ? {} : { deviceClass }),
  };
}
