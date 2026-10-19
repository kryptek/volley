import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pkg from "../package.json";
import type { AdmissionSummary } from "../src/admission";
import { admissionFor, formatAdmission } from "../src/commands/admission";
import { patchFor } from "../src/commands/config";
import {
  findBun,
  installService,
  plistPath,
  renderPlist,
  uninstallService,
} from "../src/commands/install";
import { formatLogins, formatWave } from "../src/commands/status";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import type { ExecFn } from "../src/exec";
import { makeBufferIO } from "../src/io";
import { Journal } from "../src/journal";
import type { NewEvent } from "../src/types";
import { makeDaemonEnv } from "./helpers/daemon-env";
import { fakeClock } from "./helpers/fake-clock";
import { memoryCredentials } from "./helpers/fake-dynsec";
import { runCli } from "./helpers/run-cli";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "volleyd-cli-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("volleyd (top level)", () => {
  it("prints usage, version, and rejects unknown commands", async () => {
    expect((await runCli([])).exitCode).toBe(2);
    const help = await runCli(["--help"]);
    expect(help.exitCode).toBe(0);
    for (const cmd of [
      "daemon",
      "install",
      "uninstall",
      "run",
      "validate",
      "status",
      "events",
      "ack",
      "config",
    ]) {
      expect(help.stdout).toContain(`  ${cmd}`);
    }
    expect((await runCli(["--version"])).stdout.trim()).toBe(pkg.version);
    const bad = await runCli(["frobnicate"]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain("unknown command: frobnicate");
  });
});

describe("volleyd validate", () => {
  it("accepts a valid wave file", async () => {
    const r = await runCli(["validate", fixture("example.yaml")]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ok: wave 2026-10-20-example v1 — 4 task(s), critical path 3");
  });

  it("rejects an invalid one with path-qualified errors", async () => {
    const r = await runCli(["validate", fixture("bad-cycle.yaml")]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("tasks.A.after: dependency cycle A -> B -> A");
  });

  it("reports a missing file and usage errors", async () => {
    expect((await runCli(["validate", join(home, "nope.yaml")])).exitCode).toBe(1);
    expect((await runCli(["validate"])).exitCode).toBe(2);
  });
});

describe("volleyd events / ack (journal cursors)", () => {
  const seed = (n: number) => {
    const j = Journal.open(join(home, "waves", "w1"));
    for (let i = 0; i < n; i++) {
      j.append({ type: "task_queued", task: `T${i}`, data: {} } as NewEvent);
    }
  };
  const seqs = (out: string) =>
    out
      .trim()
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l).seq);
  const env = () => ({ VOLLEYD_HOME: home });

  it("replays un-acked events until the cursor is acked", async () => {
    seed(3);
    const first = await runCli(["events", "w1", "--cursor", "coord"], env());
    expect(first.exitCode).toBe(0);
    expect(seqs(first.stdout)).toEqual([1, 2, 3]);
    // Not acked: the same events come back.
    expect(seqs((await runCli(["events", "w1", "--cursor", "coord"], env())).stdout)).toEqual([
      1, 2, 3,
    ]);

    const ack = await runCli(["ack", "w1", "--cursor", "coord", "--seq", "2"], env());
    expect(ack.exitCode).toBe(0);
    expect(ack.stdout).toBe("w1 cursor coord: 0 -> 2\n");
    expect(seqs((await runCli(["events", "w1", "--cursor", "coord"], env())).stdout)).toEqual([3]);
    // Cursors are independent.
    expect(seqs((await runCli(["events", "w1", "--cursor", "pane"], env())).stdout)).toEqual([
      1, 2, 3,
    ]);
  });

  it("treats a backwards ack as a no-op and refuses to ack past the end", async () => {
    seed(3);
    await runCli(["ack", "w1", "--cursor", "coord", "--seq", "3"], env());
    const back = await runCli(["ack", "w1", "--cursor", "coord", "--seq", "1"], env());
    expect(back.stdout).toBe("w1 cursor coord: 3 -> 3\n");
    const past = await runCli(["ack", "w1", "--cursor", "coord", "--seq", "9"], env());
    expect(past.exitCode).toBe(1);
    expect(past.stderr).toContain("past the end");
  });

  it("errors on unknown waves and bad cursor names; usage errors exit 2", async () => {
    seed(1);
    expect((await runCli(["events", "nope", "--cursor", "c"], env())).stderr).toContain(
      "unknown wave 'nope'",
    );
    expect((await runCli(["events", "w1", "--cursor", "Bad Name"], env())).exitCode).toBe(1);
    expect((await runCli(["events", "w1"], env())).exitCode).toBe(2);
    expect((await runCli(["ack", "w1", "--cursor", "c", "--seq", "x"], env())).exitCode).toBe(2);
  });
});

