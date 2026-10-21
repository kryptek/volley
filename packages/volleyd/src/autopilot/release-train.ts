import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_DEFAULTS } from "../config-defaults";
import { type DecisionInput, type DecisionRecord, waveDecisionId } from "../decisions";
import type { ExecFn, ExecOptions, ExecResult } from "../exec";
import type {
  JournalEvent,
  NewEvent,
  ReleaseState,
  Wave,
  WaveEventType,
  WaveId,
  WaveTask,
} from "../types";
import type { PlaybookStage } from "./playbook";

/**
 * The release train's stages (SPEC §4.6.19): one `release` agent per stage, run serially in
 * playbook order, each with `.volley/stage.md` (its brief, its commands, the facts it must leave
 * true and the result contract). volleyd runs no stage command itself: after a stage's `done` it
 * only reads (git fetch / rev-parse / show, `gh api` GET) to verify the facts, then writes the
 * stage's evidence. Pure apart from `verifyStage`'s reads, `writeStageEvidence` and the driver.
 */

/** The pseudo task a release agent runs under (never a wave-file task id: they cannot start with `_`). */
export const RELEASE_TASK = "_release";

/**
 * The pseudo task a release agent is spawned for: no issue, no pipeline, the wave's model, on the
 * supervisor's own machine (where the playbook was read).
 */
export const releaseWaveTask = (wave: Pick<Wave, "model">): WaveTask => ({
  id: RELEASE_TASK,
  issue: 0,
  after: [],
  stages: [],
  pipeline: [],
  model: wave.model,
  host: "local",
  files: [],
});

/** A release stage agent's result type (`vol_publish(channel="result", type="stage", …)`). */
export const STAGE_RESULT_TYPE = "stage";

/** A `stage_go` decision's answers: `go` runs the stage; `skip` marks it skipped; `hold` asks again. */
export const STAGE_GO_OPTIONS = ["go", "skip", "hold"];

/** A failed stage's `agent_blocked` decision's answers. */
export const STAGE_FAILED_OPTIONS = ["respawn", "skip", "cancel"];

/** The steer reason journaled on a stage agent's `steering_sent` (one per run, before failing it). */
export const STAGE_STEER_REASON = "stage";

/** One command the stage agent ran, as it reports it. */
export interface StageCommand {
  argv: string[];
  code: number;
  seconds: number;
}

/** The stage result payload (review-result.schema.json `stage`). */
export interface StageResult {
  stage: string;
  commands: StageCommand[];
  notes?: string;
  artifacts: { tag?: string; files?: string[]; urls?: string[] };
  /** The payload's other top-level fields (what a stage's `verify.result` checks). */
  fields?: Record<string, unknown>;
}

const CONTRACT_KEYS = new Set(["stage", "commands", "notes", "artifacts"]);

const isStrings = (x: unknown): x is string[] =>
  Array.isArray(x) && x.every((s) => typeof s === "string");

