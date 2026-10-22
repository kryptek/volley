import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { type PressureSource, realLocalDoctor } from "../src/daemon";
import { type ExecFn, exec } from "../src/exec";
import { type DaemonEnv, makeDaemonEnv } from "./helpers/daemon-env";
import { tempDir } from "./helpers/tmp";

/**
 * Once `stop()` resolves nothing writes under $VOLLEYD_HOME (the daemon's $HOME too): a test, or
 * a service manager, may remove it at once. The own doctor's children (`gh` writes its state file
 * under $HOME) and a tick still sampling when the stop came were both caught writing after it.
 */
describe("stop() leaves $VOLLEYD_HOME quiet", () => {
  let env: DaemonEnv;
  beforeEach(async () => {
    env = await makeDaemonEnv();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  /** Every entry under `dir` with its kind, size and mtime. */
  const snapshot = (dir: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        const s = statSync(p);
        out[p] = `${e.isDirectory() ? "d" : "f"}:${s.size}:${s.mtimeMs}`;
        if (e.isDirectory()) walk(p);
      }
    };
    walk(dir);
    return out;
  };

  const quietAfter = async () => {
    const before = snapshot(env.home);
    await new Promise((r) => setImmediate(r));
    // real process: past the own doctor's grandchild's late write, had it survived the stop.
    await new Promise((r) => setTimeout(r, 300));
    expect(snapshot(env.home)).toEqual(before);
  };

  /** How long the doctor's grandchild waits before its write: long enough that a loaded CI runner's stop still lands first. */
  const LATE_WRITE_MS = 1500;

  it("kills the own doctor's own children, so none writes under $HOME after the stop", async () => {
    const repo = tempDir("volleyd-quiet-repo-");
    execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
    const marks = tempDir("volleyd-quiet-marks-");
    // `volley peer doctor` stands in as git, whose ssh transport (the grandchild, like the
    // doctor's `gh`) marks that it runs, then writes under the daemon's home a moment later.
    const doctorExec: ExecFn = (_argv, opts) =>
      exec(["git", "fetch", "ssh://example.invalid/x"], {
        ...opts,
        cwd: repo,
        env: {
          ...process.env,
          GIT_SSH_COMMAND: `sh -c 'touch "${marks}/up"; sleep ${LATE_WRITE_MS / 1000}; mkdir -p "${env.home}/.local/state/gh"' --`,
        },
      });
    const daemon = await env.start({ fleet: { localDoctor: realLocalDoctor(doctorExec) } });
    void daemon.tick();
    for (let i = 0; i < 100 && !existsSync(join(marks, "up")); i++) {
      // real process: waiting for the doctor's grandchild to start.
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(existsSync(join(marks, "up"))).toBe(true);
    const upAt = Date.now();
    await daemon.stop();
    // The stop has to land before the grandchild's write, or the check below proves nothing.
    expect(Date.now() - upAt).toBeLessThan(LATE_WRITE_MS);
    await quietAfter();
    // real process: past the grandchild's late write, had it survived the stop.
    await new Promise((r) => setTimeout(r, Math.max(0, upAt + LATE_WRITE_MS + 300 - Date.now())));
    expect(existsSync(join(env.home, ".local"))).toBe(false);
  });

  it("a tick still sampling when the stop came starts nothing once it returns", async () => {
    let release!: () => void;
    const sampling = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const inSample = new Promise<void>((r) => {
      entered = r;
    });
    let held = false;
    const pressure: PressureSource = async () => {
      if (held) {
        entered();
        await sampling;
      }
      return { samples: {}, ci: {} };
    };
    let doctors = 0;
    let t = Date.UTC(2026, 0, 1);
    const daemon = await env.start({
      pressure,
      now: () => t,
      fleet: {
        localDoctor: async () => {
          doctors++;
          return null;
        },
      },
    });
    await daemon.settled();
    const before = doctors;
    // The own doctor is due again on this tick.
    t += DAEMON_DEFAULTS.machine_heartbeat_ms;
    held = true;
    const tick = daemon.tick();
    await inSample;
    await daemon.stop();
    release();
    await tick;
    expect(doctors).toBe(before);
    await quietAfter();
  });
});