describe("volleyd config set argument parsing", () => {
  it("turns a dotted path into a nested patch", () => {
    expect(patchFor("hard_ceiling", 2)).toEqual({ hard_ceiling: 2 });
    expect(patchFor("admission.ci_queue_max", 5)).toEqual({ admission: { ci_queue_max: 5 } });
    expect(() => patchFor("admission..x", 1)).toThrow(/invalid config path/);
  });

  it("needs both a path and a value", async () => {
    expect((await runCli(["config", "set", "hard_ceiling"])).exitCode).toBe(2);
    expect((await runCli(["config", "frob"])).exitCode).toBe(2);
  });
});

describe("volleyd status formatting", () => {
  it("prints a header and one row per task", () => {
    const out = formatWave({
      wave: "w1",
      version: 1,
      owner: null,
      repo: "r",
      release_branch: "release/w1",
      status: "running",
      tasks: [
        {
          id: "T1",
          issue: 101,
          stage: "spec_review",
          agents: {},
          pr: { number: 7, url: "https://x/7" },
        },
        { id: "T2", issue: 102, stage: "queued", agents: {}, why_waiting: "after: T1" },
      ],
      open_decisions: [],
      gates: [],
      updated_at: "2026-10-18T12:00:00.000Z",
    });
    expect(out).toBe(
      "w1  running  plan v1  owner: -  tasks: 2  gates: 0  decisions: 0  alarms: 0\n" +
        "  T1  #101   spec_review     PR #7\n" +
        "  T2  #102   queued          after: T1\n",
    );
  });

  it("counts the open alarms (tasks whose spawn failed) in the header", () => {
    const out = formatWave({
      wave: "w1",
      version: 1,
      owner: null,
      repo: "r",
      release_branch: "release/w1",
      status: "running",
      tasks: [
        {
          id: "T1",
          issue: 101,
          stage: "queued",
          agents: {},
          why_waiting: "spawn failed: WORKTREE_FAILED — retry in 30s (attempt 1)",
          last_error: { code: "WORKTREE_FAILED", message: "x", at: "2026-10-18T12:00:00.000Z" },
          attempt: 1,
          next_retry_at: "2026-10-18T12:00:30.000Z",
        },
        { id: "T2", issue: 102, stage: "queued", agents: {} },
      ],
      open_decisions: ["spawn_failed-abc"],
      gates: [],
      updated_at: "2026-10-18T12:00:00.000Z",
    });
    expect(out.split("\n")[0]).toBe(
      "w1  running  plan v1  owner: -  tasks: 2  gates: 0  decisions: 1  alarms: 1",
    );
    expect(out).toContain("spawn failed: WORKTREE_FAILED — retry in 30s (attempt 1)");
  });

  const plain = {
    wave: "w1",
    version: 1,
    owner: null,
    repo: "r",
    release_branch: "release/w1",
    status: "running" as const,
    tasks: [{ id: "T1", issue: 101, stage: "merge_ready" as const, agents: {} }],
    open_decisions: [],
    gates: ["T1"],
    updated_at: "2026-10-18T12:00:00.000Z",
  };

  it("shows the wave's brief preface under the header (none when it has none)", () => {
    const sha = "0123456789abcdef".repeat(4);
    const out = formatWave({
      ...plain,
      brief_preface: { path: "/r/.volley/p.md", sha256: sha, bytes: 912 },
    });
    expect(out.split("\n")[1]).toBe(
      "  brief preface: /r/.volley/p.md (912 B, sha256 0123456789ab)",
    );
    expect(formatWave({ ...plain, brief_preface: null }).split("\n")[1]).toBe(
      "  brief preface: none",
    );
    // A state from before the field existed: no line.
    expect(formatWave(plain).split("\n")[1]).toMatch(/^ {2}T1 /);
  });

  it("marks a task gated without reviews because its plan has none", () => {
    const out = formatWave({
      ...plain,
      tasks: [
        { id: "T1", issue: 101, stage: "merge_ready", agents: {}, reviews_skipped_by_plan: true },
      ],
    });
    expect(out).toContain("  T1  #101   merge_ready     reviews skipped by plan\n");
  });

  it("status --json carries brief_preface with the sha256 of the file's bytes", async () => {
    const env = await makeDaemonEnv();
    try {
      await env.start();
      const repo = join(env.home, "repo");
      mkdirSync(join(repo, ".volley"), { recursive: true });
      const preface = "Public repo: no names.\n";
      writeFileSync(join(repo, ".volley", "brief-preface.md"), preface);
      const file = join(env.home, "w1.yaml");
      writeFileSync(
        file,
        `wave: w1\nrepo: ${repo}\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: { issue: 1 }\n`,
      );
      expect((await runCli(["run", file], env.env)).exitCode).toBe(0);
      const json = JSON.parse((await runCli(["status", "w1", "--json"], env.env)).stdout);
      expect(json.brief_preface).toEqual({
        path: join(repo, ".volley", "brief-preface.md"),
        bytes: Buffer.byteLength(preface),
        sha256: createHash("sha256").update(preface).digest("hex"),
      });
      expect((await runCli(["status", "w1"], env.env)).stdout).toContain(
        `  brief preface: ${join(repo, ".volley", "brief-preface.md")} (`,
      );
    } finally {
      await env.cleanup();
    }
  });
});

