import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import type { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { randomSuffix } from "volley-mcp/util";
import { parsePositiveInt, resolveAuth, resolveBrokerUrl, resolveNamespace } from "../args";
import { type BalanceAnswer, isNextPick, printBalance } from "../claude/balance";
import { type ListResult, type UsageRecord, groupAccounts, renderGroups } from "../claude/groups";
import { connectAsClient } from "../connect";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";

export interface ClaudeArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

/**
 * `volley claude`: Claude account profiles on the volleyd supervisor. Each verb is one control
 * query on volleyd's mailbox (`claude_accounts`, `claude_account_add`, `claude_signin`,
 * `claude_sync`, `claude_balance`, `agent_move_account`), answered with an `ack` on this client's
 * own mailbox. `list` also reads every account's retained usage record, to show each Anthropic
 * account once, and asks `claude_balance` to mark the logins the next spawn would pick.
 * Signing in happens in the browser, through Claude Code's own flow: this command prints the
 * sign-in URL volleyd got from `claude auth login` and never sees a code or a token.
 */

const HELP = `Usage:
  volley claude add <label> [--machine <name>] [--wait]   Add a profile and start its sign-in
  volley claude signin <acct> [--wait]                    Sign an existing profile in again
  volley claude list [--json] [--show-email]              Accounts grouped by e-mail, their machines, usage, sharing
  volley claude balance [--model <m>] [--machine <name>] [--json] [--show-email]
                                                          Per machine, the accounts ranked by headroom
                                                          and which one each model family picks next
  volley claude sync [<acct>]                             Re-apply sharing.yaml, re-sync MCP servers
  volley claude move <agent-id> <acct>                    Stop an agent and respawn it under <acct>
                                                          (an account of the agent's own machine:
                                                          for a paired machine, a profile kept for it)

Each profile is its own Claude Code CLAUDE_CONFIG_DIR (default ~/.volley/claude/<acct>). add and
signin print a sign-in URL: open it in a browser on the supervisor's machine. When the URL is the
manual-code kind, paste the code into the terminal it names (tmux attach -t volley-signin-<acct>),
never anywhere else. --wait blocks until the sign-in finishes.

Options:
  --machine <name>       add: a paired machine: the profile is created and signed in there
                         (default: the supervisor's own machine); balance: that machine only
                         (local: the supervisor's own)
  --model <m>            balance: rank for this model and print its pick (default: each family's)
  --wait                 add / signin: wait for the sign-in to finish (exit 1 if it fails,
                         124 if it has not ended within --timeout, default 960)
  --timeout <seconds>    How long to wait for volleyd's answer (default 60; move: 180)
  --json                 list: print the raw result, with the usage records as "records";
                         balance: print volleyd's answer
  --show-email           list / balance: show each account's e-mail (masked by default)
  --broker-url <url>     MQTT broker URL (env: VOLLEY_BROKER_URL; default: mqtt://localhost:1883)
  --namespace <ns>       volleyd's namespace (env: VOLLEY_NAMESPACE; default: default)
  --username <user>      Broker username (env: VOLLEY_AUTH_USERNAME)
  --password <pw>        Broker password (env: VOLLEY_AUTH_PASSWORD)
`;

const OPTIONS = {
  machine: { type: "string" },
  model: { type: "string" },
  wait: { type: "boolean" },
  timeout: { type: "string" },
  json: { type: "boolean" },
  "show-email": { type: "boolean" },
  "broker-url": { type: "string" },
  namespace: { type: "string" },
  username: { type: "string" },
  password: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/** The wait for an answer; a move waits for the agent to stop first. */
const DEFAULT_TIMEOUT_S = 60;
const MOVE_TIMEOUT_S = 180;
/** --wait without --timeout: volleyd's own sign-in timeout (15 min), and a minute more. */
const SIGNIN_WAIT_S = 960;
/** How long volleyd's retained status may take to arrive. */
const PROBE_MS = 1_000;
/** `list`'s best-effort `claude_balance` for the next-pick marker: never the full --timeout. */
const BALANCE_HINT_MS = 3_000;
const LIVE = new Set(["spawning", "registered", "working"]);
/** Every account's sign-in topic: subscribed before the request, so no end can be missed. */
const SIGNIN_FILTER = "volley/_system/claude/+/signin";
/** Every account's retained usage record (SPEC §4.6.12). */
const ACCOUNTS_FILTER = "volley/_system/claude-accounts/+";

interface Answer {
  ok: boolean;
  error?: string;
  result?: unknown;
}

interface SigninResult {
  acct: string;
  url?: string;
  flow?: "browser_callback" | "manual_code";
  attach?: string;
  signed_in?: boolean;
  account?: { id: string; label: string };
}

export async function claude({ argv, env, io }: ClaudeArgs): Promise<ExitCode> {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb === "--help" || verb === "-h") {
    io.stdout(HELP);
    return verb === undefined ? EXIT.USAGE : EXIT.OK;
  }
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    io.stderr(`volley claude: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  const v = parsed.values;
  if (v.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const pos = parsed.positionals;
  const usage = (msg: string) => {
    io.stderr(`volley claude ${verb}: ${msg}\n`);
    return EXIT.USAGE;
  };
  if (v["show-email"] === true && verb !== "list" && verb !== "balance")
    return usage("--show-email is for list and balance only");
  if (v.model !== undefined && verb !== "balance") return usage("--model is for balance only");
  let op: string;
  let fields: Record<string, unknown>;
  switch (verb) {
    case "add":
      if (pos.length !== 1) return usage("needs exactly one <label>");
      op = "claude_account_add";
      fields = { label: pos[0], ...(v.machine !== undefined ? { machine: v.machine } : {}) };
      break;
    case "signin":
      if (pos.length !== 1) return usage("needs exactly one <acct>");
      op = "claude_signin";
      fields = { acct: pos[0] };
      break;
    case "list":
      if (pos.length !== 0) return usage("takes no arguments");
      op = "claude_accounts";
      fields = {};
      break;
    case "balance":
      if (pos.length !== 0) return usage("takes no arguments");
      op = "claude_balance";
      fields = {
        ...(v.model !== undefined ? { model: v.model } : {}),
        ...(v.machine !== undefined ? { machine: v.machine } : {}),
      };
      break;
    case "sync":
      if (pos.length > 1) return usage("takes at most one <acct>");
      op = "claude_sync";
      fields = pos[0] !== undefined ? { acct: pos[0] } : {};
      break;
    case "move":
      if (pos.length !== 2) return usage("needs <agent-id> <acct>");
      op = "agent_move_account";
      fields = { agent: pos[0], acct: pos[1] };
      break;
    default:
      io.stderr(`volley claude: unknown verb '${verb}'\n\n${HELP}`);
      return EXIT.USAGE;
  }
  let timeoutMs: number;
  let namespace: string;
  try {
    timeoutMs =
      parsePositiveInt(
        v.timeout ?? String(verb === "move" ? MOVE_TIMEOUT_S : DEFAULT_TIMEOUT_S),
        "--timeout",
      ) * 1000;
    namespace = resolveNamespace(v.namespace, env);
  } catch (e) {
    return usage(e instanceof Error ? e.message : String(e));
  }
  const brokerUrl = resolveBrokerUrl(v["broker-url"], env);
  const broker = await connectAsClient(
    brokerUrl,
    io,
    resolveAuth({ username: v.username, password: v.password }, env, process.cwd(), brokerUrl),
  );
  if (broker === null) return EXIT.ERROR;
  try {
    const status = await broker.queryRetained(buildTopic(namespace, "volleyd", "status"), PROBE_MS);
    const live = status !== null && LIVE.has(parseEnvelope(status)?.type ?? "");
    if (!live) {
      io.stderr(`volley claude: volleyd is not running in namespace '${namespace}'\n`);
      return EXIT.ERROR;
    }
    const ends = v.wait === true ? await watchSigninEnds(broker) : null;
    const answer = await request(broker, namespace, op, fields, timeoutMs);
    if (answer === null) {
      io.stderr(`volley claude ${verb}: volleyd did not answer within ${timeoutMs / 1000} s\n`);
      return EXIT.TIMEOUT;
    }
    if (!answer.ok) {
      io.stderr(`volley claude ${verb}: ${answer.error ?? "refused"}\n`);
      return EXIT.ERROR;
    }
    if (verb === "add" || verb === "signin") {
      const r = answer.result as SigninResult;
      printSignin(io, r);
      if (ends !== null && r.signed_in !== true) {
        const waitMs = v.timeout !== undefined ? timeoutMs : SIGNIN_WAIT_S * 1000;
        const end = await ends(r.acct, waitMs);
        if (end === null) {
          io.stderr(
            `volley claude: sign-in of ${r.acct} did not finish within ${waitMs / 1000} s; \`volley claude list\` shows its state\n`,
          );
          return EXIT.TIMEOUT;
        }
        return reportEnd(io, r.acct, end);
      }
      return EXIT.OK;
    }
    if (verb === "list") {
      const result = answer.result as ListResult;
      const records = await usageRecords(broker);
      if (v.json === true) io.stdout(`${JSON.stringify({ ...result, records }, null, 2)}\n`);
      else {
        // A volleyd that predates the op (or does not answer it) only costs the marker.
        const b = await request(
          broker,
          namespace,
          "claude_balance",
          {},
          Math.min(timeoutMs, BALANCE_HINT_MS),
        );
        const balance = b?.ok === true ? balanceOf(b.result) : null;
        printList(io, result, records, v["show-email"] === true, balance);
      }
      return EXIT.OK;
    }
    if (verb === "balance") {
      const result = balanceOf(answer.result);
      if (v.json === true) io.stdout(`${JSON.stringify(answer.result, null, 2)}\n`);
      else if (result === null) {
        io.stderr("volley claude balance: volleyd's answer has no machines\n");
        return EXIT.ERROR;
      } else
        io.stdout(
          printBalance(result, await usageRecords(broker), { showEmail: v["show-email"] === true }),
        );
      return EXIT.OK;
    }
    if (verb === "move") {
      const r = answer.result as { agent_id: string | null; decision?: string; to: string };
      io.stdout(
        r.agent_id !== null
          ? `moved: ${pos[0]} → ${r.agent_id} under Claude account ${r.to}\n`
          : `moved: ${pos[0]} stopped; its respawn under ${r.to} waits on decision ${r.decision}\n`,
      );
      return EXIT.OK;
    }
    const synced = (answer.result as { synced: { acct: string; mcp_servers?: number }[] }).synced;
    for (const s of synced)
      io.stdout(
        `synced ${s.acct}${s.mcp_servers !== undefined ? ` (${s.mcp_servers} MCP servers)` : ""}\n`,
      );
    if (synced.length === 0) io.stdout("no profiles on this machine\n");
    return EXIT.OK;
  } finally {
    await broker.disconnect();
  }
}

