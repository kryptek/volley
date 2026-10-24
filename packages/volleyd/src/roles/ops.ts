import { randomBytes } from "node:crypto";
import { replyKey, seal } from "../accounts";
import { DAEMON_DEFAULTS } from "../config-defaults";
import { isSshDestination } from "../peers";
import type { RoleDeps } from "./deps";
import {
  type MoveRecord,
  type MoveResult,
  type RoleMoves,
  type RolePlan,
  planWire,
} from "./engine";
import { type BrokerDeps, type BrokerKept, brokerRollbackSteps, planBroker } from "./plan-broker";
import { type DeskIssued, deskSteps, planDesk } from "./plan-desk";
import { type SupervisorDeps, planSupervisor } from "./plan-supervisor";
import { MACHINE_ROLES, type MachineRole } from "./record";

/**
 * The machine-role ops (SPEC §4.6.24), answered on the account-op topic after the admin check
 * (daemon.ts routes them): `role_plan` plans fresh and changes nothing; `role_move` plans again,
 * runs the move only when the fresh plan's `plan_id` is the one sent (else `plan changed …`), and
 * answers once the move is done or failed — a Desk move's sign-in link for the new address sealed
 * to the requester's `reply_key`; `role_rollback` undoes a done move within the retention window
 * as a new move the other way.
 *
 * A supervisor move answers as soon as it starts (`handing_over: true`, the `restarting: true`
 * pattern of `setup_apply`): its receive rotates this supervisor's login, so no answer could
 * follow. A broker move (and its rollback) answers the same way, and starts a moment after the
 * answer: its first step stops the broker every connection, the answer's included, runs through. Its progress is the moves topic, which the new supervisor goes on publishing. While
 * the fleet is not quiet it is refused, or with `drain: true` it waits (`planning`, nothing new
 * admitted: `draining`) and starts at the first tick that finds the fleet quiet.
 */

export const ROLE_OPS: ReadonlySet<string> = new Set(["role_plan", "role_move", "role_rollback"]);

type Fields = Record<string, unknown>;

export interface RoleReply {
  ok: boolean;
  error?: string;
  result?: unknown;
  sealed?: string;
}

export interface RoleOpsDeps {
  /** The planners' deps now, or why there are none (no roles record yet). */
  deps: () => RoleDeps | string;
  /** What only a supervisor move needs. */
  supervisor: () => SupervisorDeps;
  /** What only a broker move needs. */
  broker: () => BrokerDeps;
  moves: RoleMoves;
  /**
   * A move run in the background (a supervisor move) ended here: handed over, done or failed.
   * The daemon unloads itself after a hand-over.
   */
  finished: (moveId: string, r: MoveResult) => Promise<void>;
  log: (line: string) => void;
  /** The daemon's clock (a broker move's answer goes out before it starts). */
  sleep: (ms: number) => Promise<void>;
}

/** A `role_move { drain: true }` waiting for a quiet fleet. */
interface Waiting {
  move_id: string;
  p: Fields;
  by: string;
}

const refuse = (error: string): RoleReply => ({ ok: false, error });
const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/**
 * What one sealed block holds: RSA-OAEP with SHA-256 under a 2048-bit key takes at most
 * k - 2·hLen - 2 bytes (256 - 64 - 2).
 */
const SEAL_MAX = 2048 / 8 - 2 * 32 - 2;

/** A move's id: the role, when, and a little randomness (role-move.schema.json `move_id`). */
export function newMoveId(role: string, now: Date): string {
  const at = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `${role}-${at}-${randomBytes(2).toString("hex")}`;
}

export class RoleOps {
  private waiting: Waiting | null = null;
  private ticking = false;
  /** A broker move answered and about to start (`role_broker_reply_ms`). */
  private starting: string | null = null;

  constructor(private readonly o: RoleOpsDeps) {}

  /** A move waits for a quiet fleet: nothing new is admitted meanwhile. */
  draining(): boolean {
    return this.waiting !== null;
  }

