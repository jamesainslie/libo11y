/** jest-expo with real React Native JavaScript; the @libo11y and OpenTelemetry packages are ESM. */
module.exports = {
  preset: "jest-expo",
  setupFilesAfterEnv: ["./jest.setup.js"],
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  transformIgnorePatterns: [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|expo-router|standard-navigation|@libo11y/.*|@opentelemetry/.*))",
  ],
};
