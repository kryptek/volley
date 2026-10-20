import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DEFAULTS } from "../../src/config-defaults";
import type { ExecFn, ExecOptions, ExecResult } from "../../src/exec";
import { type ConsentToken, type RemoteStep, assertAllowed } from "../../src/fence";
import type { Host, LaunchSpec, WorktreeResult, WorktreeSpec } from "../../src/hosts/host";
import type { RemoteHost, RemoteHostSpec, RemoteRunOptions } from "../../src/hosts/ssh-tmux";
import type { DoctorReport } from "../../src/machines";
import type { PathProbe } from "../../src/readiness";
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
  /** @deprecated Nothing to release: the dir is a tempDir, removed when the test ends. */
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
    cleanup: async () => {},
  };
}

// ---------------------------------------------------------------------------------------------
// A paired machine on fakes (RemoteHost): its own tunnel always answers the port check.
// ---------------------------------------------------------------------------------------------

export interface FakeRemoteAnswers {
  /** probePath's answer (an Error: ssh failed). Default: both tools resolve. */
  path?: PathProbe | Error;
  /**
   * runDoctor's answer (an Error: ssh failed; a function: a run that ends when its promise does).
   * Default: an all-green report.
   */
  doctor?: DoctorReport | Error | (() => Promise<DoctorReport>);
}

export type FakeRemoteHost = FakeHost &
  RemoteHost & {
    answers: FakeRemoteAnswers;
    probes: number;
    doctorRuns: { fix: boolean; clone: boolean }[];
  };

/** A doctor report with every check passing. */
export const GREEN_DOCTOR: DoctorReport = {
  checks: [{ id: "repo.clone", ok: true, severity: "block", detail: "clone at /srv/repo" }],
  versions: { peer: "0.2.0", volley: "0.2.0", bun: "1.3.1", git: "2.43.0" },
  auth: { gh: "ok", claude: "signed_in", trust: "ok" },
  doctor_at: "2026-10-19T09:00:00.000Z",
};

export function fakeRemoteHost(
  spec: RemoteHostSpec,
  local: FakeHost,
  answers: FakeRemoteAnswers = {},
): FakeRemoteHost {
  const h = fakeHost(local.fake) as unknown as FakeRemoteHost;
  Object.assign(h, {
    name: spec.name,
    spec,
    screenSource: "tmux",
    hooksDir: `${spec.volley_dir}/packages/volley-hooks`,
    mcpEntry: `${spec.volley_dir}/packages/volley-mcp/src/index.ts`,
    brokerUrl: `mqtt://127.0.0.1:${spec.tunnel.remote_port}`,
    launchEnv: (id: { agent_id: string; namespace: string }) => ({
      VOLLEY_BROKER_URL: `mqtt://127.0.0.1:${spec.tunnel.remote_port}`,
      VOLLEY_NAMESPACE: id.namespace,
      VOLLEY_AGENT_ID: id.agent_id,
    }),
    repoExists: async () => true,
    tunnelUp: async () => true,
    readTrust: async () => ({ projects: { [spec.repo]: { hasTrustDialogAccepted: true } } }),
    recordTrust: async () => {},
    readFile: async () => null,
    answers,
    probes: 0,
    doctorRuns: [],
    // The box's steps as the local `ssh -T … bash -s` (the fake exec checks the fence).
    run: (steps: RemoteStep[], opts: RemoteRunOptions = {}) =>
      local.fake.exec(["ssh", "-T", "-o", "BatchMode=yes", spec.target, "bash", "-s"], {
        ...opts,
        remote: { steps },
      }),
    probePath: async () => {
      h.probes++;
      const a = h.answers.path ?? { claude: true, bun: true };
      if (a instanceof Error) throw a;
      return a;
    },
    runDoctor: async (opts: { fix: boolean; clone: boolean }) => {
      h.doctorRuns.push(opts);
      const a = h.answers.doctor ?? GREEN_DOCTOR;
      if (a instanceof Error) throw a;
      return typeof a === "function" ? a() : a;
    },
  });
  return h;
}

// ---------------------------------------------------------------------------------------------
// A paired machine's Claude sign-in (F8): the box's tmux / claude / files, and the forward.
// ---------------------------------------------------------------------------------------------

const claudeFixture = (name: string) =>
  readFileSync(new URL(`../fixtures/claude/${name}`, import.meta.url), "utf-8");