/** A retained `result` payload as `stage`'s result, or null when it is not one. */
export function parseStageResult(payload: unknown, stage: string): StageResult | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.stage !== stage || !Array.isArray(p.commands)) return null;
  const commands: StageCommand[] = [];
  for (const c of p.commands as unknown[]) {
    const x = c as Record<string, unknown> | null;
    if (x === null || typeof x !== "object" || !isStrings(x.argv)) return null;
    if (typeof x.code !== "number" || typeof x.seconds !== "number") return null;
    commands.push({ argv: x.argv, code: x.code, seconds: x.seconds });
  }
  const a = (p.artifacts ?? {}) as Record<string, unknown>;
  if (typeof a !== "object" || a === null) return null;
  const artifacts: StageResult["artifacts"] = {
    ...(typeof a.tag === "string" ? { tag: a.tag } : {}),
    ...(isStrings(a.files) ? { files: a.files } : {}),
    ...(isStrings(a.urls) ? { urls: a.urls } : {}),
  };
  const fields = Object.fromEntries(Object.entries(p).filter(([k]) => !CONTRACT_KEYS.has(k)));
  return {
    stage,
    commands,
    ...(typeof p.notes === "string" ? { notes: p.notes } : {}),
    artifacts,
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// The stage brief
// ---------------------------------------------------------------------------------------------

/** One argv as the shell line the agent types: words with shell metacharacters single-quoted. */
export function shellLine(argv: string[]): string {
  return argv
    .map((w) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`))
    .join(" ");
}

/** The `verify` facts in prose, one bullet each (none: the result contract alone). */
export function verifyProse(stage: PlaybookStage, releaseBranch: string): string[] {
  const v = stage.verify ?? {};
  const out: string[] = [];
  if (v.commits_on_release === true)
    out.push(
      `- At least one new commit is on \`${releaseBranch}\` (pushed with \`git push origin HEAD:${releaseBranch}\`), and your HEAD is on it.`,
    );
  if (v.tag !== undefined)
    out.push(`- A tag matching \`${v.tag}\` exists on origin at the head of \`${releaseBranch}\`.`);
  for (const f of v.files ?? [])
    out.push(`- \`${f}\` exists on \`${releaseBranch}\` (origin's copy).`);
  for (const [k, val] of Object.entries(v.result ?? {}))
    out.push(`- Your result payload carries \`${k}: ${JSON.stringify(val)}\`.`);
  return out;
}

/** The lease lines of a heavy stage (acquire first, release once done), else none. */
const leaseLines = (stage: PlaybookStage): string[] =>
  stage.heavy === undefined
    ? []
    : [
        `This stage is heavy: before anything else run \`volley lease acquire --pool ${stage.heavy}\` and wait for the grant; it prints a \`lease_id\`. Hold the lease until the stage's commands are done, then give it back with \`volley lease release --pool ${stage.heavy} --lease-id <id>\`.`,
        "",
      ];

/** The stage's commands section: the lease first (heavy), then the run lines verbatim, in order. */
export function stageCommandsText(stage: PlaybookStage): string {
  const out = leaseLines(stage);
  if (stage.run.length === 0) out.push("This stage names no commands: do what the brief says.");
  else
    out.push(
      "Run these in this order, each exactly as written, from this worktree. Stop at the first one that exits non-zero: report it and publish `failed`.",
      "",
      "```sh",
      ...stage.run.map(shellLine),
      "```",
    );
  return out.join("\n");
}

/** The facts volleyd checks after the stage's done, in prose. */
export function stageVerifyText(stage: PlaybookStage, releaseBranch: string): string {
  const facts = verifyProse(stage, releaseBranch);
  return [
    ...(facts.length > 0 ? facts : ["- Your stage result (below) is all volleyd checks."]),
    "",
    `Any push goes to the release branch: \`git push origin HEAD:${releaseBranch}\` (a fast-forward, never a force-push).`,
  ].join("\n");
}

/** The release brief's stage placeholders (brief.ts BriefVars). */
export function stageBriefVars(
  stage: PlaybookStage,
  releaseBranch: string,
): { stage: string; stage_brief: string; stage_commands: string; stage_verify: string } {
  return {
    stage: stage.name,
    stage_brief: stage.brief.trim(),
    stage_commands: stageCommandsText(stage),
    stage_verify: stageVerifyText(stage, releaseBranch),
  };
}

/** `.volley/stage.md`: the stage's brief, its commands in order, the facts to leave true, the contract. */
export function renderStageMd(
  stage: PlaybookStage,
  ctx: { wave: WaveId; release_branch: string; attempt: number },
): string {
  return [
    `# Release stage \`${stage.name}\` (wave ${ctx.wave}, attempt ${ctx.attempt})`,
    "",
    "## Brief",
    "",
    stage.brief.trim(),
    "",
    "## Commands",
    "",
    stageCommandsText(stage),
    "",
    "## Verified after your done",
    "",
    stageVerifyText(stage, ctx.release_branch),
    "",
    "## Result contract",
    "",
    "Before your `done`, publish what you ran and what it produced:",
    "",
    `    vol_publish(channel="result", type="stage", payload={ "stage": "${stage.name}", "commands": [{ "argv": [...], "code": <exit code>, "seconds": <wall seconds> }], "notes": "<one paragraph>", "artifacts": { "tag": "<tag, if any>", "files": [...], "urls": [...] } })`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// The train's view, folded from the journal
// ---------------------------------------------------------------------------------------------

/** The run of a stage's current attempt (its `agent_spawned`). */
export interface StageRun {
  agent_id: string;
  attempt: number;
  worktree?: string;
  branch?: string;
  /** The release-branch commit the worktree was cut from. */
  base_sha?: string;
}

export interface ReleaseView {
  wave: WaveId;
  release_branch: string;
  /** Whether the wave is `releasing` (paused or stopped: nothing runs). */
  releasing: boolean;
  /** Whether the wave is paused (an owner's answer still lands; its spawn waits for the resume). */
  paused: boolean;
  stages: PlaybookStage[];
  train: ReleaseState;
  /** The attempt each entered stage is at (its latest `release_stage_entered`). */
  attempt: Record<string, number>;
  /** The current attempt's run, once spawned. */
  runs: Record<string, StageRun>;
  /** Steers sent per agent id (reason `stage`). */
  steers: Record<string, number>;
  /** Open stage decisions (`stage_go`, a failed stage's `agent_blocked`), by stage. */
  open: Record<string, DecisionRecord>;
  /** Every `stage_go` asked per stage (the next one's id). */
  asked: Record<string, number>;
  /** Each verified stage's evidence file (its latest `release_stage_verified`). */
  evidence: Record<string, string>;
}

/** A decision record's stage, when it is one of the train's. */
export function stageOf(d: DecisionRecord): string | undefined {
  const x = d as unknown as { stage?: unknown; pipeline?: { on?: unknown; stage?: unknown } };
  if (d.kind === "stage_go" && typeof x.stage === "string") return x.stage;
  if (
    d.kind === "agent_blocked" &&
    x.pipeline?.on === "stage" &&
    typeof x.pipeline.stage === "string"
  )
    return x.pipeline.stage;
  return undefined;
}

/** The train's view over a wave's journal and decisions (null: no train). */
export function releaseView(o: {
  wave: WaveId;
  release_branch: string;
  status: string | undefined;
  train: ReleaseState | undefined;
  events: Iterable<JournalEvent>;
  decisions: Record<string, DecisionRecord>;
}): ReleaseView | null {
  if (o.train === undefined) return null;
  let stages: PlaybookStage[] = [];
  const attempt: Record<string, number> = {};
  const runs: Record<string, StageRun> = {};
  const steers: Record<string, number> = {};
  const evidence: Record<string, string> = {};
  for (const e of o.events) {
    if (e.type === "release_started") {
      stages = ((e.data.playbook as { stages?: PlaybookStage[] } | undefined)?.stages ??
        []) as PlaybookStage[];
    } else if (e.type === "release_stage_entered" && typeof e.data.stage === "string") {
      attempt[e.data.stage] = typeof e.data.attempt === "number" ? e.data.attempt : 1;
      delete runs[e.data.stage];
    } else if (e.type === "agent_spawned" && e.task === RELEASE_TASK) {
      // The stage's run since it was last entered (an update-prompt relaunch moves its attempt on).
      const s = e.data.stage;
      if (typeof s !== "string" || attempt[s] === undefined) continue;
      runs[s] = {
        agent_id: String(e.data.agent_id),
        attempt: Number(e.data.attempt),
        ...(typeof e.data.worktree === "string" ? { worktree: e.data.worktree } : {}),
        ...(typeof e.data.branch === "string" ? { branch: e.data.branch } : {}),
        ...(typeof e.data.base_sha === "string" ? { base_sha: e.data.base_sha } : {}),
      };
    } else if (
      e.type === "steering_sent" &&
      e.task === RELEASE_TASK &&
      e.data.reason === STAGE_STEER_REASON
    ) {
      const id = String(e.data.agent_id);
      steers[id] = (steers[id] ?? 0) + 1;
    } else if (
      e.type === "release_stage_verified" &&
      typeof e.data.stage === "string" &&
      typeof e.data.evidence === "string"
    ) {
      evidence[e.data.stage] = e.data.evidence;
    }
  }
  const open: Record<string, DecisionRecord> = {};
  const asked: Record<string, number> = {};
  for (const d of Object.values(o.decisions)) {
    const s = stageOf(d);
    if (s === undefined) continue;
    if (d.kind === "stage_go") asked[s] = (asked[s] ?? 0) + 1;
    if (d.resolved === undefined) open[s] = d;
  }
  return {
    wave: o.wave,
    release_branch: o.release_branch,
    releasing: o.status === "releasing",
    paused: o.status === "paused",
    stages,
    train: o.train,
    attempt,
    runs,
    steers,
    open,
    asked,
    evidence,
  };
}

// ---------------------------------------------------------------------------------------------
// The interpreter
// ---------------------------------------------------------------------------------------------

/** What verification found (`verifyStage`). */
export interface StageReport {
  ok: boolean;
  /** The agent's HEAD and the release branch's tip on origin, as read. */
  head?: string;
  tip?: string;
  facts: { fact: string; ok: boolean; evidence: string }[];
  /** The facts that do not hold, by name (`tag v0.5.0`, `file CHANGELOG.md`). */
  missing: string[];
}

export type ReleaseEvent =
  /** Re-evaluate: start the next stage, retry a spawn that did not happen. */
  | { kind: "advance" }
  /** A stage agent's terminal status (`blocked` too: the stage stops either way). */
  | {
      kind: "agent_done";
      agent_id: string;
      status: "done" | "failed" | "blocked";
      result?: unknown;
      why?: string;
    }
  /** Verification of `agent_id`'s run finished (`evidence`: the written `.md`, when verified). */
  | {
      kind: "stage_checked";
      stage: string;
      agent_id: string;
      report: StageReport;
      evidence?: string;
    }
  | { kind: "decision_resolved"; decision: DecisionRecord }
  /**
   * The answer to a recovery decision about a stage agent (its question, a stall, gone after a
   * restart): `stop` fails the stage (the owner is asked what next); `respawn` runs it again.
   */
  | { kind: "agent_recovery"; agent_id: string; answer: "stop" | "respawn"; why: string }
  /** The owner stopped the retries of a stage's spawn that keeps failing: the stage fails. */
  | { kind: "spawn_stopped"; why: string };

export type ReleaseAction =
  | { kind: "journal"; event: NewEvent }
  | { kind: "spawn"; stage: string; attempt: number }
  | { kind: "verify"; stage: string; agent_id: string; result: StageResult }
  | { kind: "steer"; stage: string; agent_id: string; text: string }
  | { kind: "decide"; decision: DecisionInput; data: Record<string, unknown> }
  /** Retire an agent; `status`: a DAEMON_ENDED one for an agent that never ended itself. */
  | { kind: "retire"; agent_id: string; status?: string };

const journal = (type: WaveEventType, data: Record<string, unknown>): ReleaseAction => ({
  kind: "journal",
  event: { type, data },
});

/** Enter `stage` at `attempt`: journal it, then spawn its agent. */
const enter = (stage: string, attempt: number): ReleaseAction[] => [
  journal("release_stage_entered", { stage, attempt }),
  { kind: "spawn", stage, attempt },
];

/**
 * Ask the owner `stage_go` about an owner-gated stage (the `n`th time: `class: held` after a
 * hold). It opens with the earlier stages' evidence, as `release_go` does.
 */
function askGo(v: ReleaseView, stage: PlaybookStage): ReleaseAction {
  const n = v.asked[stage.name] ?? 0;
  const done = v.train.stages.filter((s) => s.state === "verified").map((s) => s.name);
  const stages = done.map((name) => {
    const e = v.evidence[name];
    return { name, ...(e !== undefined ? { evidence: e } : {}) };
  });
  return {
    kind: "decide",
    decision: {
      kind: "stage_go",
      task: null,
      id:
        n === 0
          ? waveDecisionId("stage_go", v.wave, stage.name)
          : waveDecisionId("stage_go", v.wave, stage.name, String(n)),
      question: `Wave ${v.wave}'s release stage ${stage.name} is owner-gated (verified so far: ${done.join(", ") || "none"}). Run it? go: volleyd spawns its agent; skip: the stage is skipped; hold: asked again.`,
      options: [...STAGE_GO_OPTIONS],
    },
    data: { stage: stage.name, stages, ...(n > 0 ? { class: "held" } : {}) },
  };
}

/**
 * A stage that cannot go on: journal it failed and ask the owner what next. `run` without an
 * agent: its spawn never happened (the owner stopped its retries).
 */
function failStage(
  v: ReleaseView,
  stage: string,
  run: { agent_id?: string; attempt: number },
  reason: string,
): ReleaseAction[] {
  const agent = run.agent_id !== undefined ? { agent_id: run.agent_id } : {};
  // Keyed on the entered attempt, never the run's: an agent counts its attempts from its own
  // spawns, so after a stopped spawn and a respawn the two drift and an id would repeat.
  const entered = v.attempt[stage] ?? run.attempt;
  return [
    journal("release_stage_failed", { stage, reason, ...agent }),
    {
      kind: "decide",
      decision: {
        kind: "agent_blocked",
        task: null,
        id: waveDecisionId("agent_blocked", v.wave, RELEASE_TASK, stage, String(entered)),
        question: `Wave ${v.wave}'s release stage ${stage} failed (${run.agent_id ?? "no agent spawned"}): ${reason}. respawn: a fresh agent runs the stage again; skip: the stage is skipped; cancel: the train stops and the wave completes without its release.`,
        options: [...STAGE_FAILED_OPTIONS],
      },
      data: {
        stage,
        ...agent,
        pipeline: { on: "stage", stage, ...agent, attempt: run.attempt },
      },
    },
  ];
}

/** Steer once (`text`), then retire the agent as failed and fail the stage (`reason`). */
function steerOrFail(
  v: ReleaseView,
  stage: string,
  run: StageRun,
  text: string,
  reason: string,
): ReleaseAction[] {
  if ((v.steers[run.agent_id] ?? 0) === 0)
    return [{ kind: "steer", stage, agent_id: run.agent_id, text }];
  return [
    { kind: "retire", agent_id: run.agent_id, status: "failed" },
    ...failStage(v, stage, run, reason),
  ];
}

/** The stage `agent_id` runs (its current attempt), if any. */
function stageOfAgent(v: ReleaseView, agentId: string): string | undefined {
  return Object.entries(v.runs).find(([, r]) => r.agent_id === agentId)?.[0];
}

function stateOf(v: ReleaseView, stage: string) {
  return v.train.stages.find((s) => s.name === stage)?.state;
}

function advance(v: ReleaseView): ReleaseAction[] {
  if (!v.releasing) return [];
  // One stage at a time: running (its spawn retried until it happens), awaiting its go, or failed
  // and waiting for the owner's answer.
  for (const s of v.train.stages) {
    if (s.state === "running") {
      const attempt = v.attempt[s.name] ?? 1;
      return v.runs[s.name] === undefined ? [{ kind: "spawn", stage: s.name, attempt }] : [];
    }
    if (s.state === "awaiting_go" || s.state === "failed") return [];
  }
  const next = v.train.stages.find((s) => s.state === "pending");
  const stage = v.stages.find((s) => s.name === next?.name);
  if (next === undefined || stage === undefined) return [];
  return stage.gate === "owner" ? [askGo(v, stage)] : enter(stage.name, 1);
}

function onDone(
  v: ReleaseView,
  ev: Extract<ReleaseEvent, { kind: "agent_done" }>,
): ReleaseAction[] {
  const stage = stageOfAgent(v, ev.agent_id);
  if (stage === undefined || stateOf(v, stage) !== "running") return [];
  const run = v.runs[stage] as StageRun;
  if (ev.status !== "done") {
    const why = ev.why ?? (ev.status === "blocked" ? "the agent is blocked" : "the agent failed");
    // A blocked agent may still be alive: it is stopped before the owner is asked.
    return [
      ...(ev.status === "blocked"
        ? [{ kind: "retire" as const, agent_id: ev.agent_id, status: "stopped" }]
        : []),
      ...failStage(v, stage, run, why),
    ];
  }
  const result = parseStageResult(ev.result, stage);
  if (result === null)
    return steerOrFail(
      v,
      stage,
      run,
      `volleyd: your done for release stage ${stage} has no stage result. Publish vol_publish(channel="result", type="stage", payload={ "stage": "${stage}", "commands": [...], "notes": "...", "artifacts": {...} }) as .volley/stage.md says, then publish done again.`,
      "no stage result",
    );
  return [{ kind: "verify", stage, agent_id: ev.agent_id, result }];
}

function onChecked(
  v: ReleaseView,
  ev: Extract<ReleaseEvent, { kind: "stage_checked" }>,
): ReleaseAction[] {
  const run = v.runs[ev.stage];
  if (run?.agent_id !== ev.agent_id || stateOf(v, ev.stage) !== "running") return [];
  if (ev.report.ok)
    return [
      journal("release_stage_verified", {
        stage: ev.stage,
        agent_id: ev.agent_id,
        ...(ev.report.head !== undefined ? { head: ev.report.head } : {}),
        ...(ev.evidence !== undefined ? { evidence: ev.evidence } : {}),
      }),
      { kind: "retire", agent_id: ev.agent_id },
    ];
  const missing = ev.report.missing.join(", ");
  return steerOrFail(
    v,
    ev.stage,
    run,
    `volleyd: release stage ${ev.stage} is not verified; these facts do not hold: ${missing}. Make them true as .volley/stage.md says (or publish failed if you cannot), then publish the stage result and done again.`,
    `not verified: ${missing}`,
  );
}

function onResolved(v: ReleaseView, d: DecisionRecord): ReleaseAction[] {
  const stage = stageOf(d);
  const answer = d.resolved?.answer.trim().toLowerCase();
  // Paused too: the decision is consumed now, and advance never re-asks a stage awaiting its go
  // or failed. The spawn this enters is held until the wave resumes.
  if (stage === undefined || answer === undefined || !(v.releasing || v.paused)) return [];
  const by = d.resolved?.by ?? "";
  const skip = journal("release_stage_skipped", { stage, by, decision_id: d.decision_id });
  if (d.kind === "stage_go") {
    if (stateOf(v, stage) !== "awaiting_go") return [];
    if (answer === "go") return enter(stage, (v.attempt[stage] ?? 0) + 1);
    if (answer === "skip") return [skip];
    const s = v.stages.find((x) => x.name === stage);
    return s !== undefined ? [askGo(v, s)] : [];
  }
  if (stateOf(v, stage) !== "failed") return [];
  const old = (d as unknown as { pipeline: { agent_id?: unknown } }).pipeline.agent_id;
  // The failed run may still be alive (a blocked agent): stopped before anything else happens.
  const stop: ReleaseAction[] =
    typeof old === "string" ? [{ kind: "retire", agent_id: old, status: "stopped" }] : [];
  if (answer === "respawn") return [...stop, ...enter(stage, (v.attempt[stage] ?? 1) + 1)];
  if (answer === "skip") return [...stop, skip];
  if (answer === "cancel")
    return [...stop, journal("release_cancelled", { stage, by, decision_id: d.decision_id })];
  return [];
}

function onRecovery(
  v: ReleaseView,
  ev: Extract<ReleaseEvent, { kind: "agent_recovery" }>,
): ReleaseAction[] {
  const stage = stageOfAgent(v, ev.agent_id);
  // Paused too, as onResolved: the answer is consumed now (the agent already retired), and
  // advance never respawns a stage whose run is still recorded. The spawn waits for the resume.
  if (stage === undefined || stateOf(v, stage) !== "running" || !(v.releasing || v.paused))
    return [];
  const run = v.runs[stage] as StageRun;
  if (ev.answer === "stop")
    return [
      { kind: "retire", agent_id: ev.agent_id, status: "stopped" },
      ...failStage(v, stage, run, ev.why),
    ];
  return [
    { kind: "retire", agent_id: ev.agent_id, status: "relaunched" },
    journal("release_stage_failed", { stage, reason: ev.why, agent_id: run.agent_id }),
    ...enter(stage, (v.attempt[stage] ?? 1) + 1),
  ];
}

function onSpawnStopped(
  v: ReleaseView,
  ev: Extract<ReleaseEvent, { kind: "spawn_stopped" }>,
): ReleaseAction[] {
  if (!(v.releasing || v.paused)) return [];
  // The running stage whose agent never spawned (one with a run is the agent's to end).
  const s = v.train.stages.find((x) => x.state === "running");
  if (s === undefined || v.runs[s.name] !== undefined) return [];
  return failStage(v, s.name, { attempt: v.attempt[s.name] ?? 1 }, ev.why);
}

/** The pure interpreter: what to do about `ev` given the train's view. */
export function nextRelease(v: ReleaseView, ev: ReleaseEvent): ReleaseAction[] {
  switch (ev.kind) {
    case "advance":
      return advance(v);
    case "agent_done":
      return onDone(v, ev);
    case "stage_checked":
      return onChecked(v, ev);
    case "decision_resolved":
      return onResolved(v, ev.decision);
    case "agent_recovery":
      return onRecovery(v, ev);
    case "spawn_stopped":
      return onSpawnStopped(v, ev);
  }
}

// ---------------------------------------------------------------------------------------------
// Verification (read-only, beside the queue)
// ---------------------------------------------------------------------------------------------

/** A tag glob's literal prefix (`v0.*` → `v0.`): what `matching-refs` is asked for. */
export const globPrefix = (glob: string): string => glob.split(/[*?[]/)[0] ?? "";

/** A tag glob as a regex over the whole name (`*`, `?`, `[…]`). */
export function globRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) re += "\\[";
      else {
        re += `[${glob
          .slice(i + 1, end)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const out = (r: ExecResult) => r.stdout.trim();

/**
 * Check a stage's `verify` facts and result after its `done` (read-only git and `gh api` GETs in
 * the agent's worktree `cwd`): `commits_on_release` (the release tip moved past `start` and the
 * agent's HEAD is on it), `tag` (a matching tag at the tip), `files` (each on the release branch),
 * `result` (each field with its value), and every `run` line reported with exit code 0.
 */
export async function verifyStage(
  exec: ExecFn,
  o: {
    cwd: string;
    stage: PlaybookStage;
    start: string | undefined;
    release_branch: string;
    result: StageResult;
  },
): Promise<StageReport> {
  const facts: StageReport["facts"] = [];
  const missing: string[] = [];
  const fact = (name: string, ok: boolean, evidence: string) => {
    facts.push({ fact: name, ok, evidence });
    if (!ok) missing.push(name);
  };
  const git = (...args: string[]) => exec(["git", "-C", o.cwd, ...args]);
  const remote = `refs/remotes/origin/${o.release_branch}`;
  const fetched = await git("fetch", "--quiet", "origin", o.release_branch);
  const tipR = await git("rev-parse", "--verify", "--quiet", remote);
  const headR = await git("rev-parse", "HEAD");
  const tip = tipR.code === 0 ? out(tipR) : undefined;
  const head = headR.code === 0 ? out(headR) : undefined;
  const fetchNote =
    fetched.code === 0 ? "" : ` (fetch failed: ${fetched.stderr.trim() || fetched.code})`;
  // Every run line, in order, reported with exit code 0 (each reported command matches one line).
  let from = 0;
  const ran = o.stage.run.map((argv) => {
    const i = o.result.commands.findIndex(
      (c, j) => j >= from && c.argv.length === argv.length && c.argv.every((w, k) => w === argv[k]),
    );
    if (i < 0) return undefined;
    from = i + 1;
    return o.result.commands[i];
  });
  const failedCmd = ran.findIndex((c) => c === undefined || c.code !== 0);
  if (o.stage.run.length > 0)
    fact(
      "commands",
      failedCmd < 0,
      failedCmd < 0
        ? `${o.stage.run.length} command(s) exited 0`
        : `${shellLine(o.stage.run[failedCmd] as string[])}: ${ran[failedCmd] === undefined ? "not reported" : `exited ${ran[failedCmd]?.code}`}`,
    );
  const v = o.stage.verify ?? {};
  if (v.commits_on_release === true) {
    // The tip moved past the stage's start (an unknown start is unverifiable), HEAD on it and
    // past the start too (a tip moved by someone else does not count).
    const start = o.start;
    let ok =
      start !== undefined &&
      tip !== undefined &&
      head !== undefined &&
      tip !== start &&
      head !== start;
    if (ok)
      ok = (await git("merge-base", "--is-ancestor", start as string, tip as string)).code === 0;
    if (ok) ok = (await git("merge-base", "--is-ancestor", head as string, remote)).code === 0;
    fact(
      "commits_on_release",
      ok,
      start === undefined
        ? `start unknown (no base_sha recorded), origin/${o.release_branch} at ${tip?.slice(0, 7) ?? "?"}${fetchNote}`
        : `origin/${o.release_branch} ${start.slice(0, 7)}..${tip?.slice(0, 7) ?? "?"}, HEAD ${head?.slice(0, 7) ?? "?"}${ok ? " on it" : ""}${fetchNote}`,
    );
  }
  if (v.tag !== undefined) {
    const name = `tag ${v.tag}`;
    // Every page (a common glob like `v*` outgrows the first 30 refs): --slurp makes an array
    // of pages.
    const r = await exec(
      [
        "gh",
        "api",
        `repos/{owner}/{repo}/git/matching-refs/tags/${globPrefix(v.tag)}`,
        "--paginate",
        "--slurp",
      ],
      { cwd: o.cwd },
    );
    let refs: { ref?: string; object?: { sha?: string; type?: string } }[] = [];
    try {
      const parsed: unknown = r.code === 0 ? JSON.parse(r.stdout) : [];
      if (Array.isArray(parsed)) refs = parsed.flat();
    } catch {}
    const re = globRegex(v.tag);
    const matching = refs.filter((x) => re.test((x.ref ?? "").replace(/^refs\/tags\//, "")));
    let at: string | undefined;
    for (const m of matching) {
      let sha = m.object?.sha;
      // An annotated tag points at a tag object: read the commit it tags.
      if (m.object?.type === "tag" && sha !== undefined) {
        const t = await exec(["gh", "api", `repos/{owner}/{repo}/git/tags/${sha}`], { cwd: o.cwd });
        try {
          sha = (JSON.parse(t.stdout) as { object?: { sha?: string } }).object?.sha;
        } catch {
          sha = undefined;
        }
      }
      if (sha !== undefined && sha === tip) {
        at = (m.ref ?? "").replace(/^refs\/tags\//, "");
        break;
      }
    }
    fact(
      name,
      at !== undefined,
      at !== undefined
        ? `${at} at ${tip?.slice(0, 7)}`
        : r.code !== 0
          ? `gh api exited ${r.code}: ${r.stderr.trim()}`
          : `${matching.length} tag(s) match, none at ${tip?.slice(0, 7) ?? "the tip"}`,
    );
  }
  for (const f of v.files ?? []) {
    const r = await git("show", "--quiet", `${remote}:${f}`);
    fact(
      `file ${f}`,
      r.code === 0,
      r.code === 0 ? `on origin/${o.release_branch}` : `git show exited ${r.code}`,
    );
  }
  for (const [k, want] of Object.entries(v.result ?? {})) {
    const got = o.result.fields?.[k];
    fact(
      `result ${k}`,
      got === want,
      `${k}: ${JSON.stringify(got)}${got === want ? "" : ` (want ${JSON.stringify(want)})`}`,
    );
  }
  return {
    ok: missing.length === 0,
    ...(head !== undefined ? { head } : {}),
    ...(tip !== undefined ? { tip } : {}),
    facts,
    missing,
  };
}

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------

export interface StageEvidence {
  wave: WaveId;
  stage: string;
  agent_id: string;
  attempt: number;
  release_branch: string;
  start?: string;
  head?: string;
  tip?: string;
  commands: StageCommand[];
  notes?: string;
  artifacts: StageResult["artifacts"];
  facts: StageReport["facts"];
  verified_at: string;
}

/** A verified stage's evidence (pure). */
export function stageEvidence(o: {
  wave: WaveId;
  stage: string;
  run: StageRun;
  release_branch: string;
  result: StageResult;
  report: StageReport;
  at: string;
}): StageEvidence {
  return {
    wave: o.wave,
    stage: o.stage,
    agent_id: o.run.agent_id,
    attempt: o.run.attempt,
    release_branch: o.release_branch,
    ...(o.run.base_sha !== undefined ? { start: o.run.base_sha } : {}),
    ...(o.report.head !== undefined ? { head: o.report.head } : {}),
    ...(o.report.tip !== undefined ? { tip: o.report.tip } : {}),
    commands: o.result.commands,
    ...(o.result.notes !== undefined ? { notes: o.result.notes } : {}),
    artifacts: o.result.artifacts,
    facts: o.report.facts,
    verified_at: o.at,
  };
}

/** The evidence as Markdown: the commands and exit codes, the artifacts, the verified facts. */
export function renderStageEvidenceMd(j: StageEvidence): string {
  const md = [
    `# Release stage \`${j.stage}\` — wave ${j.wave}`,
    "",
    `- Agent: \`${j.agent_id}\` (attempt ${j.attempt})`,
    `- Release branch: \`${j.release_branch}\`${j.start !== undefined ? ` from \`${j.start.slice(0, 12)}\`` : ""}${j.tip !== undefined ? ` to \`${j.tip.slice(0, 12)}\`` : ""}`,
    ...(j.head !== undefined ? [`- Agent HEAD: \`${j.head.slice(0, 12)}\``] : []),
    "",
    "## Commands",
    "",
  ];
  if (j.commands.length === 0) md.push("(none reported)");
  for (const c of j.commands)
    md.push(`- \`${shellLine(c.argv)}\` → exit ${c.code} (${c.seconds}s)`);
  md.push("", "## Artifacts", "");
  const a = j.artifacts;
  const items = [
    ...(a.tag !== undefined ? [`- tag \`${a.tag}\``] : []),
    ...(a.files ?? []).map((f) => `- file \`${f}\``),
    ...(a.urls ?? []).map((u) => `- ${u}`),
  ];
  md.push(...(items.length > 0 ? items : ["(none)"]));
  md.push("", "## Verified facts", "");
  md.push(
    ...(j.facts.length > 0
      ? j.facts.map((f) => `- ${f.ok ? "✓" : "✗"} ${f.fact}: ${f.evidence}`)
      : ["(no verify facts: the stage result was checked)"]),
  );
  if (j.notes !== undefined) md.push("", "## Notes", "", j.notes);
  md.push("", `_Verified ${j.verified_at}._`, "");
  return md.join("\n");
}

