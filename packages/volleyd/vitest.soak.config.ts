import { defineConfig } from "vitest/config";

// The simulated soak (test/soak/, `bun run test:soak`): the whole wave through the real daemon, one
// run up to 20 minutes. `bun run test` runs the soak's own helper tests but not the soak itself.
export default defineConfig({
  test: {
    include: ["test/soak/**/*.test.ts"],
    testTimeout: 1_200_000,
    hookTimeout: 60_000,
    // VOLLEYD_SOAK: soak.test.ts runs only here (`bun test` would collect it too).
    env: { VOLLEY_NO_SAVED_LOGIN: "1", VOLLEYD_SOAK: "1" },
  },
});
