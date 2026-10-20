import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { VolleyBroker } from "volley-mcp/broker";
import { parseEnvelope } from "volley-mcp/envelope";
import { randomSuffix } from "volley-mcp/util";
import { parse } from "yaml";
import { briefPrefacePath, formatBriefPreface, readBriefPreface } from "../brief";
import { authFields } from "../broker-auth";
import { CONFIG_DEFAULTS, DAEMON_DEFAULTS } from "../config-defaults";
import { ALL_ZERO_WEIGHTS, volleydHome } from "../config-store";
import { CONFIG_TOPIC, type ControlTarget, resolveControlTarget } from "../control";
import { exec } from "../exec";
import { LOCAL_HOST } from "../fleet-name";
import { type CommandArgs, EXIT, type ExitCode } from "../io";
import { MACHINES_FILTER, type MachineRecord, parseMachine } from "../machines";
import {
  AUTO_HOST,
  type VerdictView,
  needsPlacement,
  preview as placementPreview,
  snapshotFrom,
} from "../placement";
import { criticalPaths } from "../scheduler";
import type { PlacementConfig, Tunables, Wave } from "../types";
import { loadWaveFile } from "../wave-file";
import { checkFreshBase, checkReleaseBranch, expandHome, spawnsLocally } from "../worktree";

const HELP = `Usage: volleyd validate <wave.yaml>

Parse and validate a wave file locally (no daemon needed). Exit 0 when valid, 1 with
path-qualified errors when not. When the wave's repo is on this machine, its release branch must
exist there, locally or as origin/<branch> (RELEASE_BRANCH_MISSING otherwise); a repo that is
not here is noted, and the daemon checks it at \`run\`. With require_fresh_base on (the
default), the repo must also have an origin remote (BASE_STALE otherwise: volleyd fetches the
release branch before every worktree it cuts).

A wave that places tasks (\`placement: auto\`, or a task's \`host: auto\`) also gets a placement
preview, "if admitted now: T1 → box-a (0.81), T3 → local (0.63)", from the machine records and
readiness verdicts retained on the broker (VOLLEY_BROKER_URL / VOLLEY_NAMESPACE); the real
decision is made when the scheduler admits each task.

It also prints the brief preface every agent of the wave would get — its path, size and sha256
prefix, or "none" — and fails with BRIEF_PREFACE_TOO_LARGE when the file is over
brief_preface_max_bytes (the wave's config: value, else $VOLLEYD_HOME/config.yaml's, else the
default; \`run\` re-checks it against the running daemon's config).
`;

/**
 * A top-level tunable as \`run\` would see it with no `config:` in the wave: the operator's
 * `$VOLLEYD_HOME/config.yaml` over the default. A file that does not parse is the daemon's to
 * report; validate falls back to the default.
 */
