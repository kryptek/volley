import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DAEMON_DEFAULTS } from "../config-defaults";
import type { NewEvent } from "../types";
import type { MachineRole } from "./record";

/**
 * The role-move engine (SPEC §4.6.24): runs a planned move's steps in order, one move at a time
 * per supervisor. Each change is published on `volley/_system/roles/moves/<move_id>` (through
 * `publish`), journaled in `_system` (`role_move_*`) and appended to the move's log
 * (`$VOLLEYD_HOME/roles/<move_id>/log.jsonl`). A failing step undoes every step done so far, in
 * reverse, and ends the move `failed`. The move's record (`move.json`, beside the log) is what a
 * `role_rollback` reads; the start-up sweep removes a move kept longer than the retention window
 * (`role_move_retention_ms`, 7 days, no tunable), with its retained topic.
 *
 * A step marked `handover` (a supervisor move) ends this process's part: once it is done the move
 * stays `running` and is answered `handing_over`, and the supervisor on the target continues it
 * with `run({ resume })` from its own copy of the record.
 */

export type MoveStatus =
  | "planning"
  | "running"
  | "health_check"
  | "done"
  | "failed"
  | "rolled_back";
export type StepStatus = "pending" | "running" | "ok" | "failed" | "skipped";

/** One step of a move as the moves topic shows it (role-move.schema.json `steps[]`). */
export interface StepState {
  id: string;
  title: string;
  where: string;
  status: StepStatus;
  line?: string;
}

/** The moves topic's payload (role-move.schema.json). */
export interface MovePayload {
  move_id: string;
  role: MachineRole;
  from: string;
  to: string;
  status: MoveStatus;
  steps: StepState[];
  since: string;
  error?: string;
  log_path?: string;
}

/** The move's record on disk: the payload, plus who asked, what a rollback needs, and when. */
export interface MoveRecord extends MovePayload {
  by: string;
  started_at: string;
  /** What a rollback of this move restores (the planner's: the old roles record, ports, …). */
  kept?: Record<string, unknown>;
  /** A rollback: the move it undoes. */
  rolls_back?: string;
}

/** What a step's runner is told: the move it is part of. */
export interface StepContext {
  move_id: string;
}

/** A step as the planner makes it: what it shows, what it digests, how it runs and undoes. */
export interface MoveStep {
  id: string;
  title: string;
  /** The machine it runs on (or `every machine`). */
  where: string;
  /** What `plan_id` digests: the command or change the step makes, exactly. */
  detail: string;
  /** Runs the step; its answer is the step's last line. Throws on failure. */
  run: (ctx: StepContext) => Promise<string | undefined>;
  /** Puts back what `run` changed; called in reverse when a later step fails. */
  undo?: () => Promise<void>;
  /** The move is in its health check while this step runs. */
  health?: boolean;
  /** The last step this process runs (a supervisor hands itself over after it). */
  handover?: boolean;
}

export interface MoveRequest {
  move_id: string;
  role: MachineRole;
  from: string;
  to: string;
  by: string;
  steps: MoveStep[];
  kept?: Record<string, unknown>;
  rolls_back?: string;
  /** A hand-over's continuation: the record the old supervisor left; its done steps stay `ok`. */
  resume?: MoveRecord;
}

export type MoveResult =
  | { ok: true; move_id: string; status: "done" }
  | { ok: true; move_id: string; status: "running"; handing_over: true }
  | {
      ok: false;
      move_id: string;
      status: "failed";
      step: string;
      error: string;
      rolled_back: boolean;
    };

export interface RoleMovesDeps {
  /** `$VOLLEYD_HOME`: moves are kept in its `roles/<move_id>/`. */
  home: string;
  now: () => Date;
  /** Publish the move's payload, retained, on its moves topic. */
  publish: (p: MovePayload) => Promise<void>;
  /** Clear a removed move's retained topic. */
  clear: (moveId: string) => Promise<void>;
  journal: (ev: NewEvent) => unknown;
  log: (line: string) => void;
}

/** `$VOLLEYD_HOME/roles/<move_id>`: a move's log, record and kept copy. */
export const moveDir = (home: string, moveId: string) => join(home, "roles", moveId);
const RECORD = "move.json";
const LOG = "log.jsonl";

/**
 * A plan's id: the role, the target and every step's machine and exact change, digested, so a
 * `role_move` naming an id runs only the plan the person saw (the `setup_apply` pattern).
 */
