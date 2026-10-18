import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ConsentToken } from "../../src/fence";
import type { Host, LaunchSpec, WorktreeResult, WorktreeSpec } from "../../src/hosts/host";
import type { SpawnDeps, SpawnRequest } from "../../src/spawn";
import type { NewEvent, Wave } from "../../src/types";
import type { AgentWatch, SignalState } from "../../src/verify";
import { parseWaveFile } from "../../src/wave-file";
import { type FakeExec, fakeExec } from "./fake-exec";

export interface FakeHost extends Host {
  fake: FakeExec;
  worktrees: WorktreeSpec[];
  launches: LaunchSpec[];
  screenReads: { workspace: string; lines: number }[];
  keys: { workspace: string; key: string }[];
  texts: { workspace: string; text: string }[];
  /** Screens returned by successive readScreen calls (the last one repeats); null = unreadable. */
  screens: (string | null)[];
  /** Called after each launch, e.g. to publish the hook signals a real agent would. */
  onLaunch?: (spec: LaunchSpec, workspace: string) => void | Promise<void>;
}

/**
 * A host that runs nothing: worktrees are plain directories, files are written for real (tests
 * use a temp dir), launches are recorded and answered with `workspace:<n>`.
 */
export function fakeHost(fake: FakeExec = fakeExec()): FakeHost {
  let n = 0;
  const host: FakeHost = {
    name: "local",
    fake,
    exec: fake.exec,
    worktrees: [],
    launches: [],
    screenReads: [],
    keys: [],
    texts: [],
    screens: [],
    async prepareWorktree(spec): Promise<WorktreeResult> {
      host.worktrees.push(spec);
      mkdirSync(spec.path, { recursive: true });
      return { path: spec.path, branch: spec.branch, reused: false };
    },
    async writeFile(path, content, mode) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, mode !== undefined ? { mode } : {});
      if (mode !== undefined) chmodSync(path, mode);
    },
    async launch(spec) {
      host.launches.push(spec);
      const workspace = `workspace:${++n}`;
      await host.onLaunch?.(spec, workspace);
      return { workspace };
    },
    async readScreen(workspace, lines) {
      host.screenReads.push({ workspace, lines });
      const s = host.screens.length > 1 ? host.screens.shift() : host.screens[0];
      return s ?? null;
    },
    async sendKeys(workspace, key) {
      host.keys.push({ workspace, key });
    },
    async sendText(workspace, text) {
      host.texts.push({ workspace, text });
    },
    async close(_workspace: string, _consent: ConsentToken) {},
  };
  return host;
}

// ---------------------------------------------------------------------------------------------
// A complete spawn environment on fakes: temp dirs, a trusted (or not) repo, scripted gh/volley.
// ---------------------------------------------------------------------------------------------

export interface FakeWatchOptions {
  /** Hook registry entry the watch already holds (null: none yet). */
  registry?: Record<string, unknown> | null;
  sessionStart?: boolean;
}

/** A watch whose signals are fixed up front (no broker). */
export function fakeWatch(
  namespace: string,
  agentId: string,
  o: FakeWatchOptions = {},
): AgentWatch {
  const state: SignalState = {
    hookRegistry:
      o.registry === undefined
        ? { model: "claude-opus-5-5", model_source: "harness-hook" }
        : o.registry,
    sessionStart: o.sessionStart ?? true,
    status: null,
    lastHeartbeatAt: null,
  };
  return {
    agentId,
    namespace,
    state,
    waitFor: async (pred, ms) => {
      if (pred(state)) return true;
      await new Promise((r) => setTimeout(r, Math.min(ms, 50)));
      return pred(state);
    },
    onStatus: () => {},
    onProgress: () => {},
    close: async () => {},
  };
}

export interface SpawnEnvOptions {
  trusted?: boolean;
  /** gh issue fixture file under test/fixtures (default gh-issue-42.json). */
  issueFixture?: string;
  /** The wave's issue number for T1 (default 42). */
  issue?: number;
  mint?: boolean;
  watch?: SpawnDeps["watch"];
  spawnTimeoutS?: number;
}

export interface SpawnEnv {
  dir: string;
  home: string;
  repo: string;
  claudeJson: string;
  wave: Wave;
  host: FakeHost;
  events: NewEvent[];
  openDecisions: string[];
  /** Topics the spawn cleared with an empty retained payload (a superseded attempt's). */
  cleared: string[];
  deps: SpawnDeps;
  request: (over?: Partial<SpawnRequest>) => SpawnRequest;
  /** The worktree a T1 implementer spawn uses. */
  worktree: string;
  cleanup: () => Promise<void>;
}

export const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;

export async function makeSpawnEnv(o: SpawnEnvOptions = {}): Promise<SpawnEnv> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "volleyd-spawn-")));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const claudeJson = join(dir, "claude.json");
  writeFileSync(
    claudeJson,
    JSON.stringify({
      projects: o.trusted === false ? {} : { [repo]: { hasTrustDialogAccepted: true } },
    }),
  );
  const issue = o.issue ?? 42;
  const wave = parseWaveFile(
    [
      "wave: w1",
      `repo: ${repo}`,
      "release_branch: release/w1",
      "model: claude-opus-5-5",
      "pipeline: [implement]",
      "tasks:",
      `  T1: { issue: ${issue} }`,
      "",
    ].join("\n"),
  );
  const fake = fakeExec()
    .on(["git", "-C", repo, "rev-parse", "--show-toplevel"], { stdout: `${repo}\n` })
    .on(["gh", "issue", "view"], {
      stdout: readFileSync(join(FIXTURES, o.issueFixture ?? "gh-issue-42.json"), "utf-8"),
    })
    .on(["volley", "auth", "add-agent"], (argv) => ({
      stdout: JSON.stringify({ username: argv[3], password: `pw-${argv[3]}` }),
    }));
  const host = fakeHost(fake);
  const events: NewEvent[] = [];
  const openDecisions: string[] = [];
  const cleared: string[] = [];
  const deps: SpawnDeps = {
    host,
    home,
    namespace: "volleyd-test",
    brokerUrl: "mqtt://127.0.0.1:1",
    claudeJsonPath: claudeJson,
    hooksDir: "/opt/volley/packages/volley-hooks",
    mintCredentials: o.mint ?? true,
    tunables: {
      worktree_root: join(dir, "wt"),
      spawn_timeout_s: o.spawnTimeoutS ?? 1,
      heartbeat_alarm_s: 600,
    },
    owner: null,
    journal: (ev) => {
      events.push(ev);
    },
    openDecisions,
    probe: { status: async () => null, registered: async () => false, lastHeartbeat: () => null },
    watch: o.watch ?? (async (ns, id) => fakeWatch(ns, id)),
    briefGate: null,
    clearRetained: async (topic) => {
      cleared.push(topic);
    },
    relaunchSettleMs: 50,
  };
  return {
    dir,
    home,
    repo,
    claudeJson,
    wave,
    host,
    events,
    openDecisions,
    cleared,
    deps,
    request: (over = {}) => ({ wave, task: "T1", role: "implementer", attempt: 1, ...over }),
    worktree: join(dir, "wt", "w1", "T1-implementer"),
    cleanup: async () => rmSync(dir, { recursive: true, force: true }),
  };
}
