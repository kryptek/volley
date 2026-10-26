import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { isSlug } from "volleyd/repos";
import { parsePositiveInt } from "../args";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { renderHuman } from "../peer/doctor";
import { type Answer, askVolleyd } from "./peer";

/**
 * `volley repo`: the repositories the supervisor's machines work on (SPEC §4.6.21). `add` and
 * `remove` are admin ops (sent on the admin's account-op topic, like `volley peer invite`);
 * `list`, `status` and `check` are reads any login may make (`check --fix` is an admin's).
 */

export const REPO_DEFAULTS = {
  /** `add --wait`: the longest wait for every machine to settle (a clone can take minutes). */
  wait_timeout_s: 900,
  /** `add --wait`: how often `repo_status` is asked. */
  poll_ms: 2000,
  /** `check`: how long to wait for the answer (each machine's doctor runs first). */
  check_timeout_s: 300,
  /** `check --fix`: the same, a clone included. */
  check_fix_timeout_s: 900,
} as const;

const HELP = `Usage:
  volley repo add <owner/name> [--machine <name>]... [--path <name>=<abs path>]... [--wait]
                 [--for-wave <wave>]
                                     Add a repository to every machine (or these): each paired
                                     machine clones it (or adopts the clone at --path) and
                                     trusts it; --wait follows each machine until it is ready
                                     or blocked
  volley repo list [--json]          The configured repositories and their machines
  volley repo remove <owner/name> [--machine <name>]...
                                     Remove it from every machine (or these); clones are kept
  volley repo status [<owner/name>] [--json]
                                     Where each repository stands on each machine
  volley repo check <owner/name> [--release-branch <b>] [--machine <name>]... [--fix] [--json]
                                     Whether it can run a wave, on every machine that holds it:
                                     the repository on GitHub, then each machine's fresh doctor
                                     (clone, push access, git identity, worktree root,
                                     toolchain, trust), one line per check with the fix;
                                     exit 1 unless every machine asked is ready

Options:
  --machine <name>     A machine by name (repeatable; default: all of them)
  --path <name>=<abs>  add: adopt the existing clone at <abs> on paired machine <name>
  --wait               add: wait until every machine is ready or blocked (exit 1 if one is blocked)
  --wait-timeout <s>   add --wait: how long to wait (default ${REPO_DEFAULTS.wait_timeout_s})
  --for-wave <wave>    add: the registration is for that wave only; cleaning the wave up removes
                       it (and the clones volleyd made for it); without it the repository is
                       yours and cleanup never removes it
  --release-branch <b> check: also check the wave's release branch (on origin, its review rules)
  --fix                check: apply the safe fixes on each paired machine (an admin op)
  --json               list, status, check: the answer as JSON
  --broker-url <url>   MQTT broker URL (env: VOLLEY_BROKER_URL; default: mqtt://localhost:1883)
  --namespace <ns>     volleyd's namespace (env: VOLLEY_NAMESPACE; default: default)
  --username <user>    Broker username (env: VOLLEY_AUTH_USERNAME); add and remove need an admin
  --password <pw>      Broker password (env: VOLLEY_AUTH_PASSWORD)
  --timeout <seconds>  How long to wait for each answer (default 30; check ${REPO_DEFAULTS.check_timeout_s},
                       check --fix ${REPO_DEFAULTS.check_fix_timeout_s})
`;

