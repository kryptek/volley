import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COORDINATOR_FILES,
  COORDINATOR_SETTINGS,
  REMOTE_CONTROL_ARGV,
  renderCoordinatorMcp,
  renderCoordinatorScript,
} from "../src/coordinator/role";
import {
  FenceError,
  assertAllowed,
  fenceKnowsTypedText,
  fenceKnowsVolleyFile,
  mintCoordinatorKill,
  sealCoordinatorScript,
} from "../src/fence";
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
    for (const n of [
      "decisions.md",
      "agent.json",
      "brief.md",
      "findings.json",
      "retired.json",
      "integrate.md",
    ]) {
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

/**
 * The coordinator role (SPEC §4.6.25): the files its sources write in the coordinator directory
 * and the shapes they run there, each one the fence's COORDINATOR section lets through with the
 * role's token, and nothing typed into its session.
 */
describe("the fence covers the coordinator role", () => {
  const SOURCES = ["coordinator/role.ts", "coordinator/prepare.ts", "coordinator/runner.ts"];
  const DIR = "/path/to/home/.volley/coordinator";
  const vars = {
    dir: DIR,
    name: "coord-test",
    namespace: "default",
    brokerPort: 21883,
    hooksDir: "/opt/volley/packages/volley-hooks",
    binDir: "/path/to/home/.volley/bin",
    capacity: 4,
    permissionMode: "acceptEdits" as const,
    continueGraceS: 10,
  };
  const script = renderCoordinatorScript(vars);
  const ssh = ["ssh", "-T", "-o", "BatchMode=yes", "dev@box-a", "bash", "-s"];
  const host = { name: "box-a", worktree_root: "", broker_port: 21883 };
  const contents: Record<string, string> = {
    [COORDINATOR_FILES.script]: script,
    [COORDINATOR_FILES.login]: '{"username":"coordinator","password":"pw"}\n',
    [COORDINATOR_FILES.mcp]: renderCoordinatorMcp(
      "/opt/volley/packages/volley-mcp/src/index.ts",
      vars,
    ),
    [COORDINATOR_FILES.settings]: COORDINATOR_SETTINGS,
  };

  it("every .volley/<name> the coordinator sources name is one of its directory's files", () => {
    const known = new Set([
      ...Object.values(COORDINATOR_FILES).map((f) => f.replace(/^\.volley\//, "")),
      // The login's directory (VOLLEY_AUTH_DIR), and the machine's own `~/.volley/bin` on the
      // script's PATH: read by the session, never written by volleyd.
      "auth",
      "bin",
    ]);
    const unknown = SOURCES.flatMap((f) =>
      [...volleyNames(src(f))].filter((n) => !known.has(n)).map((n) => `${f}: .volley/${n}`),
    );
    expect(unknown).toEqual([]);
  });

  it("each of its files is a write the fence lets through with the script token, and only with it", () => {
    const coordinator = sealCoordinatorScript(DIR, script);
    for (const [rel, text] of Object.entries(contents)) {
      const step = {
        argv: ["base64", "-d"],
        stdin: Buffer.from(text).toString("base64"),
        stdout: `${DIR}/${rel}`,
      };
      expect(
        () => assertAllowed(ssh, { remote: { steps: [step], host }, coordinator }),
        rel,
      ).not.toThrow();
      expect(() => assertAllowed(ssh, { remote: { steps: [step], host } }), rel).toThrow(
        FenceError,
      );
    }
  });

  it("its tmux shapes pass as REMOTE steps with their tokens; claude remote-control never runs bare", () => {
    const coordinator = sealCoordinatorScript(DIR, script);
    const S = "volley-coordinator-coord-test";
    const shapes: [string[], object][] = [
      [
        ["tmux", "new-session", "-d", "-s", S, "-c", DIR, "bash .volley/coordinator.sh"],
        { coordinator },
      ],
      [["tmux", "has-session", "-t", `=${S}`], {}],
      [["tmux", "capture-pane", "-p", "-t", `=${S}:`, "-S-60"], {}],
      [["tmux", "kill-session", "-t", `=${S}`], { coordinator: mintCoordinatorKill("coord-test") }],
    ];
    for (const [argv, tokens] of shapes)
      expect(
        () => assertAllowed(ssh, { remote: { steps: [{ argv }], host }, ...tokens }),
        argv.join(" "),
      ).not.toThrow();
    expect(() => assertAllowed(REMOTE_CONTROL_ARGV(vars))).toThrow(FenceError);
  });

  it("nothing is typed into the coordinator's session", () => {
    for (const f of SOURCES) expect(src(f), f).not.toMatch(/\.send(?:Text|Keys)\(/);
  });
});
