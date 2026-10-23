import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fenceKnowsTypedText, fenceKnowsVolleyFile } from "../src/fence";
import { LAUNCH_COMMAND } from "../src/launch";
import { CONTINUE_TEXT, WAKE_TEXT } from "../src/liveness";

/**
 * The files the supervisor reads or writes in a worktree's `.volley/` through the task's host,
 * which is a paired machine's ssh adapter for a remote task: every name they use must be one
 * the remote fence lets through, or the step is denied only on a paired machine, in a wave
 * (#393, #401). This fails the build instead.
 */
const SOURCES = [
  "spawn.ts",
  "daemon.ts",
  "decisions.ts",
  "pipeline.ts",
  "identity.ts",
  "reviews.ts",
  "retire.ts",
  "launch.ts",
  "brief.ts",
  "autopilot/carry.ts",
  "recovery.ts",
];

/**
 * Names only the supervisor's own disk ever sees, each with why it never crosses to a box:
 * add one here only with that reason.
 */
const LOCAL_ONLY: Record<string, string> = {
  // The release task's stage brief: releaseWaveTask is always `host: "local"`.
  "stage.md": "the release task runs on the supervisor",
  // spawn.ts passes hooksErrorPath only when `deps.host.name === "local"`.
  "hooks-error.json": "read only for a local worktree",
  // brief.ts readBriefPreface reads the wave repo's preface with readFileSync, at submit and spawn.
  "brief-preface.md": "read from the supervisor's own checkout",
};

const src = (f: string) => readFileSync(join(import.meta.dirname, "..", "src", f), "utf-8");

/** Every `.volley/<name>` a source names: join(…, ".volley", "<name>"), ".volley/<name>", and a spawn's `files` keys. */
function volleyNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/"\.volley",\s*"([^"]+)"/g)) names.add(m[1] as string);
  for (const m of text.matchAll(/\.volley\/([A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])/g))
    names.add(m[1] as string);
  for (const m of text.matchAll(/"([a-z][a-z0-9-]*\.(?:md|json))"\s*:/g)) names.add(m[1] as string);
  return names;
}

/**
 * The constants a source may type, by name. A variable (`answer`, `k.text`) is text a token
 * carries, checked when it is typed; a constant is checked here.
 */
const CONSTANTS: Record<string, string> = { WAKE_TEXT, LAUNCH_COMMAND, CONTINUE_TEXT };

/** Every string literal or CONSTANT passed to `sendText(` / `sendKeys(` as the text or key. */
function typed(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(
    /\.send(?:Text|Keys)\(\s*[^,]+,\s*("[^"]*"|[A-Z][A-Z0-9_]*)(?=\s*[,)])/g,
  )) {
    out.add(m[1] as string);
  }
  return out;
}

/** The value a typed expression stands for, or undefined for a constant this test does not know. */
const typedValue = (t: string) => (t.startsWith('"') ? (JSON.parse(t) as string) : CONSTANTS[t]);

describe("the remote fence covers what the supervisor touches on a paired machine", () => {
  it("every .volley/<name> the sources read or write is one the fence lets through", () => {
    const unknown: string[] = [];
    for (const f of SOURCES) {
      for (const name of volleyNames(src(f))) {
        if (!fenceKnowsVolleyFile(name) && LOCAL_ONLY[name] === undefined) {
          unknown.push(`${f}: .volley/${name}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it("finds the names it is meant to find (the scan is not vacuous)", () => {
    const all = new Set(SOURCES.flatMap((f) => [...volleyNames(src(f))]));
    for (const n of ["decisions.md", "agent.json", "brief.md", "findings.json", "retired.json"]) {
      expect(all.has(n), n).toBe(true);
    }
    expect(fenceKnowsVolleyFile("other.md")).toBe(false);
  });

  it("every text or key typed into an agent's terminal is one the fence knows", () => {
    const unknown: string[] = [];
    const seen = new Set<string>();
    for (const f of SOURCES) {
      for (const t of typed(src(f))) {
        seen.add(t);
        const v = typedValue(t);
        if (v === undefined || !fenceKnowsTypedText(v)) unknown.push(`${f}: ${t}`);
      }
    }
    expect(unknown).toEqual([]);
    for (const t of ["WAKE_TEXT", "LAUNCH_COMMAND", '"Enter"', '"Escape"']) {
      expect(seen.has(t), t).toBe(true);
    }
    expect(fenceKnowsTypedText("rm -rf ~")).toBe(false);
  });
});
