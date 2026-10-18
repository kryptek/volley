import { basename } from "node:path";
import { shq } from "./launch";

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
 *   volley auth add-agent <agent_id> [--ack-to <agent_id>]… [--json] [--no-reload]
 *   volley auth rm-agent <agent_id> [--no-reload]
 *   launchctl bootstrap | bootout | kickstart [-k] [-p] | print — only for the
 *     systems.volley.volleyd service
 *   pressure samplers, exact argv only: sysctl -n kern.memorystatus_vm_pressure_level ·
 *     memory_pressure (no arguments: report only) · docker info --format {{json .}}
 *
 * SCRIPT (allowed only with a ScriptToken naming exactly that path): the brief gate
 *   (`$VOLLEYD_HOME/brief-gate`), the one program volleyd runs by path.
 *
 * SSH (remote hosts, src/hosts/ssh-tmux.ts) — two forms only:
 *   ssh -T [-o <Opt>=<v>]… <target> bash -s   with a fenced RemoteScript (FenceOptions.remote):
 *     every step is checked against the REMOTE allow-list below and the script `exec` sends on
 *     stdin is `renderRemoteScript` of exactly those steps; a raw stdin script is refused, as is
 *     any `ssh <target> '<command>'` string (zsh login shells word-split it differently).
 *   ssh -N -R <port>:<host>:<port> [-o <Opt>=<v>]… <target>   the reverse broker tunnel.
 *   -o takes only BatchMode, ConnectTimeout, ServerAliveInterval, ServerAliveCountMax,
 *   ExitOnForwardFailure (never ProxyCommand, LocalCommand, …); a target never starts with '-'.
 *
 * REMOTE (one step of a RemoteScript; the same DENY list applies first):
 *   git — the local git policy (worktree add | fetch | rev-parse | … ; worktree remove = CONSENT)
 *   gh issue view · claude (any arguments)
 *   tmux new-session -d -s <name> -c <dir> 'bash .volley/launch.sh' (that command only) |
 *     capture-pane | send-keys | has-session — kill-session = CONSENT; no tmux global options
 *   mkdir -p <path>… · cat <path>… · chmod <octal> <path>… · nc -z 127.0.0.1 <port>
 *   base64 -d — the only step that takes stdin (base64 text only) and redirects to a file
 *   (absolute path; written under umask 077)
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

const scripts = new WeakSet<object>();

/**
 * Permission to run one local script by its exact path. Only `mintScriptToken` creates one
 * (checked by identity, like consent tokens). Callers: the brief gate only.
 */
export interface ScriptToken {
  readonly path: string;
}

export function mintScriptToken(path: string): ScriptToken {
  const token = Object.freeze({ path });
  scripts.add(token);
  return token;
}

/**
 * One command of a remote script. `stdin` (base64 text) and `stdout` (a file to write, or with
 * `append` to append to) are for `base64 -d` only: that is how files reach a remote host.
 */
export interface RemoteStep {
  argv: string[];
  /** Absolute directory on the remote host to run in. */
  cwd?: string;
  stdin?: string;
  stdout?: string;
  append?: boolean;
}

/** The script `ssh -T <target> bash -s` runs: fenced step by step, rendered by `renderRemoteScript`. */
export interface RemoteScript {
  steps: RemoteStep[];
}