/** `<home>/waves/<wave>/release/<stage>.{md,json}`, written atomically; returns both paths. */
export function writeStageEvidence(
  home: string,
  wave: WaveId,
  stage: string,
  j: StageEvidence,
): { md: string; json: string } {
  const dir = join(home, "waves", wave, "release");
  mkdirSync(dir, { recursive: true });
  const md = join(dir, `${stage}.md`);
  const json = join(dir, `${stage}.json`);
  for (const [path, body] of [
    [json, `${JSON.stringify(j, null, 2)}\n`],
    [md, renderStageEvidenceMd(j)],
  ] as const) {
    writeFileSync(`${path}.tmp`, body);
    renameSync(`${path}.tmp`, path);
  }
  return { md, json };
}

// ---------------------------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------------------------

export interface ReleaseDeps {
  /** The fenced exec (read-only verbs only; the driver adds the pipeline's hard timeout). */
  exec: ExecFn;
  /** $VOLLEYD_HOME: evidence goes to `<home>/waves/<wave>/release/`. */
  home: string;
  /** The train's view now (re-read after every journal append); null: no train. */
  view: () => ReleaseView | null;
  journal: (ev: NewEvent) => Promise<unknown>;
  /** Start a stage's agent (may hold silently: the next advance retries). */
  spawn: (stage: PlaybookStage, attempt: number) => unknown;
  steer: (agentId: string, text: string) => Promise<unknown>;
  decide: (input: DecisionInput, extra: Record<string, unknown>) => Promise<unknown>;
  retire: (agentId: string, status?: string) => Promise<unknown>;
  /** Run `fn` on the daemon's serial queue (verification folds back in through it). */
  enqueue: (fn: () => Promise<void>) => Promise<void>;
  now: () => number;
  log?: (line: string) => void;
}

