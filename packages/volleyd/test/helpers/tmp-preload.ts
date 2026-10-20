import { afterAll } from "bun:test";
import { removeLeftoverTempDirs } from "./tmp";

// Preloaded by bunfig.toml for `bun test`: a top-level hook here runs once, after every file.
// It removes the temp dirs whose test's own removal a throwing `afterEach` skipped.
afterAll(removeLeftoverTempDirs);
