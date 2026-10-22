import { afterAll } from "bun:test";
import { NO_CLAUDE_PROFILES } from "./no-claude-profiles";
import { removeLeftoverTempDirs } from "./tmp";

// As vitest.config.ts: no test sees the machine's own Claude account profiles.
process.env.VOLLEY_CLAUDE_DIR = NO_CLAUDE_PROFILES;

// Preloaded by bunfig.toml for `bun test`: a top-level hook here runs once, after every file.
// It removes the temp dirs whose test's own removal a throwing `afterEach` skipped.
afterAll(removeLeftoverTempDirs);
