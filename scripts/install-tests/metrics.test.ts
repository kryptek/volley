import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/tmp";
import {
  TIMING_TARGETS,
  WALL_TARGET_MS,
  evaluate,
  noCiVerdict,
  readyVerdict,
  redact,
  scanCli,
  scanText,
  secretsFrom,
  statusVerdict,
  waveVerdict,
} from "./metrics";

const SCRIPT = join(import.meta.dir, "metrics.ts");
const FIXTURES = join(import.meta.dir, "fixtures");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

function run(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? "", ...opts.env },
    stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const summaryArgs = (metrics: string, check: string) => [
  "summary",
  "--label",
  "ubuntu-24.04",
  "--metrics",
  join(FIXTURES, metrics),
  "--check",
  join(FIXTURES, check),
  "--yes",
  "--first-wave",
];

describe("evaluate: the targets", () => {
  const base = { label: "ubuntu-24.04", yes: true, firstWave: true };

  test("a run inside every target passes, and the table shows it", () => {
    const r = evaluate({
      ...base,
      metrics: fixture("metrics-pass.json"),
      check: fixture("check-pass.json"),
      totalMs: 400_000,
    });
    expect(r.failures).toEqual([]);
    expect(r.markdown).toContain("### Layer 1: ubuntu-24.04 ✅");
    expect(r.markdown).toContain("| Setup wall time | 3 m 5 s | ≤ 15 m | ✅ |");
    expect(r.markdown).toContain("| Install, end to end | 6 m 40 s | ≤ 15 m | ✅ |");
    expect(r.markdown).toContain("| Questions (`--yes`) | 0 | 0 | ✅ |");
    expect(r.markdown).toContain("| Test wave | merged in 1 m 38 s | merged | ✅ |");
    expect(r.markdown).toContain("| `--check` | 3/3 done | all done | ✅ |");
    expect(r.markdown).toContain("| services | 4.3 s | 3 |");
  });

  test("wall time over 15 minutes fails", () => {
    const r = evaluate({
      ...base,
      metrics: fixture("metrics-slow.json"),
      check: fixture("check-pass.json"),
    });
    expect(WALL_TARGET_MS).toBe(15 * 60 * 1000);
    expect(r.failures).toEqual(["setup took 16 m 0 s, over the 15 m target"]);
    expect(r.markdown).toContain("### Layer 1: ubuntu-24.04 ❌");
    expect(r.markdown).toContain("| Setup wall time | 16 m 0 s | ≤ 15 m | ❌ |");
  });

  test("the install end to end over 15 minutes fails", () => {
    const r = evaluate({
      ...base,
      metrics: fixture("metrics-pass.json"),
      check: fixture("check-pass.json"),
      totalMs: 15 * 60 * 1000 + 1000,
    });
    expect(r.failures).toEqual(["the install took 15 m 1 s end to end, over the 15 m target"]);
  });

  test("a question under --yes fails; without --yes it is only reported", () => {
    const m = fixture("metrics-asked.json");
    const c = fixture("check-pass.json");
    expect(evaluate({ ...base, metrics: m, check: c }).failures).toEqual([
      "setup asked 2 questions under --yes",
    ]);
    const r = evaluate({ ...base, yes: false, metrics: m, check: c });
    expect(r.failures).toEqual([]);
    expect(r.markdown).toContain("| Questions | 2 | — | ✅ |");
  });

  test("a pending or blocked --check row fails, naming the step", () => {
    const m = fixture("metrics-pass.json");
    expect(
      evaluate({ ...base, metrics: m, check: fixture("check-pending.json") }).failures,
    ).toEqual(["`volley setup --check`: services is pending (Start volleyd.service)"]);
    const r = evaluate({ ...base, metrics: m, check: fixture("check-blocked.json") });
    expect(r.failures).toEqual([
      "`volley setup --check`: broker is blocked (mosquitto is not listening)",
    ]);
    expect(r.markdown).toContain("| `--check` | 2/3 done | all done | ❌ |");
  });

  test("a skipped row fails unless that step may be skipped here (--no-lan on a Mac: the phone)", () => {
    const m = fixture("metrics-pass.json");
    const c = fixture("check-phone-skipped.json");
    expect(evaluate({ ...base, metrics: m, check: c }).failures).toEqual([
      "`volley setup --check`: phone is skipped (a phone cannot reach the broker (it is on this machine only))",
    ]);
    const r = evaluate({ ...base, metrics: m, check: c, allowSkipped: ["phone"] });
    expect(r.failures).toEqual([]);
    expect(r.markdown).toContain(
      "| `--check` | 3/4 done, 1 skipped (allowed: phone) | all done | ✅ |",
    );
    // Allowed to be skipped is not allowed to be pending or blocked.
    const pending = fixture("check-pending.json");
    expect(
      evaluate({ ...base, metrics: m, check: pending, allowSkipped: ["services"] }).failures,
    ).toHaveLength(1);
  });

  test("a test wave that did not merge, or never ran, fails when one is required", () => {
    const c = fixture("check-pass.json");
    expect(
      evaluate({ ...base, metrics: fixture("metrics-unmerged.json"), check: c }).failures,
    ).toEqual(["the test wave did not merge"]);
    const { first_wave: _fw, ...none } = fixture("metrics-pass.json");
    expect(evaluate({ ...base, metrics: none, check: c }).failures).toEqual(["no test wave ran"]);
    expect(evaluate({ ...base, firstWave: false, metrics: none, check: c }).failures).toEqual([]);
  });
});

