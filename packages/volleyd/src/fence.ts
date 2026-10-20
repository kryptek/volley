import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DYNSEC_ADMIN_USER } from "volley-cli/auth/roles";
import { canonicalRoot, claudeRoot, profileDir, readRegistry } from "./claude/profiles";
import {
  BROWSER_HELPER,
  SIGNIN_COMMAND,
  SIGNIN_SCRIPT,
  SIGNIN_URL_FILE,
  renderBrowserHelper,
  renderSigninScript,
} from "./claude/signin-script";
import { volleydHome } from "./config-store";
import { LAUNCH_COMMAND, mcpConfigPath, renderLaunchScript, renderMcpConfig, shq } from "./launch";
import { AGENT_BRANCH } from "./worktree";

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
 * CONSENT (denied unless a ConsentToken is passed — minted by `volleyd cleanup --yes`, or by a
 * retire for the retired agent's own workspace only):
 *   git worktree remove · cmux close-workspace
 *
 * ALLOW (program by bare name only — never a path):
 *   git [-C <dir>] [--no-pager] worktree add | fetch | rev-parse | log | diff | status |
 *     branch --list | branch --track <b> <remote>/<b> | merge-base | show
 *     worktree add needs -b <new branch> or --detach (never checks out an existing branch), or
 *     -B only to re-create an agent branch (`<wave>/<task>-<role>-<n>`, worktree.ts
 *     AGENT_BRANCH — never a release or any other branch); the new branch is never main/master
 *     (in any case); fetch takes a remote name or a
 *     network URL (https, ssh, git, user@host:path — never a local path) and its refspecs only
 *     write refs/remotes/…
 *   gh issue view · gh repo view · gh pr view | list | checks · gh run list | view | watch ·
 *     gh api (GET only; a relative endpoint — never a URL — and never graphql in any path
 *     segment; no request headers)
 *   cmux — exact argv shapes only, because cmux types into an agent's shell:
 *     new-workspace --cwd <dir> --name <name> --command LAUNCH_COMMAND (each once, any order),
 *       with the LaunchToken of the `.volley/launch.sh` volleyd sealed in exactly <dir>
 *     send --workspace <ref> <text>   text: TYPED_TEXT only
 *     send-key --workspace <ref> Enter|Escape · read-screen --workspace <ref> [--lines <n>]
 *     list-workspaces · ping
 *   claude — volleyd starts claude only from `.volley/launch.sh` (renderLaunchScript), which the
 *     launch commands above run; its options are pinned (LAUNCH_SCRIPT_VARS), including
 *     `[--strict-mcp-config] --mcp-config=<worktree>/.volley/mcp.json -- <prompt>` (the flag is
 *     left out only under `agent_mcp: inherit`) — or from a
 *     sealed sign-in script (below). The one direct call: `claude auth status` (exactly; it prints
 *     a profile's login state and plan, never a credential)
 *   tmux (local: Claude account sign-in, src/claude/signin.ts) — sessions named
 *     `volley-signin-<acct>` only: new-session -d -s <it> -c <dir> 'bash signin.sh' with the
 *     SigninToken sealed for <dir> (`sealSigninScript`: exactly `renderSigninScript`, which runs
 *     `claude auth login` — never `setup-token`) · capture-pane -p -J -t <it> · has-session -t
 *     <it> · kill-session -t <it> (no consent: a sign-in session holds no agent's work)
 *   (agent logins are minted and deleted over volleyd's own Dynamic Security control
 *   connection, dynsec.ts: no `volley auth` command and no broker signal is involved)
 *   mosquitto -h   (exactly: it prints the binary's version, the fallback when the broker
 *     retains no $SYS/broker/version)
 *   volley auth list --json · rotate <agent_id> --json · revoke <agent_id>
 *   volley auth add <agent_id> --role ROLE [--kind KIND] --json
 *   volley auth signin-link --role steer|watch --label LABEL --ttl <seconds> --json
 *   volley auth redeem --label LABEL --json   (the token on stdin, never argv)
 *   volley auth token --json   (admin_token: the token sealed to the admin who asked)
 *     ROLE admin|steer|watch|supervisor|peer · KIND human|device|machine|service ·
 *     LABEL 1..64 printable characters, not starting with `-`
 *   volley peer doctor --json [--repo ABS]   (the supervisor's own machine's doctor report, SPEC
 *     §4.6.15: never --fix, which runs only on a box through ssh) · ABS the running wave's repo,
 *     an absolute path with no `.`/`..` segment and no control character
 *   launchctl bootstrap gui/<uid> $HOME/Library/LaunchAgents/systems.volley.volleyd.plist (that
 *     full path only) | bootout | kickstart [-k] [-p] | print — only for the
 *     systems.volley.volleyd service
 *   pressure samplers, exact argv only: sysctl -n kern.memorystatus_vm_pressure_level ·
 *     memory_pressure (no arguments: report only) · docker info --format {{json .}}
 *
 * SCRIPT (allowed only with a ScriptToken naming exactly that path): the brief gate
 *   (`$VOLLEYD_HOME/brief-gate`), the one program volleyd runs by path.
 *
 * SETUP (only with a SetupToken, `mintSetupToken`, and with one nothing else): the commands a
 *   `volley setup` step volleyd runs for the Desk (setup-ops.ts) may run: the terminal's own
 *   commands (volley-cli's `setupFence`) for the detected layout, minus those only a terminal
 *   may run:
 *     the layout's restart (brew layouts; never one starting with sudo) ·
 *     <ctrl> dynsec init <the layout's state file> dynsec-admin <password> (brew layouts) ·
 *     mosquitto -h
 *     launchctl print gui/<uid>/systems.volley.volleyd | gui/<uid>/systems.volley.desk ·
 *       bootout gui/<uid>/systems.volley.desk ·
 *       bootstrap gui/<uid> $HOME/Library/LaunchAgents/systems.volley.desk.plist
 *     systemctl --user daemon-reload | is-active volleyd.service |
 *       is-active | enable | restart volley-desk.service
 *     bash <repo>/packages/volley-hooks/scripts/install.sh [--dry-run]
 *     <bun> <repo>/packages/volleyd/src/cli.ts install --broker-url mqtt://… --dry-run (the
 *       plan's probe only) · <bun> run build in <repo>/packages/volley-desk
 *   Never volleyd's own service (installing or restarting it would stop the volleyd answering),
 *   sudo, or the keychain (the logged-in session's): those stay terminal-only.
 *
 * TYPED_TEXT (cmux send, tmux send-keys -l: what is typed into an agent's terminal), each only
 *   with its token, checked by identity like consent tokens:
 *     LAUNCH_COMMAND   with a LaunchToken (`sealLaunchScript`: volleyd rendered that launch.sh)
 *     `/model <id>`    with the ModelSwitchToken naming exactly <id> (`mintModelSwitchToken`,
 *                      minted when an approved model_switch decision is acted on); <id> is a
 *                      MODEL_ID, the wave-file schema's `model` pattern
 *
 * SSH (remote hosts, src/hosts/ssh-tmux.ts) — three forms only:
 *   ssh -T [-o <Opt>=<v>]… <target> bash -s   with a fenced RemoteScript (FenceOptions.remote):
 *     every step is checked against the REMOTE allow-list below and the script `exec` sends on
 *     stdin is `renderRemoteScript` of exactly those steps; a raw stdin script is refused, as is
 *     any `ssh <target> '<command>'` string (zsh login shells word-split it differently).
 *   ssh -N -R <port>:<host>:<port> [-o <Opt>=<v>]… <target>   the reverse broker tunnel.
 *   ssh -N -L 127.0.0.1:<p>:127.0.0.1:<p> -o BatchMode=yes -o ExitOnForwardFailure=yes
 *     -o ConnectTimeout=<s> <target>   a paired machine's Claude sign-in forward
 *     (src/claude/forward.ts), exactly that argv, only with the SigninForwardToken a remote
 *     sign-in minted for exactly (<target>, <p>): the same port on both ends, p in 1024..65535,
 *     never a broker tunnel's port (`mintSigninForwardToken`). Its bytes are never read.
 *   -o takes only BatchMode, ConnectTimeout, ServerAliveInterval, ServerAliveCountMax,
 *   ExitOnForwardFailure (never ProxyCommand, LocalCommand, …); a target never starts with '-'.
 *
 * REMOTE (one step of a RemoteScript; the same DENY list applies first):
 *   git — the local git policy (worktree add | fetch | rev-parse | … ; worktree remove = CONSENT)
 *   gh issue view
 *   tmux new-session -d -s <name> -c <dir> 'bash .volley/launch.sh' (that command only, with
 *     the LaunchToken sealed for <dir>) | new-session -d -s volley-signin-<acct> -c <dir>
 *     'bash signin.sh' (exactly, with the remote SigninToken sealed for <dir>,
 *     `sealRemoteSigninScript`) | capture-pane | has-session |
 *     send-keys -t <t> Enter|Escape | send-keys -t <t> -l -- <TYPED_TEXT> |
 *     show-environment -g PATH | set-environment -g PATH <absolute dirs> (the box's own
 *     PATH, from printenv, then the server's own dirs) —
 *     kill-session -t volley-signin-<acct> (no consent: a sign-in session holds no agent's
 *     work) — any other kill-session = CONSENT; no other tmux global option
 *   mkdir -p <path>… · chmod <3 octal digits> <a file base64 -d may write>… ·
 *     nc -z 127.0.0.1 <port> · printenv PATH | HOME
 *   claude auth status (exactly: the box's login state and plan, never a credential; a login
 *     runs only from a sealed signin.sh)
 *   cat <path>… — only the files volleyd reads: `.claude.json`, a path ending in
 *     `/info/exclude`, `<dir>/.volley/<name>` for a VOLLEY_READS name, or a sign-in dir's `url`
 *   base64 -d — the only step that redirects to a file, from base64 text on stdin, under umask
 *     077, and only to the files volleyd writes: `<dir>/.volley/<name>` for a VOLLEY_WRITES name
 *     (agent.json, brief.md, launch.sh, mcp.json, review.md, findings.md, findings.json,
 *     rebase.md — spelled exactly, directly inside `.volley/`, so no write there is a git
 *     config, HEAD, gitfile or hook, or a case variant of launch.sh), an absolute path ending in
 *     `/ISSUE.md` or `/info/exclude`, or `~/.claude.json.volleyd.tmp`. A `.volley/launch.sh`
 *     (what the tmux session runs) is written whole, never appended, and its content must be
 *     exactly `renderLaunchScript` of valid values for that worktree (LAUNCH_SCRIPT_VARS); a
 *     `.volley/mcp.json` (the MCP server claude starts) likewise exactly `renderMcpConfig` of an
 *     absolute `…/packages/volley-mcp/src/index.ts` outside any `.volley/` (MCP_CONFIG); and
 *     a paired machine's sign-in dir `<abs>/.volley/signin/<acct>/` (src/claude/remote-signin.ts):
 *     `signin.sh` exactly `renderSigninScript` for that dir with no profile dir (`claude auth
 *     login`, never `setup-token`), `browser.sh` exactly `renderBrowserHelper`, `url` only empty
 *   command -v <claude|bun>… — the readiness PATH probe (RemoteHost.probePath)
 *   volley peer doctor --json [--fix --yes [--clone --origin <https URL>]] — the machine's doctor
 *     (RemoteHost.runDoctor, the `peer_doctor` op; the URL is `https://<host>/<path>`, no
 *     credentials or port, isCloneUrl); no other volley argv runs on a box
 *   the trust write (RemoteHost.recordTrust, on the owner's `trust` answer only):
 *     cmp -s - .claude.json (base64 of the file as read, on stdin) ·
 *     mv -f .claude.json.volleyd.tmp .claude.json
 *   Every other step's stdin is /dev/null, so no step can read the rest of the script.
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

/**
 * Mint a consent token. Callers: `volleyd cleanup --yes`, and a retire closing the retired
 * agent's own workspace (daemon.ts: its session is over, its login already deleted; the worktree
 * and branch stay for cleanup).
 */
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

const switches = new WeakSet<object>();

/**
 * Approval of one model switch: `/model <model>` is typed into an agent's terminal only with the
 * token naming that model. Only `mintModelSwitchToken` creates one (checked by identity).
 */
export interface ModelSwitchToken {
  readonly model: string;
  readonly decision_id: string;
}

/** Callers: the daemon, acting on an approved model_switch decision (runModelSwitch) only. */
export function mintModelSwitchToken(model: string, decisionId: string): ModelSwitchToken {
  if (!MODEL_ID.test(model))
    throw new FenceError(`/model ${JSON.stringify(model)}`, "not a model id");
  const token = Object.freeze({ model, decision_id: decisionId });
  switches.add(token);
  return token;
}

const launches = new WeakSet<object>();

/**
 * Proof that the `.volley/launch.sh` in `cwd` is one volleyd rendered: LAUNCH_COMMAND (which runs
 * it) is started there or typed only with one. Only `sealLaunchScript` creates one.
 */
export interface LaunchToken {
  readonly cwd: string;
}

/**
 * Seal the launch script volleyd is about to write to `<worktree>/.volley/launch.sh`: throws
 * `FenceError` unless `worktree` is a clean absolute path and `content` is exactly what
 * `renderLaunchScript` renders for that worktree (LAUNCH_SCRIPT_VARS: its `--mcp-config=` is
 * `<worktree>/.volley/mcp.json`). Callers: spawn, before the write.
 */
export function sealLaunchScript(worktree: string, content: string): LaunchToken {
  if (!absPath(worktree))
    throw new FenceError("launch.sh", "the worktree is not a clean absolute path");
  if (!isLaunchScript(content, worktree))
    throw new FenceError("launch.sh", "only a script renderLaunchScript renders for this worktree");
  const token = Object.freeze({ cwd: worktree });
  launches.add(token);
  return token;
}

const signins = new WeakSet<object>();

/**
 * Proof that `<cwd>/signin.sh` is one volleyd rendered: a profile's on this machine
 * (`sealSigninScript`), or a paired machine's default profile's (`sealRemoteSigninScript`,
 * `remote`). Each starts only its own kind of session.
 */
export interface SigninToken {
  readonly cwd: string;
  readonly remote: boolean;
}

/** A sign-in tmux session's name: `volley-signin-<acct>`, the account id grammar. */
const SIGNIN_SESSION = /^volley-signin-[a-z0-9][a-z0-9_-]{0,62}$/;
const SIGNIN_EXPORT = (name: string) => new RegExp(`^export ${name}=(${SHQ})$`);

/**
 * Seal the sign-in script volleyd is about to write to `<dir>/signin.sh`: throws `FenceError`
 * unless `dir` is a clean absolute path and `content` is exactly `renderSigninScript` of a clean
 * absolute profile dir and that `dir` (so `$BROWSER` is `<dir>/browser.sh`). Callers: signin.ts.
 */
export function sealSigninScript(dir: string, content: string): SigninToken {
  if (!absPath(dir))
    throw new FenceError("signin.sh", "the sign-in dir is not a clean absolute path");
  const m = SIGNIN_EXPORT("CLAUDE_CONFIG_DIR").exec(content.split("\n")[3] ?? "");
  const configDir = m !== null ? unshq(m[1] as string) : "";
  if (!absPath(configDir) || renderSigninScript({ configDir, signinDir: dir }) !== content)
    throw new FenceError("signin.sh", "only a script renderSigninScript renders for this dir");
  const token = Object.freeze({ cwd: dir, remote: false });
  signins.add(token);
  return token;
}

/** A paired machine's sign-in dir: `<home>/.volley/signin/<acct>` (remote-signin.ts). */
const REMOTE_SIGNIN_DIR = /^\/(?:.*\/)?\.volley\/signin\/[a-z0-9][a-z0-9_-]{0,62}$/;
const isRemoteSigninDir = (dir: string) => absPath(dir) && REMOTE_SIGNIN_DIR.test(dir);

/**
 * Seal the sign-in script volleyd is about to write to `<dir>/signin.sh` on a paired machine:
 * throws `FenceError` unless `dir` is `<abs>/.volley/signin/<acct>` and `content` is exactly
 * `renderSigninScript` of that dir with no profile dir (the box's own default profile).
 * Callers: remote-signin.ts.
 */
export function sealRemoteSigninScript(dir: string, content: string): SigninToken {
  if (!isRemoteSigninDir(dir))
    throw new FenceError("signin.sh", "the sign-in dir is not <home>/.volley/signin/<acct>");
  if (renderSigninScript({ signinDir: dir }) !== content)
    throw new FenceError("signin.sh", "only a script renderSigninScript renders for this dir");
  const token = Object.freeze({ cwd: dir, remote: true });
  signins.add(token);
  return token;
}

/**
 * A file of a paired machine's sign-in dir and the only content volleyd writes to it: the sealed
 * `signin.sh`, the `browser.sh` helper, or an empty `url` (a stale URL is never read back). Null
 * for any other path.
 */
function remoteSigninFile(path: string): { name: string; content: string } | null {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash);
  const name = path.slice(slash + 1);
  if (slash < 0 || !absPath(path) || !isRemoteSigninDir(dir)) return null;
  if (name === SIGNIN_SCRIPT) return { name, content: renderSigninScript({ signinDir: dir }) };
  if (name === BROWSER_HELPER) return { name, content: renderBrowserHelper(dir) };
  if (name === SIGNIN_URL_FILE) return { name, content: "" };
  return null;
}

const forwards = new WeakSet<object>();

/**
 * Permission for one sign-in forward: `ssh -N -L 127.0.0.1:<port>:127.0.0.1:<port> … <target>`,
 * which carries the browser's redirect to Claude Code's own listener on a paired machine. Only
 * `mintSigninForwardToken` creates one (checked by identity). Callers: remote-signin.ts.
 */
export interface SigninForwardToken {
  readonly target: string;
  readonly port: number;
}

/**
 * Mint the forward token for (`target`, `port`): throws `FenceError` for a target that is not an
 * ssh destination, a port outside 1024..65535, or one of `reserved` (the ports the config's
 * broker tunnels use).
 */
export function mintSigninForwardToken(
  target: string,
  port: number,
  reserved: readonly number[],
): SigninForwardToken {
  if (!SSH_TARGET.test(target)) throw new FenceError("ssh -L", "the target is not an ssh host");
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new FenceError("ssh -L", `port ${port} is outside 1024..65535`);
  if (reserved.includes(port))
    throw new FenceError("ssh -L", `port ${port} is a broker tunnel's port`);
  const token = Object.freeze({ target, port });
  forwards.add(token);
  return token;
}

const setups = new WeakSet<object>();

/** What one setup run may execute: `setupFence`'s inputs for the detected layout, Desk-safe. */
export interface SetupFenceInputs {
  /** The layout's restart command, or null when only a terminal may restart this broker. */
  restart: string | null;
  /** `<bin> dynsec init <stateFile> …` (the brew layouts' state file), or null. */
  ctrl: { bin: string; stateFile: string } | null;
  /** This Volley checkout, or null (then no hooks installer, Desk build or volleyd probe). */
  repoRoot: string | null;
  /** The `bun` the services run (`SetupDeps.bun`): the one program allowed by path. */
  bun: string;
  /** The user's home (the Desk service's plist). */
  home: string;
  uid: number;
}

/** Permission to run the SETUP rows for one setup run (`mintSetupToken`; checked by identity). */
export interface SetupToken {
  readonly inputs: Readonly<SetupFenceInputs>;
}

/** Callers: setup-ops.ts, once per setup_plan / setup_apply. */
export function mintSetupToken(inputs: SetupFenceInputs): SetupToken {
  const token = Object.freeze({ inputs: Object.freeze({ ...inputs }) });
  setups.add(token);
  return token;
}

const DESK_SERVICE = "systems.volley.desk";
const DESK_UNIT = "volley-desk.service";
const VOLLEYD_UNIT = "volleyd.service";
const same = (argv: readonly string[], want: readonly string[]) =>
  argv.length === want.length && want.every((w, i) => argv[i] === w);

/**
 * The SETUP rows (see the header): the only commands a setup token allows, and with one only
 * they are allowed. `cwd` is the command's working directory (the Desk build's).
 */
function setupVerdict(argv: readonly string[], t: SetupFenceInputs, cwd?: string): Verdict {
  const [a0, a1, a2, a3] = argv;
  const line = argv.join(" ");
  const repo = (...p: string[]) => (t.repoRoot === null ? null : join(t.repoRoot, ...p));
  const hooks = repo("packages", "volley-hooks", "scripts", "install.sh");
  const volleydCli = repo("packages", "volleyd", "src", "cli.ts");
  const gui = `gui/${t.uid}`;
  const ok =
    (t.restart !== null && !t.restart.startsWith("sudo ") && line === t.restart) ||
    (t.ctrl !== null &&
      argv.length === 6 &&
      a0 === t.ctrl.bin &&
      a1 === "dynsec" &&
      a2 === "init" &&
      a3 === t.ctrl.stateFile &&
      argv[4] === DYNSEC_ADMIN_USER &&
      /^[\x21-\x7e]{1,128}$/.test(argv[5] ?? "")) ||
    same(argv, ["mosquitto", "-h"]) ||
    (a0 === "launchctl" &&
      argv.length === 3 &&
      a1 === "print" &&
      (a2 === `${gui}/${SERVICE_LABEL}` || a2 === `${gui}/${DESK_SERVICE}`)) ||
    same(argv, ["launchctl", "bootout", `${gui}/${DESK_SERVICE}`]) ||
    same(argv, [
      "launchctl",
      "bootstrap",
      gui,
      join(t.home, "Library", "LaunchAgents", `${DESK_SERVICE}.plist`),
    ]) ||
    same(argv, ["systemctl", "--user", "daemon-reload"]) ||
    same(argv, ["systemctl", "--user", "is-active", VOLLEYD_UNIT]) ||
    (a0 === "systemctl" &&
      a1 === "--user" &&
      ["is-active", "enable", "restart"].includes(a2 ?? "") &&
      a3 === DESK_UNIT &&
      argv.length === 4) ||
    (hooks !== null && (same(argv, ["bash", hooks]) || same(argv, ["bash", hooks, "--dry-run"]))) ||
    // Only the dry run: installing volleyd's service would stop the volleyd answering.
    (volleydCli !== null &&
      argv.length === 6 &&
      a0 === t.bun &&
      a1 === volleydCli &&
      a2 === "install" &&
      a3 === "--broker-url" &&
      /^mqtt:\/\/[^\s]+$/.test(argv[4] ?? "") &&
      argv[5] === "--dry-run") ||
    (same(argv, [t.bun, "run", "build"]) &&
      t.repoRoot !== null &&
      cwd === repo("packages", "volley-desk"));
  return ok ? ALLOW : deny(`${line.slice(0, 60)} (not a setup command volleyd runs for the Desk)`);
}

const sealedFor = (opts: FenceOptions, cwd?: string) =>
  opts.launch !== undefined &&
  launches.has(opts.launch) &&
  (cwd === undefined || opts.launch.cwd === cwd);

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
  /** For starting or typing LAUNCH_COMMAND: the sealed launch script. */
  launch?: LaunchToken;
  /** For typing `/model <id>`: the approved switch. */
  modelSwitch?: ModelSwitchToken;
  /** For starting a sign-in tmux session: the sealed sign-in script. */
  signin?: SigninToken;
  /** For the sign-in forward (`ssh -N -L`): the token a remote sign-in minted. */
  forward?: SigninForwardToken;
  /** A setup step for the Desk (setup-ops.ts): only the SETUP rows, and nothing else. */
  setup?: SetupToken;
  /** The command's working directory; only the SETUP rows read it (the Desk build). */
  cwd?: string;
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

/** A git remote's name (`origin`): never a path (`.`, `/tmp/repo`) or a transport helper. */
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A network URL: `https|ssh|git://<host>…` or scp-like `user@host:path` (no `file://`). */
const NETWORK_URL =
  /^(?:(?:https|ssh|git):\/\/[A-Za-z0-9_\[]|[A-Za-z0-9_][^\s:/@]*@[A-Za-z0-9_][^\s:/]*:)\S*$/;

/**
 * `git fetch [<repository>] [<refspec>…]`: the repository is a remote name or a network URL
 * (never a local path or a transport helper); a refspec may write only remote-tracking refs, so
 * `+HEAD:refs/heads/main`, `+feat:main` or `main:main` can never move a local branch.
 */
function fetchPositionals(args: readonly string[]): Verdict {
  const valued = GIT_SPECS.fetch?.valued ?? [];
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (valued.includes(a)) i++;
    else if (!a.startsWith("-") || a === "-") pos.push(a);
  }
  const [repo, ...refspecs] = pos;
  if (repo !== undefined && !REMOTE_NAME.test(repo) && !NETWORK_URL.test(repo))
    return deny(`git fetch ${repo} (a remote name or a network URL only)`);
  for (const r of refspecs) {
    const colon = r.indexOf(":");
    const src = colon === -1 ? r : r.slice(0, colon);
    const dst = colon === -1 ? undefined : r.slice(colon + 1);
    const ok =
      src !== "" &&
      src !== "+" &&
      (dst === undefined ? !src.startsWith("+") : dst.startsWith("refs/remotes/"));
    if (!ok) return deny(`git fetch ${r} (refspecs write refs/remotes/ only)`);
  }
  return ALLOW;
}

const PROTECTED_BRANCHES = new Set(["main", "master"]);

/**
 * `git branch --track <b> <remote>/<b>`: the local tracking branch for a release branch that
 * exists only on the remote (worktree.ts resolveReleaseBase). Exactly that shape: a new branch
 * (git refuses to overwrite one without `-f`), never main/master, named like its upstream.
 */
function trackingBranch(args: readonly string[]): Verdict {
  const [branch, upstream] = args;
  if (args.length !== 2 || branch === undefined || upstream === undefined)
    return deny("git branch --track (only <branch> <remote>/<branch>)");
  const slash = upstream.indexOf("/");
  const ok =
    !branch.startsWith("-") &&
    !PROTECTED_BRANCHES.has(branch.toLowerCase()) &&
    slash > 0 &&
    REMOTE_NAME.test(upstream.slice(0, slash)) &&
    upstream.slice(slash + 1) === branch;
  return ok ? ALLOW : deny(`git branch --track ${branch} ${upstream}`);
}

/**
 * `git worktree add` must create its own branch (`-b <new>`, never main/master) or detach:
 * without either, git checks out an existing branch (`add /w main`, or `add /w/main`, which
 * DWIMs to the branch named like the directory), and commits would land on it. `-B` resets an
 * existing branch to the base and checks it out, so it is allowed only for a branch volleyd mints
 * (`AGENT_BRANCH`: a leftover of a failed add, re-created on the retry) — never a release branch.
 */
function worktreeAddBranch(args: readonly string[]): Verdict {
  let branch: string | undefined;
  let reset = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-b" || a === "-B") {
      branch = args[++i];
      reset = a === "-B";
    } else if ((a.startsWith("-b") || a.startsWith("-B")) && a.length > 2) {
      branch = a.slice(2);
      reset = a.startsWith("-B");
    }
  }
  if (branch === undefined && !args.includes("--detach"))
    return deny("git worktree add (without -b|-B <branch> or --detach)");
  if (branch !== undefined && PROTECTED_BRANCHES.has(branch.toLowerCase()))
    return deny(`git worktree add -b ${branch}`);
  if (reset && !AGENT_BRANCH.test(branch ?? ""))
    return deny(`git worktree add -B ${branch} (only an agent branch <wave>/<task>-<role>-<n>)`);
  return ALLOW;
}

const GIT_SPECS: Record<string, OptSpec> = {
  "worktree add": {
    flags: ["--detach", "--quiet", "-q", "--lock", "--track", "--no-track", "--checkout"],
    valued: ["-b", "-B", "--reason"],
  },
  fetch: {
    flags: ["--prune", "-p", "--prune-tags", "--tags", "--no-tags", "--quiet", "-q", "--all"],
    valued: ["--depth"],
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
  // The wave's repository visibility (public hygiene); no --web, --branch.
  "repo view": { valued: GH_OUTPUT },
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
  // token is sent), no -H / --header (X-HTTP-Method-Override turns a GET into a write). The
  // method is checked separately: GET only; so is the endpoint: never graphql (mutations).
  api: {
    flags: ["--paginate", "--slurp", "--include", "-i", "--silent"],
    valued: ["-X", "--method", "-f", "--raw-field", "--jq", "-q", "--template", "-t", "--cache"],
  },
};

/**
 * A model id (or alias) as `/model` and `claude --model` take it: `claude-opus-5-5`, `opus`,
 * `claude-x[1m]`, provider-qualified ids (`us.anthropic.claude-x-v1:0`, `claude-x@20250805`, an
 * ARN). One word, no shell syntax. The wave-file schema's `model` pattern is this regex's source
 * (a test keeps the two equal), so `volleyd validate` refuses what the fence would.
 */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}(\[[A-Za-z0-9]{1,16}\])?$/;

/**
 * TYPED_TEXT: why `text` may not be typed into an agent's terminal (cmux send, tmux send-keys
 * -l), or null when it may. Only the launch command (a relaunch in a reused workspace) and an
 * approved model switch, each with its token; anything else would be a shell command or a
 * prompt in a permission-skipping session.
 */
function typedTextRefusal(text: string, opts: FenceOptions): string | null {
  if (text === LAUNCH_COMMAND)
    return sealedFor(opts) ? null : "launch command without a sealed launch.sh";
  if (text.startsWith("/model ")) {
    const t = opts.modelSwitch;
    return t !== undefined && switches.has(t) && text === `/model ${t.model}`
      ? null
      : "/model without the token of an approved model_switch decision";
  }
  return "text volleyd never types";
}

/** The keys volleyd sends by name: submit, and interrupt. */
const NAMED_KEYS = new Set(["Enter", "Escape"]);
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
  if (opts.setup !== undefined) {
    const v = setups.has(opts.setup)
      ? setupVerdict(argv, opts.setup.inputs, opts.cwd)
      : deny(`${argv.slice(0, 2).join(" ")} (a setup token volleyd did not mint)`);
    if (v.kind !== "allow") throw new FenceError(v.verb, "not permitted for volleyd");
    return;
  }
  const prog = argv[0];
  const verdicts = prog === "ssh" ? sshVerdicts(argv.slice(1), opts) : [evaluate(argv, opts)];
  for (const v of verdicts) {
    if (v.kind === "allow") continue;
    if (v.kind === "consent") {
      if (opts.consent !== undefined && minted.has(opts.consent)) continue;
      throw new FenceError(
        v.verb,
        "requires consent from `volleyd cleanup --yes` (or a retire, for its agent's own workspace)",
      );
    }
    throw new FenceError(v.verb, "not permitted for volleyd");
  }
}

function evaluate(argv: readonly string[], opts: FenceOptions): Verdict {
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
      return cmux(args, opts);
    case "claude":
      // claude starts only from `.volley/launch.sh` or a sealed sign-in script (see the header);
      // the one direct call reads a profile's login state.
      return args.length === 2 && args[0] === "auth" && args[1] === "status"
        ? ALLOW
        : deny("claude (only from .volley/launch.sh)");
    case "tmux":
      return localTmux(args, opts);
    case "volley":
      return volley(args);
    case "mosquitto":
      return args.length === 1 && args[0] === "-h" ? ALLOW : deny("mosquitto (only -h)");
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
    const v = checkArgs("git worktree add", rest.slice(1), spec);
    return v.kind === "allow" ? worktreeAddBranch(rest.slice(1)) : v;
  }
  if (sub === "branch" && rest[0] === "--track") return trackingBranch(rest.slice(1));
  if (sub === "branch" && !rest.includes("--list") && !rest.includes("-l")) {
    return deny("git branch (without --list)");
  }
  const spec = Object.hasOwn(GIT_SPECS, sub) ? GIT_SPECS[sub] : undefined;
  if (spec === undefined) return deny(`git ${sub}`);
  const v = checkArgs(`git ${sub}`, rest, spec);
  return v.kind === "allow" && sub === "fetch" ? fetchPositionals(rest) : v;
}

function gh(args: string[]): Verdict {
  const two = args.slice(0, 2).join(" ");
  if (two === "pr merge" || two === "workflow run" || two === "repo delete")
    return deny(`gh ${two}`);
  if (args[0] === "api") {
    const v = checkArgs("gh api", args.slice(1), {
      ...(GH_SPECS.api as OptSpec),
      // A relative endpoint: a URL could name another endpoint (graphql) or another host.
      positional: (a) => !a.includes("://") && !/(^|\/)graphql(\/|\?|$)/i.test(a),
    });
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

/** A cmux workspace ref (`workspace:3`, a UUID): one word, never an option. */
const WORKSPACE_REF = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

/**
 * cmux runs and types commands in an agent's shell, so every subcommand has an exact argv shape
 * (see the header): the launch command of a sealed launch script is the only command a
 * workspace starts with, and TYPED_TEXT (`typedTextRefusal`) the only text sent into one.
 */
function cmux(args: string[], opts: FenceOptions): Verdict {
  const [sub = "", ...rest] = args;
  if (sub === "close-workspace") return { kind: "consent", verb: "cmux close-workspace" };
  const ws = rest[0] === "--workspace" && WORKSPACE_REF.test(rest[1] ?? "");
  if (sub === "send" && ws && rest.length === 3) {
    const why = typedTextRefusal(rest[2] ?? "", opts);
    return why === null ? ALLOW : deny(`cmux send (${why})`);
  }
  const ok = (() => {
    switch (sub) {
      case "new-workspace":
        return newWorkspaceAllowed(rest, opts);
      case "send-key":
        return ws && rest.length === 3 && NAMED_KEYS.has(rest[2] ?? "");
      case "read-screen":
        return (
          ws &&
          (rest.length === 2 ||
            (rest.length === 4 && rest[2] === "--lines" && /^[0-9]{1,6}$/.test(rest[3] ?? "")))
        );
      case "list-workspaces":
      case "ping":
        return rest.length === 0;
      default:
        return false;
    }
  })();
  return ok ? ALLOW : deny(`cmux ${sub}`.trim());
}

/**
 * `cmux new-workspace`: `--cwd <dir> --name <name> --command LAUNCH_COMMAND`, each once, with the
 * LaunchToken sealed for exactly <dir> (any other directory's launch.sh is not volleyd's).
 */
function newWorkspaceAllowed(args: readonly string[], fence: FenceOptions): boolean {
  if (args.length !== 6) return false;
  const opts = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const [k = "", v = ""] = [args[i], args[i + 1]];
    if (opts.has(k) || v.startsWith("-")) return false;
    opts.set(k, v);
  }
  const cwd = opts.get("--cwd") ?? "";
  return (
    opts.get("--command") === LAUNCH_COMMAND &&
    opts.has("--name") &&
    absPath(cwd) &&
    sealedFor(fence, cwd)
  );
}

/** No `..`, `.` or empty segment (after the leading `/`): the path is what it looks like. */
const cleanPath = (p: string) =>
  p
    .replace(/^\//, "")
    .split("/")
    .every((s) => s !== "" && s !== "." && s !== "..");

/** An absolute path (no newline: a heredoc delimiter could follow) that is what it looks like. */
const absPath = (p: string) => /^\/[^\n\r\0]*$/.test(p) && cleanPath(p);

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const ROLE = /^(admin|steer|watch|supervisor|peer)$/;
const KIND = /^(human|device|machine|service)$/;
const LABEL = (l: string | undefined) =>
  l !== undefined &&
  l.length >= 1 &&
  l.length <= 64 &&
  !l.startsWith("-") &&
  [...l].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f);
const TTL = /^[1-9][0-9]{0,5}$/;

/**
 * The account verbs the daemon's account ops run (accounts.ts), each one exact shape. Tokens
 * never appear: `redeem` reads its token from stdin.
 */
const ACCOUNT_SHAPES: Record<string, (a: string[]) => boolean> = {
  list: (a) => a.length === 1 && a[0] === "--json",
  rotate: (a) => a.length === 2 && AGENT_ID.test(a[0] ?? "") && a[1] === "--json",
  revoke: (a) => a.length === 1 && AGENT_ID.test(a[0] ?? ""),
  add: (a) =>
    AGENT_ID.test(a[0] ?? "") &&
    a[1] === "--role" &&
    ROLE.test(a[2] ?? "") &&
    ((a.length === 4 && a[3] === "--json") ||
      (a.length === 6 && a[3] === "--kind" && KIND.test(a[4] ?? "") && a[5] === "--json")),
  "signin-link": (a) =>
    a.length === 7 &&
    a[0] === "--role" &&
    (a[1] === "steer" || a[1] === "watch") &&
    a[2] === "--label" &&
    LABEL(a[3]) &&
    a[4] === "--ttl" &&
    TTL.test(a[5] ?? "") &&
    a[6] === "--json",
  redeem: (a) => a.length === 3 && a[0] === "--label" && LABEL(a[1]) && a[2] === "--json",
  token: (a) => a.length === 1 && a[0] === "--json",
};

/** The own doctor's `--repo`: absolute, normalised (no `.`/`..` segment), no control character. */
function isRepoPath(p: string | undefined): boolean {
  if (p === undefined || !p.startsWith("/")) return false;
  return (
    [...p].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f) &&
    !p.split("/").some((seg) => seg === "." || seg === "..")
  );
}

/** `volley auth <account verb>`: the account ops volleyd runs for an admin (accounts.ts). */
function volley(args: string[]): Verdict {
  const [group, verb] = args;
  const name = `volley ${[group, verb].filter((a) => a !== undefined).join(" ")}`;
  // The supervisor is its own machine's doctor (SPEC §4.6.15): a report, never a fix.
  if (group === "peer" && verb === "doctor") {
    const rest = args.slice(2);
    const ok =
      rest[0] === "--json" &&
      (rest.length === 1 || (rest.length === 3 && rest[1] === "--repo" && isRepoPath(rest[2])));
    return ok ? ALLOW : deny(`volley peer doctor ${rest.join(" ")} (only --json [--repo <abs>])`);
  }
  if (group === "auth" && verb !== undefined && ACCOUNT_SHAPES[verb] !== undefined) {
    return ACCOUNT_SHAPES[verb](args.slice(2)) ? ALLOW : deny(`${name} ${args.slice(2).join(" ")}`);
  }
  return deny(name);
}

/** The service plist `volleyd install` writes under `home` (`$HOME/Library/LaunchAgents`). */
export const plistPath = (home: string) =>
  join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
const plistFile = () => plistPath(process.env.HOME ?? homedir());

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
      target[1] === plistFile()) ||
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
function sshVerdicts(args: readonly string[], opts: FenceOptions): Verdict[] {
  if (args.includes("-L")) return [forwardVerdict(args, opts)];
  const script = opts.remote;
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
  return script.steps.map((s) => remoteStep(s, opts));
}

/** `-L 127.0.0.1:<port>:127.0.0.1:<port>`: loopback on both ends. */
const SSH_LOCAL_FORWARD = /^127\.0\.0\.1:([0-9]{1,5}):127\.0\.0\.1:([0-9]{1,5})$/;

/**
 * The sign-in forward, one exact argv: `-N -L 127.0.0.1:<p>:127.0.0.1:<p> -o BatchMode=yes
 * -o ExitOnForwardFailure=yes -o ConnectTimeout=<s> <target>`, with the token minted for exactly
 * (target, p). The same port on both ends: the OAuth redirect must match verbatim.
 */
function forwardVerdict(args: readonly string[], opts: FenceOptions): Verdict {
  const t = opts.forward;
  const m = SSH_LOCAL_FORWARD.exec(args[2] ?? "");
  const ok =
    t !== undefined &&
    forwards.has(t) &&
    opts.remote === undefined &&
    m !== null &&
    m[1] === String(t.port) &&
    m[2] === String(t.port) &&
    args.length === 10 &&
    sameArgv(args.slice(0, 2), ["-N", "-L"]) &&
    sameArgv(args.slice(3, 8), ["-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o"]) &&
    /^ConnectTimeout=[0-9]{1,4}$/.test(args[8] ?? "") &&
    args[9] === t.target;
  return ok ? ALLOW : deny("ssh -L (only a sign-in's forward, with its token)");
}

/** The tools the readiness PATH probe resolves on a box (`command -v claude bun`). */
export const PATH_PROBE_TOOLS = ["claude", "bun"] as const;
/** `volley peer doctor` on a box (the Desk's Repair, `peer_doctor`): these argv only. */
const REMOTE_DOCTOR: readonly (readonly string[])[] = [
  ["peer", "doctor", "--json"],
  ["peer", "doctor", "--json", "--fix", "--yes"],
];
/** … and with `--clone`, the URL it clones from (`--origin`, a CLONE_URL). */
const REMOTE_DOCTOR_CLONE = ["peer", "doctor", "--json", "--fix", "--yes", "--clone", "--origin"];
/**
 * What a box's doctor may clone (`--origin`): `https://<host>/<path>`, the form `cloneUrl`
 * (peers.ts) makes from a normalised origin. No credentials, port, query, `..` segment, space or
 * control character, so git reads it as nothing but a URL.
 */
const CLONE_URL = /^https:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9._~-]+)+$/;
export const isCloneUrl = (url: string): boolean =>
  CLONE_URL.test(url) && !url.split("/").some((seg) => seg === "." || seg === "..");

