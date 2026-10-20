/**
 * Types for the Desk store. Payload types mirror the T1 JSON schemas in
 * `spec/schemas/` (SPEC §3, §4.3, §4.6); they are read-side views, so every
 * open-ended schema keeps an index signature for forward-compatible extras
 * (SPEC §3.3).
 */

/** SPEC §3 envelope. */
export interface Envelope {
  schema_version: string;
  agent_id: string;
  channel: string;
  type: string;
  wall_time?: string;
  parent_id?: string | null;
  namespace?: string;
  payload?: unknown;
  correlation_id?: string | null;
  [key: string]: unknown;
}

/**
 * One MQTT delivery. `envelope: null` is a cleared retained topic (zero-length
 * payload, SPEC §4.6); `receivedAt` is the local receipt time in ms.
 * `retained` is set for the broker's replay of a retained topic (on subscribe
 * or reconnect), as opposed to a live publish.
 */
export interface DeskMessage {
  topic: string;
  envelope: Envelope | null;
  receivedAt: number;
  retained?: boolean;
}

// ------------------------------------------------------------- agent topics

/** registry.schema.json payload (+ §4.3 coordinator extras). */
export interface RegistryPayload {
  capabilities: string[];
  started_at: string;
  cwd?: string;
  model?: string;
  model_source?: "self-reported" | "harness-hook" | "unknown";
  /** What the agent says it is working on (SPEC §6.2); unchecked, so read it with `typeof`. */
  title?: unknown;
  /** `{ repo?, issue?, pr? }` for that purpose (SPEC §6.2); unchecked. */
  links?: unknown;
  /** A session's terminal workspace title, from its hooks (SPEC §4.3); unchecked. */
  workspace_title?: unknown;
  session_url?: string;
  workspace?: string;
  [key: string]: unknown;
}

/** screen.schema.json payload. */
export interface ScreenPayload {
  lines: string[];
  captured_at: string;
  workspace: string;
  hash: string;
  source: string;
}

// -------------------------------------------------------------- wave state

/** wave-state.schema.json `$defs/stage`. */
export type Stage =
  | "queued"
  | "implement"
  | "spec_review"
  | "quality_review"
  | "fixup"
  | "merge_ready"
  | "done"
  | "blocked"
  | "awaiting_decision"
  | "cancelled";

/** Pipeline roles as they appear in `tasks[].agents` (a test keeps them in step with the schema). */
export type Role = "implementer" | "spec_reviewer" | "quality_reviewer" | "fixup" | "rebase";

export const ROLES: readonly Role[] = [
  "implementer",
  "spec_reviewer",
  "quality_reviewer",
  "fixup",
  "rebase",
];

export interface WaveTask {
  id: string;
  issue: number;
  stage: Stage;
  agents: Partial<Record<Role, string>>;
  waiting_on?: string[];
  why_waiting?: string;
  pr?: {
    number: number;
    url: string;
    head_sha?: string;
    ci?: "green" | "red" | "running" | "none";
  };
  evidence_path?: string;
  /** The remote host the task's agents run on; absent for the supervisor's own machine. */
  host?: string;
  /** Where the task was placed and why (SPEC §4.6.15); absent until it is placed. */
  placement?: TaskPlacement;
  /** The release-branch commit the task's current worktree was cut from. */
  base_sha?: string;
  [key: string]: unknown;
}

/** One machine placement considered, best first: volleyd writes `line`, the Desk only shows it. */
export interface PlacementCandidate {
  host: string;
  /** 0..1; `null` when the machine was not eligible. */
  score: number | null;
  line: string;
}

/** `tasks[].placement` (SPEC §4.6.1): the machine a task was placed on, by whom and why. */
export interface TaskPlacement {
  /** A machine name: the supervisor's own machine under its `fleet.local_name`. */
  host: string;
  by: "auto" | "wave_file" | "decision";
  score: number | null;
  decided_at: string;
  candidates: PlacementCandidate[];
}

export type PipelineStep = string | string[];

