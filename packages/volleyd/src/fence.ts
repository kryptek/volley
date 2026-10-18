import { basename } from "node:path";

/**
 * The authority fence: a code-level policy over every external command volleyd runs.
 * `exec()` (src/exec.ts) — the only place a child process is spawned — calls `assertAllowed`
 * first, so nothing outside this policy can run.
 *
 * Evaluation order: the explicit DENY list first (so widening the allow-list later can never
 * silently un-deny a verb), then the allow-list; anything not allowed is denied.
 *
 * DENY (never, consent or not):
 *   git merge | push | rebase | reset --hard | branch -D/-d/--delete/-m/-M/-c/-C/--force
 *   gh pr merge | gh workflow run | gh repo delete | gh api with any method other than GET
 *   infrastructure CLIs: terraform, terragrunt, kubectl, helm, aws, gcloud, gsutil, az, pulumi,
 *     ansible, ansible-playbook, eksctl, doctl, flyctl
 *   docker rm | rmi | container rm | image rm | volume rm | network rm | system prune
 *   rm -rf (any spelling that combines -r/-R/--recursive with -f/--force)
 *
 * CONSENT (denied unless a ConsentToken from `volleyd cleanup --yes` is passed):
 *   git worktree remove · cmux close-workspace
 *
 * ALLOW (program by bare name only — never a path):
 *   git [-C <dir>] [--no-pager] worktree add | fetch | rev-parse | log | diff | status |
 *     branch --list | merge-base | show
 *   gh issue view · gh pr view | list | checks · gh run list | view | watch · gh api (GET only)
 *   cmux new-workspace | list-workspaces | send | send-key | read-screen | ping
 *   claude (any arguments)
 *   launchctl bootstrap | bootout | kickstart [-k] [-p] | print — only for the
 *     systems.volley.volleyd service
 *
 * OPTIONS: every git and gh subcommand above has an exact option allow-list (GIT_SPECS and
 * GH_SPECS in src/fence.ts); any other option is denied — e.g. `fetch --upload-pack`/`-u`,
 * `--exec`, `--receive-pack`, `--config`, `--output`, `--ext-diff`, `--textconv`,
 * `gh api --hostname`, `--input`, `-F`. Bundled short flags and git global options other than `-C`/`--no-pager`
 * (`-c`, `--config-env`, `--exec-path`) are denied, as are subcommand aliases and `fetch`
 * transport-helper URLs (`ext::…`).
 */

export const SERVICE_LABEL = "systems.volley.volleyd";

/** Thrown for every command the fence refuses. `verb` names what was denied. */
export class FenceError extends Error {
  readonly code = "FENCE_DENIED" as const;
  readonly verb: string;
  constructor(verb: string, why: string) {
    super(`FENCE_DENIED: ${verb} (${why})`);
    this.name = "FenceError";
    this.verb = verb;
  }
}

const minted = new WeakSet<object>();

/**
 * Proof that a human explicitly consented to a destructive cleanup. Only `mintConsentToken`
 * creates one, and the fence checks tokens by identity, so a look-alike object is rejected.
 */
export interface ConsentToken {
  readonly reason: string;
}

/** Mint a consent token. Callers: `volleyd cleanup --yes` only. */
export function mintConsentToken(reason: string): ConsentToken {
  const token = Object.freeze({ reason });
  minted.add(token);
  return token;
}

export interface FenceOptions {
  consent?: ConsentToken;
}

type Verdict =
  | { kind: "allow" }
  | { kind: "deny"; verb: string }
  | { kind: "consent"; verb: string };

const ALLOW: Verdict = { kind: "allow" };
const deny = (verb: string): Verdict => ({ kind: "deny", verb });

const INFRA = new Set([
  "terraform",
  "terragrunt",
  "kubectl",
  "helm",
  "aws",
  "gcloud",
  "gsutil",
  "az",
  "pulumi",
  "ansible",
  "ansible-playbook",
  "eksctl",
  "doctl",
  "flyctl",
]);

/**
 * The options one allowed subcommand accepts. Anything starting with `-` that is not listed is
 * denied, so an option git or gh adds later (or one that runs a command, like
 * `fetch --upload-pack`) can never slip through.
 *   flags    — take no value (`--quiet`, `-q`)
 *   valued   — take a value, attached (`--depth=1`, `-n5`) or as the next argv element, which must
 *              not start with `-` (so we and the tool never disagree on where an option starts)
 *   optional — bare or with an attached `=value` (`--porcelain`, `--porcelain=v1`); never consume
 *              the next element
 *   numeric  — `-<n>` is accepted (git log -5)
 *   pathspecs — `--` ends the options; everything after it is a path
 *   positional — extra check for every non-option argument
 */
