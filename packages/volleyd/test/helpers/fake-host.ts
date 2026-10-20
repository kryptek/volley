import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DEFAULTS } from "../../src/config-defaults";
import type { ConsentToken } from "../../src/fence";
import type { Host, LaunchSpec, WorktreeResult, WorktreeSpec } from "../../src/hosts/host";
import type { SpawnDeps, SpawnRequest } from "../../src/spawn";
import type { NewEvent, Wave } from "../../src/types";
import type { AgentWatch, SignalState } from "../../src/verify";
import { parseWaveFile } from "../../src/wave-file";
import { type MemoryCredentials, memoryCredentials } from "./fake-dynsec";
import { type FakeExec, fakeExec } from "./fake-exec";
import { tempDir } from "./tmp";

export interface FakeHost extends Host {
  fake: FakeExec;
  worktrees: WorktreeSpec[];
  launches: LaunchSpec[];
  screenReads: { workspace: string; lines: number }[];
  keys: { workspace: string; key: string }[];
  texts: { workspace: string; text: string }[];
  /** Workspaces closed (retire, cleanup). */
  closed: string[];
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
    closed: [],
    screens: [],
    async prepareWorktree(spec): Promise<WorktreeResult> {
      host.worktrees.push(spec);
      mkdirSync(spec.path, { recursive: true });
      const branch = spec.detach === true ? `HEAD (detached at ${spec.base})` : spec.branch;
      return { path: spec.path, branch, reused: false };
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
    async close(workspace: string, _consent: ConsentToken) {
      host.closed.push(workspace);
    },
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
  /** Whether the agent's own MCP server published its spawning/registered status (default true). */
  mcp?: boolean;
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
    hookRegistryAt: o.registry === null ? null : "2026-10-18T12:00:00.000Z",
    sessionStart: o.sessionStart ?? true,
    mcpStatus: o.mcp ?? true,
    status: null,
    lastHeartbeatAt: null,
  };
  return {
    agentId,
    namespace,
    state,
    // The signals are fixed: waiting changes nothing, so the window is over at once.
    waitFor: async (pred) => pred(state),
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
  /** Retained messages the spawn published (a superseded attempt's `reaped` status). */
  published: { topic: string; payload: string }[];
  deps: SpawnDeps;
  /** The logins the spawn minted and revoked. */
  creds: MemoryCredentials;
  request: (over?: Partial<SpawnRequest>) => SpawnRequest;
  /** The worktree a T1 implementer spawn uses. */
  worktree: string;
  cleanup: () => Promise<void>;
}

export const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;

export async function makeSpawnEnv(o: SpawnEnvOptions = {}): Promise<SpawnEnv> {
  const dir = realpathSync(tempDir("volleyd-spawn-"));
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
    // the wave's release branch exists locally (spawn's base, run's RELEASE_BRANCH_MISSING check)
    .on(["git", "-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/release/w1"], {
      stdout: `${"1".repeat(40)}\n`,
    })
    .on(["gh", "issue", "view"], {
      stdout: readFileSync(join(FIXTURES, o.issueFixture ?? "gh-issue-42.json"), "utf-8"),
    });
  const host = fakeHost(fake);
  const creds = memoryCredentials();
  const events: NewEvent[] = [];
  const openDecisions: string[] = [];
  const cleared: string[] = [];
  const published: { topic: string; payload: string }[] = [];
  const deps: SpawnDeps = {
    host,
    home,
    namespace: "volleyd-test",
    brokerUrl: "mqtt://127.0.0.1:1",
    claudeJsonPath: claudeJson,
    hooksDir: "/opt/volley/packages/volley-hooks",
    mcpEntry: "/opt/volley/packages/volley-mcp/src/index.ts",
    mintCredentials: o.mint ?? true,
    credentials: creds,
    tunables: {
      worktree_root: join(dir, "wt"),
      spawn_timeout_s: o.spawnTimeoutS ?? 1,
      heartbeat_alarm_s: 600,
      brief_preface_max_bytes: CONFIG_DEFAULTS.brief_preface_max_bytes,
      agent_mcp: CONFIG_DEFAULTS.agent_mcp,
    },
    owner: null,
    journal: (ev) => {
      events.push(ev);
    },
    openDecisions,
    probe: { status: async () => null, registered: async () => false, lastHeartbeat: () => null },
    watch: o.watch ?? (async (ns, id) => fakeWatch(ns, id)),
    briefGate: null,
    publishRetained: async (topic, payload) => {
      published.push({ topic, payload });
    },
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
    published,
    deps,
    creds,
    request: (over = {}) => ({ wave, task: "T1", role: "implementer", attempt: 1, ...over }),
    worktree: join(dir, "wt", "w1", "T1-implementer"),
    // `dir` is a tempDir, removed when the test ends
    cleanup: async () => {},
  };
}
