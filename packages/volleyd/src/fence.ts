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
 * ALLOW:
 *   git [-C <dir>] [--no-pager] worktree add | fetch | rev-parse | log | diff | status |
 *     branch --list | merge-base | show   (diff/show without --output / --ext-diff)
 *   gh issue view · gh pr view | list | checks · gh run list | view | watch · gh api (GET only)
 *   cmux new-workspace | list-workspaces | send | send-key | read-screen | ping
 *   claude (any arguments)
 *   launchctl bootstrap | bootout | kickstart | print — only for the systems.volley.volleyd service
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

const GIT_READ = new Set(["fetch", "rev-parse", "log", "diff", "status", "merge-base", "show"]);
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
const GH_ALLOW = new Set([
  "issue view",
  "pr view",
  "pr list",
  "pr checks",
  "run list",
  "run view",
  "run watch",
]);
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
  const [cmd, ...args] = argv;
  if (cmd === undefined || cmd === "") return deny("(empty command)");
  const prog = basename(cmd);
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

function git(args: string[]): Verdict {
  // Global options volleyd uses; anything else before the subcommand (e.g. `-c alias.x=!…`) is
  // refused, because git config can turn any subcommand into an arbitrary command.
  let i = 0;
  while (i < args.length && (args[i] ?? "").startsWith("-")) {
    const opt = args[i];
    if (opt === "-C") i += 2;
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

  // Allow-list.
  if (sub === "worktree" && rest[0] === "add") return ALLOW;
  if (sub === "branch") {
    return rest.includes("--list") || rest.includes("-l")
      ? ALLOW
      : deny("git branch (without --list)");
  }
  if (GIT_READ.has(sub)) {
    const bad = rest.find((a) => a.startsWith("--output") || a === "--ext-diff");
    return bad === undefined ? ALLOW : deny(`git ${sub} ${bad}`);
  }
  return deny(
    rest[0] !== undefined && sub === "worktree" ? `git worktree ${rest[0]}` : `git ${sub}`,
  );
}

function gh(args: string[]): Verdict {
  const two = args.slice(0, 2).join(" ");
  if (two === "pr merge" || two === "workflow run" || two === "repo delete")
    return deny(`gh ${two}`);
  if (args[0] === "api") {
    const method = ghApiMethod(args.slice(1));
    return method === "GET" ? ALLOW : deny(`gh api -X ${method}`);
  }
  return GH_ALLOW.has(two) ? ALLOW : deny(`gh ${two}`.trim());
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
    else if (/^(-f|-F|--field|--raw-field|--input)=/.test(a)) hasBody = true;
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
  const target = rest.filter((a) => !a.startsWith("-"));
  const ok =
    (sub === "bootstrap" &&
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