const remoteDeny = (v: Verdict): Verdict =>
  v.kind === "allow" ? v : { ...v, verb: `remote ${v.verb}` };

/** The remote login user's Claude Code config (bash -s starts in the home directory). */
export const REMOTE_CLAUDE_JSON = ".claude.json";
/** Where RemoteHost.recordTrust writes the new config before the compare-and-swap `mv`. */
export const REMOTE_CLAUDE_JSON_TMP = ".claude.json.volleyd.tmp";
/** The only argv that takes base64 on stdin without writing a file: the trust write's compare. */
const TRUST_COMPARE = ["cmp", "-s", "-", REMOTE_CLAUDE_JSON];
const TRUST_SWAP = ["mv", "-f", REMOTE_CLAUDE_JSON_TMP, REMOTE_CLAUDE_JSON];
const sameArgv = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The files volleyd writes in a worktree's `.volley/` (spawn.ts, pipeline.ts, identity.ts). */
const VOLLEY_WRITES = new Set([
  "agent.json",
  "brief.md",
  "launch.sh",
  "mcp.json",
  "review.md",
  "findings.md",
  "findings.json",
  "rebase.md",
]);
/** … and the ones it reads there: those, and the repo's `.volley/brief-extra.md`. */
const VOLLEY_READS = new Set([...VOLLEY_WRITES, "brief-extra.md"]);