  /**
   * Start the waiting move once the fleet is quiet (the daemon's tick); one tick at a time. A
   * fresh plan that is blocked, or is not the plan approved (`plan_id`), ends the move `failed`.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickOnce();
    } catch (e) {
      this.o.log(`roles: the waiting move: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async tickOnce(): Promise<void> {
    const w = this.waiting;
    if (w === null || this.o.moves.refusal() !== null) return;
    const d = this.o.deps();
    if (typeof d === "string") return;
    const req = this.request(w.p);
    if (typeof req === "string") return;
    const plan = await this.plan(d, req, w.by, { url: "" });
    if (typeof plan === "string" || (plan.waits ?? []).length > 0) return;
    this.waiting = null;
    const why =
      plan.blocked.length > 0
        ? `the move is blocked: ${plan.blocked.map((b) => b.why).join("; ")}`
        : planWire(plan).plan_id !== w.p.plan_id
          ? `plan changed while the fleet drained: moving the ${plan.role} to ${plan.to} would now run other steps than the plan approved; plan again`
          : null;
    if (why !== null) {
      this.o.log(`roles: ${w.move_id} not started: ${why}`);
      await this.o.moves.abandon(w.move_id, why);
      return;
    }
    this.background(plan, w.move_id, w.by);
  }

  /** `role_plan`, `role_move` or `role_rollback` from `by` (already admin-checked). */
  async handle(op: string, p: Fields, by: string): Promise<RoleReply> {
    if (op === "role_rollback") return this.rollback(p, by);
    const req = this.request(p);
    if (typeof req === "string") return refuse(req);
    const d = this.o.deps();
    if (typeof d === "string") return refuse(d);
    const issued: DeskIssued = { url: "" };
    const plan = await this.plan(d, req, by, issued);
    if (typeof plan === "string") return refuse(plan);
    const wire = planWire(plan);
    if (op === "role_plan") return { ok: true, result: wire };
    return this.move(d, p, plan, wire.plan_id, by, issued);
  }

  /** The fields every role op checks, before anything is planned. */
  private request(p: Fields): Request | string {
    if (!(MACHINE_ROLES as readonly unknown[]).includes(p.role))
      return `role must be one of ${MACHINE_ROLES.join(", ")}`;
    if (typeof p.to !== "string" || !NAME.test(p.to))
      return "to must be a machine name ([a-z0-9][a-z0-9_-]{0,62})";
    if (
      p.port !== undefined &&
      (typeof p.port !== "number" || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535)
    )
      return "port must be a whole number in 1..65535";
    if (p.terminal !== undefined && p.terminal !== "cmux" && p.terminal !== "tmux")
      return 'terminal must be "cmux" or "tmux"';
    if (p.drain !== undefined && typeof p.drain !== "boolean") return "drain must be true or false";
    if (p.address !== undefined && !isSshDestination(p.address))
      return "address must be an ssh destination ([user@]host, never starting with -)";
    if (p.lan !== undefined && typeof p.lan !== "boolean") return "lan must be true or false";
    return {
      role: p.role as MachineRole,
      to: p.to,
      ...(typeof p.port === "number" ? { port: p.port } : {}),
      ...(p.terminal === "cmux" || p.terminal === "tmux" ? { terminal: p.terminal } : {}),
      ...(typeof p.address === "string" ? { address: p.address } : {}),
      ...(typeof p.lan === "boolean" ? { lan: p.lan } : {}),
    };
  }

  private async plan(
    d: RoleDeps,
    req: Request,
    by: string,
    issued: DeskIssued,
  ): Promise<RolePlan | string> {
    if (req.role === "desk")
      return planDesk(
        d,
        { to: req.to, ...(req.port !== undefined ? { port: req.port } : {}), by },
        issued,
      );
    if (req.role === "supervisor")
      return planSupervisor(d, this.o.supervisor(), {
        to: req.to,
        ...(req.terminal !== undefined ? { terminal: req.terminal } : {}),
        by,
      });
    return planBroker(d, this.o.broker(), {
      to: req.to,
      ...(req.address !== undefined ? { address: req.address } : {}),
      ...(req.lan !== undefined ? { lan: req.lan } : {}),
      by,
    });
  }

  /**
   * Run a supervisor move in the background: its answer went out already. Once it hands over,
   * this supervisor unloads itself.
   */
  private background(plan: RolePlan, moveId: string, by: string, rollsBack?: string): void {
    // A broker move stops the broker its answer travels through: the answer goes out first.
    const first =
      plan.role === "broker"
        ? (() => {
            this.starting = moveId;
            return this.o.sleep(DAEMON_DEFAULTS.role_broker_reply_ms).finally(() => {
              this.starting = null;
            });
          })()
        : Promise.resolve();
    void first
      .then(() =>
        this.o.moves.run({
          move_id: moveId,
          role: plan.role,
          from: plan.from,
          to: plan.to,
          by,
          steps: plan.steps,
          ...(plan.kept !== undefined ? { kept: plan.kept } : {}),
          ...(rollsBack !== undefined ? { rolls_back: rollsBack } : {}),
        }),
      )
      .then((r) => this.o.finished(moveId, r))
      .catch((e: unknown) =>
        this.o.log(`roles: ${moveId}: ${e instanceof Error ? e.message : String(e)}`),
      );
  }

