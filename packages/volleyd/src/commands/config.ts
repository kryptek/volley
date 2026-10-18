import { parseArgs } from "node:util";
import { parse } from "yaml";
import { resolveTarget, withClient } from "../control";
import { type CommandArgs, EXIT, type ExitCode } from "../io";

const HELP = `Usage:
  volleyd config get [path] [--wave <id>] [--json]
  volleyd config set <path> <value> [--by <who>]

get prints the daemon's effective config (or one dotted path, e.g. admission.ci_queue_max),
optionally with a wave's config: overrides applied. set sends a config_set request over the
control channel; the daemon validates it against the config schema, writes config.yaml,
journals config_changed and applies it without a restart. <value> is parsed as YAML
(2, null, "text", [a, b], { capacity: 1 }).

Common flags: --broker-url <url>  --namespace <ns>
`;

export async function config({ argv, env, io }: CommandArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseConfig>;
  let target: ReturnType<typeof resolveTarget>;
  try {
    parsed = parseConfig(argv);
    target = resolveTarget(parsed.values, env);
  } catch (e) {
    io.stderr(`volleyd config: ${e instanceof Error ? e.message : String(e)}\n${HELP}`);
    return EXIT.USAGE;
  }
  const [action, ...rest] = parsed.positionals;
  if (parsed.values.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }

  if (action === "get" && rest.length <= 1) {
    const [path] = rest;
    const wave = parsed.values.wave;
    return withClient(target, io, "volleyd config get", async (client) => {
      const res = await client.request("config_get", {
        ...(path !== undefined ? { path } : {}),
        ...(wave !== undefined ? { wave } : {}),
      });
      if (!res.ok) {
        io.stderr(`volleyd config get: ${res.error ?? "failed"}\n`);
        return EXIT.ERROR;
      }
      const v = res.result;
      const plain = parsed.values.json !== true && (typeof v !== "object" || v === null);
      io.stdout(plain ? `${String(v)}\n` : `${JSON.stringify(v, null, 2)}\n`);
      return EXIT.OK;
    });
  }

  if (action === "set" && rest.length === 2) {
    const [path, raw] = rest as [string, string];
    let patch: Record<string, unknown>;
    try {
      patch = patchFor(path, parse(raw) as unknown);
    } catch (e) {
      io.stderr(`volleyd config set: ${e instanceof Error ? e.message : String(e)}\n`);
      return EXIT.USAGE;
    }
    const by = parsed.values.by ?? env.VOLLEY_AGENT_ID ?? "volleyd-cli";
    return withClient(target, io, "volleyd config set", async (client) => {
      const res = await client.request(
        "config_set",
        { patch, by },
        { text: `config_set ${path}=${raw}` },
      );
      if (res.applied !== true) {
        const why = (res.rejected ?? []).map((r) => `  ${r.path}: ${r.reason}\n`).join("");
        io.stderr(
          `volleyd config set: rejected${res.error !== undefined ? ` (${res.error})` : ""}\n${why}`,
        );
        return EXIT.ERROR;
      }
      const version = (res.result as { version?: number } | undefined)?.version;
      io.stdout(`config v${version}: ${path} = ${raw} (by ${by})\n`);
      return EXIT.OK;
    });
  }

  io.stderr(`volleyd config: expected 'get [path]' or 'set <path> <value>'\n${HELP}`);
  return EXIT.USAGE;
}

/** `admission.ci_queue_max`, 5 → `{ admission: { ci_queue_max: 5 } }`. */
export function patchFor(path: string, value: unknown): Record<string, unknown> {
  const segs = path.split(".");
  if (segs.some((s) => s === "")) throw new Error(`invalid config path '${path}'`);
  return segs.reduceRight<unknown>((acc, seg) => ({ [seg]: acc }), value) as Record<
    string,
    unknown
  >;
}

function parseConfig(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      wave: { type: "string" },
      by: { type: "string" },
      json: { type: "boolean", default: false },
      "broker-url": { type: "string" },
      namespace: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
}
