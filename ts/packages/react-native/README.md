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

## Status

In development. The package is not released and not on npm. The Expo
entry point, `@libo11y/react-native/expo`, and the RUM package
`@libo11y/rum-react-native` come in later steps.