interface OptSpec {
  flags?: readonly string[];
  valued?: readonly string[];
  optional?: readonly string[];
  numeric?: boolean;
  pathspecs?: boolean;
  positional?: (arg: string) => boolean;
}

const DIFF_OUTPUT = [
  "--name-only",
  "--name-status",
  "--numstat",
  "--shortstat",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-patch",
  "-s",
];

/** A positional that names a transport helper (`ext::…`, `fd::…`) can run a command. */
const notTransport = (a: string) => !/^[A-Za-z0-9+.-]+::/.test(a);

const GIT_SPECS: Record<string, OptSpec> = {
  "worktree add": {
    flags: ["--detach", "--quiet", "-q", "--lock", "--track", "--no-track", "--checkout"],
    valued: ["-b", "--reason"],
  },
  fetch: {
    flags: ["--prune", "-p", "--prune-tags", "--tags", "--no-tags", "--quiet", "-q", "--all"],
    valued: ["--depth"],
    positional: notTransport,
  },
  "rev-parse": {
    flags: [
      "--verify",
      "--quiet",
      "-q",
      "--is-inside-work-tree",
      "--is-bare-repository",
      "--show-toplevel",
      "--show-prefix",
      "--git-dir",
      "--git-common-dir",
      "--absolute-git-dir",
      "--symbolic",
      "--symbolic-full-name",
    ],
    optional: ["--short", "--abbrev-ref"],
  },
  log: {
    flags: [
      ...DIFF_OUTPUT,
      "--oneline",
      "--no-merges",
      "--merges",
      "--first-parent",
      "--reverse",
      "--graph",
      "--no-decorate",
      "--abbrev-commit",
      "--all",
      "--follow",
      "--left-right",
      "--cherry-pick",
      "-p",
      "--patch",
    ],
    valued: [
      "-n",
      "--max-count",
      "--skip",
      "--since",
      "--until",
      "--after",
      "--before",
      "--author",
      "--committer",
      "--grep",
    ],
    optional: ["--format", "--pretty", "--decorate", "--stat", "--date", "--abbrev"],
    numeric: true,
    pathspecs: true,
  },
  diff: {
    flags: [
      ...DIFF_OUTPUT,
      "--quiet",
      "--exit-code",
      "--cached",
      "--staged",
      "--merge-base",
      "--check",
      "--raw",
      "-p",
      "--patch",
    ],
    valued: ["--diff-filter", "-U", "--unified"],
    optional: ["--stat", "--find-renames", "--relative"],
    pathspecs: true,
  },
  status: {
    flags: ["--short", "-s", "--branch", "-b", "-z", "--long", "--show-stash", "--no-renames"],
    optional: ["--porcelain", "--untracked-files", "--ignored", "--ignore-submodules"],
    pathspecs: true,
  },
  branch: {
    flags: [
      "--list",
      "-l",
      "--all",
      "-a",
      "--remotes",
      "-r",
      "--no-color",
      "-v",
      "-vv",
      "--verbose",
      "--ignore-case",
    ],
    optional: ["--format", "--sort", "--merged", "--no-merged", "--contains", "--no-contains"],
  },
  "merge-base": {
    flags: ["--is-ancestor", "--all", "-a", "--octopus", "--independent", "--fork-point"],
  },
  show: {
    flags: [...DIFF_OUTPUT, "--oneline", "--quiet", "--abbrev-commit"],
    optional: ["--format", "--pretty", "--stat", "--date", "--decorate"],
    pathspecs: true,
  },
};

/** Explicitly denied `git branch` options (named in the error), whatever the allow-list says. */
const GIT_BRANCH_MUTATORS = new Set([
  "-D",
  "-d",
  "--delete",
  "-m",
  "-M",
  "--move",
  "-c",
  "-C",
  "--copy",
  "-f",
  "--force",
  "-u",
  "--set-upstream-to",
  "--unset-upstream",
  "--edit-description",
]);

/** Options every gh read verb that prints JSON accepts. */
const GH_OUTPUT = ["--json", "--jq", "-q", "--template", "-t", "--repo", "-R"];

