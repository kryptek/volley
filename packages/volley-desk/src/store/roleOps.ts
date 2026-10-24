/**
 * The Desk's machine-role ops (SPEC §4.6.24): `role_plan`, `role_move` and `role_rollback`, admin
 * ops on the account-op channel (`createAuthOps` in `control.ts`), as `peerOps.ts`'s are.
 *
 * `role_plan` changes nothing and answers at once. `role_move` plans again and runs only the plan
 * shown (its `plan_id`); a Desk or broker move is answered when it ends, which can take minutes,
 * so it waits long and takes an answer that comes later still through `onLate` (a broker move
 * drops this page's connection for a moment). A supervisor move is answered as soon as it
 * starts (`handing_over`): its progress is the moves topic, which the store folds into
 * `roleMoves`. A Desk move's answer carries the sign-in link for the new address, sealed to this
 * session's reply key as `{ link }` (or, for a long address, `{ token }` with `link_base`).
 */
import { type AuthAnswer, type AuthOps, isPlanChanged, signinLink } from "./control";
import type { MachineRole } from "./types";

export type { MachineRole } from "./types";

/** `role_plan` asks the target over ssh (a few probes, in parallel): a minute is ample. */
export const ROLE_PLAN_TIMEOUT_MS = 60_000;
/**
 * How long `role_move` waits, per role: a Desk move installs and health-checks the Desk there, a
 * broker move restarts every machine's tunnel, a supervisor move answers as it starts. Each step's
 * own limit in volleyd is 10 minutes.
 */
export const ROLE_MOVE_TIMEOUT_MS: Record<MachineRole, number> = {
  desk: 15 * 60_000,
  broker: 20 * 60_000,
  supervisor: 60_000,
};
/** A rollback is a move back, of whichever role: the longest wait. */
export const ROLE_ROLLBACK_TIMEOUT_MS = 20 * 60_000;

/** `role_plan`'s fields: the role-specific ones only for their role. */
export interface RolePlanRequest {
  role: MachineRole;
  to: string;
  /** broker: the ssh destination every tunnel reaches the broker at there. */
  address?: string;
  /** broker: whether its WebSocket listener is open to the LAN there. */
  lan?: boolean;
  /** supervisor: the terminal the old machine re-pairs with. */
  terminal?: "cmux" | "tmux";
  /** desk: its port there. */
  port?: number;
}

export interface RoleMoveRequest extends RolePlanRequest {
  /** The `plan_id` of the plan shown: volleyd refuses (`plan changed`) when it moved on. */
  planId: string;
  /** Wait for a quiet fleet instead of refusing (D2: move when the fleet is idle). */
  drain?: boolean;
}

/** What keeps a move from running now, and how to fix it. */
export interface RoleBlocker {
  why: string;
  fix?: string;
}

/** `role_plan`'s answer. */
export interface RolePlan {
  role: MachineRole;
  from: string;
  to: string;
  planId: string;
  steps: { id: string; title: string; where: string }[];
  blocked: RoleBlocker[];
  warnings: string[];
  /** The commands only a terminal on a machine can run. */
  terminal: { where: string; reason: string; command: string }[];
  /** What changes for the owner once the move is done. */
  after: string[];
}

export type RolePlanAnswer = { ok: true; plan: RolePlan } | { ok: false; error: string };

export type RoleMoveAnswer =
  | {
      ok: true;
      moveId: string;
      /** `planning`: waiting for a quiet fleet; `running`: a supervisor handing over. */
      status: "planning" | "running" | "done";
      handingOver?: true;
      /** A Desk move's sign-in link for the new address. */
      link?: string;
    }
  | {
      ok: false;
      error: string;
      /** A move that started and failed has an id, its failed step, and whether it was undone. */
      moveId?: string;
      step?: string;
      rolledBack?: boolean;
      /** volleyd planned again and the plan is not the one shown. */
      planChanged?: true;
      /** No answer in time: the move may still be running (its record says). */
      unanswered?: true;
    };

export type RoleRollbackAnswer =
  | { ok: true; moveId: string; rollsBack: string; handingOver?: true }
  | { ok: false; error: string };

export interface RoleOps {
  plan(req: RolePlanRequest): Promise<RolePlanAnswer>;
  /** `onLate` takes an answer that arrives after the wait (a long move, a broker restart). */
  move(
    req: RoleMoveRequest,
    opts?: { onLate?: (answer: RoleMoveAnswer) => void },
  ): Promise<RoleMoveAnswer>;
  /** Undo a completed move within the 7 days: the role goes back under a new move id. */
  rollback(moveId: string): Promise<RoleRollbackAnswer>;
}

/**
 * A blocker that is only the fleet not being quiet (a wave running, an agent live): volleyd
 * shows it with the others, and its fix names `drain: true`, which waits for it instead.
 */