describe("volleyd status: agent logins", () => {
  it("formats the header line", () => {
    expect(formatLogins({ live: 1, swept: 2 })).toBe("agent logins: 1 live, 2 swept");
  });

  it("the header counts the logins left after the sweep and the total swept; --json too", async () => {
    const env = await makeDaemonEnv();
    try {
      // Two logins of finished agents from an earlier run, one that is still being spawned.
      const creds = memoryCredentials();
      for (const id of ["w0-t1-implementer-1", "w0-t2-implementer-1", "w9-t1-implementer-1"]) {
        creds.logins.add(id);
      }
      creds.mintedAt.set("w0-t1-implementer-1", 0);
      creds.mintedAt.set("w0-t2-implementer-1", 0);
      creds.mintedAt.set("w9-t1-implementer-1", Date.now());
      const d = await env.start({
        spawner: { credentials: creds },
        credentialSweepMs: 3_600_000,
      });
      await d.sweepCredentials();
      const out = (await runCli(["status"], env.env)).stdout;
      expect(out.split("\n")[0]).toBe("agent logins: 1 live, 2 swept");
      const json = JSON.parse((await runCli(["status", "--json"], env.env)).stdout);
      expect(json.agent_logins).toEqual({ live: 1, swept: 2 });
    } finally {
      await env.cleanup();
    }
  });

  it("the live count is cached, re-read on the clock: it follows logins made outside the daemon", async () => {
    const env = await makeDaemonEnv();
    try {
      const creds = memoryCredentials();
      const clock = fakeClock(Date.now());
      const d = await env.start({
        spawner: { credentials: creds },
        credentialSweepMs: 3_600_000,
        clock,
      });
      await d.sweepCredentials();
      const line = async () => (await runCli(["status"], env.env)).stdout.split("\n")[0];
      // Another tool mints a login: status answers from the cache until the next re-count.
      await creds.mint("w1-t1-implementer-1");
      expect(await line()).toBe("agent logins: 0 live, 0 swept");
      await clock.advance(DAEMON_DEFAULTS.login_count_refresh_ms);
      expect(await line()).toBe("agent logins: 1 live, 0 swept");
      await creds.revoke("w1-t1-implementer-1");
      await clock.advance(DAEMON_DEFAULTS.login_count_refresh_ms);
      expect(await line()).toBe("agent logins: 0 live, 0 swept");
    } finally {
      await env.cleanup();
    }
  });

  it("without a credential store there is no login line", async () => {
    const env = await makeDaemonEnv();
    try {
      await env.start();
      expect((await runCli(["status"], env.env)).stdout).toBe("no waves\n");
    } finally {
      await env.cleanup();
    }
  });
});