const OPTIONS = {
  machine: { type: "string", multiple: true },
  path: { type: "string", multiple: true },
  wait: { type: "boolean" },
  "wait-timeout": { type: "string" },
  "for-wave": { type: "string" },
  "release-branch": { type: "string" },
  fix: { type: "boolean" },
  json: { type: "boolean" },
  timeout: { type: "string" },
  "broker-url": { type: "string" },
  namespace: { type: "string" },
  username: { type: "string" },
  password: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/** Flags only some verbs take. */
const OWNED_BY: Partial<Record<keyof typeof OPTIONS, string[]>> = {
  machine: ["add", "remove", "check"],
  path: ["add"],
  wait: ["add"],
  "wait-timeout": ["add"],
  "for-wave": ["add"],
  "release-branch": ["check"],
  fix: ["check"],
  json: ["list", "status", "check"],
};

type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>["values"];

export interface RepoArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

export interface RepoDeps {
  /** One op to volleyd: its answer, or the exit code once it printed why not. */
  ask: (
    cmd: string,
    op: string,
    fields: Record<string, unknown>,
    v: Values,
    env: Record<string, string | undefined>,
    io: IO,
    admin: boolean,
  ) => Promise<Answer | ExitCode>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollMs: number;
}

export function realRepoDeps(): RepoDeps {
  return {
    ask: askVolleyd,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    pollMs: REPO_DEFAULTS.poll_ms,
  };
}

export function repo(args: RepoArgs): Promise<ExitCode> {
  return runRepo(args, realRepoDeps());
}

/** A wave id (the id grammar volleyd checks): what `--for-wave` names. */
export const WAVE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** One repository on each machine, as `repo_status` answers it. */
interface RepoStatus {
  slug: string;
  machines: Record<string, { state: string; path?: string; reasons: string[] }>;
  lines: string[];
}

export async function runRepo({ argv, env, io }: RepoArgs, deps: RepoDeps): Promise<ExitCode> {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb === "--help" || verb === "-h") {
    io.stdout(HELP);
    return verb === undefined ? EXIT.USAGE : EXIT.OK;
  }
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    io.stderr(`volley repo: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  const v = parsed.values;
  if (v.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const pos = parsed.positionals;
  const usage = (msg: string) => {
    io.stderr(`volley repo ${verb}: ${msg}\n`);
    return EXIT.USAGE;
  };
  if (!["add", "list", "remove", "status", "check"].includes(verb)) {
    io.stderr(`volley repo: unknown verb '${verb}'\n\n${HELP}`);
    return EXIT.USAGE;
  }
  for (const [flag, owner] of Object.entries(OWNED_BY)) {
    if (v[flag as keyof Values] !== undefined && !owner.includes(verb)) {
      return usage(`--${flag} is an option of volley repo ${owner.join(", ")} only`);
    }
  }
  const slugArg = (required: boolean): string | null | ExitCode => {
    if (pos.length > 1) return usage("takes one <owner/name>");
    const s = pos[0];
    if (s === undefined) return required ? usage("needs <owner/name>") : null;
    if (!isSlug(s)) return usage(`"${s}" is not a GitHub <owner/name>`);
    return s;
  };
  const machines = v.machine !== undefined ? { machines: [...new Set(v.machine)] } : {};
  switch (verb) {
    case "add": {
      const slug = slugArg(true);
      if (typeof slug !== "string") return slug ?? EXIT.USAGE;
      const paths: Record<string, string> = {};
      for (const p of v.path ?? []) {
        const at = p.indexOf("=");
        const name = at > 0 ? p.slice(0, at) : "";
        const path = p.slice(at + 1);
        if (name === "" || !isAbsolute(path))
          return usage(`--path "${p}" is not <name>=<abs path>`);
        paths[name] = path;
      }
      let waitMs = REPO_DEFAULTS.wait_timeout_s * 1000;
      if (v["wait-timeout"] !== undefined) {
        try {
          waitMs = parsePositiveInt(v["wait-timeout"], "--wait-timeout") * 1000;
        } catch (e) {
          return usage(e instanceof Error ? e.message : String(e));
        }
      }
      const wave = v["for-wave"];
      if (wave !== undefined && !WAVE_ID_RE.test(wave))
        return usage(`--for-wave "${wave}" is not a wave id ([a-z0-9][a-z0-9_-]{0,62})`);
      const fields = {
        slug,
        ...machines,
        ...(Object.keys(paths).length > 0 ? { paths } : {}),
        ...(wave !== undefined ? { wave } : {}),
      };
      const a = await deps.ask("volley repo add", "repo_add", fields, v, env, io, true);
      if (typeof a === "number") return a;
      const r = (a.result ?? {}) as {
        slug?: string;
        url?: string;
        visibility?: string;
        machines?: string[];
        status?: string[];
        ci?: { workflows?: number };
        checks?: CheckLine[];
      };
      const added = r.slug ?? slug;
      io.stdout(
        `Added ${added}${r.visibility !== undefined ? ` (${r.visibility})` : ""} to ${(r.machines ?? []).join(", ")}.\n`,
      );
      // The repository half of `check` (#610); an older volleyd's workflows count instead.
      const workflows = r.ci?.workflows;
      if (r.checks !== undefined) io.stdout(renderHuman(r.checks));
      else if (workflows === 0)
        io.stdout(
          "CI: none — no GitHub Actions workflows; in a wave the two reviewers and the gate are the check\n",
        );
      else if (typeof workflows === "number")
        io.stdout(`CI: ${workflows} workflow${workflows === 1 ? "" : "s"}\n`);
      if (v.wait !== true) {
        for (const l of r.status ?? []) io.stdout(`  ${l}\n`);
        io.stdout(`Follow it with: volley repo check ${added}\n`);
        return EXIT.OK;
      }
      const settled = await waitSettled(added, v, env, io, deps, waitMs);
      if (settled !== EXIT.OK && settled !== EXIT.ERROR) return settled;
      // Every machine settled: end on whether a wave can run, and where (D6).
      const c = await deps.ask(
        "volley repo add",
        "repo_check",
        { slug: added },
        { ...v, timeout: v.timeout ?? String(REPO_DEFAULTS.check_timeout_s) },
        env,
        io,
        false,
      );
      if (typeof c === "number") return settled;
      const answer = asCheck(c.result);
      if (answer === null) return settled;
      io.stdout(`\n${renderMachines(answer, deps.now())}`);
      // The wait's verdict stands (a repository a machine cannot use ended it `blocked` already).
      return settled;
    }
    case "check": {
      const slug = slugArg(true);
      if (typeof slug !== "string") return slug ?? EXIT.USAGE;
      const fix = v.fix === true;
      const branch = v["release-branch"];
      if (branch !== undefined && (branch === "" || branch.startsWith("-")))
        return usage(`--release-branch "${branch}" is not a branch name`);
      const timeout =
        v.timeout ??
        String(fix ? REPO_DEFAULTS.check_fix_timeout_s : REPO_DEFAULTS.check_timeout_s);
      const a = await deps.ask(
        "volley repo check",
        "repo_check",
        {
          slug,
          ...(branch !== undefined ? { release_branch: branch } : {}),
          ...machines,
          ...(fix ? { fix: true } : {}),
        },
        { ...v, timeout },
        env,
        io,
        fix,
      );
      if (typeof a === "number") return a;
      const answer = asCheck(a.result);
      if (answer === null) {
        io.stderr(
          "volley repo check: volleyd's answer has no check (is it older than this CLI?)\n",
        );
        return EXIT.ERROR;
      }
      if (v.json === true) {
        io.stdout(`${JSON.stringify(a.result, null, 2)}\n`);
        return checkExit(answer);
      }
      const head = `${answer.slug}${answer.visibility !== undefined ? ` (${answer.visibility})` : ""}`;
      io.stdout(
        `${head}\n${renderHuman(answer.repository)}\n${renderMachines(answer, deps.now())}`,
      );
      return checkExit(answer);
    }
    case "remove": {
      const slug = slugArg(true);
      if (typeof slug !== "string") return slug ?? EXIT.USAGE;
      const a = await deps.ask(
        "volley repo remove",
        "repo_remove",
        { slug, ...machines },
        v,
        env,
        io,
        true,
      );
      if (typeof a === "number") return a;
      const r = (a.result ?? {}) as {
        slug?: string;
        machines?: string[];
        clones?: Record<string, string>;
        peers?: Record<string, string>;
      };
      io.stdout(`Removed ${r.slug ?? slug} from ${(r.machines ?? []).join(", ")}.\n`);
      const clones = Object.entries(r.clones ?? {});
      if (clones.length > 0) {
        io.stdout("Clones kept (delete them by hand if you no longer want them):\n");
        for (const [m, path] of clones) io.stdout(`  ${m}: ${path}\n`);
      }
      for (const [m, what] of Object.entries(r.peers ?? {})) {
        if (what !== "removed") io.stdout(`  ${m}: ${what}\n`);
      }
      return EXIT.OK;
    }
    case "list": {
      if (pos.length > 0) return usage("takes no arguments");
      const a = await deps.ask("volley repo list", "repo_list", {}, v, env, io, false);
      if (typeof a === "number") return a;
      const repos = ((a.result ?? {}) as { repos?: Record<string, unknown>[] }).repos ?? [];
      if (v.json === true) {
        io.stdout(`${JSON.stringify({ repos }, null, 2)}\n`);
        return EXIT.OK;
      }
      if (repos.length === 0)
        io.stdout("No repositories configured (volley repo add <owner/name>).\n");
      for (const r of repos as {
        slug: string;
        machines: unknown;
        paths?: Record<string, string>;
      }[]) {
        const on = r.machines === "all" ? "all machines" : (r.machines as string[]).join(", ");
        const adopted = Object.entries(r.paths ?? {}).map(([m, p]) => `${m}=${p}`);
        io.stdout(
          `${r.slug}  ${on !== "" ? on : "(adopted only)"}${adopted.length > 0 ? `  adopted: ${adopted.join(", ")}` : ""}\n`,
        );
      }
      return EXIT.OK;
    }
    default: {
      const slug = slugArg(false);
      if (typeof slug === "number") return slug;
      const a = await deps.ask(
        "volley repo status",
        "repo_status",
        slug !== null ? { slug } : {},
        v,
        env,
        io,
        false,
      );
      if (typeof a === "number") return a;
      const repos = ((a.result ?? {}) as { repos?: RepoStatus[] }).repos ?? [];
      if (v.json === true) {
        io.stdout(`${JSON.stringify({ repos }, null, 2)}\n`);
        return EXIT.OK;
      }
      if (repos.length === 0)
        io.stdout("No repositories configured (volley repo add <owner/name>).\n");
      for (const r of repos) printStatus(r, io);
      return EXIT.OK;
    }
  }
}

/** One check line as volleyd sends it (the doctor's report shape). */
interface CheckLine {
  id: string;
  ok: boolean;
  severity: "block" | "warn";
  detail: string;
  repo?: string;
  fix?: string;
}

/** One machine's block of a `repo_check` answer. */
interface CheckBlock {
  checks: CheckLine[];
  ready: boolean;
  state: string;
  reasons: string[];
  from: "doctor" | "record";
  doctor_at: string | null;
  note?: string;
}

/** `repo_check`'s answer (SPEC §4.6.21). */
interface CheckAnswer {
  slug: string;
  visibility?: string;
  repository: CheckLine[];
  machines: Record<string, CheckBlock>;
  ready_on: string[];
  summary: string;
}

/** A `repo_check` result, or null when it is not one (an older volleyd's answer). */
function asCheck(v: unknown): CheckAnswer | null {
  const r = v as Partial<CheckAnswer> | undefined;
  return r !== undefined &&
    Array.isArray(r.repository) &&
    typeof r.machines === "object" &&
    r.machines !== null &&
    typeof r.summary === "string"
    ? (r as CheckAnswer)
    : null;
}

/** OK when the repository passes its block lines and every machine asked is ready. */
function checkExit(a: CheckAnswer): ExitCode {
  const names = Object.keys(a.machines);
  const repoOk = a.repository.every((c) => c.ok || c.severity !== "block");
  return repoOk && names.length > 0 && names.every((n) => a.machines[n]?.ready === true)
    ? EXIT.OK
    : EXIT.ERROR;
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 120) return `${s} s ago`;
  const min = Math.floor(s / 60);
  return min < 120 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`;
}

/** Each machine's block (its header, its lines without the repository each one names), then the closing line. */
function renderMachines(a: CheckAnswer, now: number): string {
  const out: string[] = [];
  for (const [name, b] of Object.entries(a.machines)) {
    const when =
      b.doctor_at === null
        ? "no machine record"
        : b.from === "doctor"
          ? `doctor ${ago(b.doctor_at, now)}`
          : `last report ${ago(b.doctor_at, now)}`;
    const head = `${name} (${when}${b.note !== undefined ? `; ${b.note}` : ""})\n`;
    const lines = renderHuman(b.checks.map(({ repo: _repo, ...c }) => c));
    // Not ready and no failing line says why: readiness' own reasons (no record, the PATH probe).
    const failing = b.checks.some((c) => !c.ok);
    const why = !b.ready && !failing ? b.reasons.map((r) => `  ${r}\n`).join("") : "";
    out.push(`${head}${lines}${why}`);
  }
  return `${out.join("\n")}\n${a.summary}\n`;
}

function printStatus(r: RepoStatus, io: IO): void {
  io.stdout(`${r.slug}\n`);
  for (const l of r.lines) io.stdout(`  ${l}\n`);
}

/** A machine's state that a wait ends on. */
const SETTLED = new Set(["ready", "blocked"]);

/**
 * `add --wait`: ask `repo_status` until every machine is `ready` or `blocked` (each state line
 * printed as it changes); OK when all are ready, ERROR when one is blocked, TIMEOUT otherwise.
 */
async function waitSettled(
  slug: string,
  v: Values,
  env: Record<string, string | undefined>,
  io: IO,
  deps: RepoDeps,
  waitMs: number,
): Promise<ExitCode> {
  const until = deps.now() + waitMs;
  const shown = new Set<string>();
  for (;;) {
    const a = await deps.ask("volley repo add", "repo_status", { slug }, v, env, io, false);
    if (typeof a === "number") return a;
    const r = ((a.result ?? {}) as { repos?: RepoStatus[] }).repos?.[0];
    for (const l of r?.lines ?? []) {
      if (!shown.has(l)) io.stdout(`  ${l}\n`);
      shown.add(l);
    }
    const states = Object.values(r?.machines ?? {}).map((m) => m.state);
    if (states.length > 0 && states.every((s) => SETTLED.has(s))) {
      return states.every((s) => s === "ready") ? EXIT.OK : EXIT.ERROR;
    }
    if (deps.now() >= until) {
      io.stderr(`volley repo add: not every machine settled within ${waitMs / 1000} s\n`);
      return EXIT.TIMEOUT;
    }
    await deps.sleep(deps.pollMs);
  }
}
