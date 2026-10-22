/**
 * Where the Desk's control requests go. A Needs-you answer (`inbox_answer`, or a decision's
 * `resolve`) travels the Desk's own account-op topic, `volley/_system/auth/ops/<username>`: the
 * broker grants it to a Desk login only for its own username, so volleyd knows the sender is
 * a Desk login and treats its answer as the owner's (SPEC §4.6.18). volleyd's mailbox names no
 * sender, so an answer sent there must come from the wave's owner. Every other op (claim, steer,
 * the account moves) still goes to the mailbox.
 */

import type { AuthOps } from "../store/control";
import type { SteerTransport } from "./transport";

type Control = SteerTransport["control"];

/**
 * Why an unanswered Needs-you answer may have gone nowhere: a broker whose `desk` role predates
 * the account-op grant drops the publish without a word. Only a login that holds the grant once
 * migrated (steer, admin, or the fixed desk with no stored role) is told to migrate.
 */
const MIGRATE_HINT =
  "; if this broker's roles predate Desk answers, run `volley auth migrate --roles --yes`";

/** Roles the account-op grant comes with; `null` is a session whose role the Desk never learnt. */
const DESK_ANSWER_ROLES: readonly (string | null)[] = ["steer", "admin", null];

/**
 * The ops a Desk login answers as the owner, on its own account-op topic. Keep it equal to
 * volleyd's `DESK_OPS` (packages/volleyd/src/accounts.ts): an op only one list names is sent
 * to the mailbox and refused there, or to the ops topic and answered `unknown op` (scripts/desk-ops-sync.test.ts checks it).
 */
export const DESK_LOGIN_OPS: readonly string[] = ["inbox_answer", "resolve", "hold", "release"];

/**
 * The Desk's `control()`: the Needs-you ops through `authOps`, the rest through the mailbox.
 * Without the admin channel (read-only, demo) every op goes to the mailbox, as before; without
 * the mailbox there is no control at all. `role` is the session's (`readSessionRole`): it decides
 * only whether an unanswered request carries the migration hint.
 */
export function routeDeskControl(
  mailbox: Control | null,
  authOps: AuthOps | null,
  role: string | null = null,
): Control | null {
  if (authOps === null || mailbox === null) return mailbox;
  const hint = DESK_ANSWER_ROLES.includes(role) ? MIGRATE_HINT : "";
  return async (op, fields, text, timeoutMs) => {
    if (!DESK_LOGIN_OPS.includes(op)) return mailbox(op, fields, text, timeoutMs);
    const a = await authOps.request(op, fields, timeoutMs !== undefined ? { timeoutMs } : {});
    return {
      ok: a.ok,
      ...(a.error !== undefined ? { error: a.unanswered ? a.error + hint : a.error } : {}),
      ...(a.result !== undefined ? { result: a.result } : {}),
      ...(a.unsent ? { unsent: true as const } : {}),
    };
  };
}
