import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureOwnedDir } from "../auth/context";
import type { SetupContext, StepName } from "./step";

/**
 * `$VOLLEYD_HOME/setup.log`: one JSON line per step event of `volley setup`, whoever ran it (the
 * terminal, or volleyd for the Desk, whose lines carry `by`). Summaries only, never a secret.
 */

export interface SetupLogEntry {
  step: StepName;
  /** planned · applied · failed · verified · done · blocked · skipped · declined */
  event: string;
  summary?: string;
  /** Who ran the step when it was not the terminal: `desk:<admin username>`. */
  by?: string;
}

export const setupLogFile = (volleydHome: string) => join(volleydHome, "setup.log");

/** Append one entry. A record, not a gate: an unwritable home never stops the setup. */
export function appendSetupLog(ctx: SetupContext, e: SetupLogEntry): void {
  const file = setupLogFile(ctx.volleydHome);
  try {
    const invoker = ctx.auth.deps.invokingUser(ctx.auth.env);
    const owner = typeof invoker === "object" ? invoker : null;
    ensureOwnedDir(ctx.auth.deps, ctx.volleydHome, owner);
    appendFileSync(
      file,
      `${JSON.stringify({
        at: ctx.auth.io.now().toISOString(),
        step: e.step,
        event: e.event,
        ...(e.summary !== undefined ? { summary: e.summary } : {}),
        ...(e.by !== undefined ? { by: e.by } : {}),
      })}\n`,
      { mode: 0o600 },
    );
    // Under sudo the journal is the invoking user's, like the rest of $VOLLEYD_HOME.
    if (owner !== null) ctx.auth.deps.chown(file, owner.uid, owner.gid);
  } catch {
    // The journal is a record, not a gate.
  }
}

/** The newest entry's `at` (when setup last ran), or undefined when there is no log. */
export function lastSetup(volleydHome: string): string | undefined {
  const file = setupLogFile(volleydHome);
  if (!existsSync(file)) return undefined;
  let newest: string | undefined;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const at = (JSON.parse(line) as { at?: unknown }).at;
      if (typeof at === "string" && (newest === undefined || at > newest)) newest = at;
    } catch {
      // a torn line: skip it
    }
  }
  return newest;
}
