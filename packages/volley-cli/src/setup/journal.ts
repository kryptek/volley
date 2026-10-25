import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUTS, type LayoutName } from "../auth/config";
import { ensureOwnedDir } from "../auth/context";
import { withoutLogin } from "../peer/profile-checks";
import { parseBrokerHost } from "./desk-build";
import { type NetworkKind, isNetworkKind } from "./network";
import type { SetupContext, StepName } from "./step";
import {
  type CmuxSocketMode,
  type LocalTerminal,
  isCmuxSocketMode,
  isLocalTerminal,
} from "./terminal";

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
  /** Whether the WebSocket listener is open to the LAN (`--lan`); `volley auth init` keeps it. */
  lan?: boolean;
  /** cmux's socket control mode, as the cmux check last found it (macOS). */
  cmux_socket_mode?: CmuxSocketMode;
  /** The terminal volleyd starts local agents in, as the Terminal step chose it (config.yaml's `fleet.local_terminal`). */
  terminal?: LocalTerminal;
  /**
   * The coordinator name chosen once (the Claude Code step): `VOLLEY_COORDINATOR` for `volleyd`'s
   * commands when the env sets none, and `volleyd run`'s default `--owner`.
   */
  coordinator?: string;
  /** The namespace the coordinator's MCP server registers in. */
  namespace?: string;
  /** The broker the run used (never with a login): a later run's default. */
  broker_url?: string;
  /** The run's setup-metrics.json. */
  metrics?: string;
  /**
   * The broker's host when it is not the Desk's machine: the Desk's service runs
   * `volley desk serve --broker-host <it>` (set by `volley desk install --broker-host`).
   */
  broker_host?: string;
  /**
   * How this machine is reached from outside its network (the Network step): the kind, and for
   * `tailscale` its MagicDNS name and tailnet IPv4 address, for `manual` the VPN's address.
   */
  network?: NetworkRecord;
  /**
   * The Desk's address on the private network (`https://<name>`, `tailscale serve`): where links
   * and the roles record's `desk.url` point when it is set. `volley desk install --tailscale` and
   * the Services step write it.
   */
  desk_private_url?: string;
}

/** An `https://` URL with a host and nothing after it, or null. */
const privateUrlOf = (v: unknown): string | null =>
  typeof v === "string" && /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(v) ? v : null;

/** setup.json's `desk_private_url`, read on its own like `broker_host`; null when there is none. */
export function readDeskPrivateUrl(volleydHome: string): string | null {
  return privateUrlOf(rawInstall(volleydHome).desk_private_url);
}

/** The Desk's private address for `ctx`: the planner's (null: none), else the record's. */
const deskPrivateUrl = (ctx: SetupContext): string | null =>
  ctx.deskPrivateUrl !== undefined ? ctx.deskPrivateUrl : readDeskPrivateUrl(ctx.volleydHome);

/** setup.json's `network` (SPEC §4.6.14 carries the same object in the machine record). */
export interface NetworkRecord {
  kind: NetworkKind;
  name?: string;
  address?: string;
}

/** A `network` object as setup.json has it, or null when it is not one. */
export function parseNetworkRecord(v: unknown): NetworkRecord | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (!isNetworkKind(r.kind)) return null;
  const str = (k: string) => (typeof r[k] === "string" && r[k] !== "" ? (r[k] as string) : null);
  if (r.kind === "none") return { kind: "none" };
  return {
    kind: r.kind,
    ...(str("name") !== null ? { name: str("name") as string } : {}),
    ...(str("address") !== null ? { address: str("address") as string } : {}),
  };
}

/**
 * setup.json's `network`, read on its own like `broker_host`: a paired machine's setup.json holds
 * little else (`volley setup --peer` writes no install record). Null when there is none.
 */
export function readNetworkRecord(volleydHome: string): NetworkRecord | null {
  try {
    const v = JSON.parse(readFileSync(setupInstallFile(volleydHome), "utf-8")) as {
      network?: unknown;
    };
    return parseNetworkRecord(v.network);
  } catch {
    return null;
  }
}

/** Record `network` in setup.json, keeping every other key (a machine without one gets one). */
export function recordNetwork(ctx: SetupContext, network: NetworkRecord): void {
  saveInstall(ctx, { ...rawInstall(ctx.volleydHome), network });
}

/** setup.json as an object, whatever it holds; empty when there is none or it is unreadable. */
function rawInstall(volleydHome: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(setupInstallFile(volleydHome), "utf-8")) as unknown;
    if (typeof v === "object" && v !== null && !Array.isArray(v))
      return v as Record<string, unknown>;
  } catch {
    // none yet, or unreadable
  }
  return {};
}

/** The namespace the coordinator's MCP server registers in. */
export const SETUP_NAMESPACE = "default";

/** The agent-id grammar a coordinator name follows (SPEC §2.2). */
export const COORDINATOR_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const setupInstallFile = (volleydHome: string) => join(volleydHome, "setup.json");

