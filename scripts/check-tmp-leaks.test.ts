import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupLeaks, leakReport, ownersOf, prefixOf } from "./check-tmp-leaks";

const SCRIPT = join(import.meta.dir, "check-tmp-leaks.ts");

// This file guards against leaked temp dirs, so it cleans up its own.
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fakeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "vly-leakcheck-test-"));
  made.push(dir);
  return dir;
}

/** Runs the script on `sh -c script`, with `TMPDIR` pointing at `tmp`. */
function run(args: string[], tmp: string) {
  const r = Bun.spawnSync(["bun", SCRIPT, ...args], {
    env: { ...process.env, TMPDIR: tmp },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

describe("prefixOf", () => {
  test("strips mkdtemp's suffix from a Volley entry", () => {
    expect(prefixOf("volley-x-abc")).toBe("volley-x-");
    expect(prefixOf("volleyd-claude-Q1w2E3")).toBe("volleyd-claude-");
    expect(prefixOf("vly-conf-aaaaaa")).toBe("vly-conf-");
    expect(prefixOf("wave-from-issues-zzzzzz")).toBe("wave-from-issues-");
    expect(prefixOf("fence-profiles-123456")).toBe("fence-profiles-");
  });

  test("ignores everything that is not Volley's", () => {
    expect(prefixOf("claude-1000")).toBeUndefined();
    expect(prefixOf("tmux-1000")).toBeUndefined();
    expect(prefixOf("volleyball")).toBeUndefined();
  });
});

describe("groupLeaks", () => {
  test("new Volley entries, grouped by prefix; old and foreign ones ignored", () => {
    const before = ["volley-old-111111", "claude-1000"];
    const after = [...before, "volley-x-abc", "volley-x-def", "vly-conf-ghi", "foreign-jkl"];
    expect(groupLeaks(before, after)).toEqual(
      new Map([
        ["volley-x-", ["volley-x-abc", "volley-x-def"]],
        ["vly-conf-", ["vly-conf-ghi"]],
      ]),
    );
  });
});

describe("leakReport", () => {
  test("one line per prefix: count, entries, the files that create it", () => {
    const report = leakReport(new Map([["volley-x-", ["volley-x-abc"]]]), () => ["a.test.ts"]);
    expect(report).toContain("volley-x-: 1 (volley-x-abc) — created in a.test.ts");
  });

  test("a long list is cut short", () => {
    const names = Array.from({ length: 12 }, (_, i) => `volley-x-${i}`);
    const report = leakReport(new Map([["volley-x-", names]]), () => []);
    expect(report).toContain("volley-x-: 12 (volley-x-0, volley-x-1, volley-x-2, …)");
  });
});

describe("ownersOf", () => {
  test("finds the source files that spell out the prefix", () => {
    const root = fakeTmp();
    mkdirSync(join(root, "packages", "p", "test"), { recursive: true });
    writeFileSync(join(root, "packages", "p", "test", "a.test.ts"), 'tempDir("volley-x-");\n');
    writeFileSync(join(root, "packages", "p", "test", "b.test.ts"), 'tempDir("volley-y-");\n');
    expect(ownersOf("volley-x-", root)).toEqual(["packages/p/test/a.test.ts"]);
  });
});

describe("check-tmp-leaks (CLI)", () => {
  test("a command that leaves a Volley dir behind fails, naming it", () => {
    const tmp = fakeTmp();
    const r = run(["--dir", tmp, "--", "sh", "-c", 'mkdir "$TMPDIR/volley-x-abc"'], tmp);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("volley-x-: 1 (volley-x-abc)");
  });

  test("a command that leaves nothing passes", () => {
    const tmp = fakeTmp();
    const r = run(["--dir", tmp, "--", "sh", "-c", "true"], tmp);
    expect(r.code).toBe(0);
  });

  test("entries that existed before the command are ignored", () => {
    const tmp = fakeTmp();
    mkdirSync(join(tmp, "volley-old-abc"));
    const r = run(["--dir", tmp, "--", "sh", "-c", "true"], tmp);
    expect(r.code).toBe(0);
  });

  test("a non-Volley prefix is ignored", () => {
    const tmp = fakeTmp();
    const r = run(["--dir", tmp, "--", "sh", "-c", 'mkdir "$TMPDIR/other-abc"'], tmp);
    expect(r.code).toBe(0);
  });

  test("a failing command's exit code wins", () => {
    const tmp = fakeTmp();
    const r = run(["--dir", tmp, "--", "sh", "-c", "exit 3"], tmp);
    expect(r.code).toBe(3);
  });

  test("by default the command gets a private temp dir, removed afterwards, leaks and all", () => {
    const tmp = fakeTmp();
    const r = run(["--", "sh", "-c", 'mkdir "$TMPDIR/volley-x-abc"'], tmp);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("volley-x-: 1 (volley-x-abc)");
    // Nothing reaches the real temp dir: the private one is gone too.
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("--dir without a path prints usage", () => {
    const tmp = fakeTmp();
    for (const args of [["--dir"], ["--dir", "--", "true"]]) {
      const r = run(args, tmp);
      expect(r.code).toBe(2);
      expect(r.out).toContain("usage");
    }
  });

  test("a command killed by a signal says so", () => {
    const tmp = fakeTmp();
    const r = run(["--dir", tmp, "--", "sh", "-c", "kill -TERM $$"], tmp);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("killed by SIGTERM");
  });

  test("without a command it prints usage", () => {
    const tmp = fakeTmp();
    const r = run([], tmp);
    expect(r.code).toBe(2);
    expect(r.out).toContain("usage");
    expect(existsSync(tmp)).toBe(true);
  });
});
