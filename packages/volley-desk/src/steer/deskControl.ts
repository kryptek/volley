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

/** The ops a Desk login answers as the owner, on its own account-op topic. */
export const DESK_LOGIN_OPS: readonly string[] = ["inbox_answer", "resolve"];

/**
 * The Desk's `control()`: the Needs-you ops through `authOps`, the rest through the mailbox.
 * Without the admin channel (read-only, demo) every op goes to the mailbox, as before; without
 * the mailbox there is no control at all.
 */
export function routeDeskControl(mailbox: Control | null, authOps: AuthOps | null): Control | null {
  if (authOps === null || mailbox === null) return mailbox;
  return async (op, fields, text, timeoutMs) => {
    if (!DESK_LOGIN_OPS.includes(op)) return mailbox(op, fields, text, timeoutMs);
    const a = await authOps.request(op, fields, timeoutMs !== undefined ? { timeoutMs } : {});
    return {
      ok: a.ok,
      ...(a.error !== undefined ? { error: a.error } : {}),
      ...(a.result !== undefined ? { result: a.result } : {}),
      ...(a.unsent ? { unsent: true as const } : {}),
    };
  };
}
