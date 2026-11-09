import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The owner wake's fallback lives in two places: the hooks' Stop block (volley-hooks
 * `fallbackCommand` / `HOOKS_INSTALL_URL`) and volleyd's `n-owner-asleep-<wave>` notice
 * (`ownerWakeCommand` / `HOOKS_INSTALL_URL`). Neither package depends on the other, so this loads
 * both modules and keeps the command and the link equal.
 */
const root = join(import.meta.dir, "..");

describe("owner wake: the hooks' Stop block and volleyd's notice name the same fallback", async () => {
  const hooks = await import(join(root, "packages/volley-hooks/src/lib/owner-waves.ts"));
  const notices = await import(join(root, "packages/volleyd/src/coordinator/notices.ts"));

  test("the one command that arms a wait on a wave's digest", () => {
    for (const wave of ["w1", "2026-11-08-ownerwake"])
      expect(notices.ownerWakeCommand(wave)).toBe(hooks.fallbackCommand([wave]));
  });

  test("the hooks install link", () => {
    expect(notices.HOOKS_INSTALL_URL).toBe(hooks.HOOKS_INSTALL_URL);
  });
});