/**
 * `<abs dir>/.volley/<name>` for one of `names` — spelled exactly and directly inside `.volley/`,
 * so no write there is a git config, HEAD or gitfile, a hook, or a case variant of a name (which
 * a case-insensitive file system opens as the same file) — or an absolute path ending in one of
 * `endings`.
 */
function volleyPath(path: string, names: ReadonlySet<string>, endings: readonly string[]) {
  if (!absPath(path)) return false;
  const segs = path.split("/");
  if (segs.length >= 4 && segs.at(-2) === ".volley" && names.has(segs.at(-1) ?? "")) return true;
  return endings.some((e) => path.endsWith(e));
}

/** The files volleyd writes on a remote host (worktree files, the shared exclude, the trust tmp). */
function writablePath(path: string): boolean {
  return (
    path === REMOTE_CLAUDE_JSON_TMP ||
    volleyPath(path, VOLLEY_WRITES, ["/ISSUE.md", "/info/exclude"])
  );
}

/** The files volleyd reads on a remote host (the brief, brief-extra, the exclude, the config). */
function readablePath(path: string): boolean {
  return path === REMOTE_CLAUDE_JSON || volleyPath(path, VOLLEY_READS, ["/info/exclude"]);
}

/** One single-quoted bash word as `shq` renders it. */
const SHQ = "'(?:[^']|'\\\\'')*'";
const unshq = (q: string) => q.slice(1, -1).replace(/'\\''/g, "'");
const LAUNCH_EXPORT = new RegExp(`^export ([A-Z0-9_]+)=(${SHQ})$`);
const LAUNCH_HOOKS = new RegExp(`^export VOLLEY_HOOKS_DIR=(${SHQ})$`);
const LAUNCH_PROFILE = new RegExp(`^export CLAUDE_CONFIG_DIR=(${SHQ})$`);
const LAUNCH_EXEC = new RegExp(
  `^exec claude .* --model (${SHQ}) --settings ${SHQ}( --strict-mcp-config)? --mcp-config=(${SHQ}) --name (${SHQ}) -- `,
);
/** What a `.volley/mcp.json` may run: some checkout's volley-mcp entry point. */
const MCP_ENTRY_SUFFIX = "/packages/volley-mcp/src/index.ts";
/** A remote host's launch.sh exports, in order: exactly what SshTmuxHost.launchEnv emits. */
const LAUNCH_ENV_KEYS = ["VOLLEY_BROKER_URL", "VOLLEY_NAMESPACE", "VOLLEY_AGENT_ID"];
/** The broker as a remote agent sees it: the reverse tunnel's end on the box's loopback. */
const TUNNEL_BROKER_URL = /^mqtt:\/\/127\.0\.0\.1:[0-9]{1,5}$/;

/** The env block: none (local), or exactly the three keys for this agent through the tunnel. */
function launchEnvAllowed(env: Record<string, string>, agentId: string): boolean {
  const keys = Object.keys(env);
  if (keys.length === 0) return true;
  return (
    keys.length === LAUNCH_ENV_KEYS.length &&
    keys.every((k, i) => k === LAUNCH_ENV_KEYS[i]) &&
    TUNNEL_BROKER_URL.test(env.VOLLEY_BROKER_URL ?? "") &&
    AGENT_ID.test(env.VOLLEY_NAMESPACE ?? "") &&
    env.VOLLEY_AGENT_ID === agentId
  );
}

/** An absolute, clean path no segment of which is `.volley` (in any case): never volleyd's. */
const outsideVolley = (p: string) =>
  absPath(p) && !p.split("/").some((seg) => seg.toLowerCase() === ".volley");

/** `p` is `dir` or anything below it (both clean absolute paths). */
const within = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

/** `p` with its symlinks resolved, or `p` itself when it does not exist. */
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * A launch script's `CLAUDE_CONFIG_DIR`: exactly `profileDir(claudeRoot(), <id>)` (the configured
 * profiles root, `$VOLLEY_CLAUDE_DIR`, default `~/.volley/claude`) for an account in that root's
 * registry, and nothing else: a real directory (not a symlink, not out of the root once resolved),
 * never inside the agent's worktree (which the agent writes, its `.volley/` included) nor holding
 * it. A root that is, holds or sits in `$VOLLEYD_HOME` admits nothing (its entries — `volleyd`
 * among them — would pass as profiles), and a relative one admits nothing.
 */
