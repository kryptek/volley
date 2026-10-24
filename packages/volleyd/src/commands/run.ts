import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { withSetupCoordinator } from "volley-cli/auth/coordinator-login";
import { formatPlaybook, wavePlaybook } from "../autopilot/playbook";
import { DAEMON_DEFAULTS } from "../config-defaults";
import { type ControlTarget, resolveControlTarget, withClient } from "../control";
import { type CommandArgs, EXIT, type ExitCode } from "../io";
import { resolveCaller } from "../ownership";
import { formatDiff } from "../plan-diff";
import { isSlug } from "../repos";
import type { Wave, WaveState } from "../types";
import { formatWave } from "./status";
import {
  parseWithPlacement,
  placementDefaults,
  places,
  planLines,
  previewPlacement,
  waveTree,
} from "./validate";

/**
 * The `repo:` line for a wave file's `owner/name` as the daemon resolved it (`state.repo`, #448):
 * its clone here, or kept as the slug when only paired machines hold one. Empty for a path.
 */
export function runRepoLine(fileRepo: string, resolved: string): string {
  if (!isSlug(fileRepo)) return "";
  return resolved === fileRepo
    ? `repo: ${fileRepo} (no clone on this machine; its tasks run on the machines that hold it)\n`
    : `repo: ${fileRepo} → ${resolved} (this machine's clone)\n`;
}

const HELP = `Usage: volleyd run <wave.yaml> [--owner <name|agent-id>] [--json] [--broker-url <url>] [--namespace <ns>]

Validate a wave file locally, then submit it to the running daemon. Returns as soon as the
daemon has journaled the wave; tasks start as the scheduler admits them.

The wave's owner (the one coordinator allowed to resolve, pause, stop and steer it) is --owner,
else VOLLEY_AGENT_ID, else the session registered for this directory, else VOLLEY_COORDINATOR
(printed as "(auto)"); a session whose MCP server sets VOLLEY_COORDINATOR owns it by that name,
so the session keeps its waves when its MCP server restarts under a new agent id.
With none of them the wave has no owner: run warns, since nobody can answer its decisions.
Paths a task shares with a running wave's task are printed as overlap warnings (advisory).
If the daemon already runs a wave with this id, the file is that wave's next plan version: the
daemon stores it as $VOLLEYD_HOME/waves/<wave>/v<N>.yaml, journals the structural diff and applies
it (added tasks queue, removed queued tasks cancel, in-flight tasks get a plan_change decision).
Preview the diff with \`volleyd diff <wave> <wave.yaml>\`.
A wave that places tasks (\`placement: auto\`, or a task's \`host: auto\`) also prints where its
tasks would go if admitted now (as \`volleyd validate\` does; a later version only when its file
sets placement:); each is placed at admission.
It prints the overlap plan lines \`volleyd validate\` prints (SPEC §4.6.22), and a warning for each
task without files: whose issue the daemon could not read (footprint_unavailable).
`;

/** Printed when `run` submits a wave with no owner (SPEC §4.6.20). */
export const noOwnerWarning = (wave: string) =>
  `wave ${wave} has no owner: nobody can answer its decisions (pass --owner, set VOLLEY_AGENT_ID or VOLLEY_COORDINATOR, or run from a registered session); it is archived automatically once ended (archive_ended_after_h)`;

