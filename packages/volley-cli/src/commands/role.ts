import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { VolleyBroker } from "volley-mcp/broker";
import type { BrokerAuth } from "volley-mcp/config";
import { parseEnvelope } from "volley-mcp/envelope";
import { isPlanSheet, renderSheet } from "volleyd/roles/sheet";
import { parsePositiveInt, resolveAuth, resolveBrokerUrl } from "../args";
import { connectAsClient, openClient, reportConnectError } from "../connect";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { type Answer, type AskFlags, adminRefusal, askVolleyd, replyKeyPair, unseal } from "./peer";

/**
 * `volley role`: the machine roles (SPEC §4.6.24), which machine runs the broker, the supervisor
 * and the Desk. `status` reads the supervisor's retained record; it needs the broker, not an
 * answer from volleyd. `move` and `rollback` are the admin ops `role_plan`, `role_move` and
 * `role_rollback`, sent as `volley peer invite` sends its own; the plan sheet is volleyd's
 * (`volleyd/roles/sheet`, the Desk's too), and a move's progress is its retained topic,
 * `volley/_system/roles/moves/<move_id>`, streamed as `✓ step` lines until it ends.
 */

export const ROLE_DEFAULTS = {
  /** How long `role_plan` and a refusal may take to answer. */
  plan_timeout_s: 30,
  /**
   * How long a move may take, start to end, before the CLI gives up waiting (exit 124): a Desk
   * move builds the Desk, a broker move re-points every machine, a supervisor move hands over.
   */
  move_timeout_s: { desk: 900, broker: 1_200, supervisor: 1_800 },
  /** A streamed move is ours when it started no earlier than this before the request (clock skew). */
  since_skew_ms: 60_000,
  /**
   * A move's topic quiet this long is read again over a fresh connection: a broker move stops
   * the broker the stream is connected to.
   */
  poll_ms: 5_000,
  /** How long a fresh read waits for a retained topic. */
  retained_ms: 1_000,
} as const;

type MoveRole = keyof typeof ROLE_DEFAULTS.move_timeout_s;
const MOVE_ROLES: readonly MoveRole[] = ["broker", "supervisor", "desk"];
const MOVES_TOPIC = "volley/_system/roles/moves/+";
const TERMINAL = new Set(["done", "failed", "rolled_back"]);
const ADMIN_ONLY = "role moves are admin ops (an admin account's login)";

const ROLES_TOPIC = "volley/_system/roles";
const NO_RECORD = "no roles record: is volleyd running?";

const HELP = `Usage:
  volley role status [--json]        Which machine runs the broker, the supervisor and the Desk
  volley role move broker --to <machine> [--address <ssh destination>] [--lan|--no-lan]
                   [--drain] [--dry-run] [--yes]
  volley role move supervisor --to <machine> [--drain] [--dry-run] [--yes]
  volley role move desk --to <machine> [--port <port>] [--dry-run] [--yes]
                                     Plan a move, print its sheet, ask once, run it and stream
                                     each step (\`--dry-run\`: the sheet only; exit 1 when blocked)
  volley role rollback <move_id>     Undo a done move (within 7 days) as a new move the other way
  volley role receive supervisor <bundle> --from <old machine> [--local-terminal cmux|tmux]
                      [--local-agents never] [--broker-url <url>]
                                     The new machine's half of a supervisor move (volleyd runs it
                                     over ssh; \`volley role receive --help\` for more)

Options:
  --json               The record as JSON
  --timeout <seconds>  status: how long to wait for the retained record (default 2); move and
                       rollback: how long to wait for volleyd (default: 30 for the plan; a move
                       ${MOVE_ROLES.map((r) => `${r} ${ROLE_DEFAULTS.move_timeout_s[r]}`).join(", ")}), exit 124 after it
  --broker-url <url>   MQTT broker URL (env: VOLLEY_BROKER_URL; default: mqtt://localhost:1883)
  --username <user>    Broker username (env: VOLLEY_AUTH_USERNAME)
  --password <pw>      Broker password (env: VOLLEY_AUTH_PASSWORD)
`;

