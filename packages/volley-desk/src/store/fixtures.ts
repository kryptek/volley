/**
 * Demo mode: the prototype's sample state and its `tick` simulation, expressed
 * as the Volley topics a supervisor and its agents would publish
 * (`volley/_waves/<wave>/state`, `volley/<ns>/<agent>/{status,progress,screen}`,
 * …) and folded through the real reducer, so demo mode exercises the same code
 * path as a live broker. Enabled by `?demo=1` or `VITE_VOLLEY_DEMO=1`;
 * `&agents=N` (dev only) adds working agents on a `load-test` wave, for the
 * 20-agent fps check.
 */
import type { RegistryAccount } from "./claude";
import { initialState, reduceAll } from "./reducer";
import type {
  DeskMessage,
  DeskState,
  DigestPayload,
  Envelope,
  InboxItem,
  PlanCluster,
  Role,
  Stage,
  WaveAccount,
  WaveCoordinator,
  WaveStatePayload,
  WaveTask,
} from "./types";

export function isDemoMode(search: string, env: Record<string, unknown>): boolean {
  return new URLSearchParams(search).get("demo") === "1" || env.VITE_VOLLEY_DEMO === "1";
}

const NS = "demo";
const SUPERVISOR = "volleyd";
/** The supervisor's own machine (`fleet.local_name`, SPEC §4.6.15). */
const LOCAL_MACHINE = "studio";
const MODEL = "claude-opus-5-5";
const PIPELINE = ["implement", ["spec_review", "quality_review"], "fixup", "merge_ready"];

const iso = (ms: number) => new Date(ms).toISOString();

function env(
  agentId: string,
  channel: string,
  type: string,
  payload: unknown,
  at: number,
  extra: Partial<Envelope> = {},
): Envelope {
  return {
    schema_version: "0.1",
    agent_id: agentId,
    wall_time: iso(at),
    channel,
    type,
    payload,
    ...extra,
  };
}

function hash(lines: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const ch of lines.join("\n")) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

// ------------------------------------------------------------------- waves

interface TaskDef {
  id: string;
  issue: number;
  title: string;
  after: string[];
  stage: Stage;
  agents?: Partial<Record<Role, string>>;
}

interface WaveDef {
  id: string;
  owner: string;
  coordinator: Omit<WaveCoordinator, "agent_id" | "last_seen" | "presence"> & {
    lastSeenMin: number;
  };
  status: WaveStatePayload["status"];
  releaseBranch: string;
  /** The account its new agents start under (wave-state `account`); absent: balanced. */
  account?: WaveAccount;
  tasks: TaskDef[];
  decision?: {
    task: string;
    kind: "merge_conflict" | "agent_blocked";
    question: string;
    options: string[];
  };
}

const WAVES: WaveDef[] = [
  {
    id: "status-chip",
    owner: "coordinator-desk1",
    coordinator: {
      state: "awaiting_input",
      question:
        "T2 is merge-ready but T3 will rebase over the same component. Merge T2 now, or hold it until T3’s reviews land?",
      session_url: "https://claude.ai/code/session-example-1",
      workspace: "workspace:14",
      lastSeenMin: 0,
    },
    status: "running",
    releaseBranch: "release/2026-10-20-status-chip",
    // Pinned to the Team account (the demo registry's): its window's chip names it.
    account: { pinned: "team", source: "wave" },
    tasks: [
      { id: "T0", issue: 101, title: "Status chip data contract", after: [], stage: "done" },
      {
        id: "T1",
        issue: 102,
        title: "Chip mapper + null-case handling",
        after: ["T0"],
        stage: "fixup",
        agents: { fixup: "status-chip-t1-fixup-1" },
      },
      {
        id: "T2",
        issue: 103,
        title: "Status column in the table",
        after: ["T0"],
        stage: "merge_ready",
        agents: { implementer: "status-chip-t2-implementer-1" },
      },
      { id: "T3", issue: 104, title: "Detail page badge", after: ["T1", "T2"], stage: "queued" },
    ],
  },
  {
    id: "ci-speed",
    owner: "coordinator-desk2",
    coordinator: { state: "working", workspace: "workspace:9", lastSeenMin: 0 },
    status: "running",
    releaseBranch: "release/2026-10-17-ci-speed",
    tasks: [
      {
        id: "T3b",
        issue: 111,
        title: "Split integration test shards",
        after: [],
        stage: "implement",
        agents: { implementer: "ci-speed-t3b-implementer-1" },
      },
      {
        id: "T6",
        issue: 112,
        title: "Cache dependencies on the runner",
        after: [],
        stage: "spec_review",
      },
      { id: "FA", issue: 113, title: "Flaky test root cause", after: [], stage: "done" },
      {
        id: "FB",
        issue: 114,
        title: "Deterministic query-plan test",
        after: ["FA"],
        stage: "awaiting_decision",
        agents: { implementer: "ci-speed-fb-implementer-1" },
      },
    ],
    decision: {
      task: "FB",
      kind: "merge_conflict",
      question:
        "FB conflicts with FA in the query-plan test after rebase. Re-dispatch a fixup or resolve by hand?",
      options: ["fixup", "manual"],
    },
  },
  {
    id: "leaderboard",
    owner: "coordinator-desk3",
    coordinator: { state: "gone", lastSeenMin: 34 },
    status: "awaiting_decision",
    releaseBranch: "release/2026-10-18-leaderboard",
    tasks: [
      { id: "T0", issue: 121, title: "Ranking migration", after: [], stage: "done" },
      {
        id: "T1",
        issue: 122,
        title: "API exposes rank",
        after: ["T0"],
        stage: "awaiting_decision",
        agents: { implementer: "leaderboard-t1-implementer-1" },
      },
      { id: "T2", issue: 123, title: "Rank column in the UI", after: ["T1"], stage: "queued" },
    ],
    decision: {
      task: "T1",
      kind: "agent_blocked",
      question: "Should ties share a rank (1,1,3) or be dense (1,1,2)?",
      options: ["shared", "dense"],
    },
  },
];

/** Where the demo's placed tasks run, and why (SPEC §4.6.15 `tasks[].placement`). */
function placed(wave: string, task: string, now: number) {
  // An agent window's machine chip: a running task placed on the supervisor's own machine.
  if (wave === "ci-speed" && task === "T3b") {
    return {
      placement: {
        host: LOCAL_MACHINE,
        by: "auto" as const,
        score: 0.66,
        decided_at: iso(now - 40 * 60_000),
        candidates: [
          {
            host: LOCAL_MACHINE,
            score: 0.66,
            line: `${LOCAL_MACHINE}: 0.66 (cpu 0.7, slots 0.67, mem 0.6, usage 0.58)`,
          },
          {
            host: "box-a",
            score: 0.52,
            line: "box-a: 0.52 (cpu 0.83, slots 0.17, mem 0.71, usage 0.58)",
          },
        ],
      },
    };
  }
  if (wave !== "ci-speed" || task !== "T6") return {};
  return {
    host: "box-a",
    base_sha: "4f9c2e1d8b7a6c5e4d3c2b1a0f9e8d7c6b5a4f3e",
    placement: {
      host: "box-a",
      by: "auto" as const,
      score: 0.74,
      decided_at: iso(now - 25 * 60_000),
      candidates: [
        {
          host: "box-a",
          score: 0.74,
          line: "box-a: 0.74 (cpu 0.83, slots 0.67, mem 0.71, usage 0.58)",
        },
        {
          host: LOCAL_MACHINE,
          score: 0.41,
          line: `${LOCAL_MACHINE}: 0.41 (cpu 0.2, slots 0.58, mem 0.52, usage 0.58)`,
        },
        { host: "box-b", score: null, line: "ineligible: box-b is down (no heartbeat for 90 s)" },
      ],
    },
  };
}

/** The demo waves' repository on GitHub (SPEC §4.6.1), so the demo shows chips and links. */
const DEMO_GITHUB = {
  slug: "example-org/example-repo",
  url: "https://github.com/example-org/example-repo",
};