export async function run({ argv, env, io }: CommandArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseRun>;
  let target: ControlTarget;
  try {
    parsed = parseRun(argv);
    target = resolveControlTarget(parsed.values, env);
  } catch (e) {
    io.stderr(`volleyd run: ${e instanceof Error ? e.message : String(e)}\n${HELP}`);
    return EXIT.USAGE;
  }
  if (parsed.values.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const file = parsed.positionals[0];
  if (file === undefined || parsed.positionals.length > 1) {
    io.stderr(`volleyd run: expected exactly one wave file\n${HELP}`);
    return EXIT.USAGE;
  }

  // Validate locally first: a bad file fails fast, with or without a daemon.
  let text: string;
  let wave: Wave;
  let playbookLine: string;
  let placementLine: string;
  let placementFromFile: boolean;
  try {
    text = await readFile(file, "utf-8");
    // Placement and the release playbook as read here (the daemon decides both again, and is
    // authoritative).
    ({
      wave,
      placementLine,
      fromFile: placementFromFile,
    } = parseWithPlacement(text, file, placementDefaults(env)));
    const playbook = wavePlaybook(wave);
    playbookLine = `${formatPlaybook(playbook?.display ?? null, playbook?.playbook ?? null)}\n`;
  } catch (e) {
    io.stderr(`volleyd run: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }

  return withClient(target, io, "volleyd run", async (client) => {
    // Without --owner (or VOLLEY_COORDINATOR), the coordinator name `volley setup` saved.
    const named = withSetupCoordinator(env);
    const owner = await resolveCaller(client, parsed.values.owner, named.env);
    const fromSetup = owner.auto && named.saved !== null && owner.id === named.saved;
    if (owner.warning !== undefined) io.stderr(`warning: ${owner.warning}\n`);
    if (owner.id === null) io.stderr(`warning: ${noOwnerWarning(wave.wave)}\n`);
    const res = await client.request(
      "run",
      { wave_yaml: text, source: file, ...(owner.id !== null ? { owner: owner.id } : {}) },
      // The daemon fetches each task issue's body (overlap warnings) before it answers.
      {
        text: `volleyd run ${file}`,
        timeoutMs: DAEMON_DEFAULTS.issue_fetch_ms + DAEMON_DEFAULTS.request_timeout_ms,
      },
    );
    if (!res.ok) {
      io.stderr(`volleyd run: ${res.error ?? "rejected"}\n`);
      return EXIT.ERROR;
    }
    const state = res.result as WaveState;
    const warnings = (res.warnings ?? []).map((w) => `warning: ${w}\n`).join("");
    // Where its auto tasks would go if admitted now (the daemon places each at admission). A later
    // version without placement: keeps the wave's own, which this parse cannot know: no preview.
    const preview = places(wave) && (res.plan === undefined || placementFromFile);
    const placement =
      parsed.values.json !== true && preview
        ? await previewPlacement(
            wave,
            target,
            state.github?.slug ?? (isSlug(wave.repo) ? wave.repo : undefined),
          )
        : "";
    // The overlap plan as validate prints it; the tree from the clone the daemon resolved `repo:` to.
    const repoLine = runRepoLine(wave.repo, state.repo);
    const plan =
      parsed.values.json === true
        ? ""
        : planLines(wave, await waveTree(state.repo, wave.release_branch));
    if (parsed.values.json === true) {
      io.stdout(`${JSON.stringify(state, null, 2)}\n`);
      io.stderr(warnings);
    } else if (res.plan !== undefined) {
      // A later version without placement: keeps the wave's own (SPEC §4.6.15): no default line.
      const placed = placementFromFile ? placementLine : "";
      io.stdout(
        `submitted wave ${state.wave} plan v${res.plan.version}\n${repoLine}${formatDiff(res.plan.diff)}${warnings}${playbookLine}${placed}${placement}${plan}${formatWave(state, { decisions: res.plan.decisions ?? [] })}`,
      );
    } else {
      const auto = fromSetup
        ? " (auto: the coordinator name `volley setup` saved)"
        : owner.auto
          ? " (auto)"
          : "";
      io.stdout(
        `submitted wave ${state.wave} (${state.tasks.length} tasks)\nowner: ${state.owner ?? "none"}${auto}\n${repoLine}${warnings}${playbookLine}${placementLine}${placement}${plan}${formatWave(state)}`,
      );
    }
    return EXIT.OK;
  });
}

function parseRun(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: false },
      owner: { type: "string" },
      "broker-url": { type: "string" },
      namespace: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
}
