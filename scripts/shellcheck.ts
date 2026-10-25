/**
 * `bun run lint`'s shell step: shellcheck over install.sh, the release tarball script and the install
 * tests' scripts (Layers 1, 2 and 4, verify.sh, and the stand-ins Layers 2 and 4 are tested against). A contributor without shellcheck gets a notice and a pass; CI (which installs it)
 * requires it.
 */
import { join } from "node:path";

const FILES = [
  "install.sh",
  "scripts/packaging/tarball.sh",
  "scripts/install-tests/run-layer1.sh",
  "scripts/install-tests/systemctl-stand-in.sh",
  "scripts/install-tests/lib.sh",
  "scripts/install-tests/vm-linux.sh",
  "scripts/install-tests/vm-pair.sh",
  "scripts/install-tests/run-layer2.sh",
  "scripts/install-tests/run-layer4.sh",
  "scripts/install-tests/verify.sh",
  "scripts/install-tests/stubs/multipass",
  "scripts/install-tests/stubs/ssh",
  "scripts/install-tests/stubs/gh",
];
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