export interface FenceOptions {
  consent?: ConsentToken;
  script?: ScriptToken;
  /** For `ssh … bash -s` only: the remote script, which `exec` renders onto the child's stdin. */
  remote?: RemoteScript;
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

/** Read-only pressure-sampler commands (src/pressure/*), allowed as these exact argvs only. */
const PRESSURE_READS: readonly (readonly string[])[] = [
  ["sysctl", "-n", "kern.memorystatus_vm_pressure_level"],
  ["memory_pressure"],
  ["docker", "info", "--format", "{{json .}}"],
];

function exactly(argv: readonly string[], allowed: readonly (readonly string[])[]): Verdict {
  const ok = allowed.some((a) => a.length === argv.length && a.every((x, i) => x === argv[i]));
  return ok ? ALLOW : deny(argv.slice(0, 2).join(" "));
}

/** Throw `FenceError` unless the policy above allows `argv`. */
export function assertAllowed(argv: readonly string[], opts: FenceOptions = {}): void {
  if (
    opts.script !== undefined &&
    scripts.has(opts.script) &&
    argv[0] !== undefined &&
    argv[0] === opts.script.path
  ) {
    return;
  }
  const prog = argv[0];
  const verdicts = prog === "ssh" ? sshVerdicts(argv.slice(1), opts.remote) : [evaluate(argv)];
  for (const v of verdicts) {
    if (v.kind === "allow") continue;
    if (v.kind === "consent") {
      if (opts.consent !== undefined && minted.has(opts.consent)) continue;
      throw new FenceError(v.verb, "requires consent from `volleyd cleanup --yes`");
    }
    throw new FenceError(v.verb, "not permitted for volleyd");
  }
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
    case "volley":
      return volley(args);
    case "launchctl":
      return launchctl(args);
    case "sysctl":
    case "memory_pressure":
      return exactly(argv, PRESSURE_READS);
    case "docker": {
      if (exactly(argv, PRESSURE_READS).kind === "allow") return ALLOW;
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

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** `volley auth add-agent|rm-agent <id>`: mint and revoke one agent's broker credentials. */
function volley(args: string[]): Verdict {
  const [group, verb, id, ...rest] = args;
  const name = `volley ${[group, verb].filter((a) => a !== undefined).join(" ")}`;
  if (group !== "auth" || (verb !== "add-agent" && verb !== "rm-agent")) return deny(name);
  if (id === undefined || !AGENT_ID.test(id)) return deny(`${name} (agent id)`);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--no-reload") continue;
    if (verb === "add-agent" && a === "--json") continue;
    if (verb === "add-agent" && a === "--ack-to" && AGENT_ID.test(rest[i + 1] ?? "")) {
      i++;
      continue;
    }
    return deny(`${name} ${a}`);
  }
  return ALLOW;
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

// ---------------------------------------------------------------------------------------------
// Remote hosts: ssh, and the steps of a remote script
// ---------------------------------------------------------------------------------------------

const SSH_OPTIONS = new Set([
  "BatchMode",
  "ConnectTimeout",
  "ServerAliveInterval",
  "ServerAliveCountMax",
  "ExitOnForwardFailure",
]);
const SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(@[A-Za-z0-9_][A-Za-z0-9_.-]*)?$/;
/** `-R <remote port>:<host>:<port>`: no bind address, so the remote end stays on its loopback. */
const SSH_REVERSE = /^[0-9]{1,5}:[A-Za-z0-9_][A-Za-z0-9_.-]*:[0-9]{1,5}$/;
/** An absolute remote path: quoted when rendered; no newline (a heredoc delimiter could follow). */
const REMOTE_PATH = /^\/[^\n\r\0]*$/;
const BASE64 = /^[A-Za-z0-9+/=\n]*$/;
/** The only command a remote tmux session may run (renderLaunchScript's script). */
export const TMUX_LAUNCH_COMMAND = "bash .volley/launch.sh";

/** The verdicts for one `ssh` argv: the ssh form itself, then each remote step's. */
function sshVerdicts(args: readonly string[], script: RemoteScript | undefined): Verdict[] {
  let mode: "T" | "N" | undefined;
  let reverse = false;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i] ?? "";
    if (!a.startsWith("-")) break;
    if ((a === "-T" || a === "-N") && mode === undefined) mode = a === "-T" ? "T" : "N";
    else if (a === "-o") {
      const [k, v] = (args[++i] ?? "").split("=", 2);
      if (!SSH_OPTIONS.has(k ?? "") || v === undefined || !/^[A-Za-z0-9]+$/.test(v))
        return [deny(`ssh -o ${k ?? ""}`)];
    } else if (a === "-R" && !reverse && SSH_REVERSE.test(args[i + 1] ?? "")) {
      reverse = true;
      i++;
    } else return [deny(`ssh ${a}`)];
  }
  const target = args[i] ?? "";
  const rest = args.slice(i + 1);
  if (!SSH_TARGET.test(target)) return [deny("ssh (target)")];
  if (mode === "N" && reverse && rest.length === 0 && script === undefined) return [ALLOW];
  const isScript =
    mode === "T" && !reverse && rest.length === 2 && rest[0] === "bash" && rest[1] === "-s";
  if (!isScript) return [deny("ssh (only `-T <target> bash -s` and the reverse tunnel)")];
  if (script === undefined || script.steps.length === 0)
    return [deny("ssh bash -s (without a fenced remote script)")];
  return script.steps.map(remoteStep);
}

const remoteDeny = (v: Verdict): Verdict =>
  v.kind === "allow" ? v : { ...v, verb: `remote ${v.verb}` };

function remoteStep(step: RemoteStep): Verdict {
  if (step.cwd !== undefined && !REMOTE_PATH.test(step.cwd))
    return deny("remote cwd (not absolute)");
  const [prog, ...args] = step.argv;
  const io = step.stdin !== undefined || step.stdout !== undefined || step.append === true;
  if (io) {
    const write =
      prog === "base64" &&
      args.length === 1 &&
      args[0] === "-d" &&
      step.stdin !== undefined &&
      BASE64.test(step.stdin) &&
      step.stdout !== undefined &&
      REMOTE_PATH.test(step.stdout);
    return write
      ? ALLOW
      : deny("remote file write (base64 -d of base64 text to an absolute path only)");
  }
  return remoteDeny(remoteCommand(prog, args));
}

function remoteCommand(prog: string | undefined, args: string[]): Verdict {
  if (prog === undefined || prog === "") return deny("(empty command)");
  if (prog.includes("/")) return deny(`${prog} (programs are named, not pathed)`);
  const paths = (list: string[]) => list.length > 0 && list.every((a) => !a.startsWith("-"));
  switch (prog) {
    case "git":
      return git(args);
    case "gh": {
      const two = args.slice(0, 2).join(" ");
      return two === "issue view"
        ? checkArgs("gh issue view", args.slice(2), GH_SPECS["issue view"] as OptSpec)
        : deny(`gh ${two}`.trim());
    }
    case "tmux":
      return tmux(args);
    case "claude":
      return ALLOW;
    case "mkdir":
      return args[0] === "-p" && paths(args.slice(1)) ? ALLOW : deny("mkdir (only -p <path>…)");
    case "cat":
      return paths(args) ? ALLOW : deny("cat (only <path>…)");
    case "chmod":
      return /^[0-7]{3,4}$/.test(args[0] ?? "") && paths(args.slice(1))
        ? ALLOW
        : deny("chmod (only <octal> <path>…)");
    case "nc":
      return args.length === 3 &&
        args[0] === "-z" &&
        args[1] === "127.0.0.1" &&
        /^[0-9]{1,5}$/.test(args[2] ?? "")
        ? ALLOW
        : deny("nc (only -z 127.0.0.1 <port>)");
    case "base64":
      return deny("base64 (only as a file write)");
    default: {
      // Locally allowed programs (cmux, volley, launchctl) have no business on a remote host.
      const v = evaluate([prog, ...args]);
      return v.kind === "allow" ? deny(`${prog} (not on the remote allow-list)`) : v;
    }
  }
}

const TMUX_SPECS: Record<string, OptSpec> = {
  "new-session": {
    flags: ["-d"],
    valued: ["-s", "-c"],
    positional: (a) => a === TMUX_LAUNCH_COMMAND,
  },
  "capture-pane": { flags: ["-p", "-J"], valued: ["-t", "-S", "-E"] },
  "has-session": { valued: ["-t"] },
};

function tmux(args: string[]): Verdict {
  const [sub, ...rest] = args;
  if (sub === undefined || sub.startsWith("-")) return deny(`tmux ${sub ?? ""}`.trim());
  if (sub === "kill-session") {
    const v = checkArgs("tmux kill-session", rest, { valued: ["-t"] });
    return v.kind === "allow" ? { kind: "consent", verb: "tmux kill-session" } : v;
  }
  if (sub === "send-keys") {
    // `send-keys -t <target> [-l] [--] <key|text>…`: what follows the options is typed.
    const [t, target, ...tail] = rest;
    if (t !== "-t" || target === undefined || target.startsWith("-")) return deny("tmux send-keys");
    const afterL = tail[0] === "-l" ? tail.slice(1) : tail;
    const keys = afterL[0] === "--" ? afterL.slice(1) : afterL;
    const quoted = afterL[0] === "--";
    return keys.length > 0 && (quoted || keys.every((k) => !k.startsWith("-")))
      ? ALLOW
      : deny("tmux send-keys");
  }
  const spec = Object.hasOwn(TMUX_SPECS, sub) ? TMUX_SPECS[sub] : undefined;
  if (spec === undefined) return deny(`tmux ${sub}`);
  return checkArgs(`tmux ${sub}`, rest, spec);
}

/**
 * The bash script for `ssh -T <target> bash -s`: `set -euo pipefail`, then one line per step,
 * every word single-quoted (so no path or value is ever shell syntax). A step with a `cwd` runs
 * in a subshell that `cd`s first; a file write runs `base64 -d` under `umask 077` from a quoted
 * heredoc (base64 text cannot contain its delimiter).
 */
export function renderRemoteScript(script: RemoteScript): string {
  const lines = ["set -euo pipefail"];
  for (const s of script.steps) {
    const cmd = s.argv.map(shq).join(" ");
    if (s.stdout !== undefined) {
      const redirect = s.append === true ? ">>" : ">";
      lines.push(
        `( umask 077 && ${cmd} ${redirect} ${shq(s.stdout)} <<'VOLLEY_EOF'\n${s.stdin ?? ""}\nVOLLEY_EOF\n)`,
      );
    } else if (s.cwd !== undefined) {
      lines.push(`( cd ${shq(s.cwd)} && ${cmd} )`);
    } else {
      lines.push(cmd);
    }
  }
  return `${lines.join("\n")}\n`;
}