export const isQuietWait = (b: RoleBlocker) => /\bdrain: true\b/.test(b.fix ?? "");

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const str = (v: unknown): v is string => typeof v === "string";
const asList = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** The plan request's fields on the wire: only those given. */
function planFields(req: RolePlanRequest): Record<string, unknown> {
  return {
    role: req.role,
    to: req.to,
    ...(req.address !== undefined ? { address: req.address } : {}),
    ...(req.lan !== undefined ? { lan: req.lan } : {}),
    ...(req.terminal !== undefined ? { terminal: req.terminal } : {}),
    ...(req.port !== undefined ? { port: req.port } : {}),
  };
}

export function parseRolePlan(result: unknown, req: RolePlanRequest): RolePlan | null {
  const r = (result ?? {}) as Record<string, unknown>;
  if (!str(r.plan_id)) return null;
  return {
    role: (r.role as MachineRole | undefined) ?? req.role,
    from: str(r.from) ? r.from : "",
    to: str(r.to) ? r.to : req.to,
    planId: r.plan_id,
    steps: asList(r.steps),
    blocked: asList(r.blocked),
    warnings: asList<unknown>(r.warnings).filter(str),
    terminal: asList(r.terminal),
    after: asList<unknown>(r.after).filter(str),
  };
}

/** volleyd's `role_move` answer as a `RoleMoveAnswer`. */
export function parseRoleMove(a: AuthAnswer): RoleMoveAnswer {
  const r = (a.result ?? {}) as Record<string, unknown>;
  if (!a.ok) {
    return {
      ok: false,
      error: a.error ?? "volleyd refused the move",
      ...(str(r.move_id) ? { moveId: r.move_id } : {}),
      ...(str(r.step) ? { step: r.step } : {}),
      ...(typeof r.rolled_back === "boolean" ? { rolledBack: r.rolled_back } : {}),
      ...(isPlanChanged(a) ? { planChanged: true as const } : {}),
      ...(a.unanswered ? { unanswered: true as const } : {}),
    };
  }
  if (!str(r.move_id)) return { ok: false, error: "volleyd's answer carried no move id" };
  const sealed = a.secret ?? {};
  const link = str(sealed.link)
    ? sealed.link
    : str(sealed.token) && str(r.link_base)
      ? signinLink(r.link_base, sealed.token)
      : undefined;
  return {
    ok: true,
    moveId: r.move_id,
    status: r.status === "planning" || r.status === "running" ? r.status : "done",
    ...(r.handing_over === true ? { handingOver: true as const } : {}),
    ...(link !== undefined ? { link } : {}),
  };
}

export function createRoleOps(
  auth: AuthOps,
  opts: { planTimeoutMs?: number; moveTimeoutMs?: Partial<Record<MachineRole, number>> } = {},
): RoleOps {
  /** `auth.request`, which never rejects here: a throw is an unsent request. */
  const ask = (
    op: string,
    fields: Record<string, unknown>,
    timeoutMs: number,
    onLate?: (a: AuthAnswer) => void,
  ) =>
    auth
      .request(op, fields, { timeoutMs, ...(onLate ? { onLate } : {}) })
      .catch((err: unknown): AuthAnswer => ({ ok: false, error: message(err), unsent: true }));

  return {
    async plan(req) {
      const a = await ask("role_plan", planFields(req), opts.planTimeoutMs ?? ROLE_PLAN_TIMEOUT_MS);
      if (!a.ok) return { ok: false, error: a.error ?? `volleyd refused planning the ${req.role}` };
      const plan = parseRolePlan(a.result, req);
      return plan ? { ok: true, plan } : { ok: false, error: "volleyd's answer carried no plan" };
    },
    async move(req, { onLate } = {}) {
      const fields = {
        ...planFields(req),
        plan_id: req.planId,
        ...(req.drain ? { drain: true } : {}),
      };
      const wait = opts.moveTimeoutMs?.[req.role] ?? ROLE_MOVE_TIMEOUT_MS[req.role];
      const a = await ask(
        "role_move",
        fields,
        wait,
        onLate ? (late) => onLate(parseRoleMove(late)) : undefined,
      );
      return parseRoleMove(a);
    },
    async rollback(moveId) {
      const a = await ask("role_rollback", { move_id: moveId }, ROLE_ROLLBACK_TIMEOUT_MS);
      if (!a.ok) return { ok: false, error: a.error ?? `volleyd refused undoing ${moveId}` };
      const r = (a.result ?? {}) as Record<string, unknown>;
      if (!str(r.move_id)) return { ok: false, error: "volleyd's answer carried no move id" };
      return {
        ok: true,
        moveId: r.move_id,
        rollsBack: str(r.rolls_back) ? r.rolls_back : moveId,
        ...(r.handing_over === true ? { handingOver: true as const } : {}),
      };
    },
  };
}
