/**
 * The Claude profiles root every test runs with (`$VOLLEY_CLAUDE_DIR`, set by vitest.config.ts and
 * the bun preload): never the machine's own `~/.volley/claude`, whose signed-in profiles would
 * change which account a spawn balances to. Nothing can create it, so a test that writes a
 * profile without its own root fails instead of touching the machine's.
 */
export const NO_CLAUDE_PROFILES = "/nonexistent/volley-tests/claude";
