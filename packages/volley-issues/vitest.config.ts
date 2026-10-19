import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Parity tests run 30s-windowed synthetic agents; allow margin.
    testTimeout: 90000,
    hookTimeout: 30000,
    // The volley CLIs these tests start never use the coordinator login saved on this machine.
    env: { VOLLEY_NO_SAVED_LOGIN: "1" },
  },
});
