import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/tmp";
import { WALL_TARGET_MS, evaluate, redact, scanText, secretsFrom } from "./metrics";

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

  test("a missing file fails and says which", () => {
    const r = run(summaryArgs("nope.json", "check-pass.json"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("nope.json");
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
