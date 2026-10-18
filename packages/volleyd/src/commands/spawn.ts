import { parseArgs } from "node:util";
import { ROLES } from "../brief";
import { DAEMON_DEFAULTS } from "../config-defaults";
import { resolveTarget, withClient } from "../control";
import { type CommandArgs, EXIT, type ExitCode } from "../io";

const HELP = `Usage: volleyd spawn <wave> <task> [--role <role>] [--json] [--broker-url <url>] [--namespace <ns>]

Ask the daemon to spawn one agent for a task of a submitted wave now, outside admission: repo
trust check, worktree lock, worktree, ISSUE.md, brief + gate, identity, launch. Returns once the
agent is launched (or refused); the daemon then verifies it through the hook signals.

  --role <role>   ${ROLES.join(" | ")} (default implementer)

Refusals print their code: SPAWN_LOCKED (the worktree's agent is still live),
SPAWN_BRIEF_REJECTED, ISSUE_MISMATCH, CREDENTIALS_FAILED, … Exit 1 on a refusal.
`;

export async function spawn({ argv, env, io }: CommandArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseSpawn>;
  let target: ReturnType<typeof resolveTarget>;
  try {
    parsed = parseSpawn(argv);
    target = resolveTarget(parsed.values, env);
  } catch (e) {
    io.stderr(`volleyd spawn: ${e instanceof Error ? e.message : String(e)}\n${HELP}`);
    return EXIT.USAGE;
  }
  if (parsed.values.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const [wave, task, ...extra] = parsed.positionals;
  if (wave === undefined || task === undefined || extra.length > 0) {
    io.stderr(`volleyd spawn: expected <wave> <task>\n${HELP}`);
    return EXIT.USAGE;
  }
  const role = parsed.values.role ?? "implementer";
  return withClient(target, io, "volleyd spawn", async (client) => {
    const res = await client.request(
      "spawn",
      { wave, task, role },
      {
        text: `volleyd spawn ${wave} ${task} --role ${role}`,
        timeoutMs: DAEMON_DEFAULTS.spawn_request_timeout_ms,
      },
    );
    if (parsed.values.json === true) {
      io.stdout(`${JSON.stringify(res, null, 2)}\n`);
      return res.ok ? EXIT.OK : EXIT.ERROR;
    }
    const r = (res.result ?? {}) as Record<string, unknown>;
    if (!res.ok) {
      io.stderr(`volleyd spawn: ${res.error ?? "refused"}\n`);
      return EXIT.ERROR;
    }
    if (r.kind === "launched") {
      io.stdout(
        `launched ${String(r.agent_id)} in ${String(r.workspace)} (${String(r.worktree)}); verifying via hooks\n`,
      );
    } else {
      io.stdout(`parked: decision ${String(r.decision)} (${String(r.decision_id)}) needs you\n`);
    }
    return EXIT.OK;
  });
}

function parseSpawn(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      role: { type: "string" },
      json: { type: "boolean", default: false },
      "broker-url": { type: "string" },
      namespace: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
}
