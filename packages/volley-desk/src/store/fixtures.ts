/**
 * Demo mode: the prototype's sample state and its `tick` simulation, expressed
 * as the Volley topics a supervisor and its agents would publish
 * (`volley/_waves/<wave>/state`, `volley/<ns>/<agent>/{status,progress,screen}`,
 * …) and folded through the real reducer, so demo mode exercises the same code
 * path as a live broker. Enabled by `?demo=1` or `VITE_VOLLEY_DEMO=1`;
 * `&agents=N` (dev only) adds working agents on a `load-test` wave, for the
 * 20-agent fps check.
 */
import { initialState, reduceAll } from "./reducer";
import type {
  DeskMessage,
  DeskState,
  Envelope,
  Role,
  Stage,
  WaveCoordinator,
  WaveStatePayload,
} from "./types";

export function isDemoMode(search: string, env: Record<string, unknown>): boolean {
  return new URLSearchParams(search).get("demo") === "1" || env.VITE_VOLLEY_DEMO === "1";
}

const NS = "demo";
const SUPERVISOR = "volleyd";
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
  coordinator: Omit<WaveCoordinator, "agent_id" | "last_seen"> & { lastSeenMin: number };
  status: WaveStatePayload["status"];
  releaseBranch: string;
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

const decisionId = (w: WaveDef) =>
  `${w.id}-${w.decision?.task.toLowerCase()}-${w.decision?.kind}-1`;

function waveState(w: WaveDef, now: number, tasks: TaskDef[] = w.tasks): DeskMessage {
  const { lastSeenMin, ...coordinator } = w.coordinator;
  const payload: WaveStatePayload = {
    wave: w.id,
    version: 1,
    owner: w.owner,
    repo: "example-org/example-repo",
    release_branch: w.releaseBranch,
    status: w.status,
    tasks: tasks.map((t) => ({
      id: t.id,
      issue: t.issue,
      stage: t.stage,
      agents: t.agents ?? {},
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
    coordinator: { agent_id: w.owner, ...coordinator, last_seen: iso(now - lastSeenMin * 60_000) },
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
    claim_after_s: 1800,
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
    hosts: {},
    claude: { default_account: "most_headroom", warn_at_pct: 90 },
  };
  const since = iso(now - 20 * 60_000);
  const heavy = {
    pool: "heavy-it",
    capacity: 3,
    held: ["ci-speed-t6-implementer-1", "status-chip-t1-fixup-1", "ci-speed-fb-implementer-1"].map(
      (holder, i) => ({ lease_id: `l-00${i + 1}`, holder, since, ttl_s: 3600 }),
    ),
    queue: [{ lease_id: "l-004", holder: "ci-speed-t3b-implementer-1", since: iso(now - 60_000) }],
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

/** Every retained/live message the demo starts from, oldest agent history first per agent. */
/** Two Claude accounts' usage records and the agents' context samples (SPEC §4.6.12). */
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
        { ...a, sampled_at: iso(now - 30_000) },
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

export function demoMessages(now: number, agents = AGENTS.length): DeskMessage[] {
  return [
    ...globals(now),
    ...claudeUsage(now),
    ...WAVES.flatMap((w) => [waveState(w, now), ...decision(w, now)]),
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