/** What a box's sign-in session shows: the printed (manual-code) URL. */
export const SIGNIN_TRANSCRIPT = claudeFixture("auth-login-tmux.txt");
/** What Claude Code handed `$BROWSER`: the localhost-callback URL, port 51051. */
export const SIGNIN_CALLBACK = claudeFixture("browser-url.txt").trim();
/** What ssh prints when the forward's local port is taken. */
const FORWARD_BUSY =
  "bind [127.0.0.1]:51051: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 51051\nCould not request local forwarding.\n";

export interface SigninBoxOptions {
  /** `claude auth status` reports loggedIn from this call on (never: undefined). */
  signInAfter?: number;
  /** Claude Code calls `$BROWSER` (default true). */
  browser?: boolean;
  /** The callback URL of each start, in turn (default SIGNIN_CALLBACK every time). */
  callbacks?: string[];
  /** How many forwards exit at once with the port taken. */
  busy?: number;
  noTmux?: boolean;
  /** The box's HOME (default /home/dev). */
  home?: string;
  /** Runs while a `claude auth status` is in flight, before it answers. */
  onAuthStatus?: (box: { session: boolean }) => void;
}

/**
 * The local exec of a supervisor whose `ssh -T … bash -s` reaches a fake box (its sign-in tmux
 * session, url file and `claude auth status`), and whose `ssh -N -L` forwards run until aborted
 * (or exit at once, `busy`). Every argv passes the real fence.
 */
export function fakeSigninBox(o: SigninBoxOptions = {}) {
  const fx = fakeExec();
  const home = o.home ?? "/home/dev";
  const box = { files: new Map<string, string>(), session: false, starts: 0, polls: 0 };
  const scripts: string[][][] = [];
  fx.on(["ssh", "-T"], (_argv, opts) => {
    const steps = opts.remote?.steps ?? [];
    scripts.push(steps.map((s) => s.argv));
    let out = "";
    for (const s of steps) {
      const [p, ...a] = s.argv;
      if (s.stdout !== undefined) {
        box.files.set(s.stdout, Buffer.from(s.stdin ?? "", "base64").toString("utf-8"));
      } else if (p === "printenv") out += `${home}\n`;
      else if (p === "tmux" && a[0] === "new-session") {
        if (o.noTmux === true)
          return { code: 127, stderr: "bash: line 3: tmux: command not found\n" };
        box.session = true;
        const url = o.callbacks?.[box.starts] ?? SIGNIN_CALLBACK;
        box.starts++;
        if (o.browser !== false) box.files.set(`${a[5]}/url`, `${url}\n`);
      } else if (p === "tmux" && a[0] === "kill-session") {
        const had = box.session;
        box.session = false;
        if (!had) return { code: 1, stderr: "can't find session\n" };
      } else if (p === "tmux" && a[0] === "has-session") {
        if (!box.session) return { code: 1 };
      } else if (p === "tmux" && a[0] === "capture-pane") {
        if (!box.session) return { code: 1 };
        out += SIGNIN_TRANSCRIPT;
      } else if (p === "cat") {
        const f = box.files.get(a[0] as string);
        if (f === undefined) return { code: 1 };
        out += f;
      } else if (p === "claude") {
        box.polls++;
        o.onAuthStatus?.(box);
        return o.signInAfter !== undefined && box.polls >= o.signInAfter
          ? { stdout: JSON.stringify({ loggedIn: true, subscriptionType: "max" }) }
          : { code: 1, stdout: JSON.stringify({ loggedIn: false }) };
      }
    }
    return { stdout: out };
  });
  const forwards: { argv: string[]; stopped: boolean }[] = [];
  let busy = o.busy ?? 0;
  const exec: ExecFn = async (argv, opts: ExecOptions = {}): Promise<ExecResult> => {
    if (argv[0] === "ssh" && argv[1] === "-N" && argv[2] === "-L") {
      assertAllowed(argv, opts);
      const f = { argv: [...argv], stopped: false };
      forwards.push(f);
      if (busy > 0) {
        busy--;
        return { code: 255, stdout: "", stderr: FORWARD_BUSY, timedOut: false };
      }
      await new Promise((r) => opts.signal?.addEventListener("abort", r, { once: true }));
      f.stopped = true;
      return { code: 255, stdout: "", stderr: "", timedOut: false };
    }
    return fx.exec(argv, opts);
  };
  /** Every remote argv, flattened, in order. */
  const steps = () => scripts.flat();
  const ran = (...prefix: string[]) =>
    steps().filter((argv) => prefix.every((p, i) => argv[i] === p));
  return { exec, fake: fx, box, forwards, steps, ran };
}
