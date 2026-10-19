import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUTS, type LayoutName } from "../auth/config";
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

/**
 * `$VOLLEYD_HOME/setup.json`: the install the terminal's `volley setup` last finished against
 * (its layout and the config, state file and auth dir it used, flags included, and the Desk it
 * serves). volleyd plans the Desk's setup with it instead of the layout it would detect, a later
 * `volley setup` without those flags defaults to it, and `volley auth token` links to its Desk.
 * Paths only, never a secret.
 */
export interface SetupInstall {
  layout: LayoutName;
  config: string;
  state_file: string;
  auth_dir: string;
  /** The Desk setup serves: the address a phone reaches it at, and its port. */
  desk_host?: string;
  desk_port?: number;
}

export const setupInstallFile = (volleydHome: string) => join(volleydHome, "setup.json");

/** Record the install `ctx` runs against. A record, not a gate, like the journal. */
export function writeSetupInstall(ctx: SetupContext): void {
  const file = setupInstallFile(ctx.volleydHome);
  const install: SetupInstall = {
    layout: ctx.auth.layout.name,
    config: ctx.config,
    state_file: ctx.stateFile,
    auth_dir: ctx.auth.dir,
    desk_host: ctx.deskHost,
    desk_port: ctx.deskPort,
  };
  try {
    const invoker = ctx.auth.deps.invokingUser(ctx.auth.env);
    const owner = typeof invoker === "object" ? invoker : null;
    ensureOwnedDir(ctx.auth.deps, ctx.volleydHome, owner);
    writeFileSync(file, `${JSON.stringify(install, null, 2)}\n`, { mode: 0o600 });
    if (owner !== null) ctx.auth.deps.chown(file, owner.uid, owner.gid);
  } catch {
    // A record, not a gate.
  }
}

/** The recorded install, or null when there is none (or it is not one this Volley knows). */
export function readSetupInstall(volleydHome: string): SetupInstall | null {
  const file = setupInstallFile(volleydHome);
  if (!existsSync(file)) return null;
  try {
    const v = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    const str = (k: string) => (typeof v[k] === "string" && v[k] !== "" ? (v[k] as string) : null);
    const [layout, config, stateFile, authDir] = [
      str("layout"),
      str("config"),
      str("state_file"),
      str("auth_dir"),
    ];
    if (layout === null || !Object.hasOwn(LAYOUTS, layout)) return null;
    if (config === null || stateFile === null || authDir === null) return null;
    const port = v.desk_port;
    return {
      layout: layout as LayoutName,
      config,
      state_file: stateFile,
      auth_dir: authDir,
      ...(str("desk_host") !== null ? { desk_host: str("desk_host") as string } : {}),
      ...(typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65_536
        ? { desk_port: port }
        : {}),
    };
  } catch {
    return null;
  }
}