function profileDirAllowed(dir: string, worktree: string): boolean {
  try {
    const root = canonicalRoot(claudeRoot());
    const id = basename(dir);
    if (dir !== profileDir(root, id)) return false;
    if (within(dir, worktree) || within(worktree, dir)) return false;
    const home = resolve(volleydHome(process.env));
    if (within(root, home) || within(home, root)) return false;
    if (!readRegistry(root).accounts.some((a) => a.id === id)) return false;
    if (!lstatSync(dir).isDirectory()) return false;
    const resolved = realpathSync(dir);
    const wt = real(worktree);
    return (
      resolved === join(realpathSync(root), id) && !within(resolved, wt) && !within(wt, resolved)
    );
  } catch {
    return false;
  }
}

/**
 * LAUNCH_SCRIPT_VARS: whether `content` is exactly what `renderLaunchScript` renders for a
 * well-formed model id, agent id, absolute hooks directory (never inside a `.volley/`, where
 * volleyd writes), env block (`launchEnvAllowed`: a second VOLLEY_HOOKS_DIR export would win in
 * bash and point every hook at other code), optional Claude account profile (`CLAUDE_CONFIG_DIR`,
 * `profileDirAllowed`, with its credential env unset) and `worktree` — so
 * `--mcp-config=` names exactly `<worktree>/.volley/mcp.json` (with `--strict-mcp-config`, or
 * without it under `agent_mcp: inherit`, and `--` before the prompt). Parsed back into its
 * values and re-rendered, so not one byte can differ from a script volleyd writes.
 */
