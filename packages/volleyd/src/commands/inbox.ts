import { parseArgs } from "node:util";
import { type InboxItem, parseWhereLabel, whereLabel } from "../autopilot/inbox";
import { BAD_ANSWER, type ControlTarget, resolveControlTarget, withClient } from "../control";
import { type CommandArgs, EXIT, type ExitCode } from "../io";
import { resolveCaller } from "../ownership";

const HELP = `Usage:
  volleyd inbox [--all] [--json]
  volleyd inbox answer <id> <answer...> [--where <where>] [--version <n>] [--by <agent-id>]

The needs-you inbox: everything waiting for a person (decisions, pickers, handoffs, release
stages), one line each: id, kind, age, owner-only, title and options. --all also lists answered
items not yet cleared.

answer answers one through volleyd, the referee: the first answer at the item's current version
wins, and a later one is refused with where the winner answered (exit 1). --version answers the
version you saw (default: the item's current one); --where says where you answered (default
cli; desk·<device>, <machine>·terminal).

Common flags: --broker-url <url>  --namespace <ns>
`;

/** `5s`, `2m`, `3h`, `2d`: how long an item has waited. */
function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** One item: `<id>  <kind>  <age>  owner-only? yes|no  <title>  [a | b]`, then its question. */
export function formatInboxItem(item: InboxItem, now: number): string {
  const opts = (item.options ?? []).map((o) => o.label);
  const head = [
    item.id,
    item.kind,
    age(now - Date.parse(item.opened_at)),
    `owner-only? ${item.owner_only ? "yes" : "no"}`,
    item.title,
    ...(opts.length > 0 ? [`[${opts.join(" | ")}]`] : []),
  ].join("  ");
  const answered =
    item.answered !== undefined
      ? `  answered on ${whereLabel(item.answered.where)} by ${item.answered.by}: ${item.answered.answer}\n`
      : "";
  return `${head}\n  ${item.question}\n${answered}`;
}

export async function inbox({ argv, env, io }: CommandArgs): Promise<ExitCode> {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  let target: ControlTarget;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        all: { type: "boolean" },
        json: { type: "boolean" },
        where: { type: "string" },
        version: { type: "string" },
        by: { type: "string" },
        "broker-url": { type: "string" },
        namespace: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    }));
    target = resolveControlTarget(values, env);
  } catch (e) {
    io.stderr(`volleyd inbox: ${e instanceof Error ? e.message : String(e)}\n${HELP}`);
    return EXIT.USAGE;
  }
  if (values.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const usage = (why: string) => {
    io.stderr(`volleyd inbox: ${why}\n${HELP}`);
    return EXIT.USAGE;
  };
  const [action, id, ...answer] = positionals;

  if (action === undefined) {
    return withClient(target, io, "volleyd inbox", async (client) => {
      const res = await client.request("inbox", { all: values.all === true });
      if (!res.ok) {
        io.stderr(`volleyd inbox: ${res.error ?? "failed"}\n`);
        return EXIT.ERROR;
      }
      const r = res.result as { items: InboxItem[]; now: string };
      if (values.json === true) io.stdout(`${JSON.stringify(r, null, 2)}\n`);
      else if (r.items.length === 0) io.stdout("nothing needs you\n");
      // Ages are on the daemon's clock (its `now`), never this process's.
      else io.stdout(r.items.map((i) => formatInboxItem(i, Date.parse(r.now))).join(""));
      return EXIT.OK;
    });
  }
  if (action !== "answer") return usage(`unknown action '${action}'`);
  if (id === undefined || answer.length === 0) return usage("expected an item id and an answer");
  const where = parseWhereLabel(typeof values.where === "string" ? values.where : "cli");
  if (where === null || where.kind === "autopilot")
    return usage(`unknown --where '${String(values.where)}'`);
  let version: number | undefined;
  if (typeof values.version === "string") {
    version = Number(values.version);
    if (!Number.isInteger(version) || version < 1) return usage("--version must be an integer ≥ 1");
  }
  return withClient(target, io, "volleyd inbox answer", async (client) => {
    if (version === undefined) {
      const list = await client.request("inbox", { all: true });
      const item = (list.result as { items?: InboxItem[] } | undefined)?.items?.find(
        (i) => i.id === id,
      );
      if (item === undefined) {
        io.stderr(
          `volleyd inbox answer: ${list.ok ? `unknown inbox item '${id}'` : (list.error ?? "inbox request failed")}\n`,
        );
        return EXIT.ERROR;
      }
      version = item.version;
    }
    const flag = typeof values.by === "string" ? values.by : undefined;
    const caller = (await resolveCaller(client, flag, env))?.id ?? null;
    const res = await client.request(
      "inbox_answer",
      { id, version, answer: answer.join(" "), where, ...(caller !== null ? { by: caller } : {}) },
      { text: `volleyd inbox answer ${id}` },
    );
    if (!res.ok) {
      io.stderr(`volleyd inbox answer: ${res.error ?? "refused"}\n`);
      return res.code === BAD_ANSWER ? EXIT.BAD_ANSWER : EXIT.ERROR;
    }
    const item = res.result as InboxItem;
    if (values.json === true) io.stdout(`${JSON.stringify(item, null, 2)}\n`);
    else
      io.stdout(
        `answered ${id} (${whereLabel(item.answered?.where ?? where)}): ${item.answered?.answer}\n`,
      );
    return EXIT.OK;
  });
}