describe("evaluate: the VM layers' timings", () => {
  const base = {
    label: "ubuntu-24.04",
    yes: true,
    firstWave: true,
    metrics: fixture("metrics-pass.json"),
    check: fixture("check-pass.json"),
  };

  test("the heading names the layer; a timing under its target passes, one without is reported", () => {
    const r = evaluate({
      ...base,
      layer: 2,
      timings: { reboot_check_ms: 45_000, launch_ms: 61_000 },
    });
    expect(r.failures).toEqual([]);
    expect(r.markdown).toContain("### Layer 2: ubuntu-24.04 ✅");
    expect(r.markdown).toContain("| `reboot_check_ms` | 0 m 45 s | ≤ 2 m | ✅ |");
    expect(r.markdown).toContain("| `launch_ms` | 1 m 1 s | — | ✅ |");
  });

  test("--check green more than 2 minutes after the reboot fails; the peer ready after 10 too", () => {
    expect(TIMING_TARGETS).toEqual({ reboot_check_ms: 120_000, pair_ready_ms: 600_000 });
    const r = evaluate({
      ...base,
      layer: 4,
      timings: { reboot_check_ms: 121_000, pair_ready_ms: 601_000 },
    });
    expect(r.failures).toEqual([
      "reboot_check_ms was 2 m 1 s, over the 2 m target",
      "pair_ready_ms was 10 m 1 s, over the 10 m target",
    ]);
    expect(r.markdown).toContain("### Layer 4: ubuntu-24.04 ❌");
  });
});

describe("the VM layers' verdicts", () => {
  const sub = (envelope: object) => `${JSON.stringify({ topic: "t", envelope })}\n`;
  const boot = Date.parse("2026-10-24T03:00:00Z") / 1000;

  test("volleyd's status: working and published after the boot", () => {
    const working = { type: "working", wall_time: "2026-10-24T03:00:40.000Z", payload: {} };
    expect(statusVerdict(sub(working), boot)).toBeNull();
    expect(statusVerdict(sub({ ...working, wall_time: "2026-10-24T02:59:00.000Z" }), boot)).toBe(
      "volleyd's status (2026-10-24T02:59:00.000Z) is older than the boot (2026-10-24T03:00:00.000Z)",
    );
    expect(statusVerdict(sub({ ...working, type: "idle" }), boot)).toBe(
      "volleyd's status is idle, not working",
    );
    expect(statusVerdict("", boot)).toBe("no retained status from volleyd");
  });

  test("the peer's readiness verdict: ready, or why not", () => {
    const v = { type: "readiness", payload: { name: "peer", ready: true, reasons: [] } };
    expect(readyVerdict(sub(v), "peer")).toBeNull();
    expect(
      readyVerdict(
        sub({ ...v, payload: { name: "peer", ready: false, reasons: ["tunnel down"] } }),
        "peer",
      ),
    ).toBe("peer is not ready (tunnel down)");
    expect(readyVerdict("", "peer")).toBe("no readiness verdict on peer yet");
  });

  test("the peer's wave: complete, its task done and placed on the peer", () => {
    const status = JSON.stringify({ status: "complete", tasks: [{ id: "T1", stage: "done" }] });
    const placed = (host: string) =>
      `${JSON.stringify({ seq: 4, type: "task_placed", task: "T1", data: { task: "T1", host } })}\n`;
    const w = { status, events: placed("peer"), task: "T1", host: "peer" };
    expect(waveVerdict(w)).toBeNull();
    expect(waveVerdict({ ...w, events: placed("hub") })).toBe("T1 was placed on hub, not peer");
    expect(waveVerdict({ ...w, events: "" })).toBe("no task_placed for T1");
    expect(
      waveVerdict({
        ...w,
        status: JSON.stringify({ status: "running", tasks: [{ id: "T1", stage: "implement" }] }),
      }),
    ).toBe("the wave is running, T1 is implement");
  });

  test("the verdict command exits 0 or 1 with the reason; a usage error 2", () => {
    const working = { type: "working", wall_time: "2026-10-24T03:00:40.000Z" };
    expect(run(["verdict", "status", "--boot", String(boot)], { stdin: sub(working) }).code).toBe(
      0,
    );
    const old = run(["verdict", "status", "--boot", String(boot + 3600)], { stdin: sub(working) });
    expect(old.code).toBe(1);
    expect(old.stderr).toContain("older than the boot");
    expect(run(["verdict", "status"], { stdin: "" }).code).toBe(2);
    expect(run(["verdict", "frob"]).code).toBe(2);
  });
});