/** One control query to volleyd; resolves with its answer, or null at the timeout. */
async function request(
  broker: VolleyBroker,
  namespace: string,
  op: string,
  fields: Record<string, unknown>,
  timeoutMs: number,
): Promise<Answer | null> {
  const me = `volley-cli-${randomSuffix(6)}`;
  const correlationId = randomUUID();
  let done!: (a: Answer | null) => void;
  const answered = new Promise<Answer | null>((r) => {
    done = r;
  });
  const unsubscribe = await broker.subscribeStream(
    buildTopic(namespace, me, "mailbox"),
    ({ payload }) => {
      const e = parseEnvelope(payload);
      // Only volleyd may answer (SPEC §4.4: anyone can write our mailbox).
      if (e?.type === "ack" && e.correlation_id === correlationId && e.agent_id === "volleyd")
        done(e.payload as Answer);
    },
  );
  const timer = setTimeout(() => done(null), timeoutMs);
  try {
    const query = buildEnvelope({
      agentId: me,
      parentId: null,
      channel: "mailbox",
      type: "query",
      correlationId,
      payload: { op, text: `volley claude: ${op}`, ...fields },
    });
    await broker.publish(buildTopic(namespace, "volleyd", "mailbox"), JSON.stringify(query), {
      qos: 1,
      retain: false,
    });
    return await answered;
  } finally {
    clearTimeout(timer);
    await unsubscribe();
  }
}

