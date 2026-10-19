import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { briefPrefacePath, formatBriefPreface, readBriefPreface } from "../brief";
import { CONFIG_DEFAULTS } from "../config-defaults";
import { volleydHome } from "../config-store";
import { exec } from "../exec";
import { type CommandArgs, EXIT, type ExitCode } from "../io";
import { criticalPaths } from "../scheduler";
import type { Tunables } from "../types";
import { loadWaveFile } from "../wave-file";
import { checkFreshBase, checkReleaseBranch, expandHome, spawnsLocally } from "../worktree";

const HELP = `Usage: volleyd validate <wave.yaml>

Parse and validate a wave file locally (no daemon needed). Exit 0 when valid, 1 with
path-qualified errors when not. When the wave's repo is on this machine, its release branch must
exist there, locally or as origin/<branch> (RELEASE_BRANCH_MISSING otherwise); a repo that is
not here is noted, and the daemon checks it at \`run\`. With require_fresh_base on (the
default), the repo must also have an origin remote (BASE_STALE otherwise: volleyd fetches the
release branch before every worktree it cuts).

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
    io.stdout(
      `ok: wave ${wave.wave} v${wave.version} — ${wave.task_order.length} task(s), ` +
        `critical path ${longest}, release branch ${wave.release_branch}\n${note}${prefaceLine}\n`,
    );
    return EXIT.OK;
  } catch (e) {
    io.stderr(`volleyd validate: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }
}
