import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { BrokerAuth } from "volley-mcp/config";
import { resolveAuth, resolveBrokerUrl, resolveNamespace } from "../args";
import { volleydHome } from "../auth/context";
import { applyDeploy } from "../deploy/apply";
import { deployFence } from "../deploy/fence";
import { deskHealthy, volleydHealthy } from "../deploy/health";
import {
  DEPLOY,
  type Ref,
  type ServicesInstall,
  deployPlan,
  git,
  normaliseTag,
  parseDirty,
  platformServices,
  refLabel,
  resolveTag,
  servicesCheckout,
  stashName,
} from "../deploy/plan";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { readSetupInstall } from "../setup/journal";
import type { SetupExec } from "../setup/step";
import { findRepoRoot } from "./dash";
import { DESK_PORT } from "./desk-serve";

/**
 * `volley deploy [<tag>|--latest] [--dry-run]`: take the checkout this machine's volleyd and Desk
 * services run from to a release tag, build the Desk, self-check, restart both services,
 * health-check, and roll back to the previous ref on a failure. Waves survive the restart
 * (volleyd reconciles on start); the deploy sends volleyd no control op.
 */

export interface DeployDeps {
  /** Unfenced: the command puts `deployFence` in front of it. */
  exec: SetupExec;
  platform: NodeJS.Platform;
  uid: number;
  /** The user's home (where the service units live). */
  home: string;
  /** The checkout this `volley` runs from, or null. */
  runningRepo: string | null;
  /** The bun to use when no installed service names one. */
  bun: string;
  now: () => Date;
  deskHealthy: (base: string, version: string | null) => Promise<string | null>;
  volleydHealthy: (opts: {
    brokerUrl: string;
    auth: BrokerAuth | null;
    namespace: string;
    since: Date;
  }) => Promise<string | null>;
}

const wait = { timeoutMs: DEPLOY.health_timeout_ms, pollMs: DEPLOY.poll_ms };

async function realDeployDeps(env: Record<string, string | undefined>): Promise<DeployDeps> {
  const { realSetupDeps } = await import("./setup");
  return {
    exec: realSetupDeps(env).exec,
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    home: env.HOME ?? homedir(),
    runningRepo: findRepoRoot(),
    bun: process.execPath,
    now: () => new Date(),
    deskHealthy: (base, version) => deskHealthy(base, version, wait),
    volleydHealthy: (o) => volleydHealthy({ ...o, ...wait }),
  };
}

/** Where volleyd's installed unit lives on `platform`. */
const unitFile = (platform: NodeJS.Platform, home: string) =>
  platform === "darwin"
    ? join(home, "Library", "LaunchAgents", "systems.volley.volleyd.plist")
    : join(home, ".config", "systemd", "user", "volleyd.service");

const read = (p: string) => {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
};

export interface DeployArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
  deps?: DeployDeps;
}