export interface WaveSpec {
  version: number;
  release_branch?: string;
  model?: string;
  pipeline?: PipelineStep[];
  tasks: Record<string, { issue: number; title?: string; after: string[] }>;
}

export type CoordinatorState = "working" | "awaiting_input" | "gone";

export interface WaveCoordinator {
  agent_id: string;
  state: CoordinatorState;
  question?: string;
  session_url?: string;
  workspace?: string;
  last_seen: string;
}

/** wave-state `github` (SPEC §4.6.1): the repository on GitHub, as the supervisor read it. */
export interface GitHubRepo {
  /** `owner/repo`. */
  slug: string;
  /** The repository's canonical URL. */
  url: string;
}

export interface WaveStatePayload {
  wave: string;
  version: number;
  owner: string | null;
  repo: string;
  release_branch: string;
  status: "running" | "paused" | "awaiting_decision" | "complete" | "stopped";
  tasks: WaveTask[];
  open_decisions: string[];
  gates: string[];
  spec?: WaveSpec;
  coordinator?: WaveCoordinator;
  effective_config?: Tunables;
  /** Absent from an older supervisor or when the read failed: nothing then links. */
  github?: GitHubRepo;
  updated_at: string;
  [key: string]: unknown;
}

/** `decision.schema.json`'s `payload.kind` enum (a test keeps the two in step). */
export const DECISION_KINDS = [
  "reviewers_disagree",
  "merge_conflict",
  "agent_blocked",
  "agent_question",
  "agent_stalled",
  "unknown_screen",
  "hooks_auth_failed",
  "mcp_not_registered",
  "spawn_failed",
  "model_switch",
  "repo_untrusted",
  "remote_repo_missing",
  "ci_failed",
  "wave_complete",
  "plan_change",
  "pr_closed",
  "pr_head_moved",
  "spawn_budget_exhausted",
  "account_limit",
  "machine_down",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** decision.schema.json payload. */
export interface DecisionPayload {
  decision_id: string;
  wave: string;
  task: string | null;
  /** A schema kind, or a newer one this Desk does not know: shown by its question either way. */
  kind: DecisionKind | (string & {});
  question: string;
  options?: string[];
  pointers?: { diff?: string; transcript?: string; screen?: string; pr?: string };
  opened_at: string;
  resolved?: { answer: string; by: string; at: string };
  /** `account_limit` extras (SPEC §4.6.12): the account, its 5-hour pct and reset, the suggestion. */
  acct?: string;
  pct?: number;
  resets_at?: string | null;
  suggested?: string | null;
  /** `machine_down` extras (SPEC §4.6.2): the host, since when, its unfinished tasks, its state. */
  host?: string;
  down_since?: string;
  tasks?: string[];
  machine?: "down" | "draining" | "removing" | "removed";
}

// ------------------------------------------------------- config and leases

/** config.schema.json `$defs/tunables` (all optional: per-wave overrides share it). */
export interface Tunables {
  hard_ceiling?: number;
  spawn_budget_multiplier?: number;
  lease_pools?: Record<
    string,
    { capacity: number; per_machine?: number; ttl_s?: number; match?: string[] }
  >;
  admission?: {
    memory_pressure_max_level?: number;
    cmux_ping_max_ms?: number;
    container_max?: number;
    api_overload_window_s?: number;
    api_overload_max?: number;
    ci_queue_max?: number;
    hysteresis_samples?: number;
  };
  claim_after_s?: number;
  heartbeat_alarm_s?: number;
  fallback_model?: string | null;
  mailbox?: { session_expiry_s?: number };
  worktree_root?: string;
  spawn_timeout_s?: number;
  wake_grace_s?: number;
  screen_tail_interval_s?: number;
  /** Claude account profiles (SPEC §4.6.11); absent from a supervisor that predates them. */
  claude?: { default_account?: string | null; warn_at_pct?: number };
  /** Remote hosts (SPEC §4.6.4); the Desk reads their names and caps. */
  hosts?: Record<string, { max_agents?: number; drain?: boolean; [key: string]: unknown }>;
  /** The Fleet's names (SPEC §4.6.15): `local_name` is the supervisor's own machine. */
  fleet?: { local_name?: string | null };
  [key: string]: unknown;
}

/** Retained `volley/_waves/_config` payload. */
export interface ConfigPayload extends Tunables {
  version: number;
  updated_at: string;
  updated_by: string;
}

/** lease-pool.schema.json payload. */
export interface LeasePoolPayload {
  pool: string;
  capacity: number;
  /** The cap per machine (SPEC §4.6.5); absent means `capacity`. */
  per_machine?: number;
  /** `host`: the holder's machine; `null` for a holder volleyd did not spawn, absent from an older one. */
  held: { lease_id: string; holder: string; host?: string | null; since: string; ttl_s: number }[];
  queue: { lease_id: string; holder: string; host?: string | null; since: string }[];
  reasons: string[];
}

// ----------------------------------------------------- Claude accounts

/** usage.schema.json `$defs/window`: one of an account's rate-limit windows. */
export interface UsageWindow {
  pct: number;
  resets_at: string | null;
}

/** usage.schema.json payload: an agent's retained `usage` sample (SPEC §4.6.12). */
export interface UsagePayload {
  account: string | null;
  config_dir?: string;
  model: string | null;
  context_window: { used_percentage: number | null; used: number | null; size: number | null };
  rate_limits: { five_hour?: UsageWindow; weekly?: UsageWindow };
  captured_at: string;
}

/** claude-account.schema.json payload: `volley/_system/claude-accounts/<acct>`. */
export interface ClaudeAccountPayload {
  account: string;
  label?: string;
  plan?: string;
  five_hour: UsageWindow | null;
  weekly: UsageWindow | null;
  agents: string[];
  waves: string[];
  sampled_at: string;
  sampled_by?: string;
}

/**
 * A Claude account sign-in, folded from `volley/_system/claude/<acct>/signin`
 * (`claude_signin_url` → waiting, then `claude_signin_done` / `_failed`). Only
 * the provider's sign-in link ever travels there, never a credential.
 */
export interface ClaudeSignin {
  acct: string;
  state: "waiting" | "done" | "failed";
  url?: string;
  /** `browser`, or `manual_code` (the page shows a code for the sign-in terminal). */
  flow?: string;
  /** The tmux session to attach to for a `manual_code` sign-in. */
  attach?: string;
  /** A paired machine's printed (manual-code) URL next to the forwarded one: for a phone. */
  manual_url?: string;
  plan?: string;
  reason?: string;
  /** Local receipt time (ms). */
  at: number;
}

/** One doctor check on a machine record (SPEC §4.6.15): states only, never a fix's text. */
export interface MachineCheck {
  id: string;
  ok: boolean;
  /** `block`: failing makes the machine not ready; `warn`: shown only. */
  severity: "block" | "warn";
  detail: string;
}

/**
 * machine.schema.json payload: a machine's retained health record on
 * `volley/_system/machines/<name>` (SPEC §4.6.14), published by the machine
 * every heartbeat and by volleyd when the heartbeat stops. volleyd publishes
 * its own machine's (`kind: "supervisor"`, `tunnel: "local"`). The Fleet
 * fields (§4.6.15) come with a doctor report.
 */
export interface MachinePayload {
  name: string;
  kind?: "peer" | "supervisor";
  os: string;
  arch?: string;
  cores: number;
  tunnel: "up" | "down" | "local";
  /** Why the tunnel is down; absent while it is up. */
  reason?: "disconnect" | "heartbeat_timeout";
  /** The 1, 5 and 15 minute load averages. */
  load: number[];
  agents: number;
  remote_port?: number;
  last_seen: string;
  memory?: { total_mb: number; available_pct: number };
  disk?: { path: string; free_gb: number; free_pct: number };
  uptime_s?: number;
  versions?: Record<string, string | null>;
  auth?: {
    gh: "ok" | "unauthenticated" | "missing" | "no_write";
    claude: "signed_in" | "not_signed_in" | "missing" | "unknown";
    trust: "ok" | "missing" | "unknown";
    claude_plan?: string;
  };
  repo?: {
    path: string;
    exists: boolean;
    origin?: string;
    release_branch?: string;
    fetched_at?: string | null;
  };
  checks?: MachineCheck[];
  doctor_at?: string;
}

/**
 * readiness.schema.json payload: volleyd's verdict on a machine, on
 * `volley/_system/machines/<name>/readiness` (SPEC §4.6.15).
 */
export interface ReadinessPayload {
  name: string;
  ready: boolean;
  /** One line per blocker; empty when ready. */
  reasons: string[];
  drain: boolean;
  max_agents: number;
  placed: number;
  path_ok: { claude: boolean | null; bun: boolean | null };
  requirements: { volley: string; bun?: string; sharing?: Record<string, string> };
  heavy: Record<string, { held: number; per_machine: number }>;
  usage: { account: string | null; five_hour_pct: number | null };
  eligible: boolean;
  ineligible_reason?: string;
  checked_at: string;
}

// ------------------------------------------------------------------- store

export interface FeedEntry {
  topic: string;
  envelope: Envelope;
  receivedAt: number;
}

/** A non-terminal attention state reported on `progress` (SPEC §4.3). */
export interface AgentAttention {
  state: "awaiting_input";
  text?: string;
  question?: string;
  sessionUrl?: string;
  workspace?: string;
  at: number;
  /**
   * The hooks saw a live background wait (`background_wait: true`): the agent
   * ended its turn waiting on events, not on a person.
   */
  backgroundWait?: boolean;
  /** The Notification hook's `notification_type` (`idle_prompt`, `permission_prompt`, …). */
  notificationType?: string;
}

/** What the hooks' `activity` / `idle` / `resumed` ticks say a session is doing (SPEC §4.3). */
export interface WorkLog {
  /** Tool calls so far (`payload.tool_calls`). */
  toolCalls: number;
  /** ms of the last tool call, when one has been reported. */
  lastToolAt: number | null;
  /** The last activity line (`Bash: …`, `prompt received`). */
  last: string | null;
  /** Working since the last activity / resumed; idle since the turn ended. */
  state: "working" | "idle";
  /** ms the state began. */
  since: number;
}

export interface AgentView {
  id: string;
  namespace: string | null;
  parentId: string | null;
  /** Wave id, or `UNASSIGNED` when no wave state references the agent. */
  wave: string;
  task: string | null;
  role: Role | null;
  registered: boolean;
  registry: RegistryPayload | null;
  model: string | null;
  /**
   * `at` is the envelope's `wall_time` (the sender's clock); `seenAt` is when
   * it reached this Desk (`wall_time` for a retained replay), skew-free.
   */
  status: { type: string; payload: unknown; at: number; seenAt?: number } | null;
  progress: number | null;
  narration: string | null;
  /** ms of the last `progress/heartbeat`. */
  heartbeat: number | null;
  /** How many heartbeats arrived: they update liveness only and are kept out of `feed`. */
  heartbeats?: number;
  /** When the narration was current (ms). */
  narrationAt?: number;
  /** The narration was restored from this browser's session, not heard since the page loaded. */
  narrationRestored?: boolean;
  /** The last `progress` envelope's type and time (ms), any type: a sign the agent is on this broker. */
  lastProgress?: { type: string; at: number };
  /** ms of the last message on any of the agent's topics. */
  lastSeen: number;
  /** ms of the last `progress` the agent itself sent (not its hooks): "no progress reported" is timed from it. */
  reportedAt?: number;
  /**
   * Local receipt time (ms) of the first message this page heard about the agent, retained or
   * live: "no progress reported" never counts time before the Desk could see the agent.
   */
  observedAt?: number;
  /** The first progress message the agent itself sent (kept: the feed is bounded). */
  firstSaid?: string;
  /** The hooks' work log (SPEC §4.3 `activity` / `idle`), once one arrived. */
  work?: WorkLog;
  /** Set when an `awaiting_input` is outstanding; cleared by `resumed` (SPEC §4.3). */
  attention: AgentAttention | null;
  /** True once the agent has published `resumed` (or `awaiting_input`) — i.e. its hooks report attention. */
  attentionObserved: boolean;
  feed: FeedEntry[];
  screen: ScreenPayload | null;
  /**
   * When the agent was born, for the window's `born` entrance: local receipt
   * time of a live registry entry, or the registry's `started_at` (else its
   * `wall_time`) for a retained replay, so agents that already existed at page
   * load or reconnect are not "just spawned".
   */
  bornAt: number | null;
}

export interface WaveView {
  id: string;
  /** `null` until the retained state arrives (a decision can land first). */
  state: WaveStatePayload | null;
  decisions: Record<string, DecisionPayload>;
  receivedAt: number;
}

export interface CoordinatorView {
  id: string;
  waves: string[];
  state: CoordinatorState;
  /** `working` but idle with a background wait armed: waiting on wave events, not on the owner. */
  waitingOnEvents?: boolean;
  question?: string;
  text?: string;
  sessionUrl?: string;
  workspace?: string;
}

/**
 * A supervisor (`volleyd`): a registered Volley agent that is shown as health
 * (the top-bar pill, the coordinators window's first row), never as an agent
 * window.
 */
export interface SupervisorView {
  id: string;
  namespace: string | null;
  registry: RegistryPayload | null;
  /** The latest status type (`working`, `reaped`, …); null while none is retained. */
  status: string | null;
  /** ms of its last sign of life: registry, status or progress. */
  lastHeartbeat: number | null;
  version?: string;
  /** How many waves it reports supervising (its `working` status's `waves`). */
  wavesOwned: number | null;
}

export interface DeskState {
  waves: Record<string, WaveView>;
  agents: Record<string, AgentView>;
  coordinators: Record<string, CoordinatorView>;
  /** Supervisors by agent id; they are never in `agents`. */
  supervisors: Record<string, SupervisorView>;
  config: ConfigPayload | null;
  leases: Record<string, LeasePoolPayload>;
  /** `volley/_system/admission` summary; its schema lands with the daemon's admission controller. */
  admission: Record<string, unknown> | null;
  /**
   * Agents that were registered before the last reconnect `resync` and whose
   * retained registry entry has not come back yet; `pruneUnconfirmed` drops
   * them once the replay has settled.
   */
  unconfirmed?: string[];
  /**
   * The Desk's own agent id (its broker identity) once it signs in. Its
   * mailbox carries the acks and replies to what it sends, never an agent.
   */
  self?: string;
  /** Delivery receipts for mailbox messages (D4 steering); live-only. */
  steering?: SteeringReceipts;
  /** Retained per-account usage records, by account id. */
  claudeAccounts?: Record<string, ClaudeAccountPayload>;
  /** Retained `usage` samples, by agent id (kept apart: they can arrive before the registry). */
  usage?: Record<string, UsagePayload>;
  /** Claude account sign-ins heard since the page loaded, by account id; live-only. */
  signins?: Record<string, ClaudeSignin>;
  /** Paired machines' retained health records, by machine name. */
  machines?: Record<string, MachinePayload>;
  /** volleyd's readiness verdicts, by machine name. */
  readiness?: Record<string, ReadinessPayload>;
}

/** When each agent (by id) answered a message id, in local ms. */
export type Receipts = Record<string, Record<string, number>>;

/**
 * What came back for mailbox messages, keyed by message id (`correlation_id`)
 * then by the answering envelope's `agent_id`: SPEC §4.4 `ack`s, the model's
 * own `steering_acked` (§4.3), and any other mailbox message correlated to it.
 */
export interface SteeringReceipts {
  acks: Receipts;
  applied: Receipts;
  replies: Receipts;
  /** When each agent last signalled live `resumed` / `working` (never a retained replay). */
  signals: Record<string, number>;
}