/** Record the install `ctx` runs against. A record, not a gate, like the journal. */
export function writeSetupInstall(ctx: SetupContext, metrics?: string): void {
  // A run that skipped the security step (`--step services`) keeps the LAN choice on record.
  const prior = readSetupInstall(ctx.volleydHome);
  const lan = ctx.lan ?? prior?.lan;
  // A run whose Services step did not check cmux keeps the mode on record too.
  const cmux = ctx.cmuxSocketMode ?? prior?.cmux_socket_mode;
  // And a run that skipped the Terminal step keeps its choice; and the coordinator's name.
  const terminal = ctx.terminal ?? prior?.terminal;
  const coordinator = ctx.coordinator ?? prior?.coordinator;
  // The Network step's record, read on its own: it may be all a fresh run's setup.json holds yet.
  const network = ctx.networkRecord ?? readNetworkRecord(ctx.volleydHome);
  const brokerHost = deskBrokerHost(ctx);
  const privateUrl = deskPrivateUrl(ctx);
  const install: SetupInstall = {
    layout: ctx.auth.layout.name,
    config: ctx.config,
    state_file: ctx.stateFile,
    auth_dir: ctx.auth.dir,
    desk_host: ctx.deskHost,
    desk_port: ctx.deskPort,
    ...(lan !== undefined ? { lan } : {}),
    ...(cmux !== undefined ? { cmux_socket_mode: cmux } : {}),
    ...(terminal !== undefined ? { terminal } : {}),
    ...(coordinator !== undefined
      ? { coordinator, namespace: prior?.namespace ?? SETUP_NAMESPACE }
      : {}),
    // Never with a login.
    broker_url: withoutLogin(ctx.tcpUrl).url,
    ...(metrics !== undefined
      ? { metrics }
      : prior?.metrics !== undefined
        ? { metrics: prior.metrics }
        : {}),
    ...(brokerHost !== null ? { broker_host: brokerHost } : {}),
    ...(network !== null ? { network } : {}),
    ...(privateUrl !== null ? { desk_private_url: privateUrl } : {}),
  };
  saveInstall(ctx, install);
  recordRolesDesk(ctx, deskLanUrl(ctx, ctx.deskHost, ctx.deskPort), privateUrl);
}

/**
 * Record the cmux socket mode the cmux check found in an existing setup.json (the Desk's
 * Services runs; a terminal run that stops at cmux writes the whole record instead). No-op
 * without a record or a checked mode.
 */
export function recordCmuxSocketMode(ctx: SetupContext): void {
  const prior = readSetupInstall(ctx.volleydHome);
  if (prior === null || ctx.cmuxSocketMode === undefined) return;
  if (prior.cmux_socket_mode === ctx.cmuxSocketMode) return;
  saveInstall(ctx, { ...prior, cmux_socket_mode: ctx.cmuxSocketMode });
}

/**
 * setup.json's `broker_host`, read on its own: `volley desk install` records it on a machine no
 * `volley setup` has finished on, in a record without the rest. Null when there is none (or it is
 * not a bare host).
 */
export function readBrokerHost(volleydHome: string): string | null {
  try {
    const v = JSON.parse(readFileSync(setupInstallFile(volleydHome), "utf-8")) as {
      broker_host?: unknown;
    };
    return typeof v.broker_host === "string" ? parseBrokerHost(v.broker_host) : null;
  } catch {
    return null;
  }
}

/**
 * setup.json's `desk_port`, read on its own like `broker_host`: a record `volley desk install`
 * wrote on a machine no `volley setup` has finished on. Null when there is none.
 */
export function readDeskPort(volleydHome: string): number | null {
  try {
    const port = (
      JSON.parse(readFileSync(setupInstallFile(volleydHome), "utf-8")) as { desk_port?: unknown }
    ).desk_port;
    return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65_536
      ? port
      : null;
  } catch {
    return null;
  }
}

/** The Desk's broker host for `ctx`: its own (null: none), else the record's. */
export const deskBrokerHost = (ctx: SetupContext): string | null =>
  ctx.brokerHost !== undefined ? ctx.brokerHost : readBrokerHost(ctx.volleydHome);

/**
 * Record what `volley desk install` installed (its port, and its broker host or none) in
 * setup.json, keeping every other key; a machine without a record gets one with these alone.
 */
export function recordDeskInstall(
  ctx: SetupContext,
  desk: { port: number; brokerHost: string | null },
): void {
  const { broker_host: _old, desk_private_url: _url, ...rest } = rawInstall(ctx.volleydHome);
  const privateUrl = deskPrivateUrl(ctx);
  saveInstall(ctx, {
    ...rest,
    desk_port: desk.port,
    ...(desk.brokerHost !== null ? { broker_host: desk.brokerHost } : {}),
    ...(privateUrl !== null ? { desk_private_url: privateUrl } : {}),
  });
  const host = typeof rest.desk_host === "string" ? rest.desk_host : ctx.deps.lanHost();
  recordRolesDesk(ctx, deskLanUrl(ctx, host, desk.port), privateUrl);
}