function globalTunable<K extends "brief_preface_max_bytes" | "require_fresh_base">(
  env: CommandArgs["env"],
  key: K,
  valid: (v: unknown) => boolean,
): Tunables[K] {
  const fallback = CONFIG_DEFAULTS[key];
  const file = join(volleydHome(env), "config.yaml");
  if (!existsSync(file)) return fallback;
  try {
    const v = (parse(readFileSync(file, "utf-8")) as Record<string, unknown> | null)?.[key];
    return valid(v) ? (v as Tunables[K]) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * `warning: T1 pins host: local while fleet.local_agents is never …`, one line per task of a
 * `placement: auto` wave that names the own machine while the wave's `config:` or config.yaml
 * sets `never` (SPEC §4.6.15): the wave file is explicit, so the task still runs there. Empty
 * otherwise.
 */
export function localPinWarnings(wave: Wave, env: CommandArgs["env"]): string {
  if (wave.placement !== AUTO_HOST) return "";
  const file = join(volleydHome(env), "config.yaml");
  // The wave's own `config:` layer wins over config.yaml, as it does in effective config.
  let mode: unknown = (wave.config as { fleet?: { local_agents?: unknown } }).fleet?.local_agents;
  try {
    mode ??= existsSync(file)
      ? (parse(readFileSync(file, "utf-8")) as { fleet?: { local_agents?: unknown } } | null)?.fleet
          ?.local_agents
      : undefined;
  } catch {
    return "";
  }
  if (mode !== "never") return "";
  return wave.task_order
    .filter((id) => wave.tasks[id]?.host === LOCAL_HOST)
    .map(
      (id) =>
        `warning: ${id} pins host: local while fleet.local_agents is never; it still runs there (the wave file is explicit)\n`,
    )
    .join("");
}

/** `config.yaml`'s `placement.weights` (none: {}), for the merged all-zero check `run` makes. */
function globalWeights(env: CommandArgs["env"]): Partial<PlacementConfig["weights"]> {
  const file = join(volleydHome(env), "config.yaml");
  if (!existsSync(file)) return {};
  try {
    const cfg = parse(readFileSync(file, "utf-8")) as {
      placement?: { weights?: Partial<PlacementConfig["weights"]> };
    } | null;
    return cfg?.placement?.weights ?? {};
  } catch {
    return {};
  }
}

export async function validate({ argv, env, io }: CommandArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: { help: { type: "boolean", short: "h" } },
      allowPositionals: true,
    });
  } catch (e) {
    io.stderr(`volleyd validate: ${e instanceof Error ? e.message : String(e)}\n${HELP}`);
    return EXIT.USAGE;
  }
  if (parsed.values.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const file = parsed.positionals[0];
  if (file === undefined || parsed.positionals.length > 1) {
    io.stderr(`volleyd validate: expected exactly one wave file\n${HELP}`);
    return EXIT.USAGE;
  }
  try {
    const wave = await loadWaveFile(file);
    const weights = {
      ...CONFIG_DEFAULTS.placement.weights,
      ...globalWeights(env),
      ...wave.config.placement?.weights,
    };
    if (Object.values(weights).every((w) => w === 0)) {
      io.stderr(
        `volleyd validate: config.placement.weights: ${ALL_ZERO_WEIGHTS} with the global config\n`,
      );
      return EXIT.ERROR;
    }
    const repo = expandHome(wave.repo);
    let note = "";
    if (!spawnsLocally(wave)) {
      // as `run`: every task runs on a remote host, whose clone is checked on the box
    } else if (!existsSync(repo)) {
      note = `note: ${repo} is not on this machine; release branch not checked\n`;
    } else {
      const missing = await checkReleaseBranch(exec, repo, wave.release_branch);
      if (missing !== null) {
        // validate stays offline; `run` fetches the branch first
        const hint = missing.includes(" has neither ")
          ? `\n  (pushed from another clone? \`git -C ${repo} fetch origin\` — \`volleyd run\` fetches it)`
          : "";
        io.stderr(`volleyd validate: ${missing}${hint}\n`);
        return EXIT.ERROR;
      }
      // require_fresh_base on and no origin: every spawn would be refused. Say so now.
      const fresh =
        wave.config.require_fresh_base ??
        globalTunable(env, "require_fresh_base", (v) => typeof v === "boolean");
      const stale = fresh ? await checkFreshBase(exec, repo, wave.release_branch) : null;
      if (stale !== null) {
        io.stderr(`volleyd validate: ${stale}\n`);
        return EXIT.ERROR;
      }
    }
    const prefacePath = briefPrefacePath(wave.repo, wave.brief_preface);
    const preface = readBriefPreface(
      prefacePath,
      wave.config.brief_preface_max_bytes ??
        globalTunable(env, "brief_preface_max_bytes", (v) => Number.isInteger(v)),
    );
    const prefaceLine =
      preface === null
        ? `${formatBriefPreface(null)} (no ${prefacePath})`
        : formatBriefPreface(preface);
    const cp = criticalPaths(wave);
    const longest = Math.max(...Object.values(cp));
    let placement = "";
    if (places(wave)) {
      let target: ControlTarget | null = null;
      try {
        target = resolveControlTarget({}, env);
      } catch {}
      placement = target === null ? "" : await previewPlacement(wave, target);
    }
    io.stdout(
      `ok: wave ${wave.wave} v${wave.version} — ${wave.task_order.length} task(s), ` +
        `critical path ${longest}, release branch ${wave.release_branch}\n${note}${localPinWarnings(wave, env)}${prefaceLine}\n${placement}`,
    );
    return EXIT.OK;
  } catch (e) {
    io.stderr(`volleyd validate: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }
}

// --- Fleet (F3): placement preview, shared with `run` ---

/** Whether the wave has a task the supervisor places. */
export const places = (wave: Wave): boolean =>
  wave.task_order.some((id) => {
    const t = wave.tasks[id];
    return t !== undefined && needsPlacement(t);
  });

/**
 * The placement preview lines for `wave` ("if admitted now: …", and that the real decision is
 * made at admission), from what the supervisor retains on the broker: its effective config
 * (`fleet.local_name`, `placement`, `claude.warn_at_pct`), every machine record and every
 * readiness verdict it published. Read-only; a broker or supervisor that cannot be read says so.
 */
export async function previewPlacement(wave: Wave, target: ControlTarget): Promise<string> {
  const broker = new VolleyBroker();
  try {
    await broker.connect({
      url: target.brokerUrl,
      agentId: `volleyd-cli-${randomSuffix(6)}`,
      connectTimeoutMs: DAEMON_DEFAULTS.probe_ms,
      ...authFields(target.auth),
    });
  } catch (e) {
    return `placement preview unavailable (${e instanceof Error ? e.message : String(e)}): tasks are placed at admission\n`;
  }
  try {
    const wait = DAEMON_DEFAULTS.registry_scan_ms;
    const config = parseEnvelope((await broker.queryRetained(CONFIG_TOPIC, wait)) ?? "");
    if (config === null || config.agent_id !== "volleyd") {
      return "placement preview unavailable (no supervisor config on the broker): tasks are placed at admission\n";
    }
    const cfg = config.payload as Partial<Tunables>;
    const records: MachineRecord[] = [];
    for (const m of await broker.subscribeCollect(
      MACHINES_FILTER,
      Number.POSITIVE_INFINITY,
      wait,
    )) {
      const r = parseMachine(m.topic, m.payload);
      if (r !== null) records.push(r);
    }
    const verdicts: VerdictView[] = [];
    for (const m of await broker.subscribeCollect(
      `${MACHINES_FILTER}/readiness`,
      Number.POSITIVE_INFINITY,
      wait,
    )) {
      const env = m.payload === "" ? null : parseEnvelope(m.payload);
      // Only the supervisor publishes readiness (SPEC §4.6.15).
      if (env !== null && env.agent_id === "volleyd") verdicts.push(env.payload as VerdictView);
    }
    const base = { ...CONFIG_DEFAULTS.placement, ...cfg.placement };
    const over = wave.config.placement ?? {};
    const placement: PlacementConfig = {
      ...base,
      ...over,
      weights: { ...base.weights, ...over.weights },
    };
    const localName = cfg.fleet?.local_name ?? "";
    const line = placementPreview(wave, snapshotFrom(records, verdicts, localName), {
      placement,
      warn_at_pct:
        wave.config.claude?.warn_at_pct ??
        cfg.claude?.warn_at_pct ??
        CONFIG_DEFAULTS.claude.warn_at_pct,
      localName,
      // The retained config carries the resolved mode; a supervisor that predates it: always.
      local_agents: cfg.fleet?.local_agents ?? "always",
      fallback: cfg.fleet?.fallback ?? CONFIG_DEFAULTS.fleet.fallback,
    });
    return line === null
      ? ""
      : `${line}\n  (from the machines' records now; the real decision is made at admission)\n`;
  } finally {
    await broker.disconnect();
  }
}
