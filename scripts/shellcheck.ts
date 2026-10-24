/**
 * `bun run lint`'s shell step: shellcheck over install.sh. A contributor without shellcheck gets a
 * notice and a pass; CI (which installs it) requires it.
 */
import { join } from "node:path";

const FILES = ["install.sh"];
const root = join(import.meta.dir, "..");

const shellcheck = Bun.which("shellcheck");
if (shellcheck === null) {
  const ci = Boolean(process.env.CI);
  console.error(
    ci
      ? "shellcheck is not installed; CI's lint job must install it."
      : "shellcheck is not installed; skipping it (CI runs it on install.sh).",
  );
  process.exit(ci ? 1 : 0);
}
const r = Bun.spawnSync([shellcheck, ...FILES], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(r.exitCode ?? 1);
