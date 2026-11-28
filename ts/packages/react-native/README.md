# @libo11y/react-native

The libo11y platform for React Native apps on Hermes. It sets up the
OpenTelemetry JS providers with a mobile resource, sends OTLP/HTTP JSON to
a collector or the RUM gateway, saves every batch on device storage
before it is sent, flushes when the app goes to the background, gates
everything on consent, and records fetch and XHR client spans.

```sh
npm install @libo11y/react-native
```

It needs React Native 0.88 or later as a peer dependency.

## Expo

An Expo app imports `setupExpo` from `@libo11y/react-native/expo`:

```ts
import { setupExpo } from "@libo11y/react-native/expo";

const telemetry = await setupExpo({
  serviceName: "my-app",
  environment: "production",
  endpoint: "https://app.example.com/_o11y",
  consent: { initial: "pending" },
});
```

`setupExpo` is `setupReactNative` with these Expo options under the app's
own:

- `storage` is `expoFileStorage()`, one file per key in the `libo11y`
  directory of the app's documents (`expo-file-system`). The directory is
  created on the first write, not before. Each value goes to a temporary
  file that then replaces the key's file, so an app killed mid-write keeps
  the old value.
- `serviceVersion` is the native app version (`expo-application`).
- `o11y.rum.app.update_id` is the ID of the over-the-air update the app
  runs (`expo-updates`). It is absent for the bundle embedded in the
  build, in development and when updates are disabled. The RUM gateway
  uses it to find the source maps of that update.
- `o11y.rum.device.class` comes from `expo-device` when it knows the
  device type.

An option the app sets wins, and `resourceAttributes` merge key by key.
An attribute the app sets in `env` (`OTEL_RESOURCE_ATTRIBUTES`) also beats
Expo's, `service.version` included.
`expoOptions()`, `expoAppInfo()` and `expoFileStorage()` are exported for
apps that call `setupReactNative` themselves.

The entry imports `expo-application`, `expo-device`, `expo-file-system`
and `expo-updates`. They are optional peer dependencies: an app that
imports `./expo` installs them, at Expo SDK 58 or later. The main entry
imports none of them. Tested on Expo SDK 58 only.

## Status

A preview. The package first ships in `ts/v0.4.0`, and its API can change
in a minor release until the RUM package for React Native,
`@libo11y/rum-react-native`, ships on top of it. It is not on npm yet.
Until its first npm publish, install it from the tarball attached to the
[`ts/v0.4.0` GitHub Release](https://github.com/jamesainslie/libo11y/releases/tag/ts/v0.4.0),
whose notes list the exact URL:

```sh
npm install \
  https://github.com/jamesainslie/libo11y/releases/download/ts/v0.4.0/libo11y-react-native-0.4.0.tgz
```