export async function deploy({ argv, env, io, deps: given }: DeployArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        latest: { type: "boolean" },
        "dry-run": { type: "boolean" },
        "force-clean": { type: "boolean" },
        repo: { type: "string" },
        "desk-port": { type: "string" },
        "broker-url": { type: "string" },
        namespace: { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    io.stderr(`volley deploy: ${e instanceof Error ? e.message : String(e)}\n${DEPLOY_HELP}`);
    return EXIT.USAGE;
  }
  const v = parsed.values;
  const str = (k: string) => v[k] as string | undefined;
  if (v.help === true) {
    io.stdout(DEPLOY_HELP);
    return EXIT.OK;
  }
  const usage = (msg: string) => {
    io.stderr(`volley deploy: ${msg}\n`);
    return EXIT.USAGE;
  };
  const latest = v.latest === true;
  if (parsed.positionals.length > 1) return usage("one tag at most");
  const [tagArg] = parsed.positionals;
  if ((tagArg === undefined) === !latest) {
    io.stderr(`volley deploy: give a tag or --latest (not both)\n${DEPLOY_HELP}`);
    return EXIT.USAGE;
  }
  let requested = "latest";
  if (tagArg !== undefined) {
    try {
      requested = normaliseTag(tagArg);
    } catch (e) {
      return usage(e instanceof Error ? e.message : String(e));
    }
  }
  const portText = str("desk-port");
  if (portText !== undefined && (!/^\d+$/.test(portText) || Number(portText) > 65_535)) {
    return usage("--desk-port must be a port number (0..65535)");
  }
  let brokerUrl: string;
  let auth: BrokerAuth | null;
  let namespace: string;
  try {
    brokerUrl = resolveBrokerUrl(str("broker-url"), env);
    namespace = resolveNamespace(str("namespace"), env);
    auth = resolveAuth(
      { username: str("username"), password: str("password") },
      env,
      process.cwd(),
      brokerUrl,
    );
  } catch (e) {
    return usage(e instanceof Error ? e.message : String(e));
  }

  const deps = given ?? (await realDeployDeps(env));
  const services = platformServices(deps.platform, deps.uid);
  if (services === null) {
    io.stderr(`volley deploy: no service manager known here (${deps.platform})\n`);
    return EXIT.USAGE;
  }

  // The services checkout: --repo, else the one volleyd's installed unit runs, else this one.
  const unit = unitFile(deps.platform, deps.home);
  const unitText = read(unit);
  const installed: ServicesInstall | null = unitText === null ? null : servicesCheckout(unitText);
  let repo: string;
  let source: string;
  const notes: string[] = [];
  const repoFlag = str("repo");
  if (repoFlag !== undefined) {
    repo = resolve(repoFlag);
    if (!existsSync(join(repo, "bun.lock"))) {
      return usage(`--repo ${repo} is not a Volley checkout (no bun.lock)`);
    }
    source = "--repo";
    if (installed !== null && installed.repo !== repo) {
      notes.push(`note: the services run from ${installed.repo}; deploying into --repo ${repo}`);
    }
  } else if (installed !== null) {
    repo = installed.repo;
    source = `from ${unit}`;
  } else if (deps.runningRepo !== null) {
    repo = deps.runningRepo;
    source = "this volley's own checkout";
    notes.push(
      `note: no volleyd service is installed (${unit}); using the checkout this volley runs from`,
    );
  } else {
    return usage(`no volleyd service is installed (${unit}) and no checkout found; pass --repo`);
  }
  const bun = installed?.bun ?? deps.bun;
  const deskPort =
    portText !== undefined
      ? Number(portText)
      : (readSetupInstall(volleydHome(env))?.desk_port ?? DESK_PORT);
  const fence = deployFence({ repo, bun, services });
  const exec: SetupExec = async (a, o) => {
    fence(a, o);
    return deps.exec(a, o);
  };

  io.stdout(`services checkout: ${repo} (${source})\n`);
  for (const n of notes) io.stdout(`${n}\n`);

  // Read-only: local changes, and where the checkout is now.
  const status = await exec(git(repo, "status", "--porcelain"));
  if (status.code !== 0) {
    io.stderr(`volley deploy: git status failed in ${repo}: ${status.stderr.trim()}\n`);
    return EXIT.ERROR;
  }
  const dirty = parseDirty(status.stdout);
  const stash = dirty.length > 0 && v["force-clean"] === true ? stashName(deps.now()) : undefined;
  if (dirty.length > 0 && stash === undefined) {
    io.stderr(
      `volley deploy: the services checkout ${repo} has local changes:\n${dirty
        .map((d) => `  ${d}\n`)
        .join(
          "",
        )}Commit or stash them, or rerun with --force-clean (it stashes them as ${DEPLOY.stash_prefix}<time>; nothing is discarded).\n`,
    );
    return EXIT.DIRTY;
  }
  const from = await currentRef(exec, repo);
  if (from === null) {
    io.stderr(`volley deploy: cannot tell what ${repo} has checked out\n`);
    return EXIT.ERROR;
  }
  io.stdout(`current: ${refLabel(from)}${from.kind === "tag" ? "" : ` (${from.kind})`}\n`);

  if (v["dry-run"] === true) {
    const listed = await exec(git(repo, "tag", "--list", "v*"));
    const tags = listed.stdout.split("\n").map((t) => t.trim());
    let target: string;
    try {
      target = resolveTag(tags, requested);
      io.stdout(`target: ${target}\n`);
    } catch (e) {
      if (requested === "latest") {
        io.stdout(`target: the newest v* tag after the fetch (${(e as Error).message})\n`);
        target = "<newest>";
      } else {
        io.stdout(`target: ${requested} (not in the checkout yet: the fetch must bring it)\n`);
        target = requested;
      }
    }
    io.stdout("dry run: would run, in order:\n");
    const steps = deployPlan({
      repo,
      bun,
      services,
      deskPort,
      target: { kind: "tag", name: target },
      fetch: true,
      ...(stash !== undefined ? { stash } : {}),
    });
    steps.forEach((s, i) => {
      io.stdout(`  ${i + 1}. ${s.title}\n`);
      for (const c of s.commands) {
        io.stdout(`       $ ${c.cwd !== undefined ? `cd ${c.cwd} && ` : ""}${c.argv.join(" ")}\n`);
      }
      if (s.detail !== undefined) io.stdout(`       (${s.detail})\n`);
    });
    io.stdout(
      `On a failure after the checkout it repeats the checkout, install, build, restarts and health-check at ${refLabel(from)}.\ndry run: nothing changed\n`,
    );
    return EXIT.OK;
  }

  const r = await applyDeploy(
    {
      repo,
      bun,
      services,
      deskPort,
      from,
      requested,
      ...(stash !== undefined ? { stash } : {}),
    },
    {
      exec,
      env,
      now: deps.now,
      report: (l) => io.stdout(`${l}\n`),
      deskHealthy: deps.deskHealthy,
      volleydHealthy: (since) => deps.volleydHealthy({ brokerUrl, auth, namespace, since }),
    },
  );
  const stashed = stash !== undefined && r.steps[0]?.ok === true;
  if (stashed) io.stdout(`stashed the local changes as ${stash} (git stash list shows it)\n`);
  if (r.ok) {
    io.stdout(`deployed ${r.to} (was ${r.from}); waves continue (volleyd reconciles on start)\n`);
    return EXIT.OK;
  }
  const failed = r.failed as { step: string; why: string };
  const head = `volley deploy: ${r.to} failed at ${failed.step} (${failed.why})`;
  if (r.rolledBack) io.stderr(`${head}; rolled back to ${r.from}\n`);
  else if (r.rollbackFailed !== undefined) {
    io.stderr(
      `${head}; the rollback to ${r.from} failed too at ${r.rollbackFailed.step} (${r.rollbackFailed.why}). The checkout is left as it is; to put ${r.from} back, run:\n${r.rollbackFailed.byHand
        .map((c) => `  ${c}\n`)
        .join("")}`,
    );
  } else io.stderr(`${head}; nothing changed\n`);
  return EXIT.ERROR;
}