function printSignin(io: IO, r: SigninResult): void {
  if (r.account !== undefined) io.stdout(`Claude account ${r.account.id} added.\n`);
  if (r.signed_in === true) {
    io.stdout(`${r.acct} is signed in.\n`);
    return;
  }
  // `<acct>@<name>`: a profile on a paired machine, its callback forwarded to the supervisor.
  const machine = r.acct.includes("@") ? r.acct.slice(r.acct.indexOf("@") + 1) : null;
  if (r.flow === "manual_code") {
    const where = machine !== null ? ` on ${machine}` : "";
    io.stdout(
      `Sign in to Claude for ${r.acct}: open this URL in a browser, then paste the code it shows into the sign-in terminal${where} (${r.attach}):\n  ${r.url}\n`,
    );
    return;
  }
  io.stdout(
    machine !== null
      ? `Sign in to Claude for ${r.acct}: open this URL in a browser on this computer (the supervisor's machine: the sign-in on ${machine} is forwarded here):\n  ${r.url}\n`
      : `Sign in to Claude for ${r.acct}: open this URL in a browser on the supervisor's machine:\n  ${r.url}\n`,
  );
}

interface SigninEnd {
  type: string;
  reason?: string;
  plan?: string;
}

/**
 * Collect every sign-in's end (`claude_signin_done` / `_failed`, non-retained) from now on;
 * the returned function waits for one account's, up to `ms` (null: no end in time).
 */