const GH_SPECS: Record<string, OptSpec> = {
  "issue view": { flags: ["--comments"], valued: GH_OUTPUT },
  "pr view": { flags: ["--comments"], valued: GH_OUTPUT },
  "pr list": {
    valued: [
      ...GH_OUTPUT,
      "--head",
      "-H",
      "--base",
      "-B",
      "--state",
      "-s",
      "--limit",
      "-L",
      "--search",
      "-S",
      "--label",
      "-l",
      "--author",
      "-A",
    ],
  },
  "pr checks": {
    flags: ["--required", "--watch", "--fail-fast"],
    valued: [...GH_OUTPUT, "--interval", "-i"],
  },
  "run list": {
    valued: [
      ...GH_OUTPUT,
      "--branch",
      "-b",
      "--workflow",
      "-w",
      "--status",
      "-s",
      "--limit",
      "-L",
      "--commit",
      "-c",
      "--event",
      "-e",
    ],
  },
  "run view": {
    flags: ["--log", "--log-failed", "--verbose", "-v", "--exit-status"],
    valued: [...GH_OUTPUT, "--job", "-j", "--attempt", "-a"],
  },
  "run watch": {
    flags: ["--exit-status", "--compact"],
    valued: ["--interval", "-i", "--repo", "-R"],
  },
  // No --input / -F / --field (request bodies and @file uploads), no --hostname (where the
  // token is sent). The method is checked separately: GET only.
  api: {
    flags: ["--paginate", "--slurp", "--include", "-i", "--silent"],
    valued: [
      "-X",
      "--method",
      "-f",
      "--raw-field",
      "-H",
      "--header",
      "--jq",
      "-q",
      "--template",
      "-t",
      "--cache",
    ],
  },
};

const CMUX_ALLOW = new Set([
  "new-workspace",
  "list-workspaces",
  "send",
  "send-key",
  "read-screen",
  "ping",
]);
const DOCKER_DENY = new Set([
  "rm",
  "rmi",
  "container rm",
  "image rm",
  "volume rm",
  "network rm",
  "system prune",
  "container prune",
  "image prune",
  "volume prune",
]);

/** Throw `FenceError` unless the policy above allows `argv`. */
export function assertAllowed(argv: readonly string[], opts: FenceOptions = {}): void {
  const v = evaluate(argv);
  if (v.kind === "allow") return;
  if (v.kind === "consent") {
    if (opts.consent !== undefined && minted.has(opts.consent)) return;
    throw new FenceError(v.verb, "requires consent from `volleyd cleanup --yes`");
  }
  throw new FenceError(v.verb, "not permitted for volleyd");
}

function evaluate(argv: readonly string[]): Verdict {
  const [prog, ...args] = argv;
  if (prog === undefined || prog === "") return deny("(empty command)");
  // A bare name only: a path (`/tmp/evil/git`, `./claude`) could point at any binary.
  if (prog.includes("/")) return deny(`${prog} (programs are named, not pathed)`);
  switch (prog) {
    case "git":
      return git(args);
    case "gh":
      return gh(args);
    case "cmux":
      return cmux(args);
    case "claude":
      return ALLOW;
    case "launchctl":
      return launchctl(args);
    case "docker": {
      const two = args.slice(0, 2).join(" ");
      if (DOCKER_DENY.has(args[0] ?? "") || DOCKER_DENY.has(two))
        return deny(`docker ${two}`.trim());
      return deny(`docker ${args[0] ?? ""}`.trim());
    }
    case "rm":
      return deny(isRecursiveForce(args) ? "rm -rf" : "rm");
    default:
      if (INFRA.has(prog)) return deny(`${prog} (infrastructure tooling)`);
      return deny(args[0] !== undefined ? `${prog} ${args[0]}` : prog);
  }
}

/**
 * Check every argument after an allowed subcommand against its `OptSpec`. Returns the denial for
 * the first option (or positional) the spec does not accept, naming it after `verb`.
 */
function checkArgs(verb: string, args: readonly string[], spec: OptSpec): Verdict {
  const has = (list: readonly string[] | undefined, a: string) => list?.includes(a) === true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") return spec.pathspecs === true ? ALLOW : deny(`${verb} --`);
    if (!a.startsWith("-") || a === "-") {
      if (spec.positional !== undefined && !spec.positional(a)) return deny(`${verb} ${a}`);
      continue;
    }
    if (has(spec.flags, a) || has(spec.optional, a)) continue;
    if (spec.numeric === true && /^-[0-9]+$/.test(a)) continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      if (eq !== -1 && (has(spec.valued, name) || has(spec.optional, name))) continue;
      if (eq === -1 && has(spec.valued, a)) {
        const v = args[i + 1];
        if (v === undefined || v.startsWith("-")) return deny(`${verb} ${a} (missing value)`);
        i++;
        continue;
      }
      return deny(`${verb} ${name}`);
    }
    // Short option: exact `-x` taking the next element, or `-xVALUE` attached. Bundled short
    // flags (`-uq`) are not accepted: one of them could be a value-taking option.
    const short = a.slice(0, 2);
    if (has(spec.valued, short)) {
      if (a.length > 2) continue;
      const v = args[i + 1];
      if (v === undefined || v.startsWith("-")) return deny(`${verb} ${a} (missing value)`);
      i++;
      continue;
    }
    return deny(`${verb} ${a}`);
  }
  return ALLOW;
}

