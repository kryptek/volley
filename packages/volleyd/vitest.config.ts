import { defineConfig } from "vitest/config";
import { NO_CLAUDE_PROFILES } from "./test/helpers/no-claude-profiles";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The soak itself runs under vitest.soak.config.ts (`bun run test:soak`).
    exclude: ["test/soak/soak.test.ts", "**/node_modules/**"],
    testTimeout: 15000,
    hookTimeout: 15000,
    // A CLI a test starts as a child process never uses the coordinator login `volley setup`
    // saved on this machine (the keychain, coordinator.json): see coordinator-login.ts.
    // Nor the Claude account profiles signed in on it: spawns balance across the signed-in
    // accounts by default, so a test sees only the profiles root it makes (none: a path no
    // test can create, so a stray profile write fails loudly).
    env: { VOLLEY_NO_SAVED_LOGIN: "1", VOLLEY_CLAUDE_DIR: NO_CLAUDE_PROFILES },
  },
});