/** Executes the train's actions for one wave. Call it from one serial queue. */
export class ReleaseTrain {
  /** Verifications running beside the queue, by agent id. */
  private readonly inflight = new Set<string>();
  private readonly chains = new Set<Promise<void>>();

  constructor(
    private readonly wave: WaveId,
    private readonly deps: ReleaseDeps,
  ) {}

  /** Handle one observation, then advance until the train settles. */
  async handle(ev: ReleaseEvent): Promise<void> {
    const v = this.deps.view();
    if (v === null) return;
    await this.run(nextRelease(v, ev));
    for (let i = 0; i < DAEMON_DEFAULTS.pipeline_max_advances; i++) {
      const w = this.deps.view();
      if (w === null) return;
      const acts = nextRelease(w, { kind: "advance" });
      if (acts.length === 0 || !(await this.run(acts))) return;
    }
  }

  /** Resolves once no verification is running beside the queue. */
  async settled(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains]);
  }

  private async run(actions: ReleaseAction[]): Promise<boolean> {
    let progressed = false;
    for (const a of actions) {
      switch (a.kind) {
        case "journal":
          await this.deps.journal(a.event);
          progressed = true;
          break;
        case "spawn": {
          const stage = this.deps.view()?.stages.find((s) => s.name === a.stage);
          if (stage !== undefined) this.deps.spawn(stage, a.attempt);
          break;
        }
        case "steer":
          await this.deps.steer(a.agent_id, a.text);
          progressed = true;
          break;
        case "decide":
          await this.deps.decide(a.decision, a.data);
          progressed = true;
          break;
        case "retire":
          await this.deps.retire(a.agent_id, a.status);
          progressed = true;
          break;
        case "verify":
          this.verify(a.stage, a.agent_id, a.result);
          break;
      }
    }
    return progressed;
  }

  /** The fenced exec with the pipeline's hard timeout. */
  private io(): ExecFn {
    return (argv, opts: ExecOptions = {}) =>
      this.deps.exec(argv, { timeoutMs: DAEMON_DEFAULTS.pipeline_io_ms, ...opts });
  }

  /** Beside the queue: verify the run, write its evidence when verified, fold the report back in. */
  private verify(stageName: string, agentId: string, result: StageResult): void {
    const v = this.deps.view();
    const run = v?.runs[stageName];
    const stage = v?.stages.find((s) => s.name === stageName);
    if (v == null || run?.agent_id !== agentId || stage === undefined || this.inflight.has(agentId))
      return;
    this.inflight.add(agentId);
    const p: Promise<void> = (async (): Promise<ReleaseEvent> => {
      let report: StageReport;
      try {
        report =
          run.worktree === undefined
            ? { ok: false, facts: [], missing: ["worktree (none recorded)"] }
            : await verifyStage(this.io(), {
                cwd: run.worktree,
                stage,
                start: run.base_sha,
                release_branch: v.release_branch,
                result,
              });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        report = { ok: false, facts: [], missing: [`verification (${message})`] };
      }
      let evidence: string | undefined;
      if (report.ok) {
        const j = stageEvidence({
          wave: this.wave,
          stage: stageName,
          run,
          release_branch: v.release_branch,
          result,
          report,
          at: new Date(this.deps.now()).toISOString(),
        });
        try {
          evidence = writeStageEvidence(this.deps.home, this.wave, stageName, j).md;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          report = { ...report, ok: false, missing: [`evidence (${message})`] };
        }
      }
      return {
        kind: "stage_checked",
        stage: stageName,
        agent_id: agentId,
        report,
        ...(evidence !== undefined ? { evidence } : {}),
      };
    })()
      .then(async (ev) => {
        this.inflight.delete(agentId);
        await this.deps.enqueue(() => this.handle(ev));
      })
      .catch((e: unknown) => {
        this.inflight.delete(agentId);
        this.deps.log?.(`release ${this.wave}/${stageName}: ${String(e)}`);
      })
      .finally(() => this.chains.delete(p));
    this.chains.add(p);
  }
}