export function planId(
  role: string,
  to: string,
  steps: readonly { id: string; where: string; detail: string }[],
  blocked: readonly string[],
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        role,
        to,
        steps: steps.map((s) => [s.id, s.where, s.detail]),
        blocked,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return `${role}-${digest}`;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class RoleMoves {
  private current: string | null = null;

  constructor(private readonly deps: RoleMovesDeps) {}

  /** The move in progress, or null. */
  running(): string | null {
    return this.current;
  }

  /** Why a move cannot start now, or null. */
  refusal(): string | null {
    return this.current === null ? null : `a role move is in progress: ${this.current}`;
  }

  /** A kept move's record, or null. */
  read(moveId: string): MoveRecord | null {
    try {
      return JSON.parse(
        readFileSync(join(moveDir(this.deps.home, moveId), RECORD), "utf-8"),
      ) as MoveRecord;
    } catch {
      return null;
    }
  }

  /** Publish every kept move's record again (a restart: the retained topic may be stale). */
  async republish(): Promise<void> {
    const root = join(this.deps.home, "roles");
    if (!existsSync(root)) return;
    for (const id of readdirSync(root)) {
      const rec = this.read(id);
      if (rec !== null) await this.deps.publish(payloadOf(rec)).catch(() => {});
    }
  }

  /**
   * A move waiting for a quiet fleet (`role_move { drain: true }`): its record and topic say
   * `planning` until `run` starts it under the same id.
   */
  async announce(req: Omit<MoveRequest, "resume">): Promise<void> {
    mkdirSync(moveDir(this.deps.home, req.move_id), { recursive: true, mode: 0o700 });
    const rec: MoveRecord = {
      move_id: req.move_id,
      role: req.role,
      from: req.from,
      to: req.to,
      status: "planning",
      steps: req.steps.map(({ id, title, where }) => ({ id, title, where, status: "pending" })),
      since: this.iso(),
      by: req.by,
      started_at: this.iso(),
    };
    this.write(rec);
    await this.deps.publish(payloadOf(rec)).catch(() => {});
  }

  /** Mark a kept, done move `rolled_back` (a `role_rollback` undid it) and publish it. */
  async markRolledBack(moveId: string): Promise<void> {
    const rec = this.read(moveId);
    if (rec === null) return;
    const next: MoveRecord = { ...rec, status: "rolled_back", since: this.iso() };
    this.write(next);
    await this.deps.publish(payloadOf(next));
  }

  /** Run a move to its end (or its hand-over). Throws while another move runs. */
  async run(req: MoveRequest): Promise<MoveResult> {
    const busy = this.refusal();
    if (busy !== null) throw new Error(busy);
    this.current = req.move_id;
    try {
      return await this.runSteps(req);
    } finally {
      this.current = null;
    }
  }

  /**
   * Remove every move kept longer than the retention window (`role_move_retention_ms`) with its
   * retained topic: a finished move by when it finished, a directory without a record by its own
   * time. A move still running is kept. Returns the ids removed.
   */
  async sweep(): Promise<string[]> {
    const root = join(this.deps.home, "roles");
    if (!existsSync(root)) return [];
    const cutoff = this.deps.now().getTime() - DAEMON_DEFAULTS.role_move_retention_ms;
    const removed: string[] = [];
    for (const id of readdirSync(root)) {
      const dir = join(root, id);
      let at: number;
      try {
        if (!statSync(dir).isDirectory()) continue;
        const rec = this.read(id);
        // A move still running is kept; one left waiting (`planning`) ages like a finished one.
        if (rec !== null && (rec.status === "running" || rec.status === "health_check")) continue;
        at = rec !== null ? Date.parse(rec.since) : statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      if (!(at < cutoff)) continue;
      rmSync(dir, { recursive: true, force: true });
      await this.deps.clear(id).catch(() => {});
      removed.push(id);
      this.deps.log(`roles: removed move ${id}, kept past the retention window`);
    }
    return removed;
  }

  private iso(): string {
    return this.deps.now().toISOString();
  }

  private async runSteps(req: MoveRequest): Promise<MoveResult> {
    const dir = moveDir(this.deps.home, req.move_id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const logPath = join(dir, LOG);
    const done = new Set(
      (req.resume?.steps ?? []).filter((s) => s.status === "ok").map((s) => s.id),
    );
    const rec: MoveRecord = {
      move_id: req.move_id,
      role: req.role,
      from: req.from,
      to: req.to,
      status: "running",
      steps: req.steps.map((s) => {
        const was = req.resume?.steps.find((r) => r.id === s.id);
        return {
          id: s.id,
          title: s.title,
          where: s.where,
          status: done.has(s.id) ? "ok" : "pending",
          ...(done.has(s.id) && was?.line !== undefined ? { line: was.line } : {}),
        };
      }),
      since: this.iso(),
      log_path: logPath,
      by: req.by,
      started_at: req.resume?.started_at ?? this.iso(),
      ...(req.kept !== undefined ? { kept: req.kept } : {}),
      ...(req.rolls_back !== undefined ? { rolls_back: req.rolls_back } : {}),
    };
    const log = (event: string, extra: Record<string, unknown> = {}) =>
      appendFileSync(logPath, `${JSON.stringify({ at: this.iso(), event, ...extra })}\n`, {
        mode: 0o600,
      });
    const publish = async () => {
      this.write(rec);
      // A broker that went away (a hand-over rotates volleyd's login) never stops the move.
      await this.deps.publish(payloadOf(rec)).catch((e: unknown) => {
        this.deps.log(`roles: ${rec.move_id} not published: ${errorText(e)}`);
      });
    };
    const setStep = async (i: number, status: StepStatus, line?: string) => {
      const s = rec.steps[i] as StepState;
      s.status = status;
      if (line !== undefined) s.line = line;
      rec.since = this.iso();
      log("step", { step: s.id, status, ...(line !== undefined ? { line } : {}) });
      this.deps.journal({
        type: "role_move_step",
        data: { move_id: rec.move_id, step: s.id, status, ...(line !== undefined ? { line } : {}) },
      });
      await publish();
    };

    log(req.resume !== undefined ? "resumed" : "started", { by: req.by, role: req.role });
    if (req.resume === undefined)
      this.deps.journal({
        type: "role_move_started",
        data: { by: req.by, move_id: rec.move_id, role: rec.role, from: rec.from, to: rec.to },
      });
    await publish();

    const undone: MoveStep[] = [];
    for (const [i, step] of req.steps.entries()) {
      if (done.has(step.id)) continue;
      rec.status = step.health === true ? "health_check" : "running";
      await setStep(i, "running");
      let line: string | undefined;
      try {
        line = await step.run({ move_id: rec.move_id });
      } catch (e) {
        const why = errorText(e);
        await setStep(i, "failed", why);
        return this.fail(req, rec, i, `${step.id}: ${why}`, undone, publish, log);
      }
      undone.push(step);
      rec.status = "running";
      await setStep(i, "ok", line);
      if (step.handover === true) {
        log("handing_over");
        return { ok: true, move_id: rec.move_id, status: "running", handing_over: true };
      }
    }
    rec.status = "done";
    rec.since = this.iso();
    log("done");
    this.deps.journal({
      type: "role_move_completed",
      data: { by: req.by, move_id: rec.move_id, role: rec.role, from: rec.from, to: rec.to },
    });
    await publish();
    return { ok: true, move_id: rec.move_id, status: "done" };
  }

  /** Undo the done steps in reverse, then end the move `failed` naming the step. */
  private async fail(
    req: MoveRequest,
    rec: MoveRecord,
    failed: number,
    error: string,
    undone: MoveStep[],
    publish: () => Promise<void>,
    log: (event: string, extra?: Record<string, unknown>) => void,
  ): Promise<MoveResult> {
    let clean = true;
    for (const step of [...undone].reverse()) {
      const i = req.steps.indexOf(step);
      try {
        await step.undo?.();
        (rec.steps[i] as StepState).status = "skipped";
        log("undone", { step: step.id });
      } catch (e) {
        clean = false;
        (rec.steps[i] as StepState).line = `undo failed: ${errorText(e)}`;
        log("undo_failed", { step: step.id, error: errorText(e) });
      }
    }
    const step = (rec.steps[failed] as StepState).id;
    rec.status = "failed";
    rec.error = error;
    rec.since = this.iso();
    log("failed", { step, error, rolled_back: clean });
    this.deps.journal({
      type: "role_move_failed",
      data: { by: req.by, move_id: rec.move_id, role: rec.role, step, error, rolled_back: clean },
    });
    await publish();
    return { ok: false, move_id: rec.move_id, status: "failed", step, error, rolled_back: clean };
  }

  /** Atomically, mode 0600. */
  private write(rec: MoveRecord): void {
    const file = join(moveDir(this.deps.home, rec.move_id), RECORD);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }
}

/** The record's wire part (role-move.schema.json): no requester, no kept copy. */
export function payloadOf(rec: MoveRecord): MovePayload {
  const { by: _by, started_at: _s, kept: _k, rolls_back: _r, ...payload } = rec;
  return payload;
}

/** What keeps a move from running now, and how to fix it. */
export interface Blocker {
  why: string;
  fix?: string;
}

/** A command only a terminal on a machine can run (as `setup_plan`'s `terminal`). */
export interface TerminalOnly {
  where: string;
  reason: string;
  command: string;
}

/** A planner's answer: the steps to run, and what `role_plan` shows of them. */
export interface RolePlan {
  role: MachineRole;
  from: string;
  to: string;
  steps: MoveStep[];
  blocked: Blocker[];
  /**
   * What is not quiet (SPEC §4.6.24: a wave running, an agent live): shown with `blocked`, but a
   * `role_move { drain: true }` waits for it instead, so `plan_id` does not digest it.
   */
  waits?: Blocker[];
  warnings: string[];
  terminal: TerminalOnly[];
  /** What changes for the owner once the move is done. */
  after: string[];
  /** What a rollback of the move restores (kept in its record). */
  kept?: Record<string, unknown>;
}

/** `role_plan`'s `result` for a plan: its steps without their runners, and its id. */
export function planWire(p: RolePlan) {
  return {
    role: p.role,
    from: p.from,
    to: p.to,
    plan_id: planId(
      p.role,
      p.to,
      p.steps,
      p.blocked.map((b) => b.why),
    ),
    steps: p.steps.map(({ id, title, where }) => ({ id, title, where })),
    blocked: [...(p.waits ?? []), ...p.blocked],
    warnings: p.warnings,
    terminal: p.terminal,
    after: p.after,
  };
}
