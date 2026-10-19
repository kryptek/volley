import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15000,
    hookTimeout: 15000,
    // A CLI a test starts as a child process never uses the coordinator login `volley setup`
    // saved on this machine (the keychain, coordinator.json): see coordinator-login.ts.
    env: { VOLLEY_NO_SAVED_LOGIN: "1" },
  },
});