const decisionId = (w: WaveDef) =>
  `${w.id}-${w.decision?.task.toLowerCase()}-${w.decision?.kind}-1`;

function waveState(w: WaveDef, now: number, tasks: TaskDef[] = w.tasks): DeskMessage {
  const { lastSeenMin, ...coordinator } = w.coordinator;
  const payload: WaveStatePayload = {
    wave: w.id,
    version: 1,
    owner: w.owner,
    repo: "/srv/work/example-repo",
    release_branch: w.releaseBranch,
    github: DEMO_GITHUB,
    status: w.status,
    tasks: tasks.map((t) => ({
      id: t.id,
      issue: t.issue,
      stage: t.stage,
      agents: t.agents ?? {},
      ...placed(w.id, t.id, now),
      ...(t.stage === "queued" && t.after.length
        ? { waiting_on: t.after, why_waiting: `after: ${t.after.join(", ")}` }
        : {}),
    })),
    open_decisions: w.decision ? [decisionId(w)] : [],
    gates: tasks.filter((t) => t.stage === "merge_ready").map((t) => t.id),
    spec: {
      version: 1,
      release_branch: w.releaseBranch,
      model: MODEL,
      pipeline: PIPELINE,
      tasks: Object.fromEntries(
        tasks.map((t) => [t.id, { issue: t.issue, title: t.title, after: t.after }]),
      ),
    },
    coordinator: {
      agent_id: w.owner,
      presence:
        coordinator.state === "working" || coordinator.state === "awaiting_input"
          ? "online"
          : "offline",
      ...coordinator,
      last_seen: iso(now - lastSeenMin * 60_000),
    },
    account: w.account ?? { pinned: null, source: "balanced" },
    updated_at: iso(now),
  };
  return {
    topic: `volley/_waves/${w.id}/state`,
    envelope: env(SUPERVISOR, "_waves/state", "wave_state", payload, now),
    receivedAt: now,
  };
}

function decision(w: WaveDef, now: number): DeskMessage[] {
  if (!w.decision) return [];
  const id = decisionId(w);
  const payload = { decision_id: id, wave: w.id, ...w.decision, pointers: {}, opened_at: iso(now) };
  return [
    {
      topic: `volley/_waves/${w.id}/decisions/${id}`,
      envelope: env(SUPERVISOR, "_waves/decisions", "decision_opened", payload, now),
      receivedAt: now,
    },
  ];
}

// ------------------------------------------------------------------ agents

type FeedRow = [
  agoS: number,
  channel: "status" | "progress" | "mailbox" | "result",
  type: string,
  msg: string,
  progress?: number,
];

interface AgentDef {
  id: string;
  parent: string;
  bornMin: number;
  heartbeatAgoS: number;
  feed: FeedRow[];
  screen: string[];
}

const AGENTS: AgentDef[] = [
  {
    id: "status-chip-t1-fixup-1",
    parent: "coordinator-desk1",
    bornMin: 14,
    heartbeatAgoS: 4,
    feed: [
      [610, "status", "working", "fixup started from review findings"],
      [480, "progress", "narration", "Reading both reviews: 1 P1, 2 P2", 20],
      [300, "mailbox", "steering", "Coordinator: keep the P2 rename out of this PR"],
      [296, "progress", "acked-steering", "Acknowledged: leaving the rename for a follow-up", 34],
      [
        120,
        "progress",
        "narration",
        "RED test for the legacy alias written, failing as expected",
        55,
      ],
      [
        20,
        "progress",
        "narration",
        "Addressing quality P1: legacy CLSD alias falls through to the raw enum",
        62,
      ],
    ],
    screen: [
      "⏺ Bash(npx vitest run src/chip-mapper.test.ts)",
      '  ⎿  ✓ maps closed_paid → "Paid" (3 ms)',
      '     ✓ maps null status → "—" (1 ms)',
      '     ✗ maps legacy "CLSD" alias → "Closed"',
      "⏺ The legacy alias isn’t in the lookup. Adding it with a test.",
      "⏺ Update(src/chip-mapper.ts)",
    ],
  },
  {
    id: "status-chip-t2-implementer-1",
    parent: "coordinator-desk1",
    bornMin: 52,
    heartbeatAgoS: 9,
    feed: [
      [1900, "status", "working", "implementing the status column"],
      [700, "progress", "narration", "All 14 vitest + light-mode guard green", 90],
      [400, "result", "pr", "PR #18 opened against release/2026-10-20-status-chip", 96],
      [
        90,
        "progress",
        "narration",
        "Merge-ready: CI green on head 3f9c2e1, both reviews clean",
        100,
      ],
      [88, "status", "done", "merge-ready evidence published", 100],
    ],
    screen: [
      "⏺ gh pr checks 18",
      "  ⎿  ✓ web            1m42s",
      "     ✓ integration    6m10s",
      "⏺ Published merge-ready evidence. Done.",
    ],
  },
  {
    id: "ci-speed-t3b-implementer-1",
    parent: "coordinator-desk2",
    bornMin: 22,
    heartbeatAgoS: 6,
    feed: [
      [1300, "status", "working", "implementing shard split"],
      [500, "progress", "narration", "Matrix written: 4 shards by test-class hash", 38],
      [
        60,
        "progress",
        "lease-wait",
        "Waiting for a heavy-it lease (3/3 held) to run the shard matrix",
        41,
      ],
    ],
    screen: [
      "⏺ volley lease acquire heavy-it --wait",
      "  ⎿  queued: position 2 of 2 (3/3 heavy-it leases held)",
    ],
  },
  {
    id: "ci-speed-fb-implementer-1",
    parent: "coordinator-desk2",
    bornMin: 31,
    heartbeatAgoS: 12,
    feed: [
      [900, "status", "working", "implementing deterministic plan assertion"],
      [200, "progress", "narration", "Rebased onto release branch after FA merged", 70],
      [
        45,
        "status",
        "blocked",
        "Blocked: rebase conflict in the query-plan test after FA merged",
        77,
      ],
    ],
    screen: [
      "⏺ git rebase origin/release/2026-10-17-ci-speed",
      "  ⎿  CONFLICT (content): Merge conflict in test/query-plan.test.ts",
      "⏺ Publishing blocked; this needs a coordinator decision.",
    ],
  },
  {
    id: "leaderboard-t1-implementer-1",
    parent: "coordinator-desk3",
    bornMin: 40,
    heartbeatAgoS: 15,
    feed: [
      [2400, "status", "working", "implementing rank field"],
      [
        2100,
        "status",
        "blocked",
        "Blocked: should ties share a rank (1,1,3) or be dense (1,1,2)?",
        58,
      ],
    ],
    screen: [
      "⏺ Two valid tie conventions. This is a product call, not mine.",
      "⏺ Publishing blocked with the question.",
    ],
  },
];

function registry(id: string, parent: string, at: number): DeskMessage {
  const payload = { capabilities: ["implements-issue"], model: MODEL, started_at: iso(at) };
  return {
    topic: `volley/_system/registry/${id}`,
    envelope: env(id, "_system/registry", "registered", payload, at, {
      parent_id: parent,
      namespace: NS,
    }),
    receivedAt: at,
  };
}

function heartbeat(id: string, seq: number, at: number): DeskMessage {
  const payload = { seq, source: "harness-hook", hook_event: "PostToolUse" };
  return {
    topic: `volley/${NS}/${id}/progress`,
    envelope: env(id, "progress", "heartbeat", payload, at),
    receivedAt: at,
  };
}

function screen(id: string, lines: string[], at: number): DeskMessage {
  const payload = { lines, captured_at: iso(at), workspace: id, hash: hash(lines), source: "cmux" };
  return {
    topic: `volley/${NS}/${id}/screen`,
    envelope: env(SUPERVISOR, "screen", "screen_tail", payload, at),
    receivedAt: at,
  };
}