function git(args: string[]): Verdict {
  // Global options volleyd uses; anything else before the subcommand (`-c`, `--config-env`,
  // `--exec-path`, …) is refused, because git config can turn any subcommand into a command.
  let i = 0;
  while (i < args.length && (args[i] ?? "").startsWith("-")) {
    const opt = args[i];
    if (opt === "-C" && !(args[i + 1] ?? "-").startsWith("-")) i += 2;
    else if (opt === "--no-pager") i += 1;
    else return deny(`git ${opt}`);
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined) return deny("git");

  // Explicit deny list.
  if (sub === "merge" || sub === "push" || sub === "rebase") return deny(`git ${sub}`);
  if (sub === "reset" && rest.includes("--hard")) return deny("git reset --hard");
  if (sub === "branch") {
    const bad = rest.find((a) => GIT_BRANCH_MUTATORS.has(a));
    if (bad !== undefined) return deny(`git branch ${bad}`);
  }
  if (sub === "worktree" && rest[0] === "remove") {
    return { kind: "consent", verb: "git worktree remove" };
  }

  // Allow-list: exact subcommand (no aliases, which resolve through config), exact options.
  if (sub === "worktree") {
    const spec = rest[0] === "add" ? GIT_SPECS["worktree add"] : undefined;
    if (spec === undefined) return deny(`git worktree ${rest[0] ?? ""}`.trim());
    return checkArgs("git worktree add", rest.slice(1), spec);
  }
  if (sub === "branch" && !rest.includes("--list") && !rest.includes("-l")) {
    return deny("git branch (without --list)");
  }
  const spec = Object.hasOwn(GIT_SPECS, sub) ? GIT_SPECS[sub] : undefined;
  return spec === undefined ? deny(`git ${sub}`) : checkArgs(`git ${sub}`, rest, spec);
}

function gh(args: string[]): Verdict {
  const two = args.slice(0, 2).join(" ");
  if (two === "pr merge" || two === "workflow run" || two === "repo delete")
    return deny(`gh ${two}`);
  if (args[0] === "api") {
    const v = checkArgs("gh api", args.slice(1), GH_SPECS.api as OptSpec);
    if (v.kind !== "allow") return v;
    const method = ghApiMethod(args.slice(1));
    return method === "GET" ? ALLOW : deny(`gh api -X ${method}`);
  }
  const spec = Object.hasOwn(GH_SPECS, two) ? GH_SPECS[two] : undefined;
  return spec === undefined
    ? deny(`gh ${two}`.trim())
    : checkArgs(`gh ${two}`, args.slice(2), spec);
}

/** The HTTP method `gh api` would use: an explicit -X/--method, else POST when fields are sent. */
function ghApiMethod(args: string[]): string {
  let method: string | undefined;
  let hasBody = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-X" || a === "--method") method = args[++i];
    else if (a.startsWith("--method=")) method = a.slice("--method=".length);
    else if (a.startsWith("-X") && a.length > 2) method = a.slice(2);
    else if (["-f", "-F", "--field", "--raw-field", "--input"].includes(a)) hasBody = true;
    else if (/^(-f|-F|--field|--raw-field|--input)=/.test(a) || /^-[fF]./.test(a)) hasBody = true;
  }
  return (method ?? (hasBody ? "POST" : "GET")).toUpperCase();
}

function cmux(args: string[]): Verdict {
  const sub = args[0] ?? "";
  if (sub === "close-workspace") return { kind: "consent", verb: "cmux close-workspace" };
  return CMUX_ALLOW.has(sub) ? ALLOW : deny(`cmux ${sub}`.trim());
}

function launchctl(args: string[]): Verdict {
  const [sub, ...rest] = args;
  const opts = rest.filter((a) => a.startsWith("-"));
  const target = rest.filter((a) => !a.startsWith("-"));
  const optsOk = opts.every((o) => sub === "kickstart" && (o === "-k" || o === "-p"));
  const ok =
    (optsOk &&
      sub === "bootstrap" &&
      target.length === 2 &&
      /^gui\/[0-9]+$/.test(target[0] ?? "") &&
      basename(target[1] ?? "") === `${SERVICE_LABEL}.plist`) ||
    ((sub === "bootout" || sub === "kickstart" || sub === "print") &&
      target.length === 1 &&
      new RegExp(`^gui/[0-9]+/${SERVICE_LABEL.replace(/\./g, "\\.")}$`).test(target[0] ?? ""));
  return ok ? ALLOW : deny(`launchctl ${sub ?? ""}`.trim());
}

function isRecursiveForce(args: string[]): boolean {
  let r = false;
  let f = false;
  for (const a of args) {
    if (a === "--recursive") r = true;
    else if (a === "--force") f = true;
    else if (/^-[a-zA-Z]+$/.test(a)) {
      if (/[rR]/.test(a)) r = true;
      if (a.includes("f")) f = true;
    }
  }
  return r && f;
}
