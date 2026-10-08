// Pure-logic unit tests for the app's lib/ helpers. The jest-expo preset
// transforms TS/JSX and mocks React Native + Expo native modules so these run
// in Node without a device. UI/E2E (Detox) is intentionally out of scope here.
module.exports = {
  preset: "jest-expo",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  testMatch: ["<rootDir>/**/__tests__/**/*.test.ts?(x)"],
};