describe("volleyd admission [wave]", () => {
  const summary: AdmissionSummary = {
    throttled: false,
    allow: null,
    reasons: [],
    signals: {},
    sampled_at: "2026-10-18T12:00:00.000Z",
    waves: {
      w1: { allow: 2, reasons: ["2 ci runs queued"] },
      w2: { allow: null, reasons: [] },
    },
  } as unknown as AdmissionSummary;

  it("accepts the wave positional every other command takes", async () => {
    // No daemon here: the point is that the argument parses (usage errors exit 2).
    const r = await runCli(["admission", "w1"]);
    expect(r.exitCode).not.toBe(2);
    expect(r.stderr).not.toContain("Unexpected argument");
    expect((await runCli(["admission", "w1", "w2"])).exitCode).toBe(2);
  });

  it("against a running daemon: only that wave's verdict; an unknown wave is an error", async () => {
    const env = await makeDaemonEnv();
    try {
      const daemon = await env.start();
      for (const w of ["w1", "w2"]) {
        const file = join(env.home, `${w}.yaml`);
        writeFileSync(
          file,
          `wave: ${w}\nrepo: /tmp/r\nrelease_branch: release/${w}\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: { issue: 1 }\n`,
        );
        expect((await runCli(["run", file], env.env)).exitCode).toBe(0);
      }
      await daemon.tick();
      const all = await runCli(["admission", "--json"], env.env);
      expect(Object.keys(JSON.parse(all.stdout).waves).sort()).toEqual(["w1", "w2"]);
      const one = await runCli(["admission", "w1", "--json"], env.env);
      expect(one.exitCode).toBe(0);
      expect(Object.keys(JSON.parse(one.stdout).waves)).toEqual(["w1"]);
      const text = await runCli(["admission", "w1"], env.env);
      expect(text.stdout).toContain("  w1  ");
      expect(text.stdout).not.toContain("  w2  ");
      const unknown = await runCli(["admission", "nope"], env.env);
      expect(unknown.exitCode).toBe(1);
      expect(unknown.stderr).toContain("unknown wave 'nope'");
    } finally {
      await env.cleanup();
    }
  });

  it("with a wave, shows only that wave's verdict", () => {
    const one = formatAdmission(admissionFor(summary, "w1"));
    expect(one).toContain("  w1  allow 2  2 ci runs queued");
    expect(one).not.toContain("w2");
    expect(admissionFor(summary, "w3").waves).toEqual({});
    expect(formatAdmission(summary)).toContain("  w2  open");
  });
});

