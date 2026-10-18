import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { patchFor } from "../src/commands/config";
import {
  findBun,
  installService,
  plistPath,
  renderPlist,
  uninstallService,
} from "../src/commands/install";
import { formatWave } from "../src/commands/status";
import type { ExecFn } from "../src/exec";
import { makeBufferIO } from "../src/io";
import { Journal } from "../src/journal";
import type { NewEvent } from "../src/types";
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
    expect((await runCli(["--version"])).stdout).toMatch(/^\d+\.\d+\.\d+/);
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
      "w1  running  plan v1  owner: -  tasks: 2  gates: 0  decisions: 0\n" +
        "  T1  #101   spec_review     PR #7\n" +
        "  T2  #102   queued          after: T1\n",
    );
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

  it("never writes broker credentials into the (world-readable) plist", async () => {
    const r = await runCli(["install", "--dry-run"], {
      HOME: home,
      VOLLEYD_HOME: join(home, "state"),
      VOLLEY_AUTH_USERNAME: "volleyd",
      VOLLEY_AUTH_PASSWORD: "plist-must-not-hold-this",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("plist-must-not-hold-this");
    expect(r.stdout).not.toContain("VOLLEY_AUTH");
  });
});