function isLaunchScript(content: string, worktree: string): boolean {
  const lines = content.split("\n");
  const hooks = LAUNCH_HOOKS.exec(lines[4] ?? "");
  const run = LAUNCH_EXEC.exec(lines.at(-2) ?? "");
  if (hooks === null || run === null) return false;
  if (!absPath(worktree) || unshq(run[3] as string) !== mcpConfigPath(worktree)) return false;
  // A Claude account profile: its CLAUDE_CONFIG_DIR export (re-rendered below with its unset).
  const profile = LAUNCH_PROFILE.exec(lines[5] ?? "");
  const claudeConfigDir = profile !== null ? unshq(profile[1] as string) : undefined;
  // `agent_mcp: inherit` (the user's MCP servers load too) renders no --strict-mcp-config.
  const strict = run[2] !== undefined;
  const env: Record<string, string> = {};
  // The exports end before launch.sh's claude check (the line before the exec).
  for (const line of lines.slice(profile !== null ? 7 : 5, -3)) {
    const m = LAUNCH_EXPORT.exec(line);
    if (m === null || Object.hasOwn(env, m[1] ?? "")) return false;
    env[m[1] as string] = unshq(m[2] as string);
  }
  const vars = {
    hooksDir: unshq(hooks[1] as string),
    model: unshq(run[1] as string),
    agentId: unshq(run[4] as string),
    worktree,
    env,
    ...(claudeConfigDir !== undefined ? { claudeConfigDir } : {}),
    ...(strict ? {} : { agentMcp: "inherit" as const }),
  };
  return (
    (claudeConfigDir === undefined || profileDirAllowed(claudeConfigDir, worktree)) &&
    outsideVolley(vars.hooksDir) &&
    MODEL_ID.test(vars.model) &&
    AGENT_ID.test(vars.agentId) &&
    launchEnvAllowed(env, vars.agentId) &&
    renderLaunchScript(vars) === content
  );
}