/** The tag HEAD is exactly at, else its branch, else the commit. */
async function currentRef(exec: SetupExec, repo: string): Promise<Ref | null> {
  const tag = await exec(git(repo, "describe", "--tags", "--exact-match", "HEAD"));
  if (tag.code === 0 && tag.stdout.trim() !== "") return { kind: "tag", name: tag.stdout.trim() };
  const branch = await exec(git(repo, "rev-parse", "--abbrev-ref", "HEAD"));
  const b = branch.stdout.trim();
  if (branch.code === 0 && b !== "" && b !== "HEAD") return { kind: "branch", name: b };
  const sha = await exec(git(repo, "rev-parse", "HEAD"));
  const s = sha.stdout.trim();
  return sha.code === 0 && /^[0-9a-f]{40}$/.test(s) ? { kind: "commit", name: s } : null;
}

export const DEPLOY_HELP = `Usage: volley deploy (<tag> | --latest) [--dry-run] [--force-clean] [--repo <dir>]
                     [--desk-port <n>]

Take the checkout this machine's volleyd and Desk services run from to a release tag: fetch
tags, check the tag out (detached), bun install --frozen-lockfile, build the Desk, self-check,
restart both services, health-check. A failure after the checkout repeats those steps at the
previous tag (or branch) and exits 1. Running waves continue: volleyd reconciles on start.

The services checkout is the one volleyd's installed service runs (its launchd plist or systemd
unit); with none installed, the checkout this volley runs from. A checkout with local changes is
refused (exit 3) unless --force-clean stashes them (never discards them).

Options:
  <tag>             The release tag (v0.5.0; a bare 0.5.0 gets its v)
  --latest          The newest v* tag by version order
  --dry-run         Print every step and command; run only the read-only ones (no fetch)
  --force-clean     Stash local changes first (git stash push -u -m ${DEPLOY.stash_prefix}<time>)
  --repo <dir>      Deploy into this checkout instead of the services'
  --desk-port <n>   The Desk's port for the health check (default: setup's, else ${DESK_PORT})
  --broker-url <url>, --namespace <ns>, --username <u>, --password <pw>
                    Where volleyd's health is read (as for volley list)
  -h, --help        Show this help and exit

Exit codes: 0 deployed, 1 failed (rolled back, or the by-hand commands printed), 2 usage,
3 local changes in the services checkout.
`;