/** `volley desk uninstall`: setup.json without `desk_private_url`, the roles record back on the LAN. */
export function forgetDeskPrivateUrl(ctx: SetupContext): void {
  const { desk_private_url: url, ...rest } = rawInstall(ctx.volleydHome);
  if (url === undefined) return;
  saveInstall(ctx, rest);
  const host = typeof rest.desk_host === "string" ? rest.desk_host : ctx.deps.lanHost();
  const port = typeof rest.desk_port === "number" ? rest.desk_port : ctx.deskPort;
  recordRolesDesk(ctx, deskLanUrl(ctx, host, port), null);
}

/** The Desk's LAN address: `http://<host>:<port>` (a wildcard host: this machine's LAN address). */
function deskLanUrl(ctx: SetupContext, host: string, port: number): string {
  const h = host === "0.0.0.0" || host === "::" ? ctx.deps.lanHost() : host;
  return `http://${h.includes(":") && !h.startsWith("[") ? `[${h}]` : h}:${port}`;
}

/**
 * The machine roles record's Desk (`$VOLLEYD_HOME/roles.json`, SPEC §4.6.24) when it is this
 * Desk (its `url` or `lan_url` is `lanUrl`, or its `url` is `privateUrl`): `url` the private
 * address with `lan_url` the LAN one, or back to the LAN address alone. One version on, written
 * atomically; volleyd publishes it at its next start. A record, not a gate: no file (volleyd
 * writes it on its first start, from setup.json), another machine's Desk, or an unreadable file
 * is left alone.
 */
export function recordRolesDesk(
  ctx: SetupContext,
  lanUrl: string,
  privateUrl: string | null,
): void {
  const file = join(ctx.volleydHome, "roles.json");
  try {
    const r = JSON.parse(readFileSync(file, "utf-8")) as {
      desk?: { machine?: unknown; url?: unknown; lan_url?: unknown };
      version?: unknown;
    };
    const d = r.desk;
    if (typeof d !== "object" || d === null || typeof r.version !== "number") return;
    const ours =
      d.url === lanUrl || d.lan_url === lanUrl || (privateUrl !== null && d.url === privateUrl);
    if (!ours) return;
    const desk =
      privateUrl !== null
        ? { machine: d.machine, url: privateUrl, lan_url: lanUrl }
        : { machine: d.machine, url: lanUrl };
    if (d.url === desk.url && d.lan_url === (privateUrl !== null ? lanUrl : undefined)) return;
    const tmp = `${file}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify(
        {
          ...r,
          desk,
          version: r.version + 1,
          updated_at: ctx.auth.io.now().toISOString(),
          updated_by: "volley-cli",
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    renameSync(tmp, file);
    // Under sudo it stays the invoking user's, like the rest of $VOLLEYD_HOME (volleyd writes it).
    const invoker = ctx.auth.deps.invokingUser(ctx.auth.env);
    if (typeof invoker === "object" && invoker !== null) {
      ctx.auth.deps.chown(file, invoker.uid, invoker.gid);
    }
  } catch {
    // A record, not a gate.
  }
}

function saveInstall(ctx: SetupContext, install: SetupInstall | Record<string, unknown>): void {
  const file = setupInstallFile(ctx.volleydHome);
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
      ...(typeof v.lan === "boolean" ? { lan: v.lan } : {}),
      ...(isCmuxSocketMode(v.cmux_socket_mode) ? { cmux_socket_mode: v.cmux_socket_mode } : {}),
      ...(isLocalTerminal(v.terminal) ? { terminal: v.terminal } : {}),
      ...(str("coordinator") !== null && COORDINATOR_NAME.test(str("coordinator") as string)
        ? { coordinator: str("coordinator") as string }
        : {}),
      ...(str("namespace") !== null && COORDINATOR_NAME.test(str("namespace") as string)
        ? { namespace: str("namespace") as string }
        : {}),
      ...(str("broker_url") !== null ? { broker_url: str("broker_url") as string } : {}),
      ...(str("metrics") !== null ? { metrics: str("metrics") as string } : {}),
      ...(str("broker_host") !== null && parseBrokerHost(str("broker_host") as string) !== null
        ? { broker_host: parseBrokerHost(str("broker_host") as string) as string }
        : {}),
      ...(parseNetworkRecord(v.network) !== null
        ? { network: parseNetworkRecord(v.network) as NetworkRecord }
        : {}),
      ...(privateUrlOf(v.desk_private_url) !== null
        ? { desk_private_url: privateUrlOf(v.desk_private_url) as string }
        : {}),
    };
  } catch {
    return null;
  }
}
