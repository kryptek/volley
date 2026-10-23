import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type PairedPeer, RECORD_LOCK_ARGV, RESTART_PEER_ARGV } from "../../src/deploy/peers";
import type { Command } from "../../src/deploy/plan";
import { LOCK_MARKER, lockHash } from "../../src/peer/doctor";
import type { ExecResult } from "../../src/setup/step";
import { tempDir } from "../helpers/tmp";

/**
 * A paired machine reached over ssh, played on disk: its volley checkout is a temp dir whose
 * `package.json` and `bun.lock` follow the checked-out ref, `bun install` fills `node_modules`,
 * the deploy's lock record runs for real (`sh`), and `volley peer doctor --json` reports the
 * checkout's version with the doctor's own install verdict (the marker against `bun.lock`).
 * `fail` makes one command (its argv joined with spaces, optionally only at one version) exit 1.
 */
export function fakePeerHost(
  name: string,
  opts: {
    head: { tag?: string; branch?: string };
    dirty?: string;
    claudeSignedIn?: boolean;
    /** The version the doctor reports (default: the checkout's). */
    doctorVersion?: string;
  },
) {
  const volleyDir = tempDir(`volley-deploy-peer-${name}-`);
  const peer: PairedPeer = { name, target: `dev@${name}`, volleyDir };
  const state = { head: { ...opts.head }, restarts: 0, installs: 0 };
  const versionAt = () =>
    (state.head.tag ?? (state.head.branch !== undefined ? "v0.4.1" : "v0.3.0")).replace(/^v/, "");
  const writeCheckout = () => {
    writeFileSync(join(volleyDir, "package.json"), JSON.stringify({ version: versionAt() }));
    writeFileSync(join(volleyDir, "bun.lock"), JSON.stringify({ lock: versionAt() }));
  };
  writeCheckout();
  // Installed from the current lock by an earlier doctor (synced).
  mkdirSync(join(volleyDir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(volleyDir, "node_modules", LOCK_MARKER), `${lockHash(volleyDir)}\n`);
  const ran: Command[] = [];
  const failures: { line: string; atVersion?: string; stderr?: string }[] = [];
  const res = (code: number, stdout = "", stderr = ""): ExecResult => ({ code, stdout, stderr });
  const synced = () => {
    try {
      return readFileSync(join(volleyDir, "node_modules", LOCK_MARKER), "utf-8").trim() ===
        lockHash(volleyDir)
        ? "synced"
        : "stale";
    } catch {
      return "stale";
    }
  };
  const report = () => {
    const lock = synced();
    const checks = [
      {
        id: "volley.installed",
        ok: lock === "synced",
        severity: "block",
        detail:
          lock === "synced"
            ? `volley ${versionAt()} in ${volleyDir}: installed from its bun.lock`
            : `volley ${versionAt()} in ${volleyDir}: dependencies not installed from its current bun.lock`,
      },
      {
        id: "claude.signin",
        ok: opts.claudeSignedIn !== false,
        severity: "block",
        detail: opts.claudeSignedIn !== false ? "signed in" : "Claude Code is not signed in",
      },
    ];
    return {
      checks,
      versions: {
        peer: versionAt(),
        volley: opts.doctorVersion ?? versionAt(),
        bun: "1.3.2",
        git: "2.43.0",
      },
      auth: { gh: "ok", claude: "signed_in", trust: "ok" },
      memory: { total_mb: 16384, available_pct: 50 },
      doctor_at: "2026-10-20T14:06:00.000Z",
    };
  };
  const remote = async (c: Command): Promise<ExecResult> => {
    ran.push({ argv: [...c.argv], ...(c.cwd !== undefined ? { cwd: c.cwd } : {}) });
    const line = c.argv.join(" ");
    const f = failures.find(
      (x) => line === x.line && (x.atVersion === undefined || x.atVersion === versionAt()),
    );
    if (f !== undefined) return res(1, "", f.stderr ?? `${c.argv[0]} failed`);
    const [cmd] = c.argv;
    if (cmd === "git") {
      const sub = c.argv.slice(3).join(" ");
      if (sub === "status --porcelain") return res(0, opts.dirty ?? "");
      if (sub === "rev-parse --abbrev-ref HEAD") return res(0, `${state.head.branch ?? "HEAD"}\n`);
      if (sub === "describe --tags --exact-match HEAD") {
        return state.head.tag !== undefined
          ? res(0, `${state.head.tag}\n`)
          : res(128, "", "fatal: no tag exactly matches");
      }
      if (sub === "rev-parse HEAD") return res(0, `${"a".repeat(40)}\n`);
      if (sub === "fetch --tags origin") return res(0);
      const g = c.argv.slice(3);
      if (g[0] === "checkout" && g[1] === "--detach") {
        state.head = { tag: g[2] as string };
        writeCheckout();
        return res(0);
      }
      if (g[0] === "checkout" && g[2] === "--") {
        state.head = { branch: g[1] as string };
        writeCheckout();
        return res(0);
      }
    }
    if (line === "bun install --frozen-lockfile" && c.cwd === volleyDir) {
      state.installs++;
      mkdirSync(join(volleyDir, "node_modules", ".bin"), { recursive: true });
      return res(0);
    }
    if (line === RECORD_LOCK_ARGV.join(" ") && c.cwd === volleyDir) {
      const [sh, ...args] = RECORD_LOCK_ARGV;
      const r = spawnSync(sh as string, args, { cwd: volleyDir, encoding: "utf-8" });
      return res(r.status ?? 1, r.stdout, r.stderr);
    }
    if (line === RESTART_PEER_ARGV.join(" ")) {
      state.restarts++;
      return res(0);
    }
    if (
      c.argv[0] === "bun" &&
      c.argv[1] === join(volleyDir, "packages", "volley-cli", "src", "cli.ts") &&
      c.argv.slice(2).join(" ") === "peer doctor --json"
    ) {
      const r = report();
      return res(r.checks.every((x) => x.ok) ? 0 : 1, JSON.stringify(r));
    }
    return res(127, "", `fake peer: unknown command ${line}`);
  };
  return {
    peer,
    state,
    ran,
    remote,
    synced,
    version: versionAt,
    lines: () => ran.map((c) => c.argv.join(" ")),
    fail: (line: string, o: { atVersion?: string; stderr?: string } = {}) =>
      failures.push({ line, ...o }),
  };
}