function agentMessages(a: AgentDef, now: number): DeskMessage[] {
  const out = [registry(a.id, a.parent, now - a.bornMin * 60_000)];
  for (const [ago, channel, type, msg, progress] of a.feed) {
    const at = now - ago * 1000;
    const envelope =
      channel === "mailbox"
        ? env(a.parent, "mailbox", type, { text: msg, from_agent_id: a.parent }, at)
        : env(a.id, channel, type, { msg, ...(progress === undefined ? {} : { progress }) }, at, {
            parent_id: a.parent,
          });
    out.push({ topic: `volley/${NS}/${a.id}/${channel}`, envelope, receivedAt: at });
  }
  out.push(heartbeat(a.id, 1, now - a.heartbeatAgoS * 1000));
  out.push(screen(a.id, a.screen, now - a.heartbeatAgoS * 1000));
  return out;
}

// ------------------------------------------------------- machine-global

function globals(now: number): DeskMessage[] {
  const config = {
    version: 1,
    updated_at: iso(now),
    updated_by: "coordinator-desk1",
    hard_ceiling: 12,
    spawn_budget_multiplier: 3,
    lease_pools: { "heavy-it": { capacity: 3, ttl_s: 3600 }, build: { capacity: 2, ttl_s: 1800 } },
    admission: {
      memory_pressure_max_level: 2,
      cmux_ping_max_ms: 2000,
      container_max: 20,
      api_overload_window_s: 300,
      api_overload_max: 3,
      ci_queue_max: 10,
      hysteresis_samples: 3,
    },
    heartbeat_alarm_s: 600,
    fallback_model: MODEL,
    mailbox: { session_expiry_s: 604800 },
    worktree_root: "~/.volley/worktrees",
    spawn_timeout_s: 120,
    spawn_retry_max_s: 900,
    spawn_retry_max: 8,
    wake_grace_s: 60,
    idle_grace_s: 180,
    screen_tail_interval_s: 5,
    hosts: {
      "box-a": {
        target: "owner@box-a",
        tunnel: { remote_port: 21883, supervise: false },
        max_agents: 6,
      },
      "box-b": { target: "owner@box-b", tunnel: { remote_port: 21884, supervise: false } },
    },
    fleet: { local_name: LOCAL_MACHINE },
    // Settings › Repositories (SPEC §4.6.21): the wave repo everywhere, a second on box-a only.
    repos: {
      "example-org/example-repo": { machines: "all" },
      "example-org/docs-site": { machines: ["box-a"] },
    },
    claude: { default_account: "most_headroom", warn_at_pct: 90 },
  };
  const since = iso(now - 20 * 60_000);
  const heavy = {
    pool: "heavy-it",
    capacity: 3,
    per_machine: 2,
    held: [
      ["ci-speed-t6-implementer-1", "box-a"],
      ["status-chip-t1-fixup-1", LOCAL_MACHINE],
      ["ci-speed-fb-implementer-1", null],
    ].map(([holder, host], i) => ({ lease_id: `l-00${i + 1}`, holder, host, since, ttl_s: 3600 })),
    queue: [
      {
        lease_id: "l-004",
        holder: "ci-speed-t3b-implementer-1",
        host: "box-a",
        since: iso(now - 60_000),
      },
    ],
    reasons: ["queued: 3/3 heavy-it leases held"],
  };
  const build = {
    pool: "build",
    capacity: 2,
    held: [{ lease_id: "l-005", holder: "status-chip-t2-implementer-1", since, ttl_s: 1800 }],
    queue: [],
    reasons: [],
  };
  const admission = { open: true, running: 5, hard_ceiling: 12, reasons: [] };
  return [
    {
      topic: "volley/_waves/_config",
      envelope: env(SUPERVISOR, "_waves/_config", "config", config, now),
      receivedAt: now,
    },
    {
      topic: "volley/_system/leases/heavy-it",
      envelope: env(SUPERVISOR, "_system/leases", "lease_pool", heavy, now),
      receivedAt: now,
    },
    {
      topic: "volley/_system/leases/build",
      envelope: env(SUPERVISOR, "_system/leases", "lease_pool", build, now),
      receivedAt: now,
    },
    {
      topic: "volley/_system/admission",
      envelope: env(SUPERVISOR, "_system/admission", "admission", admission, now),
      receivedAt: now,
    },
  ];
}

// ------------------------------------------------------ sized demo (dev)

/** The most agents `?agents=N` asks for. */
export const DEMO_AGENTS_MAX = 40;

/** `?agents=N` → the demo's agent count, clamped to the stock demo's … `DEMO_AGENTS_MAX`. */
export function demoAgentCount(search: string): number {
  const n = Number.parseInt(new URLSearchParams(search).get("agents") ?? "", 10);
  return Number.isFinite(n) ? Math.min(DEMO_AGENTS_MAX, Math.max(AGENTS.length, n)) : AGENTS.length;
}

const LOAD_WAVE = "load-test";
const LOAD_OWNER = "coordinator-load";
const loadAgentId = (k: number) => `${LOAD_WAVE}-l${k}-implementer-1`;
/** The narrating stock agents (`NARRATION_POOL`) the load agents copy, in turn. */
const LOAD_BASES = ["status-chip-t1-fixup-1", "ci-speed-t3b-implementer-1"];

/** The stock agent a load agent copies (its feed, screen and narration), or `undefined`. */
function loadBase(id: string): string | undefined {
  const k = /^load-test-l(\d+)-implementer-1$/.exec(id)?.[1];
  return k === undefined ? undefined : LOAD_BASES[(Number(k) - 1) % LOAD_BASES.length];
}

function loadMessages(extra: number, now: number): DeskMessage[] {
  if (extra <= 0) return [];
  const ks = Array.from({ length: extra }, (_, i) => i + 1);
  const wave: WaveDef = {
    id: LOAD_WAVE,
    owner: LOAD_OWNER,
    coordinator: { state: "working", lastSeenMin: 0 },
    status: "running",
    releaseBranch: `release/2026-10-18-${LOAD_WAVE}`,
    tasks: ks.map((k) => ({
      id: `L${k}`,
      issue: 900 + k,
      title: `Load task ${k}`,
      after: [],
      stage: "implement" as const,
      agents: { implementer: loadAgentId(k) },
    })),
  };
  return [
    waveState(wave, now),
    ...ks.flatMap((k) => {
      const base = AGENTS.find((a) => a.id === loadBase(loadAgentId(k))) as AgentDef;
      return agentMessages({ ...base, id: loadAgentId(k), parent: LOAD_OWNER }, now);
    }),
  ];
}

/** The owner's own Claude login: this machine's and box-a's default login. */
const OWNER_EMAIL = "owner@example.com";
const SIGNED_IN_AT = "2026-10-01T09:00:00.000Z";

/**
 * volleyd's profile registry as the demo's `claude_accounts` answers it: Work and Personal here,
 * the Team account on this machine and on box-a (one account, two machines), and a profile on
 * box-a still waiting for its sign-in.
 */
export const DEMO_CLAUDE_REGISTRY: RegistryAccount[] = [
  {
    id: "work",
    label: "Work",
    machine: "local",
    plan: "max",
    email: "work@example.com",
    signed_in_at: SIGNED_IN_AT,
  },
  {
    id: "team",
    label: "Team account",
    machine: "local",
    plan: "team",
    email: "team@example.com",
    org: "Example Org",
    signed_in_at: SIGNED_IN_AT,
  },
  {
    id: "team",
    label: "Team account (box-a)",
    machine: "box-a",
    plan: "team",
    email: "team@example.com",
    org: "Example Org",
    signed_in_at: SIGNED_IN_AT,
  },
  {
    id: "personal",
    label: "Personal",
    machine: "local",
    plan: "pro",
    email: "personal@example.com",
    signed_in_at: SIGNED_IN_AT,
  },
  {
    id: "pending-work",
    label: "Work (box-a)",
    machine: "box-a",
    signin: { state: "pending", url: "https://claude.com/cai/oauth/authorize?state=demo" },
  },
];

