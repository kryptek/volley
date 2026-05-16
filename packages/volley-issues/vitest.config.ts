import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Parity tests run 30s-windowed synthetic agents; allow margin.
    testTimeout: 90000,
    hookTimeout: 30000,
  },
});
