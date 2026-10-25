import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { VolleyBroker } from "volley-mcp/broker";
import { parseEnvelope } from "volley-mcp/envelope";
import { randomSuffix } from "volley-mcp/util";
import { parse } from "yaml";
import { formatPlaybook, wavePlaybook } from "../autopilot/playbook";
import { briefPrefacePath, formatBriefPreface, readBriefPreface } from "../brief";
import { authFields } from "../broker-auth";
import { CONFIG_DEFAULTS, DAEMON_DEFAULTS, defaultsFor } from "../config-defaults";
import { ALL_ZERO_WEIGHTS, volleydHome } from "../config-store";
import { CONFIG_TOPIC, type ControlTarget, resolveControlTarget } from "../control";
import { exec } from "../exec";
import { LOCAL_HOST, localMachineName } from "../fleet-name";
import { type Tree, footprintSummary, readReleaseTree } from "../footprint";
import { type CommandArgs, EXIT, type ExitCode } from "../io";
import { MACHINES_FILTER, type MachineRecord, parseMachine } from "../machines";
import { explain } from "../overlap-plan";
import {
  AUTO_HOST,
  type VerdictView,
  needsPlacement,
  preview as placementPreview,
  snapshotFrom,
} from "../placement";
import { repoVerdictFromRecord } from "../readiness";
import { type RepoConfig, holdersOf, isSlug, slugKey } from "../repos";
import { criticalPaths } from "../scheduler";
import type { PlacementConfig, Tunables, Wave } from "../types";
import {
  type PlacementDefaults,
  defaultPlacement,
  filePlan,
  formatPlacement,
  parseWaveFile,
  planNotes,
  resolveWaveRepo,
} from "../wave-file";
import { checkFreshBase, checkReleaseBranch, expandHome, spawnsLocally } from "../worktree";

const HELP = `Usage: volleyd validate <wave.yaml>

Parse and validate a wave file locally (no daemon needed). Exit 0 when valid, 1 with
path-qualified errors when not. When the wave's repo is on this machine, its release branch must
exist there, locally or as origin/<branch> (RELEASE_BRANCH_MISSING otherwise); a repo that is
not here is noted, and the daemon checks it at \`run\`. With require_fresh_base on (the
default), the repo must also have an origin remote (BASE_STALE otherwise: volleyd fetches the
release branch before every worktree it cuts).

A \`repo:\` that is an owner/name is resolved as \`run\` resolves it, from $VOLLEYD_HOME/config.yaml:
"repo: <owner/name> → <path> (this machine's clone)", or "repo: <owner/name> (no clone on this
machine; held by <machines>: its tasks run there)"; one no machine holds is refused.

A wave that places tasks (\`placement: auto\`, or a task's \`host: auto\`) also gets a placement
preview, "if admitted now: T1 → box-a (0.81), T3 → local (0.63)", from the machine records and
readiness verdicts retained on the broker (VOLLEY_BROKER_URL / VOLLEY_NAMESPACE); the real
decision is made when the scheduler admits each task.

Under \`agent_mcp: inherit\` (the wave's \`config:\`, else config.yaml's) it prints which MCP
servers the agents start: "agent_mcp: inherit (allow: migrations, playwright)", or "(every user
server)" with no \`agent_mcp_allow\`.

It also prints the brief preface every agent of the wave would get — its path, size and sha256
prefix, or "none" — and fails with BRIEF_PREFACE_TOO_LARGE when the file is over
brief_preface_max_bytes (the wave's config: value, else $VOLLEYD_HOME/config.yaml's, else the
default; \`run\` re-checks it against the running daemon's config).

And the release playbook (\`playbook:\`, else .volley/release.yaml in the repo): "release
playbook: <path> (N stages, M owner-gated)", or "none" (\`playbook: none\`, or no file at the
default path); an invalid one, or a configured one that does not exist, fails with
RELEASE_PLAYBOOK_INVALID and its path-qualified errors.

Then the overlap plan (SPEC §4.6.22): the file's own plan in words (its clusters, the independent
tasks, the expected branch updates), a "note: …" for each place the planner would differ when
the repo's tree reads here (advisory: the file is kept as written), and the footprint line
("footprints: 3 listed, 1 guessed (#7)"), or "footprints: none (…)" when no task has files:.
`;