describe("volleyd install / uninstall", () => {
  const paths = () => ({
    launchAgentsDir: join(home, "LaunchAgents"),
    home: join(home, "state"),
    uid: 501,
    bun: "/opt/bun/bin/bun",
    brokerUrl: "mqtt://localhost:1883",
    namespace: "default",
    path: "/opt/bin:/usr/bin",
  });

  it("renders the plist with KeepAlive, RunAtLoad, the log path and escaped values", () => {
    const xml = renderPlist({ ...paths(), namespace: "a&b" });
    expect(xml).toContain("<string>systems.volley.volleyd</string>");
    expect(xml).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml).toContain(`<string>${join(home, "state", "volleyd.log")}</string>`);
    expect(xml).toContain("<string>/opt/bun/bin/bun</string>");
    expect(xml).toMatch(
      /<string>[^<]*packages\/volleyd\/src\/cli\.ts<\/string>\n\s*<string>daemon<\/string>/,
    );
    expect(xml).toContain("<string>a&amp;b</string>");
    expect(xml).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("writes the plist and bootstraps it through the fenced exec", async () => {
    const calls: string[][] = [];
    const fake: ExecFn = async (argv) => {
      calls.push([...argv]);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    const io = makeBufferIO();
    const p = paths();
    expect(await installService(p, io, fake)).toBe(0);
    const file = plistPath(p.launchAgentsDir);
    expect(readFileSync(file, "utf-8")).toContain("systems.volley.volleyd");
    expect(calls).toEqual([
      ["launchctl", "bootout", "gui/501/systems.volley.volleyd"],
      ["launchctl", "bootstrap", "gui/501", file],
    ]);

    calls.length = 0;
    expect(await uninstallService(p, io, fake)).toBe(0);
    expect(calls).toEqual([["launchctl", "bootout", "gui/501/systems.volley.volleyd"]]);
    expect(() => readFileSync(file)).toThrow();
  });

  it("puts the first bun on PATH in the plist, not a versioned install path", () => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "bun"), "");
    expect(findBun(`/nonexistent:${bin}:/usr/bin`, "/fallback/bun")).toBe(join(bin, "bun"));
    expect(findBun("/nonexistent", "/fallback/bun")).toBe("/fallback/bun");
  });

  it("--dry-run prints the plist without loading anything", async () => {
    const r = await runCli(["install", "--dry-run"], {
      HOME: home,
      VOLLEYD_HOME: join(home, "state"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("LaunchAgents/systems.volley.volleyd.plist");
    expect(r.stdout).toContain("<key>KeepAlive</key>");
  });

  it("renders VOLLEY_AUTH_DIR only when an auth dir is given", () => {
    const without = renderPlist(paths());
    expect(without).not.toContain("VOLLEY_AUTH_DIR");
    expect(without).not.toMatch(/\{\{[A-Z_]+\}\}/);
    const withDir = renderPlist({ ...paths(), authDir: "/opt/mq/volley&co" });
    expect(withDir).toContain(
      "<key>VOLLEY_AUTH_DIR</key>\n    <string>/opt/mq/volley&amp;co</string>",
    );
    expect(withDir).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("--dry-run carries VOLLEY_AUTH_DIR into the plist (volleyd's `volley auth` uses it)", async () => {
    const r = await runCli(["install", "--dry-run"], {
      HOME: home,
      VOLLEYD_HOME: join(home, "state"),
      VOLLEY_AUTH_DIR: "/srv/mosquitto/volley",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "<key>VOLLEY_AUTH_DIR</key>\n    <string>/srv/mosquitto/volley</string>",
    );
  });

  it("never writes broker credentials into the (world-readable) plist", async () => {
    const r = await runCli(["install", "--dry-run"], {
      HOME: home,
      VOLLEYD_HOME: join(home, "state"),
      VOLLEY_AUTH_USERNAME: "volleyd",
      VOLLEY_AUTH_PASSWORD: "plist-must-not-hold-this",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("plist-must-not-hold-this");
    expect(r.stdout).not.toContain("VOLLEY_AUTH_USERNAME");
    expect(r.stdout).not.toContain("VOLLEY_AUTH_PASSWORD");
  });
});