export interface RoleArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

/** The fields `status` prints; the rest of the record is printed by `--json` as it is. */
interface RolesPayload {
  broker: { machine: string };
  supervisor: { machine: string };
  desk: { machine: string; url: string; lan_url?: string };
}

export interface RoleDeps {
  /** Asks once before a move runs (`--yes` skips it); false when there is no terminal. */
  confirm: (question: string) => Promise<boolean>;
}

export function realRoleDeps(): RoleDeps {
  return {
    confirm: async (question) => {
      if (process.stdin.isTTY !== true) return false;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
  };
}

export function role(args: RoleArgs): Promise<ExitCode> {
  return runRole(args, realRoleDeps());
}

export async function runRole({ argv, env, io }: RoleArgs, deps: RoleDeps): Promise<ExitCode> {
  // Its own options and help (role-receive.ts).
  if (argv[0] === "receive") {
    return (await import("./role-receive")).receive({ argv: argv.slice(1), env, io });
  }
  if (argv[0] === "move" || argv[0] === "rollback")
    return moveOrRollback(argv[0], argv.slice(1), env, io, deps);
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        json: { type: "boolean", default: false },
        timeout: { type: "string", default: "2" },
        "broker-url": { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    io.stderr(`volley role: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  const [verb, ...extra] = parsed.positionals;
  if (parsed.values.help === true || verb === "help") {
    io.stdout(HELP);
    return EXIT.OK;
  }
  if (verb !== "status") {
    io.stderr(verb === undefined ? HELP : `volley role: unknown verb: ${verb}\n\n${HELP}`);
    return EXIT.USAGE;
  }
  if (extra.length > 0) {
    io.stderr(`volley role status: unexpected argument: ${extra[0]}\n`);
    return EXIT.USAGE;
  }

  let brokerUrl: string;
  let auth: BrokerAuth | null;
  let timeoutSec: number;
  try {
    brokerUrl = resolveBrokerUrl(parsed.values["broker-url"] as string | undefined, env);
    auth = resolveAuth(
      {
        username: parsed.values.username as string | undefined,
        password: parsed.values.password as string | undefined,
      },
      env,
      process.cwd(),
      brokerUrl,
    );
    timeoutSec = parsePositiveInt(parsed.values.timeout as string, "--timeout");
  } catch (e) {
    io.stderr(`volley role: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }

  const broker = await connectAsClient(brokerUrl, io, auth);
  if (broker === null) return EXIT.ERROR; // connectAsClient already printed the diagnostic.
  try {
    const raw = await broker.queryRetained(ROLES_TOPIC, timeoutSec * 1000);
    const envelope = raw === null || raw === "" ? null : parseEnvelope(raw);
    // Only the supervisor's record counts: any login may publish on a topic it can write.
    if (envelope === null || envelope.agent_id !== "volleyd" || envelope.type !== "roles") {
      io.stderr(`volley role: ${NO_RECORD}\n`);
      return EXIT.ERROR;
    }
    const record: unknown = envelope.payload;
    if (!isRolesPayload(record)) {
      io.stderr("volley role: malformed roles record\n");
      return EXIT.ERROR;
    }
    if (parsed.values.json === true) {
      io.stdout(`${JSON.stringify(record, null, 2)}\n`);
      return EXIT.OK;
    }
    io.stdout(
      [
        `broker      on ${record.broker.machine}`,
        `supervisor  on ${record.supervisor.machine}`,
        `desk        on ${record.desk.machine} (${record.desk.url}${typeof record.desk.lan_url === "string" ? ` · LAN ${record.desk.lan_url}` : ""})`,
        "",
      ].join("\n"),
    );
    return EXIT.OK;
  } catch (e) {
    io.stderr(`volley role: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  } finally {
    await broker.disconnect();
  }
}

/** Just enough shape to print the three lines: each role names its machine, the Desk its URL. */
function isRolesPayload(p: unknown): p is RolesPayload {
  const machineOf = (r: unknown) =>
    typeof r === "object" && r !== null && typeof (r as { machine?: unknown }).machine === "string";
  if (typeof p !== "object" || p === null) return false;
  const { broker, supervisor, desk } = p as Record<string, unknown>;
  return (
    machineOf(broker) &&
    machineOf(supervisor) &&
    machineOf(desk) &&
    typeof (desk as { url?: unknown }).url === "string"
  );
}

/** A move as its retained topic shows it (role-move.schema.json). */
interface MoveState {
  move_id: string;
  role: string;
  from: string;
  to: string;
  status: string;
  since: string;
  steps: { id: string; title: string; where: string; status: string; line?: string }[];
  error?: string;
}

function isMoveState(p: unknown): p is MoveState {
  if (typeof p !== "object" || p === null) return false;
  const m = p as Record<string, unknown>;
  return (
    ["move_id", "role", "from", "to", "status", "since"].every((k) => typeof m[k] === "string") &&
    Array.isArray(m.steps)
  );
}

/** `volley role move <role> …` and `volley role rollback <move_id>`. */
async function moveOrRollback(
  verb: "move" | "rollback",
  argv: string[],
  env: Record<string, string | undefined>,
  io: IO,
  deps: RoleDeps,
): Promise<ExitCode> {
  const cmd = `volley role ${verb}`;
  let parsed: ReturnType<typeof parseMoveArgs>;
  try {
    parsed = parseMoveArgs(argv);
  } catch (e) {
    io.stderr(`${cmd}: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  const v = parsed.values;
  if (v.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  let timeoutS: number | undefined;
  try {
    timeoutS = v.timeout === undefined ? undefined : parsePositiveInt(v.timeout, "--timeout");
  } catch (e) {
    io.stderr(`${cmd}: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  const flags = (seconds: number): AskFlags => ({
    timeout: String(timeoutS ?? seconds),
    "broker-url": v["broker-url"],
    username: v.username,
    password: v.password,
  });
  const ask = (op: string, fields: Record<string, unknown>, seconds: number) =>
    askVolleyd(cmd, op, fields, flags(seconds), env, io, true, ADMIN_ONLY);

  if (verb === "rollback") {
    const [id, ...extra] = parsed.positionals;
    if (id === undefined || extra.length > 0) {
      io.stderr(`${cmd}: name one move: volley role rollback <move_id>\n`);
      return EXIT.USAGE;
    }
    if (moveOnlyFlag(v) !== null) {
      io.stderr(`${cmd}: ${moveOnlyFlag(v)} is an option of volley role move only\n`);
      return EXIT.USAGE;
    }
    const longest = Math.max(...Object.values(ROLE_DEFAULTS.move_timeout_s));
    // The stream connects before role_rollback is asked: refuse a non-admin before it.
    let auth: BrokerAuth | null;
    try {
      auth = resolveAuth({ username: v.username, password: v.password }, env);
    } catch (e) {
      io.stderr(`${cmd}: ${e instanceof Error ? e.message : String(e)}\n`);
      return EXIT.ERROR;
    }
    const refused = adminRefusal(cmd, auth, env, io, ADMIN_ONLY);
    if (refused !== null) return refused;
    return streamed(cmd, io, env, v, timeoutS ?? longest, null, async (stream) => {
      const a = await ask("role_rollback", { move_id: id }, longest);
      if (typeof a === "number") return a;
      const r = (a.result ?? {}) as { move_id?: unknown };
      if (typeof r.move_id !== "string") {
        io.stderr(`${cmd}: volleyd's answer names no move\n`);
        return EXIT.ERROR;
      }
      const end = await stream.follow(r.move_id);
      if (typeof end === "number") return end;
      if (end.status !== "done") return failed(cmd, io, end);
      io.stdout(`${id} rolled back: the ${end.role} runs on ${end.to}\n`);
      return EXIT.OK;
    });
  }

  const req = moveRequest(v, parsed.positionals);
  if (typeof req === "string") {
    io.stderr(`${cmd}: ${req}\n`);
    return EXIT.USAGE;
  }
  const a = await ask("role_plan", req.fields, ROLE_DEFAULTS.plan_timeout_s);
  if (typeof a === "number") return a;
  if (!isPlanSheet(a.result)) {
    io.stderr(`${cmd}: volleyd's plan is malformed\n`);
    return EXIT.ERROR;
  }
  const plan = a.result;
  io.stdout(`${renderSheet(plan).join("\n")}\n`);
  if (v["dry-run"] === true) return plan.blocked.length > 0 ? EXIT.ERROR : EXIT.OK;
  // Only a fleet that is not quiet waits under --drain; volleyd refuses any other blocker.
  if (plan.blocked.length > 0 && v.drain !== true) {
    io.stderr(`${cmd}: the move is blocked: fix the above, then run it again\n`);
    return EXIT.ERROR;
  }
  if (v.yes !== true && !(await deps.confirm(`Move the ${req.role} to ${plan.to}?`))) {
    io.stderr(`${cmd}: not moved\n`);
    return EXIT.ERROR;
  }
  const seconds = ROLE_DEFAULTS.move_timeout_s[req.role];
  const key = replyKeyPair();
  return streamed(cmd, io, env, v, timeoutS ?? seconds, req, async (stream) => {
    const fields = {
      ...req.fields,
      plan_id: plan.plan_id,
      ...(v.drain === true ? { drain: true } : {}),
      reply_key: key.jwk,
    };
    const answer = await ask("role_move", fields, seconds);
    if (typeof answer === "number") {
      // A failed move answers ok: false; its topic tells which step failed and what was undone.
      const last = stream.ours();
      if (answer === EXIT.ERROR && last !== null && last.status === "failed") {
        stream.print(last);
        io.stdout(`the ${req.role} stays on ${last.from}: every step done was undone\n`);
      }
      return answer;
    }
    const r = (answer.result ?? {}) as { move_id?: unknown; status?: unknown };
    if (typeof r.move_id !== "string") {
      io.stderr(`${cmd}: volleyd's answer names no move\n`);
      return EXIT.ERROR;
    }
    if (r.status === "planning")
      io.stdout(`${r.move_id}: waiting for a quiet fleet (nothing new is admitted meanwhile)\n`);
    const end = await stream.follow(r.move_id);
    if (typeof end === "number") return end;
    if (end.status !== "done") return failed(cmd, io, end);
    io.stdout(`the ${req.role} runs on ${end.to} (undo: volley role rollback ${end.move_id})\n`);
    const link = signinLink(answer, key.privateKey);
    if (link !== null) io.stdout(`sign in at the Desk's new address: ${link}\n`);
    if (req.role === "broker") {
      const sup = await stream.supervisorMachine();
      if (sup !== null && sup !== end.to)
        io.stdout(
          `the supervisor stays on ${sup}; to move it too: volley role move supervisor --to ${end.to}\n`,
        );
    }
    return EXIT.OK;
  });
}

function parseMoveArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      to: { type: "string" },
      address: { type: "string" },
      lan: { type: "boolean" },
      "no-lan": { type: "boolean" },
      port: { type: "string" },
      drain: { type: "boolean" },
      "dry-run": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      timeout: { type: "string" },
      "broker-url": { type: "string" },
      username: { type: "string" },
      password: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
}

type MoveValues = ReturnType<typeof parseMoveArgs>["values"];

/** The first option given that only `volley role move` takes. */
function moveOnlyFlag(v: MoveValues): string | null {
  for (const k of ["to", "address", "lan", "no-lan", "port", "drain", "dry-run", "yes"] as const)
    if (v[k] !== undefined) return `--${k}`;
  return null;
}

/** `move`'s role and the plan request's fields, or why they are wrong. */
function moveRequest(
  v: MoveValues,
  positionals: string[],
): { role: MoveRole; fields: Record<string, unknown> } | string {
  const [r, ...extra] = positionals;
  if (r === undefined || !(MOVE_ROLES as readonly string[]).includes(r))
    return `name the role to move: ${MOVE_ROLES.join(", ")}`;
  if (extra.length > 0) return `unexpected argument: ${extra[0]}`;
  const role = r as MoveRole;
  if (v.to === undefined || v.to === "") return "--to <machine> is required";
  const only = (flag: string, owner: MoveRole) => `--${flag} is an option of a ${owner} move only`;
  if (role !== "broker") {
    if (v.address !== undefined) return only("address", "broker");
    if (v.lan !== undefined) return only("lan", "broker");
    if (v["no-lan"] !== undefined) return only("no-lan", "broker");
  }
  if (role !== "desk" && v.port !== undefined) return only("port", "desk");
  if (role === "desk" && v.drain !== undefined)
    return "--drain is for a broker or supervisor move: moving the Desk never waits for a quiet fleet";
  if (v.lan === true && v["no-lan"] === true) return "--lan and --no-lan exclude each other";
  if (v.address?.startsWith("-") === true) return "--address must be an ssh destination";
  const fields: Record<string, unknown> = { role, to: v.to };
  if (v.address !== undefined) fields.address = v.address;
  if (v.lan === true) fields.lan = true;
  if (v["no-lan"] === true) fields.lan = false;
  if (v.port !== undefined) {
    const port = Number(v.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return "--port must be a whole number in 1..65535";
    fields.port = port;
  }
  return { role, fields };
}

/** A failed (or rolled back) move's ending: why, and exit 1. */
function failed(cmd: string, io: IO, end: MoveState): ExitCode {
  const step = end.steps.find((s) => s.status === "failed");
  io.stderr(
    `${cmd}: ${end.move_id} ${end.status}${step !== undefined ? ` at ${step.id}` : ""}${end.error !== undefined ? `: ${end.error}` : ""}\n`,
  );
  return EXIT.ERROR;
}

/** The sign-in link a Desk move seals to our reply key (whole, or a token to join to its base). */
function signinLink(a: Answer, key: Parameters<typeof unseal>[0]): string | null {
  const s = unseal(key, a.sealed);
  if (s === null) return null;
  if (typeof s.link === "string") return s.link;
  const base = (a.result as { link_base?: unknown } | undefined)?.link_base;
  return typeof s.token === "string" && typeof base === "string"
    ? `${base}#signin=${s.token}`
    : null;
}

interface Stream {
  /** Our move's latest state, once it is known. */
  ours: () => MoveState | null;
  /** Print the step lines `m` adds to what was printed. */
  print: (m: MoveState) => void;
  /** Wait for `moveId` to end (its state), or exit 124 at the deadline. */
  follow: (moveId: string) => Promise<MoveState | ExitCode>;
  /** The supervisor's machine as the roles record names it now (null: no record). */
  supervisorMachine: () => Promise<string | null>;
}

/**
 * Run `body` with the moves topic streamed on a connection of its own: a move's `role_move`
 * answers only when it ends (a supervisor move's, as it starts), so its steps are printed from
 * the retained topic as they go, before the move id is known. A move is ours once it appears
 * after the request, for this role and target (`want`; any, for a rollback).
 */
async function streamed(
  cmd: string,
  io: IO,
  env: Record<string, string | undefined>,
  v: MoveValues,
  timeoutS: number,
  want: { role: MoveRole; fields: Record<string, unknown> } | null,
  body: (s: Stream) => Promise<ExitCode>,
): Promise<ExitCode> {
  let broker: VolleyBroker;
  let url: string;
  let auth: BrokerAuth | null;
  try {
    url = resolveBrokerUrl(v["broker-url"], env);
    auth = resolveAuth({ username: v.username, password: v.password }, env);
    broker = await openClient(url, auth);
  } catch (e) {
    reportConnectError(io, e);
    return EXIT.ERROR;
  }
  const deadline = Date.now() + timeoutS * 1000;
  /** One retained topic's envelope over a connection of its own; null when there is none (yet). */
  const fresh = async (topic: string) => {
    try {
      const b = await openClient(url, auth);
      try {
        const raw = await b.queryRetained(topic, ROLE_DEFAULTS.retained_ms);
        return raw === null || raw === "" ? null : parseEnvelope(raw);
      } finally {
        await b.disconnect().catch(() => {});
      }
    } catch {
      return null;
    }
  };
  const before = new Set<string>();
  const latest = new Map<string, MoveState>();
  const printed = new Map<string, string>();
  let sentAt: number | null = null;
  let ourId: string | null = null;
  let wake: () => void = () => {};

  const print = (m: MoveState) => {
    for (const s of m.steps) {
      if (printed.get(s.id) === s.status) continue;
      const line = s.line !== undefined && s.line !== "" ? `: ${s.line}` : "";
      if (s.status === "ok") io.stdout(`✓ ${s.title} (${s.where})${line}\n`);
      else if (s.status === "failed") io.stdout(`✗ ${s.title} (${s.where})${line}\n`);
      else if (s.status === "skipped") io.stdout(`- ${s.title} (${s.where}): skipped${line}\n`);
      else continue;
      printed.set(s.id, s.status);
    }
  };
  const isOurs = (m: MoveState) =>
    ourId !== null
      ? m.move_id === ourId
      : sentAt !== null &&
        !before.has(m.move_id) &&
        Date.parse(m.since) >= sentAt - ROLE_DEFAULTS.since_skew_ms &&
        (want === null || (m.role === want.role && m.to === want.fields.to));

  const unsubscribe = await broker.subscribeStream(MOVES_TOPIC, ({ payload }) => {
    const e = parseEnvelope(payload);
    // Only the supervisor's moves count (any login may publish on a topic it can write).
    if (e === null || e.agent_id !== "volleyd" || !isMoveState(e.payload)) return;
    const m = e.payload;
    if (sentAt === null) before.add(m.move_id);
    latest.set(m.move_id, m);
    if (!isOurs(m)) return;
    ourId ??= m.move_id;
    print(m);
    wake();
  });
  sentAt = Date.now();
  const stream: Stream = {
    ours: () => (ourId === null ? null : (latest.get(ourId) ?? null)),
    print,
    follow: async (moveId) => {
      ourId = moveId;
      for (;;) {
        const m = latest.get(moveId);
        if (m !== undefined) {
          print(m);
          if (TERMINAL.has(m.status)) return m;
        }
        const left = deadline - Date.now();
        if (left <= 0) {
          io.stderr(
            `${cmd}: ${moveId} did not end within ${timeoutS} s (it may still be running: volley role status)\n`,
          );
          return EXIT.TIMEOUT;
        }
        const woken = await new Promise<boolean>((r) => {
          const t = setTimeout(() => r(false), Math.min(left, ROLE_DEFAULTS.poll_ms));
          wake = () => {
            clearTimeout(t);
            r(true);
          };
        });
        // Quiet for a while: a broker move stops the broker this stream is connected to, so read
        // the topic again over a fresh connection (the supervisor republishes it once it is back).
        if (!woken) {
          const e = await fresh(`volley/_system/roles/moves/${moveId}`);
          if (e !== null && e.agent_id === "volleyd" && isMoveState(e.payload))
            latest.set(moveId, e.payload);
        }
      }
    },
    supervisorMachine: async () => {
      const e = await fresh(ROLES_TOPIC);
      if (e === null || e.agent_id !== "volleyd" || !isRolesPayload(e.payload)) return null;
      return e.payload.supervisor.machine;
    },
  };
  try {
    return await body(stream);
  } finally {
    await unsubscribe().catch(() => {});
    await broker.disconnect().catch(() => {});
  }
}