/**
 * MCP_CONFIG: whether `content` is exactly `renderMcpConfig` of an absolute, clean volley-mcp
 * entry point outside any `.volley/` (claude runs that server for the agent).
 */
function isMcpConfig(content: string): boolean {
  let entry: unknown;
  try {
    entry = JSON.parse(content)?.mcpServers?.volley?.args?.[1];
  } catch {
    return false;
  }
  return (
    typeof entry === "string" &&
    entry.endsWith(MCP_ENTRY_SUFFIX) &&
    outsideVolley(entry) &&
    renderMcpConfig(entry) === content
  );
}

/** A write to a `.volley/launch.sh`: the file a tmux session's TMUX_LAUNCH_COMMAND runs. */
const isLaunchScriptPath = (path: string) => path.endsWith("/.volley/launch.sh");
/** A write to a `.volley/mcp.json`: the MCP servers claude starts for the agent. */
const isMcpConfigPath = (path: string) => path.endsWith("/.volley/mcp.json");

function remoteStep(step: RemoteStep, opts: FenceOptions): Verdict {
  if (step.cwd !== undefined && !REMOTE_PATH.test(step.cwd))
    return deny("remote cwd (not absolute)");
  const [prog, ...args] = step.argv;
  const io = step.stdin !== undefined || step.stdout !== undefined || step.append === true;
  if (io) {
    const b64 = step.stdin !== undefined && BASE64.test(step.stdin);
    if (sameArgv(step.argv, TRUST_COMPARE) && step.stdout === undefined && step.append !== true)
      return b64 ? ALLOW : deny("remote cmp (base64 text on stdin only)");
    const signin = step.stdout !== undefined ? remoteSigninFile(step.stdout) : null;
    if (signin !== null) {
      return sameArgv(step.argv, ["base64", "-d"]) &&
        b64 &&
        step.append !== true &&
        Buffer.from(step.stdin ?? "", "base64").toString("utf-8") === signin.content
        ? ALLOW
        : deny(`remote ${signin.name} write (only what volleyd renders for that sign-in dir)`);
    }
    const write =
      prog === "base64" &&
      args.length === 1 &&
      args[0] === "-d" &&
      b64 &&
      step.stdout !== undefined &&
      writablePath(step.stdout) &&
      (step.append !== true || step.stdout !== REMOTE_CLAUDE_JSON_TMP);
    if (!write)
      return deny("remote file write (base64 -d of base64 text to a file volleyd writes only)");
    const path = step.stdout ?? "";
    const content = () => Buffer.from(step.stdin ?? "", "base64").toString("utf-8");
    if (isLaunchScriptPath(path)) {
      const worktree = path.slice(0, -"/.volley/launch.sh".length);
      if (step.append === true || !isLaunchScript(content(), worktree))
        return deny("remote launch.sh write (only a script renderLaunchScript renders)");
    }
    if (isMcpConfigPath(path) && (step.append === true || !isMcpConfig(content())))
      return deny("remote mcp.json write (only an mcp.json renderMcpConfig renders)");
    return ALLOW;
  }
  if (sameArgv(step.argv, TRUST_SWAP)) return ALLOW;
  return remoteDeny(remoteCommand(prog, args, opts));
}