describe("a wave on a repository with no CI (verdict wave --ci none, #602)", () => {
  const status = readFileSync(join(FIXTURES, "wave-status-noci.json"), "utf8");
  const events = readFileSync(join(FIXTURES, "wave-events-noci.jsonl"), "utf8");
  const ev = (o: object) => `${JSON.stringify(o)}\n`;

  test("complete, mode none, nothing waited on CI and no decision but wave_complete's: null", () => {
    expect(noCiVerdict({ status, events })).toBeNull();
  });

  test("a ci_pending, a task's decision, a missing or other mode, no wave_complete: why", () => {
    expect(
      noCiVerdict({ status, events: events + ev({ seq: 9, type: "ci_pending", data: {} }) }),
    ).toBe("the journal has ci_pending: the wave waited for CI on a repository with none");
    expect(
      noCiVerdict({
        status,
        events: events + ev({ seq: 9, type: "decision_opened", data: { kind: "ci_timeout" } }),
      }),
    ).toBe("the wave asked the owner (ci_timeout) on a repository with no CI");
    const noMode = events
      .split("\n")
      .filter((l) => !l.includes("ci_mode_detected"))
      .join("\n");
    expect(noCiVerdict({ status, events: noMode })).toBe(
      'no ci_mode_detected { mode: "none" } in the journal',
    );
    expect(
      noCiVerdict({ status, events: events.replace('"mode":"none"', '"mode":"workflows"') }),
    ).toBe("ci_mode_detected says workflows, not none");
    const running = events
      .split("\n")
      .filter((l) => !l.includes('"type":"wave_complete"'))
      .join("\n");
    expect(
      noCiVerdict({ status: JSON.stringify({ status: "running", tasks: [] }), events: running }),
    ).toBe("the wave is running, no wave_complete yet");
  });

  test("the command: exit 0 on the fixtures, 1 with the reason, 2 without --status/--events", () => {
    const args = [
      "verdict",
      "wave",
      "--ci",
      "none",
      "--status",
      join(FIXTURES, "wave-status-noci.json"),
    ];
    expect(run([...args, "--events", join(FIXTURES, "wave-events-noci.jsonl")]).code).toBe(0);
    const dir = tempDir("volley-metrics-noci-");
    const pending = join(dir, "events.jsonl");
    writeFileSync(pending, `${events}${ev({ seq: 9, type: "ci_pending", data: {} })}`);
    const r = run([...args, "--events", pending]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ci_pending");
    expect(run(["verdict", "wave", "--ci", "none"]).code).toBe(2);
    expect(run([...args, "--events", pending, "--ci", "some"]).code).toBe(2);
  });
});

describe("text a person reads (the text command, #597)", () => {
  test("scanCli names each line that says undefined, NaN, [object Object] or null on", () => {
    expect(scanCli(readFileSync(join(FIXTURES, "text-undefined.txt"), "utf8"))).toEqual([
      { line: 2, word: "undefined", text: "coordinator: undefined on undefined" },
    ]);
    expect(scanCli("a\nrate: NaN/s\nx: [object Object]\ncoordinator: null on box\n")).toEqual([
      { line: 2, word: "NaN", text: "rate: NaN/s" },
      { line: 3, word: "[object Object]", text: "x: [object Object]" },
      { line: 4, word: "null on", text: "coordinator: null on box" },
    ]);
    // Words that merely contain one are fine.
    expect(scanCli("undefinedness; NaNo; nullon\n")).toEqual([]);
  });

  test("JSON is a value, not text: a string value saying undefined passes", () => {
    expect(
      scanCli(JSON.stringify({ msg: "coordinator: undefined on undefined" }, null, 2)),
    ).toEqual([]);
    expect(scanCli(`plain\n${JSON.stringify({ msg: "NaN" })}\n`)).toEqual([]);
  });

  test("the command: 0 on a clean --check and status, 1 listing the line, 2 without a file", () => {
    const dir = tempDir("volley-metrics-text-");
    const clean = join(dir, "status.txt");
    writeFileSync(clean, "wave hello-1 (complete)\ncoordinator: coordinator on athena\n");
    expect(run(["text", join(FIXTURES, "check-pass.json"), clean]).code).toBe(0);
    const json = join(dir, "status.json");
    writeFileSync(json, JSON.stringify({ note: "undefined is a word here" }));
    expect(run(["text", json]).code).toBe(0);
    const bad = run(["text", clean, join(FIXTURES, "text-undefined.txt")]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toBe("undefined\n");
    expect(bad.stderr).toBe(
      `${join(FIXTURES, "text-undefined.txt")}:2: 'undefined': coordinator: undefined on undefined\n`,
    );
    expect(run(["text"]).code).toBe(2);
    expect(run(["text", join(dir, "missing.txt")]).code).toBe(2);
  });
});

describe("the summary command", () => {
  test("passes, prints the table and appends it to the step summary", () => {
    const dir = tempDir("volley-layer1-");
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "earlier\n");
    const r = run(summaryArgs("metrics-pass.json", "check-pass.json"), {
      env: { GITHUB_STEP_SUMMARY: summary },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("### Layer 1: ubuntu-24.04 ✅");
    const written = readFileSync(summary, "utf8");
    expect(written.startsWith("earlier\n")).toBe(true);
    expect(written).toContain("### Layer 1: ubuntu-24.04 ✅");
  });

  for (const [metrics, check, why] of [
    ["metrics-slow.json", "check-pass.json", "over the 15 m target"],
    ["metrics-asked.json", "check-pass.json", "asked 2 questions under --yes"],
    ["metrics-unmerged.json", "check-pass.json", "the test wave did not merge"],
    ["metrics-pass.json", "check-pending.json", "services is pending"],
    ["metrics-pass.json", "check-blocked.json", "broker is blocked"],
  ] as const) {
    test(`exits 1: ${why}`, () => {
      const r = run(summaryArgs(metrics, check));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(why);
      expect(r.stdout).toContain("❌");
    });
  }

  test("--allow-skipped <step> lets that step's row be skipped", () => {
    const args = summaryArgs("metrics-pass.json", "check-phone-skipped.json");
    expect(run(args).code).toBe(1);
    expect(run([...args, "--allow-skipped", "phone"]).code).toBe(0);
  });

  test("a missing file fails and says which", () => {
    const r = run(summaryArgs("nope.json", "check-pass.json"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("nope.json");
  });

  test("--layer, --timing and --out: the run's metrics as JSON", () => {
    const dir = tempDir("volley-layer1-");
    const out = join(dir, "metrics.json");
    const r = run([
      ...summaryArgs("metrics-pass.json", "check-pass.json"),
      "--layer",
      "4",
      "--timing",
      "pair_ready_ms=90000",
      "--out",
      out,
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("### Layer 4: ubuntu-24.04 ✅");
    const written = JSON.parse(readFileSync(out, "utf8"));
    expect(written).toMatchObject({
      label: "ubuntu-24.04",
      layer: 4,
      timings: { pair_ready_ms: 90000 },
      failures: [],
    });
    expect(written.setup.wall_ms).toBe(fixture("metrics-pass.json").wall_ms);
    expect(
      run([...summaryArgs("metrics-pass.json", "check-pass.json"), "--timing", "x"]).code,
    ).toBe(2);
  });

  test("a usage error exits 2", () => {
    expect(run(["summary", "--metrics"]).code).toBe(2);
    expect(run(["frobnicate"]).code).toBe(2);
  });
});

describe("secrets in the logs", () => {
  const PW = "Zq3xV9mK2pL7wR4tY8uB1nC6dF5gH0jE";

  test("secretsFrom collects every password and token in a credentials file", () => {
    expect(
      secretsFrom({
        username: "volleyd",
        password: PW,
        nested: [{ token: "tok-abcdefgh12345678" }],
        short: { password: "x" },
      }),
    ).toEqual([PW, "tok-abcdefgh12345678"]);
  });

  test("scanText finds token-shaped text and the known secrets, never echoing them", () => {
    const text = [
      "volleyd started",
      "merged 0123456789abcdef0123456789abcdef01234567 into main",
      `logged in with ${PW}`,
      "gh says ghp_ABCDEFGHIJKLMNOPQRSTUVWX",
      "key sk-ant-api03-abc_DEF",
      '{"username":"desk","password":"hunter2hunter2"}',
      "password=hunter2hunter2",
      'no "password": "" here',
      "Open the Desk: http://localhost:5199/#signin=vly_admin_93752a6c_69047b0547219adf8cd56c841d3dc6cc",
    ].join("\n");
    const hits = scanText(text, [PW]);
    expect(hits).toEqual([
      { line: 3, kind: "a known secret" },
      { line: 4, kind: "a GitHub token" },
      { line: 5, kind: "an Anthropic key" },
      { line: 6, kind: "a password field" },
      { line: 7, kind: "a password field" },
      { line: 9, kind: "a Volley token" },
    ]);
    expect(JSON.stringify(hits)).not.toContain(PW);
  });

  test("scan exits 1 naming file and line, 0 on clean logs", () => {
    const dir = tempDir("volley-layer1-");
    const creds = join(dir, "broker.json");
    writeFileSync(creds, JSON.stringify({ username: "volleyd", password: PW }));
    const clean = join(dir, "volleyd.log");
    writeFileSync(clean, "volleyd up\nwave started\n");
    const dirty = join(dir, "desk.log");
    writeFileSync(dirty, `desk up\nconnecting as desk:${PW}\n`);
    const missing = join(dir, "unknown.jsonl");

    const ok = run(["scan", "--secrets", creds, clean, missing]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("no secrets in 1 log");

    const bad = run(["scan", "--secrets", creds, clean, dirty]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain(`${dirty}:2: a known secret`);
    expect(`${bad.stdout}${bad.stderr}`).not.toContain(PW);
  });

  test("scan exits 2 on a secrets file it cannot read, not 1", () => {
    const dir = tempDir("volley-layer1-");
    const creds = join(dir, "broker.json");
    writeFileSync(creds, "{ not json");
    const log = join(dir, "volleyd.log");
    writeFileSync(log, "volleyd up\n");
    const r = run(["scan", "--secrets", creds, log]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`cannot read ${creds}`);
  });

  test("redact replaces the known secrets and token-shaped text", () => {
    expect(redact(`pw ${PW} and ghp_ABCDEFGHIJKLMNOPQRSTUVWX`, [PW])).toBe(
      "pw [redacted] and [redacted]",
    );
    // A password shown once and kept nowhere (the Desk's) is caught by its shape: 24 random bytes,
    // base64url. A one-time token too.
    expect(
      redact(
        [
          "New passwords (shown ONCE; store them now):",
          "  desk           XcnnAWEeK-r1Z2chX3aNwJFkgCaXDtBq",
          "  #signin=vly_signin_0123abcd_69047b0547219adf8cd56c841d3dc6cc here",
          "  a commit 0123456789abcdef0123456789abcdef01234567 stays",
        ].join("\n"),
        [],
      ),
    ).toBe(
      [
        "New passwords (shown ONCE; store them now):",
        "  desk           [redacted]",
        "  #signin=[redacted] here",
        "  a commit 0123456789abcdef0123456789abcdef01234567 stays",
      ].join("\n"),
    );
    const dir = tempDir("volley-layer1-");
    const creds = join(dir, "admin.json");
    writeFileSync(creds, JSON.stringify({ username: "admin", password: PW }));
    const r = run(["redact", "--secrets", creds], { stdin: `Admin password: ${PW}\n` });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Admin password: [redacted]\n");
  });
});