/**
 * A top-level tunable as \`run\` would see it with no `config:` in the wave: the operator's
 * `$VOLLEYD_HOME/config.yaml` over the default. A file that does not parse is the daemon's to
 * report; validate falls back to the default.
 */
function globalTunable<
  K extends "brief_preface_max_bytes" | "require_fresh_base" | "agent_mcp" | "agent_mcp_allow",
>(env: CommandArgs["env"], key: K, valid: (v: unknown) => boolean): Tunables[K] {
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

/**
 * `agent_mcp: inherit (allow: a, b)` (or `(every user server)`) when the wave's agents inherit the
 * user's MCP servers, from the wave's `config:` over config.yaml; empty under `strict`.
 */
export function agentMcpLine(wave: Wave, env: CommandArgs["env"]): string {
  const mode =
    wave.config.agent_mcp ??
    globalTunable(env, "agent_mcp", (v) => v === "strict" || v === "inherit");
  if (mode !== "inherit") return "";
  const allow =
    wave.config.agent_mcp_allow ??
    globalTunable(
      env,
      "agent_mcp_allow",
      (v) => Array.isArray(v) && v.every((n) => typeof n === "string"),
    );
  return `agent_mcp: inherit (${allow.length > 0 ? `allow: ${allow.join(", ")}` : "every user server"})\n`;
}

/**
 * What a wave without `placement:` takes as `run` would see it here: config.yaml's
 * `placement.default` over the built-in, and its paired machines (`hosts.<name>`, the own
 * machine's name aside), with this machine's name and theirs (so a host name is checked and the
 * placement line names them). No config.yaml, or one that does not parse (the daemon's to
 * report): the built-in, none, and no name checked.
 */
export function placementDefaults(env: CommandArgs["env"]): PlacementDefaults {
  const fallback: PlacementDefaults = { default: CONFIG_DEFAULTS.placement.default, paired: 0 };
  const file = join(volleydHome(env), "config.yaml");
  if (!existsSync(file)) return fallback;
  try {
    const cfg = parse(readFileSync(file, "utf-8")) as {
      placement?: { default?: unknown };
      hosts?: unknown;
      fleet?: { local_name?: unknown };
    } | null;
    const def = cfg?.placement?.default;
    const hosts =
      cfg?.hosts !== null && typeof cfg?.hosts === "object" ? Object.keys(cfg.hosts) : [];
    const name = cfg?.fleet?.local_name;
    const local = localMachineName(typeof name === "string" ? name : null);
    const pairedNames = hosts.filter((n) => n !== LOCAL_HOST && n !== local && n !== name);
    return {
      default: def === "local" || def === "auto" ? def : fallback.default,
      paired: pairedNames.length,
      local,
      pairedNames,
    };
  } catch {
    return fallback;
  }
}

/**
 * The wave file `text` parsed under `defaults`, with its placement line
 * (`placement: auto (placement.default; 1 paired machine)`) and a `note:` line per retired key
 * its `config:` dropped.
 */
export function parseWithPlacement(
  text: string,
  file: string,
  defaults: PlacementDefaults,
): { wave: Wave; placementLine: string; fromFile: boolean; notes: string } {
  const dropped: string[] = [];
  const wave = parseWaveFile(text, file, defaults, dropped);
  // Valid, so a mapping; `placement:` and `config:` as written.
  const raw = parse(text) as { placement?: "auto" | "local"; config?: Wave["config"] };
  const placed = defaultPlacement(raw, defaults);
  return {
    wave,
    placementLine: `${formatPlacement(placed, defaults)}\n`,
    fromFile: placed.by === "wave file",
    notes: dropped.map((n) => `note: ${n}\n`).join(""),
  };
}

/**
 * What resolving a wave file's `owner/name` `repo:` reads, offline (#448): config.yaml's `repos`,
 * `hosts` and `fleet.repo_root` / `fleet.local_name` over the defaults the daemon starts from. A
 * file that does not parse is the daemon's to report: nothing configured, and `unparsed` names it.
 */
export function offlineRepoConfig(env: CommandArgs["env"]): {
  cfg: RepoConfig;
  local: string;
  unparsed?: string;
} {
  const defaults = defaultsFor(env);
  const file = join(volleydHome(env), "config.yaml");
  type Raw = {
    repos?: unknown;
    hosts?: unknown;
    fleet?: { repo_root?: unknown; local_name?: unknown };
  } | null;
  let raw: Raw = null;
  let unparsed: string | undefined;
  try {
    raw = existsSync(file) ? (parse(readFileSync(file, "utf-8")) as Raw) : null;
  } catch {
    unparsed = file;
  }
  const map = (v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, never>) : {};
  const root = raw?.fleet?.repo_root;
  const name = raw?.fleet?.local_name;
  return {
    cfg: {
      repos: map(raw?.repos),
      hosts: map(raw?.hosts),
      fleet: { repo_root: typeof root === "string" ? root : defaults.fleet.repo_root },
    },
    local: localMachineName(typeof name === "string" ? name : null),
    ...(unparsed !== undefined ? { unparsed } : {}),
  };
}

/**
 * The wave file's `owner/name` `repo:` resolved as `run` resolves it (`resolveWaveRepo`), and the
 * line saying which it became: `repo: <slug> → <path> (this machine's clone)`, or `repo: <slug>
 * (no clone on this machine; held by <machines>: its tasks run there)`. A path: unchanged, no line.
 */
export function resolveOffline(
  wave: Wave,
  env: CommandArgs["env"],
  file: string,
): { wave: Wave; repoLine: string } {
  if (!isSlug(wave.repo)) return { wave, repoLine: "" };
  const { cfg, local, unparsed } = offlineRepoConfig(env);
  let resolved: Wave;
  try {
    resolved = resolveWaveRepo(wave, cfg, local, homedir(), file);
  } catch (e) {
    // a malformed config.yaml reads as nothing configured: say so beside the refusal
    if (unparsed === undefined || !(e instanceof Error)) throw e;
    e.message += ` (${unparsed} does not parse: read as nothing configured)`;
    throw e;
  }
  if (resolved.repo !== wave.repo)
    return {
      wave: resolved,
      repoLine: `repo: ${wave.repo} → ${resolved.repo} (this machine's clone)\n`,
    };
  const holders = holdersOf(cfg, local, wave.repo).filter((m) => m !== local);
  return {
    wave: resolved,
    repoLine: `repo: ${wave.repo} (no clone on this machine; held by ${holders.join(", ")}: its tasks run there)\n`,
  };
}

/** Printed for a wave none of whose tasks has `files:` (SPEC §4.6.22). */
export const NO_FOOTPRINTS =
  "footprints: none (write them with wave-from-issues, or the daemon reads each issue's Files list at run)";

/**
 * The tree the wave's tasks start from, when its repository is a checkout on this machine
 * (`repo` as resolved: a path; null otherwise — an `owner/name` included — or when the release
 * branch does not read).
 */
export async function waveTree(repo: string, branch: string): Promise<Tree | null> {
  // An `owner/name` the supervisor holds no clone of (#448): no tree here.
  if (isSlug(repo)) return null;
  const dir = expandHome(repo);
  return existsSync(dir) ? readReleaseTree(exec, dir, branch) : null;
}

/**
 * The overlap plan lines `validate` and `run` print after the placement line: `explain` of the
 * file's own plan (when it has one), then where the planner would differ (`note: …`, with the
 * tree only: without sizes every coupling is 0), then the footprint line.
 */
export function planLines(wave: Wave, tree: Tree | null): string {
  const tasks = wave.task_order.flatMap((id) => {
    const t = wave.tasks[id];
    return t === undefined || t.synthetic === true ? [] : [t];
  });
  if (!tasks.some((t) => t.files.length > 0)) return `${NO_FOOTPRINTS}\n`;
  const out = wave.overlap_plan !== undefined ? explain(filePlan(wave, tree ?? {})) : [];
  if (tree !== null) out.push(...planNotes(wave, tree).map((n) => `note: ${n}`));
  const footprints = tasks.map((t) => ({
    id: t.id,
    issues: t.issues ?? [t.issue],
    footprint: t.footprint ?? { confidence: t.files.length > 0 ? "listed" : "none" },
  }));
  out.push(footprintSummary(footprints, "inline"));
  return out.map((l) => `${l}\n`).join("");
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

/**
 * `volleyd run` needs an owner to answer its decisions (an ownerless wave only auto-archives).
 * Shown unless VOLLEY_AGENT_ID or VOLLEY_COORDINATOR names the caller (validate is offline: the registry is not read).
 */
const OWNER_NOTE =
  "note: `volleyd run` needs an owner (--owner, VOLLEY_AGENT_ID, a registered session or VOLLEY_COORDINATOR): an ownerless wave's decisions go unanswered\n";

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
    const parsed = parseWithPlacement(readFileSync(file, "utf-8"), file, placementDefaults(env));
    const { placementLine, notes } = parsed;
    // An `owner/name` repo: as the daemon resolves it at submit (#448).
    const { wave, repoLine } = resolveOffline(parsed.wave, env, file);
    const slug = isSlug(parsed.wave.repo) ? parsed.wave.repo : undefined;
    if (notes !== "") io.stderr(notes);
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
      // as `run`: every task runs on a remote host, whose clone is checked on the box (an
      // `owner/name` no clone here holds always: its local-pinned tasks are refused above)
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
    const playbook = wavePlaybook(wave);
    const playbookLine = formatPlaybook(playbook?.display ?? null, playbook?.playbook ?? null);
    const cp = criticalPaths(wave);
    const longest = Math.max(...Object.values(cp));
    let placement = "";
    if (places(wave)) {
      let target: ControlTarget | null = null;
      try {
        target = resolveControlTarget({}, env);
      } catch {}
      placement = target === null ? "" : await previewPlacement(wave, target, slug);
    }
    io.stdout(
      `ok: wave ${wave.wave} v${wave.version} — ${wave.task_order.length} task(s), ` +
        `critical path ${longest}, release branch ${wave.release_branch}\n` +
        `${env.VOLLEY_AGENT_ID || env.VOLLEY_COORDINATOR ? "" : OWNER_NOTE}` +
        `${repoLine}${note}${localPinWarnings(wave, env)}${agentMcpLine(wave, env)}${prefaceLine}\n${playbookLine}\n${placementLine}${placement}${planLines(wave, await waveTree(wave.repo, wave.release_branch))}`,
    );
    return EXIT.OK;
  } catch (e) {
    io.stderr(`volleyd validate: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }
}

// --- Fleet (F3): placement preview, shared with `run` ---

/**
 * The repository whose clone on the supervisor's own machine is `repo` (its verdict's `repos`):
 * a wave file's repository without asking GitHub, when a running wave shares the clone.
 */
function slugByClone(own: VerdictView | undefined, repo: string): string | undefined {
  const dir = resolve(expandHome(repo));
  return Object.entries(own?.repos ?? {}).find(([, v]) => v.path === dir)?.[0];
}

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
 * The wave's repository (`slug`, #436; unset: the supervisor's own verdict's repository whose
 * clone is the wave's `repo`) filters out machines without a ready clone of it.
 */
export async function previewPlacement(
  wave: Wave,
  target: ControlTarget,
  slug?: string,
): Promise<string> {
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
    const waveSlug =
      slug ??
      slugByClone(
        verdicts.find((v) => v.name === localName),
        wave.repo,
      );
    if (waveSlug !== undefined) {
      // A peer's verdict that does not judge the wave's repository yet (no running wave shares
      // it): judged from its record. The own machine holds the wave's clone.
      for (const v of verdicts) {
        if (v.name === localName || slugKey(v.repos, waveSlug) !== undefined) continue;
        const r = repoVerdictFromRecord(
          v.name,
          records.find((x) => x.name === v.name),
          waveSlug,
        );
        if (r !== undefined) v.repos = { ...v.repos, [waveSlug]: r };
      }
    }
    const line = placementPreview(wave, snapshotFrom(records, verdicts, localName), {
      ...(waveSlug !== undefined ? { waveSlug } : {}),
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