async function watchSigninEnds(
  broker: VolleyBroker,
): Promise<(acct: string, ms: number) => Promise<SigninEnd | null>> {
  const ended = new Map<string, SigninEnd>();
  const waiters = new Map<string, (e: SigninEnd) => void>();
  await broker.subscribeStream(SIGNIN_FILTER, ({ topic, payload }) => {
    const e = parseEnvelope(payload);
    if (e?.type !== "claude_signin_done" && e?.type !== "claude_signin_failed") return;
    const acct = topic.split("/")[3] ?? "";
    const end = { type: e.type, ...(e.payload as { reason?: string; plan?: string }) };
    ended.set(acct, end);
    waiters.get(acct)?.(end);
  });
  return (acct, ms) =>
    new Promise((resolve) => {
      const seen = ended.get(acct);
      if (seen !== undefined) return resolve(seen);
      const t = setTimeout(() => resolve(null), ms);
      waiters.set(acct, (e) => {
        clearTimeout(t);
        resolve(e);
      });
    });
}

function reportEnd(io: IO, acct: string, end: SigninEnd): ExitCode {
  if (end.type === "claude_signin_done") {
    io.stdout(`${acct} is signed in${end.plan !== undefined ? ` (${end.plan})` : ""}.\n`);
    return EXIT.OK;
  }
  io.stderr(`volley claude: sign-in of ${acct} failed: ${end.reason ?? "unknown"}\n`);
  return EXIT.ERROR;
}

/** The retained `claude_account` records volleyd publishes, read for PROBE_MS. */
async function usageRecords(broker: VolleyBroker): Promise<UsageRecord[]> {
  const msgs = await broker.subscribeCollect(ACCOUNTS_FILTER, Number.POSITIVE_INFINITY, PROBE_MS);
  return msgs.flatMap(({ payload }) => {
    const e = parseEnvelope(payload);
    // Only volleyd's records count (SPEC §4.4: the topic is anyone's to write).
    return e?.type === "claude_account" && e.agent_id === "volleyd"
      ? [e.payload as UsageRecord]
      : [];
  });
}

/** A `claude_balance` result, or null when it is not one (machines with their picks). */
function balanceOf(result: unknown): BalanceAnswer | null {
  const machines = (result as { machines?: unknown } | undefined)?.machines;
  return Array.isArray(machines) &&
    machines.every((m) => typeof m === "object" && m !== null && "picks" in m && "candidates" in m)
    ? (result as BalanceAnswer)
    : null;
}

function printList(
  io: IO,
  r: ListResult,
  records: UsageRecord[],
  showEmail: boolean,
  balance: BalanceAnswer | null,
): void {
  const groups = groupAccounts(r, records);
  if (groups.length === 0) io.stdout(`no Claude account profiles under ${r.root}\n`);
  io.stdout(
    renderGroups(groups, {
      now: Date.now(),
      showEmail,
      nextPick: (account) => isNextPick(balance, account),
    }),
  );
  io.stdout(
    `sharing: ${Object.entries(r.sharing)
      .map(([item, mode]) => `${item}=${mode}`)
      .join(" ")}\n`,
  );
}
