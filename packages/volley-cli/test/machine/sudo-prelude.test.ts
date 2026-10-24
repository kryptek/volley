import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sudoPrelude } from "../../src/machine/add";
import { tempDir } from "../helpers/tmp";

/**
 * The box side of a headless install's sudo (volleyd's `machine_add`): run with real bash, a fake
 * `sudo` first on PATH that prints its arguments and what its askpass helper says, as sudo -A would
 * ask it.
 */
describe("sudoPrelude", () => {
  const PASSWORD = "s3cret 'quoted' pass";

  function run(after: string) {
    const bin = tempDir("volley-sudo-bin-");
    const tmp = tempDir("volley-sudo-tmp-");
    writeFileSync(
      join(bin, "sudo"),
      '#!/bin/sh\necho "args:$*"\necho "said:$("$SUDO_ASKPASS")"\n',
      {
        mode: 0o755,
      },
    );
    const r = spawnSync("bash", ["-c", `${sudoPrelude(PASSWORD)}\n${after}`], {
      encoding: "utf-8",
      env: { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: tmp },
    });
    return { ...r, tmp };
  }

  it("sudo runs the real one with -A, whose helper reads the password", () => {
    const r = run("sudo -v");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("args:-A -v");
    expect(r.stdout).toContain(`said:${PASSWORD}`);
  });

  it("the password file is 0600 while the step runs, and gone when it ends (an exit too)", () => {
    const r = run(
      'stat -c %a "$volley_sudo/pw" 2>/dev/null || stat -f %Lp "$volley_sudo/pw"\nexit 3',
    );
    expect(r.status).toBe(3);
    expect(r.stdout.trim()).toBe("600");
    expect(readdirSync(r.tmp)).toEqual([]);
  });

  it("never carries the password in clear in the script", () => {
    expect(sudoPrelude(PASSWORD)).not.toContain("s3cret");
  });
});