function remoteCommand(prog: string | undefined, args: string[], opts: FenceOptions): Verdict {
  if (prog === undefined || prog === "") return deny("(empty command)");
  if (prog.includes("/")) return deny(`${prog} (programs are named, not pathed)`);
  const paths = (list: string[]) => list.length > 0 && list.every((a) => !a.startsWith("-"));
  switch (prog) {
    case "git":
      return git(args);
    case "gh":
      // The named read-only verbs of this machine's policy (issue/repo/pr view, pr list, pr checks,
      // run list): verifying an agent's PR on a paired machine reads them there. No `gh api` at all
      // on a remote box; merges, workflow runs and deletes stay denied.
      return args[0] === "api" ? deny("gh api (not on a remote machine)") : gh(args);
    case "tmux":
      return tmux(args, opts);
    case "mkdir":
      return args[0] === "-p" && paths(args.slice(1)) ? ALLOW : deny("mkdir (only -p <path>…)");
    case "cat":
      return paths(args) &&
        args.every((a) => readablePath(a) || remoteSigninFile(a)?.name === SIGNIN_URL_FILE)
        ? ALLOW
        : deny("cat (only the files volleyd reads)");
    case "chmod":
      // Three digits: no setuid, setgid or sticky bit; only on the files volleyd writes.
      return /^[0-7]{3}$/.test(args[0] ?? "") &&
        paths(args.slice(1)) &&
        args.slice(1).every((a) => writablePath(a) || isSigninScriptFile(a))
        ? ALLOW
        : deny("chmod (only <3 octal digits> <a file volleyd writes>…)");
    case "printenv":
      // The PATH an ssh session gets on the box, for its tmux server (SshTmuxHost.launch), and
      // its HOME, where a sign-in's dir is (remote-signin.ts).
      return sameArgv(args, ["PATH"]) || sameArgv(args, ["HOME"])
        ? ALLOW
        : deny("printenv (only PATH or HOME)");
    case "claude":
      // The box's login state and plan (remote-signin.ts); a login runs only from signin.sh.
      return sameArgv(args, ["auth", "status"]) ? ALLOW : deny("claude (only auth status)");
    case "nc":
      return args.length === 3 &&
        args[0] === "-z" &&
        args[1] === "127.0.0.1" &&
        /^[0-9]{1,5}$/.test(args[2] ?? "")
        ? ALLOW
        : deny("nc (only -z 127.0.0.1 <port>)");
    case "base64":
      return deny("base64 (only as a file write)");
    // --- Fleet (F2): the PATH probe and the doctor on a paired machine ---
    case "command":
      return args[0] === "-v" &&
        args.length > 1 &&
        args.slice(1).every((n) => (PATH_PROBE_TOOLS as readonly string[]).includes(n))
        ? ALLOW
        : deny(`command (only -v ${PATH_PROBE_TOOLS.join(" ")})`);
    case "volley":
      // The one remote volley step: elsewhere volley is a local program (`volley auth`).
      return REMOTE_DOCTOR.some((shape) => sameArgv(args, shape)) ||
        (args.length === REMOTE_DOCTOR_CLONE.length + 1 &&
          sameArgv(args.slice(0, -1), REMOTE_DOCTOR_CLONE) &&
          isCloneUrl(args.at(-1) ?? ""))
        ? ALLOW
        : deny(
            `volley ${args.slice(0, 2).join(" ")} (only peer doctor --json [--fix --yes [--clone --origin <https URL>]])`,
          );
    default: {
      // Locally allowed programs (cmux, volley, launchctl) have no business on a remote host.
      const v = evaluate([prog, ...args], opts);
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

function tmux(args: string[], opts: FenceOptions): Verdict {
  const [sub, ...rest] = args;
  if (sub === undefined || sub.startsWith("-")) return deny(`tmux ${sub ?? ""}`.trim());
  if (sub === "kill-session") {
    // A sign-in session holds no agent's work (as locally): no consent.
    if (rest.length === 2 && rest[0] === "-t" && SIGNIN_SESSION.test(rest[1] ?? "")) return ALLOW;
    const v = checkArgs("tmux kill-session", rest, { valued: ["-t"] });
    return v.kind === "allow" ? { kind: "consent", verb: "tmux kill-session" } : v;
  }
  if (sub === "show-environment") {
    // Read-only: the server's global PATH, which set-environment then only adds to.
    return sameArgv(rest, ["-g", "PATH"]) ? ALLOW : deny("tmux show-environment (only -g PATH)");
  }
  if (sub === "set-environment") {
    // Only the global PATH, to an absolute directory list (the box's own, from `printenv PATH`).
    const [g, name, value, ...more] = rest;
    return g === "-g" &&
      name === "PATH" &&
      more.length === 0 &&
      value !== undefined &&
      value.split(":").every((d) => REMOTE_PATH.test(d))
      ? ALLOW
      : deny("tmux set-environment (only -g PATH <absolute dirs>)");
  }
  if (sub === "send-keys") {
    // `send-keys -t <target> <key>` (a named key) or `send-keys -t <target> -l -- <text>`:
    // whatever follows the options is typed into the agent's shell, so only NAMED_KEYS and
    // TYPED_TEXT. (Without -l, tmux types any argument that is not a key name as text.)
    const [t, target, ...tail] = rest;
    if (t !== "-t" || target === undefined || target.startsWith("-")) return deny("tmux send-keys");
    if (tail.length === 1 && NAMED_KEYS.has(tail[0] ?? "")) return ALLOW;
    if (tail.length !== 3 || tail[0] !== "-l" || tail[1] !== "--") return deny("tmux send-keys");
    const why = typedTextRefusal(tail[2] ?? "", opts);
    return why === null ? ALLOW : deny(`tmux send-keys (${why})`);
  }
  if (sub === "new-session" && rest.at(-1) === SIGNIN_COMMAND)
    return remoteSigninSession(rest, opts);
  const spec = Object.hasOwn(TMUX_SPECS, sub) ? TMUX_SPECS[sub] : undefined;
  if (spec === undefined) return deny(`tmux ${sub}`);
  const v = checkArgs(`tmux ${sub}`, rest, spec);
  return v.kind === "allow" && sub === "new-session" ? newSessionSealed(rest, opts) : v;
}

/**
 * Local tmux: Claude account sign-in sessions only (`volley-signin-<acct>`). Agents run in cmux
 * locally; a remote host's tmux is the REMOTE policy (`tmux` above).
 */
function localTmux(args: string[], opts: FenceOptions): Verdict {
  const [sub, ...rest] = args;
  const target = (flag: string, a: readonly string[]) => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const session = (flag: string) => SIGNIN_SESSION.test(target(flag, rest) ?? "");
  const verb = `tmux ${sub ?? ""}`.trim();
  switch (sub) {
    case "new-session": {
      const cwd = target("-c", rest);
      return sameArgv(rest, [
        "-d",
        "-s",
        target("-s", rest) ?? "",
        "-c",
        cwd ?? "",
        SIGNIN_COMMAND,
      ]) &&
        session("-s") &&
        opts.signin !== undefined &&
        signins.has(opts.signin) &&
        !opts.signin.remote &&
        opts.signin.cwd === cwd
        ? ALLOW
        : deny("tmux new-session (only a sealed sign-in script, in a volley-signin-* session)");
    }
    case "capture-pane":
      return sameArgv(rest, ["-p", "-J", "-t", target("-t", rest) ?? ""]) && session("-t")
        ? ALLOW
        : deny(verb);
    case "has-session":
    case "kill-session":
      return sameArgv(rest, ["-t", target("-t", rest) ?? ""]) && session("-t") ? ALLOW : deny(verb);
    default:
      return deny(verb);
  }
}

/** `signin.sh` or `browser.sh` of a paired machine's sign-in dir (chmod: the helper runs). */
const isSigninScriptFile = (p: string) => {
  const f = remoteSigninFile(p);
  return f !== null && f.name !== SIGNIN_URL_FILE;
};

/**
 * A paired machine's sign-in session: exactly `new-session -d -s volley-signin-<acct> -c <dir>
 * 'bash signin.sh'`, with the remote seal for <dir> (`sealRemoteSigninScript`).
 */
function remoteSigninSession(args: readonly string[], opts: FenceOptions): Verdict {
  const [d, s, session, c, cwd] = args;
  return args.length === 6 &&
    d === "-d" &&
    s === "-s" &&
    SIGNIN_SESSION.test(session ?? "") &&
    c === "-c" &&
    opts.signin !== undefined &&
    signins.has(opts.signin) &&
    opts.signin.remote &&
    opts.signin.cwd === cwd
    ? ALLOW
    : deny("tmux new-session (only a sealed sign-in script, in a volley-signin-* session)");
}

/**
 * `tmux new-session … -c <dir> 'bash .volley/launch.sh'`: the command is required, and <dir> is
 * the worktree of a sealed launch script (tmux keeps the last `-c`, so does this).
 */
function newSessionSealed(args: readonly string[], opts: FenceOptions): Verdict {
  let cwd: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-c") cwd = args[++i];
    else if (a.startsWith("-c")) cwd = a.slice(2);
  }
  return args.at(-1) === TMUX_LAUNCH_COMMAND && cwd !== undefined && sealedFor(opts, cwd)
    ? ALLOW
    : deny("tmux new-session (only in the worktree of a sealed launch script)");
}

/**
 * The bash script for `ssh -T <target> bash -s`: `set -euo pipefail`, then one line per step,
 * every word single-quoted (so no path or value is ever shell syntax). A step with a `cwd` runs
 * in a subshell that `cd`s first; a file write runs `base64 -d` under `umask 077` from a quoted
 * heredoc (base64 text cannot contain its delimiter). The trust compare is fed the same way,
 * through `base64 -d |`. Every other step reads /dev/null: under `bash -s` a step that read its
 * stdin would consume the rest of the script.
 */
export function renderRemoteScript(script: RemoteScript): string {
  const lines = ["set -euo pipefail"];
  const heredoc = (s: RemoteStep) => `<<'VOLLEY_EOF'\n${s.stdin ?? ""}\nVOLLEY_EOF`;
  for (const s of script.steps) {
    const cmd = s.argv.map(shq).join(" ");
    if (s.stdout !== undefined) {
      const redirect = s.append === true ? ">>" : ">";
      lines.push(`( umask 077 && ${cmd} ${redirect} ${shq(s.stdout)} ${heredoc(s)}\n)`);
    } else if (s.stdin !== undefined) {
      lines.push(`'base64' '-d' ${heredoc(s).replace("\n", ` | ${cmd}\n`)}`);
    } else if (s.cwd !== undefined) {
      lines.push(`( cd ${shq(s.cwd)} && ${cmd} </dev/null )`);
    } else {
      lines.push(`${cmd} </dev/null`);
    }
  }
  return `${lines.join("\n")}\n`;
}