/** The demo's `claude_accounts` answer: the registry, the primary, the machines it reads. */
export function demoClaudeAccounts() {
  return {
    root: "/path/to/home/.volley/claude",
    accounts: DEMO_CLAUDE_REGISTRY,
    primary: { plan: "max", email: OWNER_EMAIL },
    machines: [
      { name: LOCAL_MACHINE, kind: "supervisor", claude: "signed_in", email: OWNER_EMAIL },
      { name: "box-a", kind: "peer", claude: "signed_in", plan: "max", email: OWNER_EMAIL },
      { name: "box-b", kind: "peer", claude: "unknown" },
    ],
    sharing: { mcp: "copy" },
  };
}

/** The demo's `claude_balance` answer: per machine, the account each family's next spawn takes. */
export function demoClaudeBalance() {
  const candidate = (account: string, five: number, weekly: number) => ({
    account,
    headroom: 100 - five,
    five_hour_pct: five,
    weekly_pct: weekly,
    agents: 0,
  });
  return {
    machines: [
      {
        name: "local",
        candidates: [candidate("team", 8, 15), candidate("personal", 12, 22)],
        picks: { fable: "team", opus: "team", sonnet: "personal", haiku: "personal" },
      },
      {
        name: "box-a",
        candidates: [candidate("team@box-a", 8, 15)],
        picks: { fable: "team@box-a", opus: "team@box-a", sonnet: "team@box-a", haiku: null },
      },
    ],
  };
}

/** The Claude accounts' usage records and the agents' context samples (SPEC §4.6.12). */
function claudeUsage(now: number): DeskMessage[] {
  const win = (pct: number, inMin: number) => ({ pct, resets_at: iso(now + inMin * 60_000) });
  const accounts = [
    {
      account: "work",
      label: "Work",
      plan: "max",
      five_hour: win(34, 130),
      weekly: win(41, 4 * 1440),
      agents: ["status-chip-t1-fixup-1", "status-chip-t2-implementer-1"],
      waves: ["status-chip"],
    },
    {
      account: "personal",
      label: "Personal",
      plan: "pro",
      five_hour: win(12, 242),
      weekly: win(22, 5 * 1440),
      agents: ["ci-speed-t3b-implementer-1"],
      waves: ["ci-speed"],
    },
    {
      account: "team",
      label: "Team account",
      plan: "team",
      email: "team@example.com",
      five_hour: win(8, 190),
      weekly: win(15, 3 * 1440),
      agents: [],
      waves: [],
      sampled_at: iso(now - 120_000),
    },
    {
      // The Team account's login on box-a: the fresher reading, and the usage probe's.
      account: "team@box-a",
      label: "Team account (box-a)",
      plan: "team",
      email: "team@example.com",
      five_hour: win(8, 190),
      weekly: win(15, 3 * 1440),
      model_weekly: { fable: win(6, 3 * 1440) },
      probe: {
        machine: "box-a",
        state: "ok",
        attempted_at: iso(now - 30_000),
        read_at: iso(now - 30_000),
      },
      agents: [],
      waves: [],
    },
  ];
  const samples: [string, string, number, number][] = [
    ["status-chip-t1-fixup-1", "work", 143_000, 200_000],
    ["status-chip-t2-implementer-1", "work", 61_000, 200_000],
    ["ci-speed-t3b-implementer-1", "personal", 182_000, 200_000],
  ];
  return [
    ...accounts.map((a) => ({
      topic: `volley/_system/claude-accounts/${a.account}`,
      envelope: env(
        "volleyd",
        "_system/claude-accounts",
        "claude_account",
        { sampled_at: iso(now - 30_000), ...a },
        now,
      ),
      receivedAt: now,
      retained: true,
    })),
    ...samples.map(([id, account, used, size]) => ({
      topic: `volley/${NS}/${id}/usage`,
      envelope: env(
        id,
        "usage",
        "usage",
        {
          account,
          model: MODEL,
          context_window: { used_percentage: Math.round((used / size) * 100), used, size },
          rate_limits: {},
          captured_at: iso(now - 30_000),
        },
        now,
      ),
      receivedAt: now,
      retained: true,
    })),
  ];
}

/** How often the demo republishes the live machines' records (a real peer beats every 30 s). */
export const MACHINES_TICK_MS = 5_000;
/** box-a's overload swell: every `SWELL_EVERY` ticks it climbs over `SWELL_TICKS` and back. */
const SWELL_EVERY = 48;
const SWELL_TICKS = 24;
/** volleyd's `placement.load_per_core_max` default: above it a machine takes no new agents. */
const LOAD_PER_CORE_MAX = 1.5;

/** Deterministic noise in [-1, 1] for `name` at `step` (the demo's tests replay it exactly). */
function noise(name: string, step: number): number {
  return (Number.parseInt(hash([name, String(step)]), 16) / 0xffffffff) * 2 - 1;
}

/** A bounded walk around 0: two neighbouring steps' noise, averaged, so it drifts rather than jumps. */
const walk = (name: string, step: number) =>
  step === 0 ? 0 : (noise(name, step) + noise(name, step - 1)) / 2;