  private async move(
    d: RoleDeps,
    p: Fields,
    plan: RolePlan,
    planId: string,
    by: string,
    issued: DeskIssued,
  ): Promise<RoleReply> {
    if (typeof p.plan_id !== "string" || p.plan_id === "")
      return refuse("plan_id is required: the plan_id from the role_plan answer shown");
    const key = replyKey(p.reply_key);
    if (typeof key === "string") return refuse(key);
    if (planId !== p.plan_id)
      return refuse(
        `plan changed: moving the ${plan.role} to ${plan.to} would now run other steps than the plan shown; plan again`,
      );
    if (plan.blocked.length > 0)
      return refuse(`the move is blocked: ${plan.blocked.map((b) => b.why).join("; ")}`);
    const busy = this.busy();
    if (busy !== null) return refuse(busy);
    const moveId = newMoveId(plan.role, d.now());
    const waits = plan.waits ?? [];
    if (waits.length > 0) {
      if (p.drain !== true)
        return refuse(
          `the fleet is not quiet: ${waits.map((w) => w.why).join("; ")} (stop them, or move when idle with drain: true)`,
        );
      this.waiting = { move_id: moveId, p, by };
      await this.o.moves.announce({
        move_id: moveId,
        role: plan.role,
        from: plan.from,
        to: plan.to,
        by,
        steps: plan.steps,
      });
      return { ok: true, result: { move_id: moveId, status: "planning" } };
    }
    if (plan.role === "supervisor" || plan.role === "broker") {
      this.background(plan, moveId, by);
      return { ok: true, result: { move_id: moveId, status: "running", handing_over: true } };
    }
    const r = await this.o.moves.run({
      move_id: moveId,
      role: plan.role,
      from: plan.from,
      to: plan.to,
      by,
      steps: plan.steps,
      ...(plan.kept !== undefined ? { kept: plan.kept } : {}),
    });
    return answer(r, issued, key);
  }

  /** Why no move can start now: one in progress, or one waiting for a quiet fleet. */
  private busy(): string | null {
    return (
      this.o.moves.refusal() ??
      (this.starting !== null ? `a role move is in progress: ${this.starting}` : null) ??
      (this.waiting !== null
        ? `a role move is waiting for a quiet fleet: ${this.waiting.move_id}`
        : null)
    );
  }

  /** `role_rollback { move_id }`: a done move, within retention, undone as a new move. */
  private async rollback(p: Fields, by: string): Promise<RoleReply> {
    const id = p.move_id;
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id))
      return refuse("move_id must be a move's id");
    const rec = this.o.moves.read(id);
    if (rec === null) return refuse(`no kept move "${id}" (gone after ${retentionDays()} days)`);
    if (rec.status !== "done")
      return refuse(`move ${id} is ${rec.status}: only a done move is rolled back`);
    const d = this.o.deps();
    if (typeof d === "string") return refuse(d);
    if (d.now().getTime() - Date.parse(rec.since) > DAEMON_DEFAULTS.role_move_retention_ms)
      return refuse(`move ${id} is older than ${retentionDays()} days: its kept copy is gone`);
    if (rec.rolls_back !== undefined)
      return refuse(
        `move ${id} is itself a rollback (of ${rec.rolls_back}): move the ${rec.role} again instead`,
      );
    const busy = this.busy();
    if (busy !== null) return refuse(busy);
    if (rec.role === "supervisor") return this.rollbackSupervisor(d, rec, by);
    if (rec.role === "broker") return this.rollbackBroker(d, rec, by);
    if (rec.role !== "desk")
      return refuse(`rolling back a ${rec.role} move is not supported by this supervisor yet`);
    if (rec.kept === undefined) return refuse(`move ${id} kept nothing to roll back to`);
    const kept = rec.kept as { desk?: { url: string }; port?: number; from_port?: number };
    const issued: DeskIssued = { url: kept.desk?.url ?? "" };
    if (d.roles.desk.machine !== rec.to)
      return refuse(`the Desk runs on ${d.roles.desk.machine} now, not ${rec.to}: not rolled back`);
    const steps = deskSteps(
      d,
      {
        from: rec.to,
        to: rec.from,
        port: kept.from_port ?? 0,
        fromPort: kept.port ?? 0,
        by,
        signin: false,
      },
      issued,
    );
    // The old machine's Desk was stopped, not removed: put back as it was, not installed again.
    const back = steps.map((s) =>
      s.id === "install" && rec.from === d.localName ? reloadStep(d, s) : s,
    );
    const moveId = newMoveId("desk", d.now());
    const r = await this.o.moves.run({
      move_id: moveId,
      role: "desk",
      from: rec.to,
      to: rec.from,
      by,
      steps: back,
      rolls_back: id,
    });
    // The engine marks the original `rolled_back` once this move is done.
    if (!r.ok) return { ok: false, error: r.error, result: { move_id: moveId, rolls_back: id } };
    return { ok: true, result: { move_id: moveId, rolls_back: id } };
  }

  /**
   * A supervisor move rolled back: the supervisor moves back to the machine it came from (a
   * paired machine since the hand-over), as a supervisor move does, under a new id: a fresh
   * bundle of this home (what changed since the move travels back), not the move's kept bundle.
   * The original is marked `rolled_back` here at the hand-over, and journaled by the supervisor
   * there once the rollback is done; a rollback that fails leaves it `done`.
   */
  private async rollbackSupervisor(
    d: RoleDeps,
    rec: { move_id: string; from: string; to: string },
    by: string,
  ): Promise<RoleReply> {
    if (d.roles.supervisor.machine !== rec.to || d.localName !== rec.to)
      return refuse(
        `the supervisor runs on ${d.roles.supervisor.machine} now, not ${rec.to}: not rolled back`,
      );
    const plan = await planSupervisor(d, this.o.supervisor(), { to: rec.from, by });
    if (typeof plan === "string") return refuse(plan);
    const not = [...(plan.waits ?? []), ...plan.blocked];
    if (not.length > 0)
      return refuse(`the rollback is blocked: ${not.map((b) => b.why).join("; ")}`);
    const moveId = newMoveId("supervisor", d.now());
    this.background(plan, moveId, by, rec.move_id);
    return { ok: true, result: { move_id: moveId, rolls_back: rec.move_id, handing_over: true } };
  }

  /**
   * A broker move rolled back: the broker goes back to the supervisor's machine from the move's
   * record (its `kept`: the old layout, every paired machine's tunnel before the move), answered as
   * it starts like the move itself.
   */
  private rollbackBroker(d: RoleDeps, rec: MoveRecord, by: string): RoleReply {
    const kept = rec.kept as unknown as BrokerKept | undefined;
    if (kept === undefined || kept.peers === undefined)
      return refuse(`move ${rec.move_id} kept nothing to roll back to`);
    if (d.roles.broker.machine !== rec.to)
      return refuse(
        `the broker runs on ${d.roles.broker.machine} now, not ${rec.to}: not rolled back`,
      );
    if (rec.from !== d.localName)
      return refuse(
        `the broker came from ${rec.from}, not this supervisor's machine (${d.localName}): not rolled back`,
      );
    const moveId = newMoveId("broker", d.now());
    const plan: RolePlan = {
      role: "broker",
      from: rec.to,
      to: rec.from,
      steps: brokerRollbackSteps(d, this.o.broker(), rec, kept, by),
      blocked: [],
      warnings: [],
      terminal: [],
      after: [],
    };
    this.background(plan, moveId, by, rec.move_id);
    return { ok: true, result: { move_id: moveId, rolls_back: rec.move_id, handing_over: true } };
  }
}

type Request = {
  role: MachineRole;
  to: string;
  port?: number;
  terminal?: "cmux" | "tmux";
  address?: string;
  lan?: boolean;
};

const retentionDays = () => Math.round(DAEMON_DEFAULTS.role_move_retention_ms / 86_400_000);

/** A rollback's first step on the supervisor's machine: reload the Desk's kept service. */
function reloadStep(d: RoleDeps, install: RolePlan["steps"][number]) {
  const start =
    d.platform === "darwin"
      ? [
          "launchctl",
          "bootstrap",
          `gui/${d.uid}`,
          `${d.home}/Library/LaunchAgents/systems.volley.desk.plist`,
        ]
      : ["systemctl", "--user", "start", "volley-desk.service"];
  const stop =
    d.platform === "darwin"
      ? ["launchctl", "bootout", `gui/${d.uid}/systems.volley.desk`]
      : ["systemctl", "--user", "stop", "volley-desk.service"];
  return {
    ...install,
    id: "restore",
    title: `Start the kept Desk on ${d.localName}`,
    detail: start.join(" "),
    run: async () => {
      const r = await d.exec(start);
      if (r.code !== 0) throw new Error(`${start.slice(0, 2).join(" ")}: exit ${r.code}`);
      return "started";
    },
    undo: async () => {
      await d.exec(stop);
    },
  };
}

/** A finished move's answer: its id and outcome; a Desk move's link sealed to the requester. */
function answer(r: MoveResult, issued: DeskIssued, key: Parameters<typeof seal>[0]): RoleReply {
  if (!r.ok)
    return {
      ok: false,
      error: r.error,
      result: { move_id: r.move_id, status: r.status, step: r.step, rolled_back: r.rolled_back },
    };
  const result = {
    move_id: r.move_id,
    status: r.status,
    ...("handing_over" in r ? { handing_over: true } : {}),
  };
  if (issued.token === undefined) return { ok: true, result };
  const link = `${issued.url}/#signin=${issued.token}`;
  // A long address does not fit one sealed block with the token: the client joins them then.
  return Buffer.byteLength(JSON.stringify({ link })) <= SEAL_MAX
    ? { ok: true, result, sealed: seal(key, { link }) }
    : {
        ok: true,
        result: { ...result, link_base: `${issued.url}/` },
        sealed: seal(key, { token: issued.token }),
      };
}