/** box-a's swell at `step`, 0 … 1: a half sine over `SWELL_TICKS` once every `SWELL_EVERY`. */
function swell(step: number): number {
  const phase = step % SWELL_EVERY;
  return step > 0 && phase < SWELL_TICKS ? Math.sin((Math.PI * phase) / SWELL_TICKS) : 0;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** A load triple whose 5- and 15-minute averages trail the 1-minute one. */
const loads = (one: number, base: readonly [number, number, number]) =>
  [round1(one), round1((one + base[1]) / 2), round1((one + 2 * base[2]) / 3)] as const;

interface MachineLoad {
  cores: number;
  load: readonly number[];
}

/** placement's overload line (volleyd `machineIneligible`): judged on the higher of load 1 / 5. */
function overload(r: MachineLoad): { eligible?: false; ineligible_reason?: string } {
  const load = Math.max(r.load[0] ?? 0, r.load[1] ?? 0);
  if (load / r.cores <= LOAD_PER_CORE_MAX) return {};
  return {
    eligible: false,
    ineligible_reason: `overloaded: load ${load.toFixed(1)} on ${r.cores} cores · no new agents`,
  };
}

/** The demo's live machines' next beat: new `last_seen`, load and memory, and their verdicts. */
export function machinesTick(now: number, step: number): DeskMessage[] {
  return machines(now, step);
}

/**
 * The machines (SPEC §4.6.14–15): the supervisor's own record, two paired machines' (one up
 * with a doctor report, one whose heartbeat stopped) and volleyd's readiness verdict on each.
 * `step` 0 is the demo's starting reading; every later step (`machinesTick`) walks the live
 * machines' load and memory around it, and box-a swells into its overload band and back.
 */
function machines(now: number, step = 0): DeskMessage[] {
  const checks = (trust: boolean) => [
    { id: "tool.git", ok: true, severity: "block", detail: "git 2.47.0" },
    { id: "tool.bun", ok: true, severity: "block", detail: "bun 1.3.2" },
    { id: "claude_on_path", ok: true, severity: "warn", detail: "claude resolves on the ssh PATH" },
    { id: "volley.version", ok: true, severity: "block", detail: "volley 0.3.1" },
    { id: "repo.clone", ok: true, severity: "block", detail: "clone at /srv/work/example-repo" },
    {
      id: "gh.auth",
      ok: true,
      severity: "block",
      detail: "gh can push to example-org/example-repo",
    },
    { id: "claude.signin", ok: true, severity: "block", detail: "Claude Code is signed in" },
    trust
      ? { id: "claude.trust", ok: true, severity: "warn", detail: "Claude Code trusts the repo" }
      : { id: "claude.trust", ok: false, severity: "warn", detail: "the repo is not trusted yet" },
  ];
  const up = swell(step);
  const memWalk = (name: string, base: number) =>
    Math.round(Math.min(95, Math.max(5, base + 6 * walk(`${name}:mem`, step))));
  const doctor = (trust: boolean, repo: string, available_pct: number) => ({
    memory: { total_mb: 65_536, available_pct },
    disk: { path: "/srv/work", free_gb: 312, free_pct: 64 },
    versions: { peer: "0.3.1", volley: "0.3.1", bun: "1.3.2", git: "2.47.0", claude: "2.1.0" },
    auth: {
      gh: "ok",
      claude: "signed_in",
      trust: trust ? "ok" : "missing",
      // The owner's own login, on this machine and on box-a alike.
      claude_email: OWNER_EMAIL,
      claude_plan: "max",
    },
    repo: { path: repo, exists: true, origin: "github.com/example-org/example-repo" },
    checks: checks(trust),
    doctor_at: iso(now - 60_000),
  });
  // studio sits under its 20% memory floor at every step, as its stock verdict says.
  const localMemory = memWalk(LOCAL_MACHINE, 13);
  const records = [
    {
      name: LOCAL_MACHINE,
      kind: "supervisor",
      os: "darwin",
      arch: "arm64",
      cores: 12,
      tunnel: "local",
      load: loads(Math.max(0.2, 3.1 + 1.2 * walk(LOCAL_MACHINE, step)), [3.1, 2.8, 2.5]),
      agents: 5,
      last_seen: iso(now - 5_000),
      ...doctor(true, "/path/to/repo", localMemory),
    },
    {
      name: "box-a",
      kind: "peer",
      os: "linux",
      arch: "x64",
      cores: 32,
      tunnel: "up",
      load: loads(Math.max(0.2, 1.6 + 0.6 * walk("box-a", step) + 72 * up), [1.6, 1.2, 0.9]),
      agents: 2,
      remote_port: 21883,
      last_seen: iso(now - 12_000),
      ...doctor(false, "/srv/work/example-repo", memWalk("box-a", 71 - 30 * up)),
    },
    {
      name: "box-b",
      os: "darwin",
      arch: "arm64",
      cores: 10,
      tunnel: "down",
      reason: "heartbeat_timeout",
      load: [0.4, 0.5, 0.6],
      agents: 0,
      remote_port: 21884,
      last_seen: iso(now - 6 * 60_000),
    },
  ];
  const verdict = (name: string, over: Record<string, unknown>) => ({
    name,
    ready: true,
    reasons: [],
    drain: false,
    max_agents: 4,
    placed: 0,
    path_ok: { claude: true, bun: true },
    requirements: { volley: "0.3.1" },
    heavy: {},
    usage: { account: `primary@${name}`, five_hour_pct: 38 },
    eligible: true,
    checked_at: iso(now - 4_000),
    ...over,
  });
  const repos = (over: Record<string, unknown>) => ({
    "example-org/example-repo": { state: "ready", path: "/srv/work/example-repo", reasons: [] },
    ...over,
  });
  const verdicts = [
    verdict(LOCAL_MACHINE, {
      repos: repos({
        "example-org/example-repo": { state: "ready", path: "/path/to/repo", reasons: [] },
      }),
      max_agents: 12,
      placed: 5,
      eligible: false,
      ineligible_reason: `memory available ${localMemory}% (min 20%)`,
      usage: { account: "primary", five_hour_pct: 64 },
    }),
    verdict("box-a", {
      max_agents: 6,
      placed: 2,
      repos: repos({
        "example-org/docs-site": {
          state: "blocked",
          path: "/path/to/home/.volley/repos/example-org/docs-site",
          reasons: ["hugo not installed (needed by example-org/docs-site)"],
        },
      }),
      ...overload(records[1] as MachineLoad),
    }),
    verdict("box-b", {
      repos: repos({
        "example-org/example-repo": {
          state: "blocked",
          reasons: ["box-b is down: retried when it is back"],
        },
      }),
      ready: false,
      eligible: false,
      reasons: ["tunnel down: no heartbeat for 90 s"],
      ineligible_reason: "box-b is down (no heartbeat for 90 s)",
    }),
  ];
  // After the start only the live machines beat (and are judged again): box-b's record and
  // verdict stand.
  const live = step === 0 ? records : records.filter((r) => r.tunnel !== "down");
  const judged = step === 0 ? verdicts : verdicts.filter((v) => v.name !== "box-b");
  return [
    ...live.map((r) => ({
      topic: `volley/_system/machines/${r.name}`,
      envelope: env(r.tunnel === "up" ? r.name : SUPERVISOR, "_system/machines", "machine", r, now),
      receivedAt: now,
      retained: true,
    })),
    ...judged.map((v) => ({
      topic: `volley/_system/machines/${v.name}/readiness`,
      envelope: env(SUPERVISOR, "_system/machines/readiness", "readiness", v, now),
      receivedAt: now,
      retained: true,
    })),
  ];
}

/**
 * The machine roles (SPEC §4.6.24): the broker and the supervisor on this machine, the Desk moved
 * to box-a an hour ago, and that move's retained record (done, kept for a rollback).
 */
function roles(now: number): DeskMessage[] {
  const at = now - 3_600_000;
  const record = {
    broker: {
      machine: LOCAL_MACHINE,
      address: { ssh: null, mqtt_port: 1883, ws_port: 9001 },
      lan: true,
    },
    supervisor: { machine: LOCAL_MACHINE },
    desk: { machine: "box-a", url: "http://box-a.local:5199" },
    version: 2,
    updated_at: iso(at),
    updated_by: "owner",
  };
  const moveId = "mv-desk-demo";
  const step = (id: string, title: string, where: string, line?: string) => ({
    id,
    title,
    where,
    status: "ok",
    ...(line ? { line } : {}),
  });
  const move = {
    move_id: moveId,
    role: "desk",
    from: LOCAL_MACHINE,
    to: "box-a",
    status: "done",
    steps: [
      step("install", "Install the Desk on box-a", "box-a", "desk installed on :5199"),
      step("check", "Check http://127.0.0.1:5199", "box-a", "ok"),
      step("record", "Record the Desk on box-a", LOCAL_MACHINE),
      step("signin", "Make a sign-in link for the new address", LOCAL_MACHINE),
      step("unload", `Unload the old Desk on ${LOCAL_MACHINE}`, LOCAL_MACHINE),
    ],
    since: iso(at),
  };
  return [
    {
      topic: "volley/_system/roles",
      envelope: env(SUPERVISOR, "_system/roles", "roles", record, at),
      receivedAt: now,
      retained: true,
    },
    {
      topic: `volley/_system/roles/moves/${moveId}`,
      envelope: env(SUPERVISOR, "_system/roles/moves", "role_move", move, at),
      receivedAt: now,
      retained: true,
    },
  ];
}

/** Every retained/live message the demo starts from, oldest agent history first per agent. */
export function demoMessages(now: number, agents = AGENTS.length): DeskMessage[] {
  return [
    ...globals(now),
    ...claudeUsage(now),
    ...machines(now),
    ...roles(now),
    ...WAVES.flatMap((w) => [waveState(w, now), ...decision(w, now)]),
    ...demoAutopilot(now),
    ...demoPlanned(now),
    endedWave(now),
    ...demoDigest(now, DEMO_ENDED_WAVE),
    ...demoInbox(now),
    ...AGENTS.flatMap((a) => agentMessages(a, now)),
    ...loadMessages(agents - AGENTS.length, now),
  ];
}

export function demoState(now = Date.now(), agents = AGENTS.length): DeskState {
  return reduceAll(initialState(), demoMessages(now, agents));
}

// -------------------------------------------------------------- simulation

export const NARRATION_POOL: Record<string, string[]> = {
  "status-chip-t1-fixup-1": [
    "Added CLSD → Closed to the alias table",
    "Re-running chip-mapper.test.ts",
    "All 9 mapper tests green",
    "Running light-mode guard",
    "Pushing fixup commit to the task branch",
    "Waiting on CI for head a71c09d",
  ],
  "ci-speed-t3b-implementer-1": [
    "Still queued for a heavy-it lease (position 1 of 2)",
    "Lease granted: running the 4-shard matrix locally",
    "Shard 1/4 green (2m12s)",
    "Shard 2/4 green (2m40s)",
  ],
  // The reviewer `demoReviewer` spawns mid-demo keeps a signal too (else it shows "no signal").
  "status-chip-t1-spec_reviewer-1": [
    "Checking the alias table against the plan",
    "Fixup diff matches section T1",
    "Re-reading the light-mode guard change",
  ],
};

const SCREEN_POOL: Record<string, string[]> = {
  "status-chip-t1-fixup-1": [
    "⏺ Update(src/chip-mapper.ts)",
    "  ⎿  Updated with 1 addition",
    "⏺ Bash(npx vitest run src/chip-mapper.test.ts)",
    "  ⎿  ✓ 9 passed (412 ms)",
    "⏺ Bash(npx vitest run src/light-mode-guard.test.ts)",
    "  ⎿  ✓ 31 passed",
    '⏺ Bash(git commit -m "fix(chip): map legacy CLSD alias" && git push)',
    "  ⎿  a71c09d  task-branch -> task-branch",
  ],
  "ci-speed-t3b-implementer-1": [
    "  ⎿  lease granted: heavy-it (slot 3)",
    "⏺ Bash(bun run test:integration --shard=1/4)",
    "  ⎿  Tests run: 412, Failures: 0  (2m12s)",
    "⏺ Bash(bun run test:integration --shard=2/4)",
    "  ⎿  Tests run: 398, Failures: 0  (2m40s)",
  ],
};

/**
 * One simulation step (the prototype runs it every 2.6 s): each working agent
 * with a narration pool heartbeats, narrates the next pool line (pausing two
 * steps after the pool ends) and appends a terminal line.
 */
export function tick(state: DeskState, step: number, now = Date.now()): DeskState {
  const msgs: DeskMessage[] = [];
  // The pooled stock agents, then any `?agents=N` load agents on their base's pool.
  const ids = [...Object.keys(NARRATION_POOL), ...Object.keys(state.agents).filter(loadBase)];
  for (const id of ids) {
    const base = loadBase(id) ?? id;
    const pool = NARRATION_POOL[base] as string[];
    const a = state.agents[id];
    if (!a || a.status?.type !== "working") continue;
    msgs.push(heartbeat(id, step + 1, now));
    const i = step % (pool.length + 2);
    if (i < pool.length) {
      const progress = Math.min(97, (a.progress ?? 0) + 3 + (step % 3));
      const payload = { progress, msg: pool[i] };
      msgs.push({
        topic: `volley/${NS}/${id}/progress`,
        envelope: env(id, "progress", "narration", payload, now, { parent_id: a.parentId }),
        receivedAt: now,
      });
    }
    const s = SCREEN_POOL[base];
    if (s)
      msgs.push(
        screen(id, [...(a.screen?.lines ?? []), s[step % s.length] as string].slice(-30), now),
      );
  }
  return reduceAll(state, msgs);
}

/** The spec reviewer the prototype pops up mid-demo, as volleyd would spawn one. */
export function demoReviewer(now = Date.now()): DeskMessage[] {
  const w = WAVES[0] as WaveDef;
  const id = "status-chip-t1-spec_reviewer-1";
  const tasks = w.tasks.map((t) =>
    t.id === "T1"
      ? { ...t, stage: "spec_review" as const, agents: { ...t.agents, spec_reviewer: id } }
      : t,
  );
  return [
    waveState(w, now, tasks),
    registry(id, w.owner, now),
    {
      topic: `volley/${NS}/${id}/status`,
      envelope: env(
        id,
        "status",
        "working",
        { msg: "Reading plan section T1 and the fixup diff", progress: 8 },
        now,
        {
          parent_id: w.owner,
        },
      ),
      receivedAt: now,
    },
    screen(
      id,
      ["⏺ Read(ISSUE.md)", "⏺ Bash(git diff origin/release/2026-10-20-status-chip...HEAD --stat)"],
      now,
    ),
  ];
}

/** How long ago the demo's `lead` owner went offline (its away and gone waves). */
const OWNER_AWAY_MS = 2 * 3_600_000;

/**
 * Autopilot's surfaces (SPEC §4.6.16–19), as two more waves a supervisor would publish: one whose
 * coordinator (`relay`) is reconnecting (its session's MCP restarted), and one autopilot runs that
 * is releasing, with a merge queue, a release train, a synthetic fixer task and both journal
 * events. Its owner (`lead`) is offline, and the release's owner-only `publish` item waits on it,
 * so it is `gone` (its other wave, `demoPlanned`'s, waits on nothing: `away`).
 */
export function demoAutopilot(now = Date.now()): DeskMessage[] {
  const base = (wave: string, over: Partial<WaveStatePayload>): WaveStatePayload => ({
    wave,
    version: 1,
    owner: "lead",
    repo: "example-org/example-repo",
    release_branch: `release/2026-10-20-${wave}`,
    status: "running",
    tasks: [],
    open_decisions: [],
    gates: [],
    updated_at: iso(now),
    ...over,
  });
  const state = (p: WaveStatePayload): DeskMessage => ({
    topic: `volley/_waves/${p.wave}/state`,
    envelope: env(SUPERVISOR, "_waves/state", "wave_state", p, now),
    receivedAt: now,
  });
  const task = (id: string, issue: number, stage: Stage) => ({ id, issue, stage, agents: {} });
  const reconnecting = base("relaunch", {
    owner: "relay",
    tasks: [task("T1", 201, "implement")],
    spec: { version: 1, tasks: { T1: { issue: 201, title: "Grace window", after: [] } } },
    coordinator: {
      agent_id: "relay-a7",
      presence: "offline",
      state: "reconnecting",
      last_seen: iso(now - 3 * 60_000),
    },
    autopilot: { enabled: true, auto_resolved: 0, escalated: 0, budgets: {} },
  });
  const train = base("autopilot", {
    status: "releasing",
    tasks: [
      task("T3", 211, "merge_ready"),
      task("T5", 212, "merge_ready"),
      task("T7", 213, "merge_ready"),
      task("T9", 214, "merge_ready"),
      {
        ...task("fix-queue-order-flake", 0, "fixup"),
        synthetic: true,
        remediation: {
          kind: "fix_flake",
          test: "merge queue > orders by dependents",
          since: iso(now - 6 * 60_000),
          test_file: "packages/volleyd/test/merge-queue.test.ts",
          run_urls: ["https://github.com/example/repo/actions/runs/1"],
          for: ["T3", "T7"],
        },
      },
    ],
    gates: ["T3", "T5", "T7", "T9"],
    spec: {
      version: 1,
      tasks: {
        T3: { issue: 211, title: "Queue order", after: [] },
        T5: { issue: 212, title: "Update before merge", after: [] },
        T7: { issue: 213, title: "Refused merges", after: ["T3"] },
        T9: { issue: 214, title: "Train stages", after: ["T5"] },
      },
    },
    coordinator: {
      agent_id: "lead",
      presence: "offline",
      state: "gone",
      last_seen: iso(now - OWNER_AWAY_MS),
    },
    autopilot: {
      enabled: true,
      auto_resolved: 4,
      escalated: 1,
      budgets: { "relaunch_max:T3/implementer": { used: 1, max: 1 } },
    },
    merge_queue: [
      { task: "T3", state: "merging", since: iso(now - 4 * 60_000) },
      { task: "T5", state: "updating", since: iso(now - 3 * 60_000) },
      { task: "T7", state: "queued", since: iso(now - 2 * 60_000) },
      { task: "T9", state: "queued", since: iso(now - 60_000) },
    ],
    release: {
      stage: "publish",
      stages: [
        { name: "tag", state: "verified" },
        { name: "publish", state: "awaiting_go" },
        { name: "announce", state: "pending" },
      ],
    },
  });
  const event = (type: string, seq: number, data: Record<string, unknown>, t?: string) => ({
    topic: "volley/_waves/autopilot/events",
    envelope: env(
      SUPERVISOR,
      "_waves/events",
      type,
      { wave: "autopilot", seq, at: iso(now), ...(t ? { task: t } : {}), data },
      now,
    ),
    receivedAt: now,
  });
  return [
    state(reconnecting),
    state(train),
    event(
      "decision_auto_resolved",
      41,
      {
        decision_id: "autopilot-t3-hooks_auth_failed-1",
        kind: "hooks_auth_failed",
        policy: "hooks_auth_failed/relaunch",
        answer: "relaunch",
        rationale: "a bad launch is cheaper to retry than to read",
        evidence: { screen_hash: "9c41e0aa", attempt: 1 },
        budget: { key: "relaunch_max:T3/implementer", used: 1, max: 1 },
      },
      "T3",
    ),
    event("decision_escalated", 42, {
      decision_id: "autopilot-stage_go-1",
      kind: "stage_go",
      why: "owner_only",
    }),
  ];
}

/** The demo's planned wave (the overlap plan): two clusters, a bundle, a hold, a train, churn. */
export const PLANNED_WAVE = "overlap";

/**
 * A wave the overlap planner planned: cluster A (five tasks on `daemon.ts`, one a bundle closing
 * #310 and #312, capped at 4 in flight with 4 running) and cluster B (held after its churn ran
 * out, its second task chained after its first); three independent PRs merging as `train-1`
 * while two more wait in the queue; and the plan's events in the wave's feed.
 */
export function demoPlanned(now = Date.now()): DeskMessage[] {
  const w = PLANNED_WAVE;
  const daemon = "packages/volleyd/src/daemon.ts";
  const pr = (n: number) => ({
    number: n,
    url: `${DEMO_GITHUB.url}/pull/${n}`,
    head_sha: `${n}c0ffee`,
    ci: "green" as const,
  });
  const task = (id: string, issue: number, stage: Stage, over: Partial<WaveTask> = {}) => ({
    id,
    issue,
    stage,
    agents: {},
    ...over,
  });
  const clusters: PlanCluster[] = [
    {
      id: "A",
      tasks: ["i310", "i315", "i317", "i318", "i320"],
      hot: [
        { file: daemon, bytes: 11_234, shared_by: ["i310", "i315", "i317", "i318", "i320"] },
        { file: "packages/volleyd/src/reducer.ts", bytes: 4_100, shared_by: ["i310", "i317"] },
      ],
      strategy: { collapse: [["i310"]], cap: 4 },
      state: "planned",
      why: `5 tasks share ${daemon}: capped at 4 in flight`,
    },
    {
      id: "B",
      tasks: ["i330", "i331"],
      hot: [
        {
          file: "packages/volley-desk/src/App.tsx",
          bytes: 52_000,
          shared_by: ["i330", "i331"],
        },
      ],
      strategy: { chain: [["i330", "i331"]] },
      state: "hold",
      why: "held: 4 churn spawns rebasing App.tsx",
    },
  ];
  const tasks: WaveTask[] = [
    task("i301", 301, "merge_ready", { pr: pr(341) }),
    task("i302", 302, "merge_ready", { pr: pr(342) }),
    task("i303", 303, "merge_ready", { pr: pr(343) }),
    task("i305", 305, "merge_ready", { pr: pr(345) }),
    task("i306", 306, "merge_ready", { pr: pr(346) }),
    task("i310", 310, "implement", { cluster: "A" }),
    task("i315", 315, "spec_review", { cluster: "A" }),
    task("i317", 317, "implement", { cluster: "A" }),
    task("i318", 318, "fixup", { cluster: "A", churn: 3 }),
    task("i320", 320, "queued", { cluster: "A", why_waiting: "cluster A: 4 in flight (cap 4)" }),
    task("i330", 330, "queued", { cluster: "B", churn: 4, why_waiting: "cluster B is held" }),
    task("i331", 331, "queued", { cluster: "B", why_waiting: "cluster B is held" }),
    task("train-1", 0, "implement", {
      synthetic: true,
      pr: pr(340),
      train: {
        members: [
          { task: "i301", pr: 341, head: "341c0ffee" },
          { task: "i302", pr: 342, head: "342c0ffee" },
          { task: "i303", pr: 343, head: "343c0ffee" },
        ],
      },
    }),
  ];
  const independent = { by: "independent" as const };
  const inA = (by: "collapse" | "cap") => ({ cluster: "A", by });
  const payload: WaveStatePayload = {
    wave: w,
    version: 1,
    owner: "lead",
    repo: "example-org/example-repo",
    release_branch: `release/2026-10-23-${w}`,
    github: DEMO_GITHUB,
    status: "running",
    tasks,
    open_decisions: [],
    gates: ["i301", "i302", "i303", "i305", "i306"],
    spec: {
      version: 1,
      release_branch: `release/2026-10-23-${w}`,
      model: MODEL,
      pipeline: PIPELINE,
      tasks: {
        i301: { issue: 301, title: "Train member: lease ttl", after: [], plan: independent },
        i302: { issue: 302, title: "Train member: drain chip", after: [], plan: independent },
        i303: { issue: 303, title: "Train member: peer doctor", after: [], plan: independent },
        i305: { issue: 305, title: "Digest wording", after: [], plan: independent },
        i306: { issue: 306, title: "Inbox filter", after: [], plan: independent },
        i310: {
          issue: 310,
          title: "Daemon admission + spawn budget",
          after: [],
          issues: [310, 312],
          files: [daemon, "packages/volleyd/src/reducer.ts"],
          footprint: { confidence: "listed" },
          plan: { ...inA("collapse"), why: "#310 and #312 rewrite the same admission code" },
        },
        i315: { issue: 315, title: "Daemon reconnect", after: [], plan: inA("cap") },
        i317: { issue: 317, title: "Daemon journal fsync", after: [], plan: inA("cap") },
        i318: { issue: 318, title: "Daemon control ops", after: [], plan: inA("cap") },
        i320: { issue: 320, title: "Daemon shutdown", after: [], plan: inA("cap") },
        i330: {
          issue: 330,
          title: "Desk window arrange",
          after: [],
          plan: { cluster: "B", by: "independent" },
        },
        i331: {
          issue: 331,
          title: "Desk window pins",
          after: ["i330"],
          plan: { cluster: "B", by: "chain", why: "both rewrite App.tsx's window table" },
        },
      },
    },
    // Its owner went offline two hours ago; nothing here waits on it, so autopilot runs it.
    coordinator: {
      agent_id: "lead",
      presence: "offline",
      state: "away",
      last_seen: iso(now - OWNER_AWAY_MS),
    },
    autopilot: { enabled: true, auto_resolved: 2, escalated: 0, budgets: {} },
    merge_queue: [
      { task: "i305", state: "queued", since: iso(now - 2 * 60_000) },
      { task: "i306", state: "queued", since: iso(now - 60_000) },
    ],
    overlap_plan: { clusters },
    spawns: { productive: 14, churn: 7 },
    trains: [
      {
        id: "train-1",
        pr: 340,
        tasks: ["i301", "i302", "i303"],
        state: "integrating",
        since: iso(now - 90_000),
      },
    ],
    updated_at: iso(now),
  };
  const event = (type: string, seq: number, data: Record<string, unknown>) => ({
    topic: `volley/_waves/${w}/events`,
    envelope: env(SUPERVISOR, "_waves/events", type, { wave: w, seq, at: iso(now), data }, now),
    receivedAt: now,
  });
  return [
    {
      topic: `volley/_waves/${w}/state`,
      envelope: env(SUPERVISOR, "_waves/state", "wave_state", payload, now),
      receivedAt: now,
    },
    event("wave_planned", 3, {
      clusters: clusters.map((c) => (c.id === "B" ? { ...c, state: "planned" } : c)),
    }),
    event("cluster_strategy_changed", 61, {
      cluster: "B",
      from: "chain",
      to: "hold",
      why: "4 churn spawns rebasing App.tsx",
    }),
    event("train_started", 72, {
      train: "train-1",
      tasks: ["i301", "i302", "i303"],
      heads: { i301: "341c0ffee", i302: "342c0ffee", i303: "343c0ffee" },
      release_sha: "5be0c2a1f9d4",
    }),
  ];
}

/**
 * The needs-you inbox (SPEC §4.6.18): one item of each kind as volleyd publishes them on
 * `volley/_inbox/<id>`. The release item is owner-only, for the `autopilot` wave's `publish` stage
 * (`demoAutopilot`), and points at its stage evidence on disk.
 */
export const INBOX_RELEASE_EVIDENCE = {
  wave: "autopilot",
  stage: "tag",
  artifacts: {
    tag: "v0.5.0",
    changelog_entries: [
      "**Needs you** window: one row per open item, with `Only you` filter.",
      "- Phone layout with 48 px targets\n- Owner-only items push to the phone",
    ],
    screenshots: ["smoke-desk.png", "smoke-phone.webp"],
    release_pr: "https://github.com/example-org/example-repo/pull/300",
    ci_runs: ["https://github.com/example-org/example-repo/actions/runs/77"],
    smoke_log: "smoke.log",
    guide_url: "https://guide.example.com/releasing",
  },
};

export function demoInbox(now = Date.now()): DeskMessage[] {
  const item = (p: InboxItem): DeskMessage => ({
    topic: `volley/_inbox/${p.id}`,
    envelope: env(SUPERVISOR, "_inbox", p.answered ? "inbox_answered" : "inbox_item", p, now),
    receivedAt: now,
    retained: true,
  });
  return [
    item({
      id: "d-autopilot-d-rv7",
      kind: "decision",
      version: 2,
      owner_only: false,
      wave: "autopilot",
      task: "T7",
      agent_id: "autopilot-t7-implementer-1",
      title: "Reviewers disagree · autopilot/T7",
      question: "The spec reviewer calls the missing retry a P1; the quality reviewer says fine.",
      options: [{ label: "blocker" }, { label: "fine" }],
      allow_other: true,
      pointers: { pr: "https://github.com/example-org/example-repo/pull/213" },
      opened_at: iso(now - 4 * 60_000),
      source: { decision_id: "d-rv7", decision_kind: "reviewers_disagree" },
    }),
    item({
      id: "p-coord-a1b2c3-toolu_01AbCdEf",
      kind: "picker",
      version: 1,
      owner_only: false,
      agent_id: "coord-a1b2c3",
      title: "Pick a storage backend",
      question: "Which backend should the cache use?",
      options: [
        { label: "SQLite", description: "One file, no server" },
        { label: "Redis", description: "Shared across machines" },
      ],
      allow_other: true,
      multi: false,
      pointers: {},
      opened_at: iso(now - 3 * 60_000),
      source: { tool_use_id: "toolu_01AbCdEf", machine: "laptop" },
    }),
    item({
      id: "h-sess-9f2-12",
      kind: "handoff",
      version: 1,
      owner_only: false,
      agent_id: "sess-9f2",
      title: "Session sess-9f2 is waiting",
      question: "Should I also migrate the old rows?",
      allow_other: true,
      pointers: {},
      opened_at: iso(now - 2 * 60_000),
      source: { seq: 12 },
    }),
    item({
      id: "r-autopilot-publish",
      kind: "release",
      version: 1,
      owner_only: true,
      wave: "autopilot",
      agent_id: SUPERVISOR,
      title: "Run stage publish · autopilot",
      question: "Stage tag is verified. Run publish?",
      options: [{ label: "go" }, { label: "skip" }, { label: "hold" }],
      pointers: {},
      opened_at: iso(now - 60_000),
      source: {
        wave: "autopilot",
        stage: "publish",
        evidence: {
          md: "~/.volleyd/waves/autopilot/release/tag.md",
          json: "~/.volleyd/waves/autopilot/release/tag.json",
        },
      },
    }),
  ];
}

// ------------------------------------------------------------------ digest

/** The demo's finished wave: it folds under Show finished, its digest card on top. */
export const DEMO_ENDED_WAVE = "onboarding";
/** The running wave whose morning digest the demo publishes after `DIGEST_AFTER_MS`. */
export const DIGEST_WAVE = "ci-speed";

const ENDED_TASKS = [
  { id: "T0", issue: 91, title: "Welcome screen copy", pr: 181 },
  { id: "T1", issue: 92, title: "First-run checklist", pr: 182 },
  { id: "T2", issue: 93, title: "Invite a teammate", pr: 184 },
];

/** `onboarding`, complete: every task merged, its coordinator signed off. */
function endedWave(now: number): DeskMessage {
  const payload: WaveStatePayload = {
    wave: DEMO_ENDED_WAVE,
    version: 1,
    owner: "coordinator-desk4",
    repo: "/srv/work/example-repo",
    release_branch: "release/2026-10-19-onboarding",
    github: DEMO_GITHUB,
    status: "complete",
    tasks: ENDED_TASKS.map((t) => ({ id: t.id, issue: t.issue, stage: "done", agents: {} })),
    open_decisions: [],
    gates: [],
    spec: {
      version: 1,
      release_branch: "release/2026-10-19-onboarding",
      model: MODEL,
      pipeline: PIPELINE,
      tasks: Object.fromEntries(
        ENDED_TASKS.map((t) => [t.id, { issue: t.issue, title: t.title, after: [] }]),
      ),
    },
    updated_at: iso(now - 9 * 60 * 60_000),
  };
  return {
    topic: `volley/_waves/${DEMO_ENDED_WAVE}/state`,
    envelope: env(SUPERVISOR, "_waves/state", "wave_state", payload, now),
    receivedAt: now,
    retained: true,
  };
}

const pr = (number: number) => ({ number, url: `${DEMO_GITHUB.url}/pull/${number}` });

/**
 * volleyd's morning digest (SPEC §4.6.16) on `volley/_waves/<wave>/digest`: for
 * `DEMO_ENDED_WAVE` the wave-complete one (three PRs merged, a flake fixed on the way), for
 * `DIGEST_WAVE` the escalation it sends at morning: FA shipped overnight, FB's merge conflict
 * waits for the owner.
 */
export function demoDigest(now: number, wave: string): DeskMessage[] {
  const payload: DigestPayload =
    wave === DEMO_ENDED_WAVE
      ? {
          wave,
          release_branch: "release/2026-10-19-onboarding",
          generated_at: iso(now - 9 * 60 * 60_000),
          trigger: "wave_complete",
          shipped: ENDED_TASKS.map((t, i) => ({
            task: t.id,
            issue: t.issue,
            title: t.title,
            pr: pr(t.pr),
            merge_sha: hash([t.id]).repeat(5),
            merged_by: i === 2 ? ("operator" as const) : ("supervisor" as const),
          })),
          closes: ENDED_TASKS.map((t) => t.issue),
          auto: {
            decisions_resolved: 3,
            flakes_fixed: [
              { test: "checklist > persists ticks", fixer: "fix-checklist-flake", prs_released: 1 },
            ],
            conflicts_resolved: 1,
            retries: 2,
            merges: 2,
          },
          waiting: [],
          failures: [],
        }
      : {
          wave,
          release_branch: "release/2026-10-17-ci-speed",
          generated_at: iso(now),
          trigger: "escalation",
          shipped: [
            {
              task: "FA",
              issue: 113,
              title: "Flaky test root cause",
              pr: pr(190),
              merge_sha: hash(["FA"]).repeat(5),
              merged_by: "supervisor",
            },
          ],
          closes: [113],
          auto: {
            decisions_resolved: 2,
            flakes_fixed: [],
            conflicts_resolved: 0,
            retries: 1,
            merges: 1,
          },
          waiting: WAVES.flatMap((w) => {
            const d = w.decision;
            if (w.id !== wave || !d) return [];
            return [
              {
                id: decisionId(w),
                kind: d.kind,
                task: d.task,
                question: d.question,
                since: iso(now - 50 * 60_000),
                owner_only: false,
              },
            ];
          }),
          failures: [],
        };
  return [
    {
      topic: `volley/_waves/${wave}/digest`,
      envelope: env(SUPERVISOR, "_waves/digest", "digest", payload, now),
      receivedAt: now,
      retained: true,
    },
  ];
}
