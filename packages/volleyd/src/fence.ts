import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, posix, resolve } from "node:path";
import { DYNSEC_ADMIN_USER } from "volley-cli/auth/roles";
import { PMSET_BATT_ARGV } from "volley-cli/machine/laptop";
import { isTailscaleCommand } from "volley-cli/setup/network";
import { isTailscaleServeCommand } from "volley-cli/setup/tailscale-serve";
import { COMPACT_MAX, COMPACT_MIN } from "./claude/context-window";
import { canonicalRoot, claudeRoot, profileDir, readRegistry } from "./claude/profiles";
import { parseSigninEntry } from "./claude/signin-entry";
import {
  BROWSER_HELPER,
  SIGNIN_COMMAND,
  SIGNIN_SCRIPT,
  SIGNIN_URL_FILE,
  renderBrowserHelper,
  renderSigninScript,
} from "./claude/signin-script";
import { DAEMON_DEFAULTS } from "./config-defaults";
import { volleydHome } from "./config-store";
import {
  COORDINATOR_COMMAND,
  COORDINATOR_FILES,
  COORDINATOR_SETTINGS,
  type CoordinatorScriptVars,
  PERMISSION_MODES,
  type PermissionMode,
  coordinatorSession,
  renderCoordinatorMcp,
  renderCoordinatorScript,
} from "./coordinator/role";
import {
  LAUNCH_COMMAND,
  isMcpServerEntry,
  mcpConfigPath,
  renderLaunchScript,
  renderMcpConfig,
  shq,
} from "./launch";
import { WAKE_TEXT } from "./liveness";
import { isSlug } from "./repos";
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
 *   gh pr merge (except MERGE below) | gh workflow run | gh repo delete | gh api with any method
 *     other than GET
 *   infrastructure CLIs: terraform, terragrunt, kubectl, helm, aws, gcloud, gsutil, az, pulumi,
 *     ansible, ansible-playbook, eksctl, doctl, flyctl
 *   docker rm | rmi | container rm | image rm | volume rm | network rm | system prune
 *   rm -rf (any spelling that combines -r/-R/--recursive with -f/--force), except the one REMOTE
 *     step a ProfileRemoveToken unlocks (below)
 *
 * MERGE (only with a token, checked by identity like consent tokens; either unlocks nothing else:
 *   git merge, push and rebase stay denied). Never --admin, --auto or --rebase.
 *   - a MergeToken (`mintMergeToken`, minted by the pipeline's gate after the evidence package is
 *     written): exactly
 *       gh pr merge <n> --squash --match-head-commit <sha40> [--delete-branch]
 *     with <n> the token's PR and <sha40> its gated head (GitHub refuses the merge if the head
 *     moved since the gate). Never --merge.
 *   - a TrainToken (`mintTrainToken`, minted for a merge train after the train's evidence is
 *     written): exactly
 *       gh pr merge <n> --merge --match-head-commit <sha40>
 *     with <n> the train's PR and <sha40> its gated head: a merge commit, so the member PRs, whose
 *     heads it contains, read as merged. Never --squash.
 *   - a ReleaseToken (`mintReleaseToken`, minted only by the `release_go` go, from the release PR
 *     a prepare stage verified, at its CI-green head; SPEC §4.6.19): exactly
 *       gh pr merge <n> --squash --match-head-commit <sha40> --delete-branch
 *     with <n> the release PR and <sha40> that head: the release branch is squash-merged into the
 *     default branch and deleted. Never --merge, never without --delete-branch.
 *   Any may end in exactly `--repo <owner/name>` (or `<host>/<owner>/<name>`): a wave the
 *   supervisor holds no clone of (#448).
 *
 * CONSENT (denied unless a ConsentToken is passed — minted by `volleyd cleanup --yes`, or by a
 * retire for the retired agent's own workspace only):
 *   git worktree remove · cmux close-workspace
 *
 * ALLOW (program by bare name only — never a path):
 *   git [-C <dir>] [--no-pager] worktree add | fetch | rev-parse | log | diff | status |
 *     branch --list | branch --track <b> <remote>/<b> | merge-base | show | ls-tree |
 *     remote get-url origin (exactly: repo_probe's reading; every other `git remote` is denied)
 *     worktree add needs -b <new branch> or --detach (never checks out an existing branch), or
 *     -B only to re-create an agent branch (`<wave>/<task>-<role>-<n>`, worktree.ts
 *     AGENT_BRANCH — never a release or any other branch); the new branch is never main/master
 *     (in any case); fetch takes a remote name or a
 *     network URL (https, ssh, git, user@host:path — never a local path) and its refspecs only
 *     write refs/remotes/…
 *   gh pr ready <n> [--repo <slug>] (a draft PR marked ready before the CI gate; never --undo)
 *   gh issue view · gh repo view · gh pr view | list | checks · gh run list | view | watch ·
 *     gh api (GET only; a relative endpoint — never a URL — and never graphql in any path
 *     segment; no request headers)
 *   the issue lifecycle (autopilot/issues.ts), exactly, <n> a positive issue number:
 *     gh issue edit <n> --add-label merged-to-release | --remove-label merged-to-release ·
 *     gh issue comment <n> --body <text> · gh issue close <n> --comment <text> (<text> carrying
 *     a `<!-- volleyd:… wave=… -->` marker: only volleyd's own comments) ·
 *     gh label list --search merged-to-release --json name ·
 *     gh label create merged-to-release --description <text> --color <6 hex> (never --force);
 *     each of these may end in exactly `--repo <owner/name>`;
 *     never on a paired machine
 *   cmux — exact argv shapes only, because cmux types into an agent's shell:
 *     new-workspace --cwd <dir> --name <name> --command LAUNCH_COMMAND (each once, any order),
 *       with the LaunchToken of the `.volley/launch.sh` volleyd sealed in exactly <dir>
 *     send --workspace <ref> <text>   text: TYPED_TEXT only
 *     send-key --workspace <ref> Enter|Escape | Up|Down|Space (PICKER below) ·
 *       read-screen --workspace <ref> [--lines <n>]
 *     list-workspaces · ping
 *   claude — volleyd starts claude only from `.volley/launch.sh` (renderLaunchScript), which the
 *     launch commands above run; its options are pinned (LAUNCH_SCRIPT_VARS), including
 *     `[--strict-mcp-config] --mcp-config=<worktree>/.volley/mcp.json -- <prompt>` (the flag is
 *     left out only under `agent_mcp: inherit`) — or from a
 *     sealed sign-in script (below). The direct calls: `claude auth status` (exactly; it prints
 *     a profile's login state and plan, never a credential) and `claude --version` (exactly: the
 *     version a seeded profile records as its `lastOnboardingVersion`)
 *   tmux (local agents, hosts/local-tmux.ts, under `fleet.local_terminal: tmux`) — sessions
 *     named `volley-<wave>-<task>-<role>[-<n>]` only (AGENT_SESSION; never `volley-signin-*`),
 *     targeted exactly (`=<it>`, its pane `=<it>:`):
 *     new-session -d [-x <n> -y <n>] -s <it> -c <dir> 'bash .volley/launch.sh' (that order, with
 *       the LaunchToken sealed for <dir>; n in 20..500) · capture-pane -p [-J] -t =<it>: -S-<n> ·
 *       has-session -t =<it> · resize-window -t =<it>: -x <n> -y <n> ·
 *       send-keys -t =<it>: Enter|Escape (Up|Down|Space: PICKER) ·
 *       send-keys -t =<it>: -l -- <TYPED_TEXT> · kill-session -t =<it> = CONSENT
 *   tmux (local: Claude account sign-in, src/claude/signin.ts) — sessions named
 *     `volley-signin-<acct>` only: new-session -d -s <it> -c <dir> 'bash signin.sh' with the
 *     SigninToken sealed for <dir> (`sealSigninScript`: exactly `renderSigninScript`, which runs
 *     `claude auth login` — never `setup-token`) · capture-pane -p -J -t <it> · has-session -t
 *     <it> · kill-session -t <it> (no consent: a sign-in session holds no agent's work) ·
 *     send-keys -t <it> Enter · send-keys -t <it> -l -- <code> (only with the SigninEntryToken
 *     naming exactly that session and code, typed once: `mintSigninEntryToken`)
 *   curl -fsS --max-time 10 http://127.0.0.1:<p>/callback?<query>   (exactly, only with the
 *     SigninEntryToken naming exactly that URL, once: a sign-in's redirect the owner pasted,
 *     completed on the machine whose listener waits; also a REMOTE step)
 *   (agent logins are minted and deleted over volleyd's own Dynamic Security control
 *   connection, dynsec.ts: no `volley auth` command and no broker signal is involved)
 *   ps -axo pid=,command=   (exactly: lists processes for procs.ts, which stops a retired
 *     agent's claude by `process.kill`, never by a spawned `kill`)
 *   mosquitto -h   (exactly: it prints the binary's version, the fallback when the broker
 *     retains no $SYS/broker/version)
 *   pmset -g batt   (exactly, on macOS: whether this machine has a battery, its record's
 *     `laptop`, SPEC §4.6.25)
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
 *   volley peer doctor --json --probe-login PROFILE   (a prime: one login's usage reading;
 *     PROFILE `default` or a profile id)
 *   launchctl bootstrap gui/<uid> $HOME/Library/LaunchAgents/systems.volley.volleyd.plist (that
 *     full path only) | bootout | kickstart [-k] [-p] | print — only for the
 *     systems.volley.volleyd service
 *   pressure samplers, exact argv only: sysctl -n kern.memorystatus_vm_pressure_level ·
 *     memory_pressure (no arguments: report only) · docker info --format {{json .}}
 *
 * MACHINE ROLES (SPEC §4.6.24; roles/), each one exact shape, here:
 *   launchctl bootout gui/<uid>/systems.volley.desk · launchctl bootstrap gui/<uid>
 *     $HOME/Library/LaunchAgents/systems.volley.desk.plist · systemctl --user stop | start
 *     volley-desk.service | volleyd.service (a Desk move unloads the old Desk; the old supervisor
 *     unloads itself after a hand-over)
 *   tar -czf <abs>.tgz -C <abs> --files-from <abs>   (a supervisor move's bundle; never -x)
 *   volley desk install --port <n> --broker-host <host> · volley desk uninstall ·
 *     volley desk check --url http://127.0.0.1:<n> --version <v>   (a Desk move to this machine)
 *   and as REMOTE steps on a paired machine (below; each as `bun <volley_dir>/packages/volley-cli/
 *   src/cli.ts <args>`, the box's own checkout, never `volley`): the same three `desk` verbs;
 *   volley peer retarget --to <dest> [--port <n>] [--tunnel ssh|none] (peer_retarget);
 *   volley peer join <code> --to <dest> --name <name> --target <dest> --tunnel none (the old
 *   supervisor re-paired); volley role receive supervisor <abs>/.volley/roles/<move_id>/bundle.tgz
 *   --from <name> [--local-terminal cmux|tmux] [--local-agents never] [--broker-url
 *   mqtt://127.0.0.1:<n>]; ssh -n -o BatchMode=yes -o ConnectTimeout=<s> <dest> true (the
 *   ssh-back probe); base64 -d to that bundle path (the copy).
 *   A broker move's, here: brew services stop|start mosquitto · sudo -n snap|systemctl
 *   stop|start mosquitto (the old broker, through its layout) · volley broker tunnel --to <dest>
 *   --port <n> --name <name> --broker-port <n> | --off (the own tunnel) · systemctl --user
 *   daemon-reload (volleyd's unit rewritten) · the ssh probe above, to the new address; and as
 *   REMOTE steps: volley broker probe · volley broker receive <abs>/.volley/roles/broker/bundle.tgz
 *   --lan|--no-lan|--check · volley broker tunnel --show.
 *
 * COORDINATOR (SPEC §4.6.25, coordinator/; with a CoordinatorToken, checked by identity, and only
 *   on the session `volley-coordinator-<name>`, which is never an agent's): volleyd starts
 *   `claude remote-control` only from `<dir>/.volley/coordinator.sh`, exactly
 *   `renderCoordinatorScript` (`sealCoordinatorScript`: `--continue` alone, then `--name <name>
 *   --remote-control-session-name-prefix <name> --spawn same-dir --capacity <n> --permission-mode
 *   <mode>`, nothing else; never as a direct argv), and, locally and as REMOTE steps:
 *     tmux new-session -d -s volley-coordinator-<name> -c <dir> 'bash .volley/coordinator.sh'
 *       (the script token for <dir> and <name>; on a paired machine its broker port the host's) ·
 *     has-session -t =<it> · capture-pane -p [-J] -t =<it>: -S-<n> ·
 *     kill-session -t =<it> (the kill token `mintCoordinatorKill(name)`: no consent, the session
 *       holds no agent's work) — nothing is ever typed into it
 *   and as REMOTE steps with the script token, its directory's files: base64 -d (whole, never
 *   appended) to `<dir>/.volley/coordinator.sh` (the sealed text), `<dir>/.volley/auth/
 *   coordinator.json` (a JSON object of string username and password: the coordinator login),
 *   `<dir>/.mcp.json` (exactly `renderCoordinatorMcp` of an absolute volley-mcp entry) and
 *   `<dir>/.claude/settings.json` (exactly COORDINATOR_SETTINGS); chmod on those;
 *   ln -sfn <abs> <dir>/repos/<owner>/<name> (a repository's link)
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
 *     tailscale (on PATH, or /Applications/Tailscale.app/Contents/MacOS/Tailscale) version |
 *       status --json | ip -4 | up · brew install --cask tailscale (the Network step; never
 *       `tailscale funnel`, an `up` flag, or `sudo tailscale up`) · tailscale serve
 *       status --json | --bg --https=443 http://127.0.0.1:<desk port> | --bg --https=8443
 *       http://127.0.0.1:9001 (the Desk on the tailnet, macOS; Linux's needs sudo, a
 *       terminal's; never `serve reset` or a target off loopback)
 *   Never volleyd's own service (installing or restarting it would stop the volleyd answering),
 *   sudo, or the keychain (the logged-in session's): those stay terminal-only.
 *
 * MACHINE ADD (only with a MachineAddToken, `mintMachineAddToken`, and with one nothing else): the
 *   steps `machine_add` (machine-add.ts, SPEC §4.6.14) runs to make a bare box a paired machine,
 *   volley-cli's `volley machine add` step list without a terminal (no `ssh -t`):
 *     ssh -T -o BatchMode=yes -o ConnectTimeout=<s> -o ServerAliveInterval=<s>
 *       -o ServerAliveCountMax=<n> -o StrictHostKeyChecking=accept-new <target> bash -s
 *     ssh -T -i <key> -o IdentitiesOnly=yes …the same… <target> bash -s   (the person's key)
 *     ssh -T -o ConnectTimeout=<s> -o StrictHostKeyChecking=accept-new -o NumberOfPasswordPrompts=1
 *       -o PreferredAuthentications=password,keyboard-interactive <target> bash -s   (a password:
 *       env SSH_ASKPASS=<the token's helper>, SSH_ASKPASS_REQUIRE=force)
 *   each to the token's target only (and its key only), its stdin exactly a script the run's
 *   registry (volley-cli's `Scripts`) rendered; this machine's key creation (`ssh-keygen -t
 *   ed25519 -N '' -q -f <home>/.ssh/id_ed25519`); a Mac's Remote Login check (`launchctl print
 *   system/com.openssh.sshd`). A host key is trusted on first contact (nobody is at a terminal
 *   to answer ssh's question).
 *
 * ASKPASS (the env rule): a command whose env sets SSH_ASKPASS, SSH_ASKPASS_REQUIRE or
 *   SUDO_ASKPASS is refused, except MACHINE ADD's password form with exactly the token's helper
 *   and `SSH_ASKPASS_REQUIRE=force` (no SUDO_ASKPASS: sudo runs on the box, from its own helper).
 *
 * TYPED_TEXT (cmux send, tmux send-keys -l: what is typed into an agent's terminal), each only
 *   with its token, checked by identity like consent tokens:
 *     LAUNCH_COMMAND   with a LaunchToken (`sealLaunchScript`: volleyd rendered that launch.sh)
 *     `/model <id>`    with the ModelSwitchToken naming exactly <id> (`mintModelSwitchToken`,
 *                      minted when an approved model_switch decision is acted on); <id> is a
 *                      MODEL_ID, the wave-file schema's `model` pattern
 *     an inbox answer  with the PickerToken (a picker's Other text) or HandoffToken (a
 *                      coordinator handoff's reply) carrying exactly that text, typed once per
 *                      token; minted only for one line with no control character that does not
 *                      start with `/` or `!` (never a slash command or bash-mode line)
 *     WAKE_TEXT        with a WakeToken (`mintWakeToken`, minted when an idle agent did not ack
 *                      a mailbox message in time), typed once per token; nothing else with it
 *
 * PICKER (needs-you inbox pickers, SPEC §4.6.18): `cmux send-key … Up|Down|Space` and
 *   `tmux send-keys -t <t> Up|Down|Space` only with a PickerToken (`mintPickerToken`, minted for
 *   one item version after the screen showed its picker) naming that key; `Enter` and `Escape`
 *   need no token. No other key name is ever sent.
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
 *   tmux new-session -d [-x <n> -y <n>] -s <name> -c <dir> 'bash .volley/launch.sh' (that
 *     command only, with the LaunchToken sealed for <dir>; n in 20..500) |
 *     new-session -d -s volley-signin-<acct> -c <dir>
 *     'bash signin.sh' (exactly, with the remote SigninToken sealed for <dir>,
 *     `sealRemoteSigninScript`) | capture-pane | has-session |
 *     send-keys -t <t> Enter|Escape (Up|Down|Space: PICKER) | send-keys -t <t> -l -- <TYPED_TEXT> |
 *     send-keys -t volley-signin-<acct> -l -- <code> (its SigninEntryToken, once) |
 *     resize-window -t =<session>: -x <n> -y <n> (exactly; n in 20..500: the Desk's Terminal
 *     popout) | show-environment -g PATH | set-environment -g PATH <absolute dirs> (the box's own
 *     PATH, from printenv, then the server's own dirs) —
 *     kill-session -t volley-signin-<acct> (no consent: a sign-in session holds no agent's
 *     work) — any other kill-session = CONSENT; no other tmux global option
 *   mkdir -p <path>… · chmod <3 octal digits> <a file base64 -d may write>… ·
 *     chmod 700 <home>/.volley/claude/<acct> (a remote profile dir: the only chmod on a
 *     directory) · nc -z 127.0.0.1 <port> · printenv PATH | HOME ·
 *     curl -fsS --max-time 10 http://127.0.0.1:<p>/callback?<query> (its SigninEntryToken, once)
 *   rm -rf <home>/.volley/claude/<acct> (exactly, only with the ProfileRemoveToken
 *     `mintProfileRemoveToken` minted for exactly that dir: a person's `claude_account_remove`)
 *   claude auth status (exactly: the box's login state and plan, never a credential; a login
 *     runs only from a sealed signin.sh) — the one step with an env: `env.CLAUDE_CONFIG_DIR`
 *     only, only `<abs>/.volley/claude/<acct>` (a profile the supervisor created there),
 *     rendered as one single-quoted `CLAUDE_CONFIG_DIR=…` before the argv
 *   cat <path>… — only the files volleyd reads: `.claude.json`, a remote profile's
 *     `<home>/.volley/claude/<acct>/settings.json`, a path ending in
 *     `/info/exclude`, `<dir>/.volley/<name>` for a VOLLEY_READS name, a worktree's
 *     `<abs dir>/.mcp.json` (no `..` segment), or a sign-in dir's `url`
 *   base64 -d — the only step that redirects to a file, from base64 text on stdin, under umask
 *     077, and only to the files volleyd writes: `<dir>/.volley/<name>` for a VOLLEY_WRITES name
 *     (agent.json, brief.md, launch.sh, mcp.json, review.md, findings.md, findings.json,
 *     rebase.md, integrate.md, decisions.md, retired.json — spelled exactly, directly inside
 *     `.volley/`, so no write there is a git config, HEAD, gitfile or hook, or a case variant of
 *     launch.sh), an
 *     absolute path ending in `/ISSUE.md` or `/info/exclude`, or `~/.claude.json.volleyd.tmp`.
 *     A `.volley/launch.sh` (what the tmux session runs) is written whole, never appended, and
 *     its content must be exactly `renderLaunchScript` of valid values for that worktree
 *     (LAUNCH_SCRIPT_VARS: a `CLAUDE_CODE_AUTO_COMPACT_WINDOW` export only on the line after the
 *     profile block, an integer in 100000..1000000, never in the env block; its `CLAUDE_CONFIG_DIR`,
 *     if any, exactly the `<home>/.volley/claude/<id>` the registry recorded at sign-in for a
 *     signed-in profile `<id>` of that host — the script's `host`, SshTmuxHost's spec — with the
 *     worktree under that host's `worktree_root`); a `.volley/mcp.json` (the MCP server claude
 *     starts) likewise exactly `renderMcpConfig` of an absolute `…/packages/volley-mcp/src/index.ts`
 *     outside any `.volley/`, with the `agent_mcp_allow` entries copied from the box's own config
 *     after it (MCP_CONFIG: shape only, whatever their `command` and whatever `agent_mcp` — trusted
 *     as the owner's config); and
 *     a paired machine's sign-in dir `<abs>/.volley/signin/<acct>/` (src/claude/remote-signin.ts):
 *     `signin.sh` exactly `renderSigninScript` for that dir with no profile dir, or with the
 *     profile dir `<same abs>/.volley/claude/<same acct>` (`claude auth login`, never
 *     `setup-token`), `browser.sh` exactly `renderBrowserHelper`, `url` only empty
 *   command -v <claude|bun>… — the readiness PATH probe (RemoteHost.probePath)
 *   every volley argv on a box runs its own checkout, `bun <volley_dir>/packages/volley-cli/src/
 *     cli.ts <args>` (remoteVolleyArgv; the host's `volley_dir` exactly), never a `volley` on its
 *     PATH; VOLLEY below is that prefix:
 *   VOLLEY peer doctor --json --probe-login PROFILE — a prime's one-login usage reading
 *   VOLLEY peer doctor --json [--supervisor-volley-dir ABS] [--fix --yes [--clone --origin
 *     <https URL>]] — the machine's doctor
 *     (RemoteHost.runDoctor, the `peer_doctor` op; the URL is `https://<host>/<path>`, no
 *     credentials or port, isCloneUrl); or, for its repositories (#435), after [--fix --yes]
 *     any number of --repo-add <owner/name>[=ABS] (isSlug; ABS as --supervisor-volley-dir's) and
 *     --repo-remove <owner/name>, then --clone only under --fix with an add (each added
 *     repository cloned from https://github.com/<owner>/<name>.git, built on the box, never an
 *     argv here); the role-move steps above; no other volley argv runs on a box
 *   the trust write (RemoteHost.recordTrust, on the owner's `trust` answer or a `repo_add`, SPEC
 *     §4.6.21: adding a repository to a machine is the owner's consent to trust its clone there):
 *     cmp -s - .claude.json (base64 of the file as read, on stdin) ·
 *     mv -f .claude.json.volleyd.tmp .claude.json — or, for a profile the supervisor created
 *     there, the same three steps on `<home>/.volley/claude/<acct>/.claude.json` and its
 *     `.claude.json.volleyd.tmp` (absolute paths; the tmp the only other file base64 -d writes)
 *   the onboarding seed (RemoteHost.seedProfile, #400): in a profile the supervisor created
 *     there, the trust write's steps on its `.claude.json`, and the same on its `settings.json`
 *     with `settings.json.volleyd.tmp` (absolute paths); nothing else of the profile
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
 * Mint a consent token. Callers: `volleyd cleanup --yes`; a retire closing the retired agent's
 * own workspace (daemon.ts: its session is over, its login already deleted; the worktree and
 * branch stay for cleanup); and a launch reconcile closing a workspace volleyd itself just opened
 * and no agent registered in (spawn.ts reconcileLaunch).
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

const merges = new WeakSet<object>();

/**
 * Permission to merge one gated PR at exactly its gated head (autopilot merging, SPEC §4.6.17).
 * Only `mintMergeToken` creates one (checked by identity).
 */
export interface MergeToken {
  readonly wave: string;
  readonly task: string;
  readonly pr: number;
  readonly head: string;
  readonly release_branch: string;
}

const SHA40 = /^[0-9a-f]{40}$/;

/** Callers: the pipeline's gate (PipelineDriver.gate), after the evidence package is written. */
export function mintMergeToken(t: MergeToken): MergeToken {
  if (!Number.isSafeInteger(t.pr) || t.pr <= 0)
    throw new FenceError(`gh pr merge ${t.pr}`, "not a PR number");
  if (!SHA40.test(t.head))
    throw new FenceError(`gh pr merge --match-head-commit ${t.head}`, "not a full commit sha");
  const token = Object.freeze({
    wave: t.wave,
    task: t.task,
    pr: t.pr,
    head: t.head,
    release_branch: t.release_branch,
  });
  merges.add(token);
  return token;
}

const trains = new WeakSet<object>();

/**
 * Permission to merge one merge train's PR, with a merge commit, at exactly its gated head (the
 * merge train, SPEC §4.6.23): `members` are the gated PRs' tasks at the heads the train
 * integrated. Only `mintTrainToken` creates one (checked by identity).
 */
export interface TrainToken {
  readonly train: string;
  readonly pr: number;
  readonly head: string;
  readonly release_branch: string;
  readonly members: readonly { readonly task: string; readonly head: string }[];
}

const TRAIN_ID = /^train-[1-9][0-9]{0,8}$/;

/** Callers: the merge train's driver, after the train's evidence is written. */
export function mintTrainToken(t: TrainToken): TrainToken {
  if (!TRAIN_ID.test(t.train))
    throw new FenceError(`gh pr merge (train ${t.train})`, "not a train id");
  if (!Number.isSafeInteger(t.pr) || t.pr <= 0)
    throw new FenceError(`gh pr merge ${t.pr}`, "not a PR number");
  if (!SHA40.test(t.head))
    throw new FenceError(`gh pr merge --match-head-commit ${t.head}`, "not a full commit sha");
  if (t.release_branch === "")
    throw new FenceError("gh pr merge (train)", "a train without a release branch");
  if (new Set(t.members.map((m) => m.task)).size < 2)
    throw new FenceError("gh pr merge (train)", "a train of fewer than two distinct members");
  for (const m of t.members) {
    if (m.task === "")
      throw new FenceError("gh pr merge (train member)", "a member without a task");
    if (!SHA40.test(m.head))
      throw new FenceError(`gh pr merge (train member ${m.task})`, "not a full commit sha");
  }
  const token = Object.freeze({
    train: t.train,
    pr: t.pr,
    head: t.head,
    release_branch: t.release_branch,
    members: Object.freeze(t.members.map((m) => Object.freeze({ task: m.task, head: m.head }))),
  });
  trains.add(token);
  return token;
}

const releases = new WeakSet<object>();

/**
 * Permission to squash-merge one wave's release PR at exactly its CI-green head, deleting the
 * release branch (the owner's `release_go` go, SPEC §4.6.19). Only `mintReleaseToken` creates
 * one (checked by identity).
 */
export interface ReleaseToken {
  readonly wave: string;
  readonly pr: number;
  readonly head: string;
  readonly release_branch: string;
  readonly decision_id: string;
}

/** Callers: the daemon's `release_go` go only, from the journaled release PR at its green head. */
export function mintReleaseToken(t: ReleaseToken): ReleaseToken {
  if (!Number.isSafeInteger(t.pr) || t.pr <= 0)
    throw new FenceError(`gh pr merge ${t.pr}`, "not a PR number");
  if (!SHA40.test(t.head))
    throw new FenceError(`gh pr merge --match-head-commit ${t.head}`, "not a full commit sha");
  if (t.release_branch === "" || t.decision_id === "")
    throw new FenceError("gh pr merge (release)", "a release without its branch or go");
  const token = Object.freeze({
    wave: t.wave,
    pr: t.pr,
    head: t.head,
    release_branch: t.release_branch,
    decision_id: t.decision_id,
  });
  releases.add(token);
  return token;
}

/**
 * A `--repo` value naming the repository a supervisor holds no clone of (#448): `owner/name`, or
 * `host/owner/name` off github.com.
 */
const isRepoName = (v: string): boolean =>
  isSlug(v) || (/^[A-Za-z0-9.-]+\/[^/]+\/[^/]+$/.test(v) && isSlug(v.slice(v.indexOf("/") + 1)));

/**
 * `gh pr merge <n> --squash --match-head-commit <head> [--delete-branch]` for a MergeToken's n and
 * head, `gh pr merge <n> --merge --match-head-commit <head>` for a TrainToken's, or
 * `gh pr merge <n> --squash --match-head-commit <head> --delete-branch` for a ReleaseToken's,
 * exactly; each may end in exactly `--repo <owner/name>` (a wave the supervisor holds no clone
 * of, #448).
 */
function mergeVerdict(
  all: readonly string[],
  token: MergeToken | undefined,
  train: TrainToken | undefined,
  release: ReleaseToken | undefined,
): Verdict {
  const repo = all.length >= 2 && all.at(-2) === "--repo" && isRepoName(all.at(-1) ?? "");
  const args = repo ? all.slice(0, -2) : all;
  const squash = token !== undefined && merges.has(token);
  const commit = train !== undefined && trains.has(train);
  const rel = release !== undefined && releases.has(release);
  if (!squash && !commit && !rel) return deny("gh pr merge");
  const is = (exact: readonly string[], extra?: string) =>
    (args.length === exact.length ||
      (extra !== undefined && args.length === exact.length + 1 && args[exact.length] === extra)) &&
    exact.every((a, i) => args[i] === a);
  const ok =
    (squash &&
      is(
        ["pr", "merge", String(token.pr), "--squash", "--match-head-commit", token.head],
        "--delete-branch",
      )) ||
    (commit &&
      is(["pr", "merge", String(train.pr), "--merge", "--match-head-commit", train.head])) ||
    (rel &&
      is([
        "pr",
        "merge",
        String(release.pr),
        "--squash",
        "--match-head-commit",
        release.head,
        "--delete-branch",
      ]));
  return ok ? ALLOW : deny("gh pr merge (not the gated PR at its gated head)");
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

const pickers = new WeakSet<object>();
const handoffs = new WeakSet<object>();
/** Tokens whose `text` was typed already: an answer's text is typed once. */
const spentText = new WeakSet<object>();

/** The navigation keys a PickerToken may unlock (`Enter`, `Escape` need no token). */
export const PICKER_KEYS = ["Up", "Down", "Space"] as const;
export type PickerKey = (typeof PICKER_KEYS)[number];

/**
 * Text an inbox answer may type into a Claude Code session: one line, no control character, and
 * not a slash command (`/…`) or bash-mode line (`!…`) should it land in the prompt.
 */
export function answerTextRefusal(text: string): string | null {
  if (text.trim() === "") return "empty text";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text))
    return "a control character or a second line";
  if (/^\s*[/!]/.test(text)) return "a slash command or shell line";
  return null;
}

/**
 * Selecting an answer in a Claude Code picker for one inbox item (SPEC §4.6.18): `Up`, `Down`
 * and `Space` are pressed into an agent's terminal only with the token naming them, and its
 * Other text typed once. Only `mintPickerToken` creates one (checked by identity).
 */
export interface PickerToken {
  readonly item_id: string;
  readonly version: number;
  readonly keys: readonly PickerKey[];
  readonly text?: string;
}

/** Callers: the daemon, carrying out an accepted picker answer after verifying the screen. */
export function mintPickerToken(t: {
  item_id: string;
  version: number;
  keys: readonly string[];
  text?: string;
}): PickerToken {
  const bad = t.keys.find(
    (k) => !(PICKER_KEYS as readonly string[]).includes(k) && !NAMED_KEYS.has(k),
  );
  if (bad !== undefined)
    throw new FenceError(`picker key ${JSON.stringify(bad)}`, "not a picker key");
  const why = t.text !== undefined ? answerTextRefusal(t.text) : null;
  if (why !== null) throw new FenceError(`picker text ${JSON.stringify(t.text)}`, why);
  const token = Object.freeze({
    item_id: t.item_id,
    version: t.version,
    keys: Object.freeze(
      [...new Set(t.keys)].filter((k): k is PickerKey =>
        (PICKER_KEYS as readonly string[]).includes(k),
      ),
    ),
    ...(t.text !== undefined ? { text: t.text } : {}),
  });
  pickers.add(token);
  return token;
}

/**
 * A coordinator handoff's reply (SPEC §4.6.18): typed into the session's idle prompt once, then
 * submitted with `Enter`. Only `mintHandoffToken` creates one (checked by identity).
 */
export interface HandoffToken {
  readonly item_id: string;
  readonly version: number;
  readonly text: string;
}

/** Callers: the daemon, carrying out an accepted handoff answer at an idle prompt. */
export function mintHandoffToken(t: {
  item_id: string;
  version: number;
  text: string;
}): HandoffToken {
  const why = answerTextRefusal(t.text);
  if (why !== null) throw new FenceError(`handoff text ${JSON.stringify(t.text)}`, why);
  const token = Object.freeze({ item_id: t.item_id, version: t.version, text: t.text });
  handoffs.add(token);
  return token;
}

const wakes = new WeakSet<object>();

/**
 * Waking an idle agent to read its mailbox: WAKE_TEXT, the one constant, is typed once with it.
 * Only `mintWakeToken` creates one (checked by identity).
 */
export interface WakeToken {
  readonly text: typeof WAKE_TEXT;
}

/** Callers: the daemon, when an idle agent has not acked a mailbox message (wakeIfUnacked). */
export function mintWakeToken(): WakeToken {
  const token = Object.freeze({ text: WAKE_TEXT });
  wakes.add(token);
  return token;
}

/** The answer token whose exact text `text` is and that has not typed it yet, or null. */
function answerTextToken(text: string, opts: FenceOptions): object | null {
  for (const [t, set] of [
    [opts.picker, pickers],
    [opts.handoff, handoffs],
  ] as const) {
    if (t !== undefined && set.has(t) && t.text === text) return t;
  }
  return null;
}

/** A named key volleyd may press: Enter or Escape, or one the picker token names. */
function keyAllowed(key: string, opts: FenceOptions): boolean {
  if (NAMED_KEYS.has(key)) return true;
  const t = opts.picker;
  return t !== undefined && pickers.has(t) && (t.keys as readonly string[]).includes(key);
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
export function sealLaunchScript(
  worktree: string,
  content: string,
  /** A paired machine's spawn: its name and `worktree_root` (a profile there is checked so). */
  host?: ProfileHost,
): LaunchToken {
  if (!absPath(worktree))
    throw new FenceError("launch.sh", "the worktree is not a clean absolute path");
  if (!isLaunchScript(content, worktree, host))
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

/** `<home>/.volley/<segment>/<acct>` on a paired machine, `<acct>` in the §2.1 id grammar. */
const remoteVolleyDir = (segment: string) =>
  new RegExp(`^/(?:.*/)?\\.volley/${segment}/[a-z0-9][a-z0-9_-]{0,62}$`);
/** A paired machine's sign-in dir: `<home>/.volley/signin/<acct>` (remote-signin.ts). */
const REMOTE_SIGNIN_DIR = remoteVolleyDir("signin");
const isRemoteSigninDir = (dir: string) => absPath(dir) && REMOTE_SIGNIN_DIR.test(dir);
/** A profile the supervisor created on a paired machine: `<home>/.volley/claude/<acct>`. */
const REMOTE_PROFILE_DIR = remoteVolleyDir("claude");
const isRemoteProfileDir = (dir: string) => absPath(dir) && REMOTE_PROFILE_DIR.test(dir);

/**
 * The two `signin.sh` renderings a paired machine's sign-in dir may hold: the box's default
 * profile's (no `CLAUDE_CONFIG_DIR`), or, for `<home>/.volley/signin/<acct>`, the profile
 * `<home>/.volley/claude/<acct>`'s (the same home, the same acct).
 */
function remoteSigninScripts(dir: string): string[] {
  const profile = dir.replace(/\/\.volley\/signin\/([^/]+)$/, "/.volley/claude/$1");
  return [
    renderSigninScript({ signinDir: dir }),
    renderSigninScript({ configDir: profile, signinDir: dir }),
  ];
}

/**
 * Seal the sign-in script volleyd is about to write to `<dir>/signin.sh` on a paired machine:
 * throws `FenceError` unless `dir` is `<abs>/.volley/signin/<acct>` and `content` is exactly
 * `renderSigninScript` of that dir with no profile dir (the box's own default profile) or with
 * the profile dir `<abs>/.volley/claude/<acct>` (a profile the supervisor created there).
 * Callers: remote-signin.ts.
 */
export function sealRemoteSigninScript(dir: string, content: string): SigninToken {
  if (!isRemoteSigninDir(dir))
    throw new FenceError("signin.sh", "the sign-in dir is not <home>/.volley/signin/<acct>");
  if (!remoteSigninScripts(dir).includes(content))
    throw new FenceError("signin.sh", "only a script renderSigninScript renders for this dir");
  const token = Object.freeze({ cwd: dir, remote: true });
  signins.add(token);
  return token;
}

/**
 * A file of a paired machine's sign-in dir and the only contents volleyd writes to it: a sealed
 * `signin.sh` (either rendering, `remoteSigninScripts`), the `browser.sh` helper, or an empty
 * `url` (a stale URL is never read back). Null for any other path.
 */
function remoteSigninFile(path: string): { name: string; contents: string[] } | null {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash);
  const name = path.slice(slash + 1);
  if (slash < 0 || !absPath(path) || !isRemoteSigninDir(dir)) return null;
  if (name === SIGNIN_SCRIPT) return { name, contents: remoteSigninScripts(dir) };
  if (name === BROWSER_HELPER) return { name, contents: [renderBrowserHelper(dir)] };
  if (name === SIGNIN_URL_FILE) return { name, contents: [""] };
  return null;
}

// ---------------------------------------------------------------------------------------------
// COORDINATOR (SPEC §4.6.25, coordinator/): the Remote Control server volleyd keeps alive
// ---------------------------------------------------------------------------------------------

const coordinators = new WeakSet<object>();

/**
 * Proof for the coordinator role, checked by identity: `script`, that the
 * `<dir>/.volley/coordinator.sh` volleyd writes is exactly `renderCoordinatorScript` of `vars`
 * (`sealCoordinatorScript`), which starts the coordinator's tmux session and writes its
 * directory's files; `kill`, the coordinator's own session ended (`mintCoordinatorKill`: it holds
 * no agent's work, so no consent).
 */
export type CoordinatorToken =
  | {
      readonly kind: "script";
      readonly dir: string;
      readonly session: string;
      readonly script: string;
      readonly vars: CoordinatorScriptVars;
    }
  | { readonly kind: "kill"; readonly session: string };

/** A coordinator name: the §2.2 agent-id grammar `volley setup` records it in. */
const COORDINATOR_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** `volley-coordinator-<name>`: never an agent's session (isAgentSession excludes it). */
const COORDINATOR_SESSION = new RegExp(`^volley-coordinator-${COORDINATOR_NAME.source.slice(1)}`);
const COORDINATOR_EXPORT = (name: string) => new RegExp(`^export ${name}=(${SHQ})$`, "m");
const COORDINATOR_PATH = () => new RegExp(`^export PATH=(${SHQ}):"\\$PATH"$`, "m");
const COORDINATOR_GRACE = /^\[ \$\(\(SECONDS - started\)\) -lt ([1-9][0-9]{0,3}) \] \|\| exit 1$/m;
const COORDINATOR_EXEC = () =>
  new RegExp(`^exec .* '--capacity' '([1-9][0-9]{0,2})' '--permission-mode' (${SHQ})$`, "m");
const COORDINATOR_BROKER = /^mqtt:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;

/**
 * Seal the coordinator script volleyd is about to write to `<dir>/.volley/coordinator.sh`: throws
 * `FenceError` unless `dir` is a clean absolute path and `text` is exactly what
 * `renderCoordinatorScript` renders for that dir and valid values (a coordinator name, a
 * namespace, a loopback broker port, absolute hooks and bin dirs, a capacity, a `--permission-mode`
 * of the help's enum): so its `claude remote-control` carries exactly the pinned flags.
 */
export function sealCoordinatorScript(dir: string, text: string): CoordinatorToken {
  const refuse = () =>
    new FenceError("coordinator.sh", "only a script renderCoordinatorScript renders for this dir");
  if (!absPath(dir)) throw new FenceError("coordinator.sh", "the dir is not a clean absolute path");
  const word = (re: RegExp) => {
    const m = re.exec(text);
    return m !== null ? unshq(m[1] as string) : null;
  };
  const name = word(COORDINATOR_EXPORT("VOLLEY_COORDINATOR"));
  const namespace = word(COORDINATOR_EXPORT("VOLLEY_NAMESPACE"));
  const broker = COORDINATOR_BROKER.exec(word(COORDINATOR_EXPORT("VOLLEY_BROKER_URL")) ?? "");
  const hooksDir = word(COORDINATOR_EXPORT("VOLLEY_HOOKS_DIR"));
  const binDir = word(COORDINATOR_PATH());
  const grace = COORDINATOR_GRACE.exec(text);
  const exec = COORDINATOR_EXEC().exec(text);
  const mode = exec !== null ? unshq(exec[2] as string) : "";
  const port = Number(broker?.[1] ?? 0);
  if (
    name === null ||
    !COORDINATOR_NAME.test(name) ||
    namespace === null ||
    !AGENT_ID.test(namespace) ||
    port < 1 ||
    port > 65535 ||
    hooksDir === null ||
    !absPath(hooksDir) ||
    binDir === null ||
    !absPath(binDir) ||
    grace === null ||
    exec === null ||
    !(PERMISSION_MODES as readonly string[]).includes(mode)
  )
    throw refuse();
  const vars: CoordinatorScriptVars = {
    dir,
    name,
    namespace,
    brokerPort: port,
    hooksDir,
    binDir,
    capacity: Number(exec[1]),
    permissionMode: mode as PermissionMode,
    continueGraceS: Number(grace[1]),
  };
  if (renderCoordinatorScript(vars) !== text) throw refuse();
  const token = Object.freeze({
    kind: "script" as const,
    dir,
    session: coordinatorSession(name),
    script: text,
    vars: Object.freeze(vars),
  });
  coordinators.add(token);
  return token;
}

/** Permission to end the coordinator's session for `name` (a restart, a stop, a machine change). */
export function mintCoordinatorKill(name: string): CoordinatorToken {
  if (!COORDINATOR_NAME.test(name))
    throw new FenceError("coordinator kill", "not a coordinator name");
  const token = Object.freeze({ kind: "kill" as const, session: coordinatorSession(name) });
  coordinators.add(token);
  return token;
}

/** The sealed script token in `opts`, if volleyd minted it. */
function coordinatorScript(
  opts: FenceOptions,
): Extract<CoordinatorToken, { kind: "script" }> | null {
  const t = opts.coordinator;
  return t !== undefined && coordinators.has(t) && t.kind === "script" ? t : null;
}

/**
 * tmux on the coordinator's session (`volley-coordinator-<name>`), locally and as a REMOTE step,
 * in exactly the shapes the runner sends; null when the command does not name one:
 *   new-session -d -s <it> -c <dir> 'bash .volley/coordinator.sh'   (the script token for <dir>
 *     and <it>; on a paired machine its broker port the host's) ·
 *   has-session -t =<it> · capture-pane -p [-J] -t =<it>: -S-<n> ·
 *   kill-session -t =<it>   (the kill token for <it>)
 * Nothing is ever typed into it.
 */
function coordinatorTmux(
  sub: string | undefined,
  rest: readonly string[],
  opts: FenceOptions,
): Verdict | null {
  const named = (t: string | undefined, suffix = "") =>
    t?.startsWith("=") && t.endsWith(suffix)
      ? COORDINATOR_SESSION.test(t.slice(1, t.length - suffix.length))
      : false;
  const verb = `tmux ${sub ?? ""} (the coordinator's session)`;
  if (sub === "new-session") {
    const [d, s, session, c, cwd, cmd, ...more] = rest;
    if (cmd !== COORDINATOR_COMMAND && !COORDINATOR_SESSION.test(session ?? "")) return null;
    const t = coordinatorScript(opts);
    const port = opts.remote?.host?.broker_port;
    return d === "-d" &&
      s === "-s" &&
      c === "-c" &&
      cmd === COORDINATOR_COMMAND &&
      more.length === 0 &&
      t !== null &&
      t.session === session &&
      t.dir === cwd &&
      (port === undefined || t.vars.brokerPort === port)
      ? ALLOW
      : deny("tmux new-session (only the sealed coordinator script, in its own session and dir)");
  }
  if (!rest.some((a) => named(a) || named(a, ":"))) return null;
  switch (sub) {
    case "has-session":
      return rest.length === 2 && rest[0] === "-t" && named(rest[1]) ? ALLOW : deny(verb);
    case "capture-pane": {
      const j = rest[1] === "-J" ? 1 : 0;
      const [p, t, target, start, ...more] = [rest[0], ...rest.slice(1 + j)];
      return p === "-p" &&
        t === "-t" &&
        named(target, ":") &&
        CAPTURE_START.test(start ?? "") &&
        more.length === 0
        ? ALLOW
        : deny(verb);
    }
    case "kill-session": {
      const k = opts.coordinator;
      return rest.length === 2 &&
        rest[0] === "-t" &&
        named(rest[1]) &&
        k !== undefined &&
        coordinators.has(k) &&
        k.kind === "kill" &&
        `=${k.session}` === rest[1]
        ? ALLOW
        : deny("tmux kill-session (the coordinator's session, only with its kill token)");
    }
    default:
      return deny(verb);
  }
}

/**
 * A file of the coordinator directory and whether `content` is what volleyd writes there, with
 * the script token for that directory: `.volley/coordinator.sh` (the sealed text),
 * `.volley/auth/coordinator.json` (the coordinator login: a JSON object of string `username` and
 * `password`, the file the supervisor holds), `.mcp.json` (`renderCoordinatorMcp` of an absolute
 * `…/packages/volley-mcp/src/index.ts` and the token's vars) and `.claude/settings.json`
 * (COORDINATOR_SETTINGS). Null: not a coordinator file (or no token).
 */
function coordinatorFile(
  path: string,
  opts: FenceOptions,
): { name: string; ok: (content: string) => boolean } | null {
  const t = coordinatorScript(opts);
  if (t === null || !absPath(path) || !path.startsWith(`${t.dir}/`)) return null;
  const rel = path.slice(t.dir.length + 1);
  switch (rel) {
    case COORDINATOR_FILES.script:
      return { name: rel, ok: (c) => c === t.script };
    case COORDINATOR_FILES.login:
      return {
        name: rel,
        ok: (c) => {
          try {
            const j = JSON.parse(c) as Record<string, unknown>;
            return (
              typeof j === "object" &&
              j !== null &&
              typeof j.username === "string" &&
              typeof j.password === "string"
            );
          } catch {
            return false;
          }
        },
      };
    case COORDINATOR_FILES.mcp:
      return {
        name: rel,
        ok: (c) => {
          try {
            const entry = (JSON.parse(c) as { mcpServers?: { volley?: { args?: unknown[] } } })
              .mcpServers?.volley?.args?.[0];
            return (
              typeof entry === "string" &&
              absPath(entry) &&
              entry.endsWith(MCP_ENTRY_SUFFIX) &&
              outsideVolley(entry) &&
              c === renderCoordinatorMcp(entry, t.vars)
            );
          } catch {
            return false;
          }
        },
      };
    case COORDINATOR_FILES.settings:
      return { name: rel, ok: (c) => c === COORDINATOR_SETTINGS };
    default:
      return null;
  }
}

/** `ln -sfn <abs target> <dir>/repos/<owner>/<name>`: a repository's link, with the script token. */
function coordinatorLink(args: readonly string[], opts: FenceOptions): boolean {
  const t = coordinatorScript(opts);
  const [f, target, link, ...more] = args;
  if (t === null || f !== "-sfn" || more.length > 0 || target === undefined || link === undefined)
    return false;
  const prefix = `${t.dir}/repos/`;
  return (
    absPath(target) && absPath(link) && link.startsWith(prefix) && isSlug(link.slice(prefix.length))
  );
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

const profileRemovals = new WeakSet<object>();

/**
 * Permission to remove one profile the supervisor created on a paired machine:
 * `rm -rf <home>/.volley/claude/<acct>` as one REMOTE step, exactly that dir. Only
 * `mintProfileRemoveToken` creates one (checked by identity). Callers: claude/service.ts remove.
 */
export interface ProfileRemoveToken {
  readonly dir: string;
}

/** Mint the removal token for `dir`; throws `FenceError` unless it is a remote profile dir. */
export function mintProfileRemoveToken(dir: string): ProfileRemoveToken {
  if (!isRemoteProfileDir(dir))
    throw new FenceError("remote rm -rf", "only <home>/.volley/claude/<acct>");
  const token = Object.freeze({ dir });
  profileRemovals.add(token);
  return token;
}

const entries = new WeakSet<object>();
/** Entry tokens already used: a pasted code is typed, a pasted redirect requested, once. */
const spentEntries = new WeakSet<object>();

/**
 * Permission to finish one waiting sign-in with what the owner pasted (SPEC §4.6.11): type
 * `code` into the sign-in session (`tmux send-keys -t <session> -l -- <code>`), or request `url`
 * (`curl -fsS --max-time 10 <url>`, Claude Code's own callback on 127.0.0.1), once, on this
 * machine or as a REMOTE step. Only `mintSigninEntryToken` creates one. Callers:
 * claude/service.ts enterSignin.
 */
export interface SigninEntryToken {
  readonly session: string;
  readonly code?: string;
  readonly url?: string;
}

/** The callback a pasted redirect is completed at: Claude Code's listener, nothing to quote. */
const SIGNIN_CALLBACK_URL = /^http:\/\/127\.0\.0\.1:([0-9]{4,5})\/callback\?[A-Za-z0-9._~%+=&-]+$/;

/**
 * Mint the entry token: throws `FenceError` unless `session` is a `volley-signin-<acct>` session
 * and `code` a code `parseSigninEntry` accepts, or `url` a 127.0.0.1 callback on 1024..65535.
 */
export function mintSigninEntryToken(
  e: { session: string; code: string } | { session: string; url: string },
): SigninEntryToken {
  if (!SIGNIN_SESSION.test(e.session))
    throw new FenceError("sign-in entry", "not a volley-signin-* session");
  if ("code" in e) {
    const p = parseSigninEntry(e.code);
    if (p.kind !== "code" || p.code !== e.code)
      throw new FenceError("sign-in entry", "not a sign-in code");
  } else {
    const port = Number(SIGNIN_CALLBACK_URL.exec(e.url)?.[1] ?? 0);
    if (port < 1024 || port > 65535)
      throw new FenceError("sign-in entry", "not a sign-in callback on 127.0.0.1");
  }
  const token = Object.freeze({ ...e });
  entries.add(token);
  return token;
}

/** True (and the token spent) when `opts` carries an unspent entry token matching `want`. */
function entryAllows(opts: FenceOptions, want: (t: SigninEntryToken) => boolean): boolean {
  const t = opts.signinEntry;
  if (t === undefined || !entries.has(t) || spentEntries.has(t) || !want(t)) return false;
  spentEntries.add(t);
  return true;
}

/** `curl -fsS --max-time 10 <url>` with the entry token naming exactly that url. */
function entryCurl(args: readonly string[], opts: FenceOptions): Verdict {
  return entryAllows(
    opts,
    (t) => t.url !== undefined && sameArgv(args, ["-fsS", "--max-time", "10", t.url]),
  )
    ? ALLOW
    : deny("curl (only a sign-in's pasted callback, with its token)");
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

const machineAdds = new WeakSet<object>();

/** Permission to run one `machine_add`'s steps (`mintMachineAddToken`; checked by identity). */
export interface MachineAddToken {
  readonly target: string;
  /** This machine's home: its key creation's path. */
  readonly home: string;
  /** The scripts the run rendered (volley-cli's `Scripts`): the only stdin its ssh forms take. */
  readonly scripts: { has(s: string | undefined): boolean };
  /** The key the person named (`auth.key`), or null. */
  readonly key: string | null;
  /** The askpass helper the password form's env names, or null. */
  readonly askpass: string | null;
}

/** Callers: machine-add.ts, once per `machine_add` run. */
export function mintMachineAddToken(t: MachineAddToken): MachineAddToken {
  if (!SSH_TARGET.test(t.target)) throw new FenceError(`ssh ${t.target}`, "not an ssh destination");
  const token = Object.freeze({ ...t });
  machineAdds.add(token);
  return token;
}

/**
 * The ssh argv of a `machine_add` step: `batch` (this machine's key, every step after the first),
 * `key` (the person's key file) or `password` (ssh asks the token's askpass helper).
 */
export function machineAddArgv(
  target: string,
  how: "batch" | "key" | "password",
  key?: string,
): string[] {
  const connect = `ConnectTimeout=${DAEMON_DEFAULTS.machine_add_connect_timeout_s}`;
  const hostKey = "StrictHostKeyChecking=accept-new";
  if (how === "password") {
    return [
      "ssh",
      "-T",
      "-o",
      connect,
      "-o",
      hostKey,
      "-o",
      "NumberOfPasswordPrompts=1",
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      target,
      "bash",
      "-s",
    ];
  }
  return [
    "ssh",
    "-T",
    ...(how === "key" ? ["-i", key ?? "", "-o", "IdentitiesOnly=yes"] : []),
    "-o",
    "BatchMode=yes",
    "-o",
    connect,
    "-o",
    `ServerAliveInterval=${DAEMON_DEFAULTS.machine_add_alive_interval_s}`,
    "-o",
    `ServerAliveCountMax=${DAEMON_DEFAULTS.machine_add_alive_count_max}`,
    "-o",
    hostKey,
    target,
    "bash",
    "-s",
  ];
}

/** This machine's key creation, as volley-cli's `keygenArgv` (no passphrase: BatchMode needs none). */
const keygenArgv = (home: string): string[] => [
  "ssh-keygen",
  "-t",
  "ed25519",
  "-N",
  "",
  "-q",
  "-f",
  join(home, ".ssh", "id_ed25519"),
];
/** A Mac's Remote Login as launchd has it, as volley-cli's `REMOTE_LOGIN_ARGV`. */
const REMOTE_LOGIN_ARGV = ["launchctl", "print", "system/com.openssh.sshd"];

const ASKPASS_ENV = ["SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "SUDO_ASKPASS"] as const;

/** Whether `env` sets an askpass helper (an empty value sets none). */
const asksPass = (env: FenceOptions["env"]) =>
  env !== undefined && ASKPASS_ENV.some((k) => (env[k] ?? "") !== "");

/** The MACHINE ADD rows (see the header): the only commands a machine-add token allows. */
function machineAddVerdict(
  argv: readonly string[],
  t: MachineAddToken,
  opts: FenceOptions,
): Verdict {
  const script = t.scripts.has(opts.input);
  const env = opts.env;
  const askpassOk =
    t.askpass !== null &&
    env?.SSH_ASKPASS === t.askpass &&
    env.SSH_ASKPASS_REQUIRE === "force" &&
    (env.SUDO_ASKPASS ?? "") === "";
  const ok = asksPass(env)
    ? script && askpassOk && same(argv, machineAddArgv(t.target, "password"))
    : (script &&
        (same(argv, machineAddArgv(t.target, "batch")) ||
          (t.key !== null && same(argv, machineAddArgv(t.target, "key", t.key))))) ||
      same(argv, keygenArgv(t.home)) ||
      same(argv, REMOTE_LOGIN_ARGV);
  return ok ? ALLOW : deny(`${argv.slice(0, 3).join(" ")} (not a machine_add step)`);
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
      cwd === repo("packages", "volley-desk")) ||
    isTailscaleCommand(argv, { sudo: false }) ||
    isTailscaleServeCommand(argv, { sudo: false });
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
  /**
   * `claude auth status` of a profile the supervisor created on the box (remote-signin.ts): its
   * `CLAUDE_CONFIG_DIR`, `<home>/.volley/claude/<acct>`. On no other step.
   */
  env?: { CLAUDE_CONFIG_DIR: string };
  stdin?: string;
  stdout?: string;
  append?: boolean;
}

/** The script `ssh -T <target> bash -s` runs: fenced step by step, rendered by `renderRemoteScript`. */
export interface RemoteScript {
  steps: RemoteStep[];
  /** The configured host it runs on (SshTmuxHost's spec): which profiles its launch.sh may use. */
  host?: ProfileHost;
}

/** A paired machine as the profile rule sees it: its name and its worktree root there. */
export interface ProfileHost {
  name: string;
  worktree_root: string;
  /**
   * The port its agents reach the broker at on its loopback (`hosts.<name>.tunnel.remote_port`:
   * its tunnel's end, or with `tunnel: none` the broker's own port, SPEC §4.6.14): the one
   * `VOLLEY_BROKER_URL` its launch.sh may name. Absent: any loopback port.
   */
  broker_port?: number;
  /**
   * Its Volley checkout (`hosts.<name>.volley_dir`): the only `volley` that runs there is
   * `bun <volley_dir>/packages/volley-cli/src/cli.ts …` (remoteVolleyArgv). Absent: none runs.
   */
  volley_dir?: string;
}

/** The Volley CLI's script in the checkout at `volleyDir`. */
export const volleyCliPath = (volleyDir: string): string =>
  posix.join(volleyDir, "packages", "volley-cli", "src", "cli.ts");

/**
 * A `volley <args>` as a paired machine runs it: its own checkout, by bun, never a `volley` found
 * on the box's PATH (a non-interactive ssh PATH may have none). The form `volley deploy` uses.
 */
export const remoteVolleyArgv = (volleyDir: string, args: readonly string[]): string[] => [
  "bun",
  volleyCliPath(volleyDir),
  ...args,
];

export interface FenceOptions {
  consent?: ConsentToken;
  script?: ScriptToken;
  /** For `ssh … bash -s` only: the remote script, which `exec` renders onto the child's stdin. */
  remote?: RemoteScript;
  /** For starting or typing LAUNCH_COMMAND: the sealed launch script. */
  launch?: LaunchToken;
  /** For `gh pr merge`: the gate's token for exactly that PR and head. */
  merge?: MergeToken;
  /** For a merge train's `gh pr merge --merge`: the train's token for exactly its PR and head. */
  train?: TrainToken;
  /** For the release PR's squash merge: the `release_go` go's token for its PR and green head. */
  release?: ReleaseToken;
  /** For typing `/model <id>`: the approved switch. */
  modelSwitch?: ModelSwitchToken;
  /** For Up/Down/Space and a picker's Other text: the inbox item's picker answer. */
  picker?: PickerToken;
  /** For typing a coordinator handoff's reply: the inbox item's answer. */
  handoff?: HandoffToken;
  /** For typing WAKE_TEXT into an idle agent's session. */
  wake?: WakeToken;
  /** For starting a sign-in tmux session: the sealed sign-in script. */
  signin?: SigninToken;
  /** The coordinator role's script (its session, its directory's files) or kill token. */
  coordinator?: CoordinatorToken;
  /** For the sign-in forward (`ssh -N -L`): the token a remote sign-in minted. */
  forward?: SigninForwardToken;
  /** For a remote `rm -rf <home>/.volley/claude/<acct>`: the removal's token for that dir. */
  profileRemove?: ProfileRemoveToken;
  /** For typing a pasted sign-in code or requesting a pasted callback: the entry's token. */
  signinEntry?: SigninEntryToken;
  /** A setup step for the Desk (setup-ops.ts): only the SETUP rows, and nothing else. */
  setup?: SetupToken;
  /** The command's working directory; only the SETUP rows read it (the Desk build). */
  cwd?: string;
  /** A `machine_add` step (machine-add.ts): only the MACHINE ADD rows, and nothing else. */
  machineAdd?: MachineAddToken;
  /** The child's environment; the ASKPASS rule reads it. */
  env?: Record<string, string | undefined>;
  /** Written to the child's stdin, which is then closed (not with `remote`, which is the stdin); the MACHINE ADD rows read it. */
  input?: string;
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
 *   values   — extra check for a valued option's value, by option (either form)
 */
interface OptSpec {
  flags?: readonly string[];
  valued?: readonly string[];
  optional?: readonly string[];
  numeric?: boolean;
  pathspecs?: boolean;
  positional?: (arg: string) => boolean;
  values?: Readonly<Record<string, (value: string) => boolean>>;
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
  // The footprint resolver's tree read (footprint.ts readTree): paths and sizes, nothing else.
  "ls-tree": {
    flags: ["-r", "-l", "--long", "--full-tree", "-z", "--name-only", "-t", "-d"],
    pathspecs: true,
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

/** A git branch name as `gh run list --branch` takes it: never an option, no space or shell syntax. */
const isBranchName = (v: string): boolean =>
  /^[A-Za-z0-9._/-]+$/.test(v) && !v.startsWith("-") && !v.includes("..");

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
    // A branch name (a red head's classification reads the release branch's runs), never an option.
    values: { "--branch": isBranchName, "-b": isBranchName },
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
  const wake = opts.wake;
  if (text === WAKE_TEXT && wake !== undefined && wakes.has(wake)) {
    if (spentText.has(wake)) return "a wake is typed once";
    spentText.add(wake);
    return null;
  }
  const answer = answerTextToken(text, opts);
  if (answer !== null) {
    if (spentText.has(answer)) return "an inbox answer's text is typed once";
    spentText.add(answer);
    return null;
  }
  return "text volleyd never types";
}

/** The keys volleyd sends by name: submit, and interrupt. */
const NAMED_KEYS = new Set(["Enter", "Escape"]);

/**
 * True when `text` is something the fence ever lets volleyd type or press in an agent's
 * terminal (with its token, where it needs one): a named or picker key, the launch command, or
 * the wake line (fence-coverage.test.ts). Anything else is typed only as a token's own text.
 */
export function fenceKnowsTypedText(text: string): boolean {
  return (
    NAMED_KEYS.has(text) ||
    (PICKER_KEYS as readonly string[]).includes(text) ||
    text === LAUNCH_COMMAND ||
    text === WAKE_TEXT
  );
}
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

/** The one process listing (procs.ts): read-only; signals are sent with `process.kill`, never a child. */
export const PS_ARGV: readonly string[] = ["ps", "-axo", "pid=,command="];

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
  // Before every other branch: a sealed script or a setup token gets no askpass env either.
  if (opts.machineAdd === undefined && asksPass(opts.env)) {
    throw new FenceError(
      `${argv.slice(0, 2).join(" ")} with an askpass env`,
      "only a machine_add password step names an askpass helper",
    );
  }
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
  if (opts.machineAdd !== undefined) {
    const v = machineAdds.has(opts.machineAdd)
      ? machineAddVerdict(argv, opts.machineAdd, opts)
      : deny(`${argv.slice(0, 2).join(" ")} (a machine-add token volleyd did not mint)`);
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
      return gh(args, opts);
    case "cmux":
      return cmux(args, opts);
    case "claude":
      // claude starts only from `.volley/launch.sh` or a sealed sign-in script (see the header);
      // the direct calls read a profile's login state and Claude Code's version.
      return (args.length === 2 && args[0] === "auth" && args[1] === "status") ||
        sameArgv(args, ["--version"])
        ? ALLOW
        : deny("claude (only from .volley/launch.sh)");
    case "tmux":
      return localTmux(args, opts);
    case "curl":
      return entryCurl(args, opts);
    case "volley":
      return volley(args);
    case "mosquitto":
      return args.length === 1 && args[0] === "-h" ? ALLOW : deny("mosquitto (only -h)");
    case "pmset":
      return exactly(argv, [PMSET_BATT_ARGV]);
    case "launchctl":
      return launchctl(args);
    case "systemctl":
      return systemctl(args);
    case "tar":
      return tar(args);
    case "brew":
    case "sudo":
      // A broker move stops (and a rollback starts) the broker here through its layout.
      return isBrokerService(argv) ? ALLOW : deny(`${prog} ${args[0] ?? ""}`.trim());
    case "ps":
      return exactly(argv, [PS_ARGV]);
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

/** A valued option's value passes the spec's check for that option (none: any value). */
const valueOk = (spec: OptSpec, option: string, value: string): boolean =>
  spec.values?.[option]?.(value) ?? true;

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
      if (eq !== -1 && (has(spec.valued, name) || has(spec.optional, name))) {
        if (!valueOk(spec, name, a.slice(eq + 1))) return deny(`${verb} ${a}`);
        continue;
      }
      if (eq === -1 && has(spec.valued, a)) {
        const v = args[i + 1];
        if (v === undefined || v.startsWith("-")) return deny(`${verb} ${a} (missing value)`);
        if (!valueOk(spec, a, v)) return deny(`${verb} ${a} ${v}`);
        i++;
        continue;
      }
      return deny(`${verb} ${name}`);
    }
    // Short option: exact `-x` taking the next element, or `-xVALUE` attached. Bundled short
    // flags (`-uq`) are not accepted: one of them could be a value-taking option.
    const short = a.slice(0, 2);
    if (has(spec.valued, short)) {
      if (a.length > 2) {
        if (!valueOk(spec, short, a.slice(2))) return deny(`${verb} ${a}`);
        continue;
      }
      const v = args[i + 1];
      if (v === undefined || v.startsWith("-")) return deny(`${verb} ${a} (missing value)`);
      if (!valueOk(spec, short, v)) return deny(`${verb} ${a} ${v}`);
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
  // repo_probe's origin reading (SPEC §4.6.21): exactly `remote get-url origin`, never a write.
  if (sub === "remote") {
    return rest.length === 2 && rest[0] === "get-url" && rest[1] === "origin"
      ? ALLOW
      : deny(`git remote ${rest[0] ?? ""}`.trim());
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

/** An issue number as gh takes it: a positive decimal, never an option. */
const ISSUE_NUMBER = /^[1-9][0-9]{0,8}$/;

/** The one label volleyd adds, removes and creates (the issue lifecycle, autopilot/issues.ts). */
const LIFECYCLE_LABEL = "merged-to-release";

/** The marker every comment volleyd writes on an issue ends with, on a line of its own (autopilot/issues.ts). */
const COMMENT_MARKER = /\n\n<!-- volleyd:[a-z-]+ wave=[a-z0-9][a-z0-9_-]{0,62}( pr=[0-9]+)? -->$/;

/**
 * The issue lifecycle's writes (#416), each an exact argv: the label added or removed, a comment
 * or a closing comment that carries volleyd's marker, the label listed or created; each may end
 * in `--repo <owner/name>`. Null: not one of them (the read-only allow-list decides).
 */
function issueLifecycle(all: string[]): Verdict | null {
  // A wave named by its `owner/name` (no clone on the supervisor) ends each form in exactly
  // `--repo <owner/name>` (#448).
  const repo = all.length >= 2 && all.at(-2) === "--repo" && isSlug(all.at(-1) ?? "");
  const args = repo ? all.slice(0, -2) : all;
  const [verb = "", sub = "", n = "", flag = "", value = ""] = args;
  const two = `${verb} ${sub}`;
  if (two === "issue edit" || two === "issue comment" || two === "issue close") {
    const shape =
      args.length === 5 &&
      ISSUE_NUMBER.test(n) &&
      (two === "issue edit"
        ? (flag === "--add-label" || flag === "--remove-label") && value === LIFECYCLE_LABEL
        : flag === (two === "issue comment" ? "--body" : "--comment") &&
          COMMENT_MARKER.test(value));
    return shape ? ALLOW : deny(`gh ${two} (only the issue lifecycle's exact forms)`);
  }
  if (two === "label list")
    return args.length === 6 &&
      n === "--search" &&
      flag === LIFECYCLE_LABEL &&
      value === "--json" &&
      args[5] === "name"
      ? ALLOW
      : deny("gh label list (only --search merged-to-release --json name)");
  if (two === "label create")
    return args.length === 7 &&
      n === LIFECYCLE_LABEL &&
      flag === "--description" &&
      value !== "" &&
      !value.startsWith("-") &&
      args[5] === "--color" &&
      /^[0-9a-f]{6}$/.test(args[6] ?? "")
      ? ALLOW
      : deny("gh label create (only merged-to-release, with a description and a hex color)");
  return null;
}

function gh(args: string[], opts: FenceOptions): Verdict {
  const two = args.slice(0, 2).join(" ");
  if (two === "pr merge") return mergeVerdict(args, opts.merge, opts.train, opts.release);
  if (two === "pr ready") return readyVerdict(args.slice(2));
  const lifecycle = issueLifecycle(args);
  if (lifecycle !== null) return lifecycle;
  if (two === "workflow run" || two === "repo delete") return deny(`gh ${two}`);
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

/**
 * `gh pr ready <n> [--repo <slug>]`, exactly: a draft PR marked ready for review, so the CI its
 * repository skips on drafts runs before the gate (#408). Never `--undo`, never another option.
 */
function readyVerdict(args: string[]): Verdict {
  if (!/^[1-9][0-9]*$/.test(args[0] ?? "")) return deny("gh pr ready (not one PR number)");
  return checkArgs("gh pr ready", args.slice(1), {
    valued: ["--repo", "-R"],
    positional: () => false,
  });
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
        return ws && rest.length === 3 && keyAllowed(rest[2] ?? "", opts);
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

/**
 * A prime's probe (`peer doctor --json --probe-login <profile>`, here or on a box): one Claude
 * login's usage reading, `default` or a profile id.
 */
const PROBE_LOGIN = "--probe-login";
const isLoginName = (p: string | undefined) =>
  p !== undefined && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(p);

/** `volley auth <account verb>`: the account ops volleyd runs for an admin (accounts.ts). */
function volley(args: string[]): Verdict {
  const [group, verb] = args;
  const name = `volley ${[group, verb].filter((a) => a !== undefined).join(" ")}`;
  // The supervisor is its own machine's doctor (SPEC §4.6.15): a report, never a fix.
  if (group === "peer" && verb === "doctor") {
    const rest = args.slice(2);
    const ok =
      rest[0] === "--json" &&
      (rest.length === 1 ||
        (rest.length === 3 && rest[1] === "--repo" && isRepoPath(rest[2])) ||
        (rest.length === 3 && rest[1] === PROBE_LOGIN && isLoginName(rest[2])));
    return ok
      ? ALLOW
      : deny(
          `volley peer doctor ${rest.join(" ")} (only --json [--repo <abs> | --probe-login <profile>])`,
        );
  }
  if (group === "auth" && verb !== undefined && ACCOUNT_SHAPES[verb] !== undefined) {
    return ACCOUNT_SHAPES[verb](args.slice(2)) ? ALLOW : deny(`${name} ${args.slice(2).join(" ")}`);
  }
  // A Desk move to (or back to) the supervisor's own machine (SPEC §4.6.24).
  if (group === "desk")
    return isDeskVerb(args.slice(1)) ? ALLOW : deny(`${name} (not a Desk move's)`);
  // A broker move's own tunnel here (SPEC §4.6.24).
  if (group === "broker")
    return isOwnBrokerTunnel(args.slice(1)) ? ALLOW : deny(`${name} (not a broker move's)`);
  return deny(name);
}

/** The service plist `volleyd install` writes under `home` (`$HOME/Library/LaunchAgents`). */
export const plistPath = (home: string) =>
  join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
const plistFile = () => plistPath(process.env.HOME ?? homedir());

function launchctl(args: string[]): Verdict {
  if (isDeskLaunchctl(args)) return ALLOW;
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

// ---------------------------------------------------------------------------------------------
// Machine roles (SPEC §4.6.14 peer_retarget, §4.6.24): the commands a role move runs
// ---------------------------------------------------------------------------------------------

/** A port in 1..65535, as an argv element. */
const isPortArg = (p: string | undefined) =>
  p !== undefined && /^[1-9][0-9]{0,4}$/.test(p) && Number(p) <= 65535;
/** A bare host `volley desk install --broker-host` takes: a name or an IPv4 address. */
const BARE_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
/** A version `volley desk check --version` compares with (the supervisor's own). */
const VERSION_ARG = /^[0-9][0-9A-Za-z.+-]{0,63}$/;
/** A pairing code as `peer_invite` makes one (peers.ts ALPHABET). */
const PAIRING_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;
/** A move's id (role-move.schema.json `$defs/move_id`). */
const MOVE_ID = "[A-Za-z0-9][A-Za-z0-9_-]{0,63}";
/** Where a supervisor move copies its bundle on the target: `<abs>/.volley/roles/<move_id>/bundle.tgz`. */
const BUNDLE_PATH = new RegExp(`^/[^\\n\\r\\0]*/\\.volley/roles/${MOVE_ID}/bundle\\.tgz$`);
export const isBundlePath = (p: string): boolean => BUNDLE_PATH.test(p) && absPath(p);

/**
 * `volley desk install --port <n> --broker-host <host>` · `volley desk uninstall` ·
 * `volley desk check --url http://127.0.0.1:<n> --version <v>` (args after `desk`): a Desk
 * move's steps, here or on its target.
 */
function isDeskVerb(a: readonly string[]): boolean {
  const [verb, ...rest] = a;
  if (verb === "uninstall") return rest.length === 0;
  if (verb === "install")
    return (
      rest.length === 4 &&
      rest[0] === "--port" &&
      isPortArg(rest[1]) &&
      rest[2] === "--broker-host" &&
      BARE_HOST.test(rest[3] ?? "")
    );
  if (verb === "check") {
    const m = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/.exec(rest[1] ?? "");
    return (
      rest.length === 4 &&
      rest[0] === "--url" &&
      m !== null &&
      isPortArg(m[1]) &&
      rest[2] === "--version" &&
      VERSION_ARG.test(rest[3] ?? "")
    );
  }
  return false;
}

/**
 * The volley steps a role move runs on a paired machine (args after `volley`), each one exact
 * shape: `peer retarget --to <dest> [--port <n>] [--tunnel ssh|none]` (`peer_retarget`), `peer join
 * <code> --to <dest> --name <name> --target <dest> --tunnel none` (a supervisor move re-pairing the
 * old machine), the Desk's verbs (`isDeskVerb`), and `role receive supervisor <bundle> --from
 * <name> [--local-terminal cmux|tmux] [--local-agents never] [--broker-url mqtt://127.0.0.1:<n>]`.
 */
export function isRoleRemoteVolley(a: readonly string[]): boolean {
  const [group, verb, ...rest] = a;
  if (group === "desk") return isDeskVerb(a.slice(1));
  if (group === "broker") return isBrokerRemote(a.slice(1));
  if (group === "peer" && verb === "retarget") {
    if (rest[0] !== "--to" || !SSH_TARGET.test(rest[1] ?? "")) return false;
    let i = 2;
    if (rest[i] === "--port" && isPortArg(rest[i + 1]) && Number(rest[i + 1]) >= 1024) i += 2;
    if (rest[i] === "--tunnel" && (rest[i + 1] === "ssh" || rest[i + 1] === "none")) i += 2;
    return i === rest.length;
  }
  if (group === "peer" && verb === "join")
    return (
      rest.length === 9 &&
      PAIRING_CODE.test(rest[0] ?? "") &&
      rest[1] === "--to" &&
      SSH_TARGET.test(rest[2] ?? "") &&
      rest[3] === "--name" &&
      AGENT_ID.test(rest[4] ?? "") &&
      rest[5] === "--target" &&
      SSH_TARGET.test(rest[6] ?? "") &&
      rest[7] === "--tunnel" &&
      rest[8] === "none"
    );
  if (group === "role" && verb === "receive") {
    if (rest[0] !== "supervisor" || !isBundlePath(rest[1] ?? "")) return false;
    if (rest[2] !== "--from" || !AGENT_ID.test(rest[3] ?? "")) return false;
    let i = 4;
    if (rest[i] === "--local-terminal" && (rest[i + 1] === "cmux" || rest[i + 1] === "tmux"))
      i += 2;
    if (rest[i] === "--local-agents" && rest[i + 1] === "never") i += 2;
    if (rest[i] === "--broker-url" && isTunnelBrokerUrl(rest[i + 1] ?? "")) i += 2;
    return i === rest.length;
  }
  return false;
}

/**
 * A broker move's volley steps on a paired machine (args after `broker`): `probe` (the target's
 * mosquitto), `receive <bundle> --lan | --no-lan | --check` (the bundle at
 * `<abs>/.volley/roles/broker/bundle.tgz`), `tunnel --show` (the tunnel a peer had).
 */
function isBrokerRemote(a: readonly string[]): boolean {
  const [verb, ...rest] = a;
  if (verb === "probe") return rest.length === 0;
  if (verb === "tunnel") return sameArgv(rest, ["--show"]);
  return (
    verb === "receive" &&
    rest.length === 2 &&
    isBundlePath(rest[0] ?? "") &&
    (rest[0] ?? "").endsWith("/.volley/roles/broker/bundle.tgz") &&
    (rest[1] === "--lan" || rest[1] === "--no-lan" || rest[1] === "--check")
  );
}

/**
 * The supervisor's own tunnel to the broker's new machine (args after `broker`): `tunnel --to
 * <dest> --port <n> --name <name> --broker-port <n>` and `tunnel --off`.
 */
function isOwnBrokerTunnel(a: readonly string[]): boolean {
  if (sameArgv(a, ["tunnel", "--off"])) return true;
  return (
    a.length === 9 &&
    a[0] === "tunnel" &&
    a[1] === "--to" &&
    SSH_TARGET.test(a[2] ?? "") &&
    a[3] === "--port" &&
    isPortArg(a[4]) &&
    a[5] === "--name" &&
    AGENT_ID.test(a[6] ?? "") &&
    a[7] === "--broker-port" &&
    isPortArg(a[8])
  );
}

/**
 * The broker here stopped or started through its layout, by a broker move (argv whole):
 * `brew services stop|start mosquitto`, `sudo -n snap stop|start mosquitto`, `sudo -n systemctl
 * stop|start mosquitto` (`-n`: never a password prompt; without a sudo rule it fails).
 */
function isBrokerService(argv: readonly string[]): boolean {
  const verbs = ["stop", "start"];
  return (
    (argv.length === 4 &&
      sameArgv(argv.slice(0, 2), ["brew", "services"]) &&
      verbs.includes(argv[2] ?? "") &&
      argv[3] === "mosquitto") ||
    (argv.length === 5 &&
      sameArgv(argv.slice(0, 2), ["sudo", "-n"]) &&
      (argv[2] === "snap" || argv[2] === "systemctl") &&
      verbs.includes(argv[3] ?? "") &&
      argv[4] === "mosquitto")
  );
}

/**
 * The ssh-back probe a supervisor move's plan runs on its target, once per other paired machine:
 * `ssh -n -o BatchMode=yes -o ConnectTimeout=<s> <dest> true` (args after `ssh`).
 */
function isSshBackProbe(a: readonly string[]): boolean {
  return (
    a.length === 7 &&
    a[0] === "-n" &&
    a[1] === "-o" &&
    a[2] === "BatchMode=yes" &&
    a[3] === "-o" &&
    /^ConnectTimeout=[1-9][0-9]?$/.test(a[4] ?? "") &&
    SSH_TARGET.test(a[5] ?? "") &&
    a[6] === "true"
  );
}

/** The Desk's launchd service, unloaded and reloaded by a Desk move here (args after launchctl). */
function isDeskLaunchctl(a: readonly string[]): boolean {
  const home = process.env.HOME ?? homedir();
  return (
    (a.length === 2 &&
      a[0] === "bootout" &&
      /^gui\/[0-9]+\/systems\.volley\.desk$/.test(a[1] ?? "")) ||
    (a.length === 3 &&
      a[0] === "bootstrap" &&
      /^gui\/[0-9]+$/.test(a[1] ?? "") &&
      a[2] === join(home, "Library", "LaunchAgents", `${DESK_SERVICE}.plist`))
  );
}

/**
 * systemd user units a role move stops and starts here: the Desk's (`stop` | `start`
 * volley-desk.service, a Desk move) and volleyd's own (`stop` | `start` volleyd.service, the
 * old supervisor unloading itself, or put back after a failed hand-over).
 */
function systemctl(args: string[]): Verdict {
  const ok =
    (args.length === 3 &&
      args[0] === "--user" &&
      (args[1] === "stop" || args[1] === "start") &&
      (args[2] === DESK_UNIT || args[2] === VOLLEYD_UNIT)) ||
    // A broker move rewrote volleyd's unit (its VOLLEY_BROKER_URL) for its next start.
    sameArgv(args, ["--user", "daemon-reload"]);
  return ok ? ALLOW : deny(`systemctl ${args.slice(0, 2).join(" ")}`.trim());
}

/**
 * `tar -czf <out>.tgz -C <dir> --files-from <list>`: a supervisor move's bundle (roles/bundle.ts),
 * every path absolute and clean. Never extracts (`-x`): the target's `volley role receive` does.
 */
function tar(args: string[]): Verdict {
  const ok =
    args.length === 6 &&
    args[0] === "-czf" &&
    absPath(args[1] ?? "") &&
    (args[1] ?? "").endsWith(".tgz") &&
    args[2] === "-C" &&
    absPath(args[3] ?? "") &&
    args[4] === "--files-from" &&
    absPath(args[5] ?? "");
  return ok ? ALLOW : deny(`tar ${args[0] ?? ""}`.trim());
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
/** An ssh destination the fence takes: `[user@]host`, never an option. */
export const isSshTarget = (s: string): boolean => SSH_TARGET.test(s);
/** `-R <remote port>:<host>:<port>`: no bind address, so the remote end stays on its loopback. */
const SSH_REVERSE = /^[0-9]{1,5}:[A-Za-z0-9_][A-Za-z0-9_.-]*:[0-9]{1,5}$/;
/** An absolute remote path: quoted when rendered; no newline (a heredoc delimiter could follow). */
const REMOTE_PATH = /^\/[^\n\r\0]*$/;
const BASE64 = /^[A-Za-z0-9+/=\n]*$/;
/** The only command a remote tmux session may run (renderLaunchScript's script). */
export const TMUX_LAUNCH_COMMAND = "bash .volley/launch.sh";
/** The window sizes volleyd gives a remote tmux session (`new-session -x/-y`, `resize-window`). */
export const TMUX_SIZE = { min: 20, max: 500 } as const;
/** A column or row count in `TMUX_SIZE`, in plain decimal (no sign, leading zero or exponent). */
const isTmuxSize = (v: string) =>
  /^[1-9][0-9]*$/.test(v) && Number(v) >= TMUX_SIZE.min && Number(v) <= TMUX_SIZE.max;
/**
 * A session as `resize-window` targets it: `=<session>:` (hosts/ssh-tmux.ts sessionName). Any
 * session name matches, a `volley-signin-*` terminal too; resizing one is only cosmetic.
 */
const AGENT_PANE = /^=[A-Za-z0-9_-]{1,128}:$/;

/** The verdicts for one `ssh` argv: the ssh form itself, then each remote step's. */
function sshVerdicts(args: readonly string[], opts: FenceOptions): Verdict[] {
  if (args.includes("-L")) return [forwardVerdict(args, opts)];
  // A broker move's plan: can this machine reach the broker's new address (the ssh-back shape).
  if (opts.remote === undefined && isSshBackProbe(args)) return [ALLOW];
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
/**
 * After `--json`, the doctor may be told the box's `volley_dir` (`--supervisor-volley-dir`, so
 * it checks every volley MCP entry against it): an absolute path, no `..` segment, no control
 * character.
 */
const SUPERVISOR_VOLLEY_DIR = "--supervisor-volley-dir";
const isVolleyDir = (p: string) =>
  p.startsWith("/") &&
  !p.split("/").includes("..") &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
  !/[\u0000-\u001f\u007f]/.test(p);
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

/** An adopted clone's path (`--repo-add`'s, `repo_probe`'s): absolute, no `..`, no control character. */
export const isRepoAddPath = (p: string): boolean => isVolleyDir(p);

/** `--repo-add`'s value: `<owner/name>`, or `<owner/name>=<abs path>` (an adopted clone). */
export const isRepoAdd = (v: string): boolean => {
  const i = v.indexOf("=");
  return i < 0 ? isSlug(v) : isSlug(v.slice(0, i)) && isRepoAddPath(v.slice(i + 1));
};

/**
 * The box's doctor (#435): `peer doctor --json`, then `--fix --yes` or not, then any number of
 * `--repo-add <owner/name>[=<abs path>]` / `--repo-remove <owner/name>`, then (under --fix, with
 * at least one add) `--clone`, which clones each added repository from its GitHub URL; or the
 * legacy single-repo shapes (REMOTE_DOCTOR, REMOTE_DOCTOR_CLONE).
 */
function isRemoteDoctor(rest: readonly string[]): boolean {
  if (REMOTE_DOCTOR.some((shape) => sameArgv(rest, shape))) return true;
  if (
    rest.length === 5 &&
    sameArgv(rest.slice(0, 3), REMOTE_DOCTOR[0] as readonly string[]) &&
    rest[3] === PROBE_LOGIN &&
    isLoginName(rest[4])
  )
    return true;
  if (
    rest.length === REMOTE_DOCTOR_CLONE.length + 1 &&
    sameArgv(rest.slice(0, -1), REMOTE_DOCTOR_CLONE) &&
    isCloneUrl(rest.at(-1) ?? "")
  ) {
    return true;
  }
  const fix = sameArgv(rest.slice(0, 5), REMOTE_DOCTOR[1] as readonly string[]);
  let i = fix ? 5 : 3;
  if (!fix && !sameArgv(rest.slice(0, 3), REMOTE_DOCTOR[0] as readonly string[])) return false;
  let adds = 0;
  let edits = 0;
  while (i + 1 < rest.length && (rest[i] === "--repo-add" || rest[i] === "--repo-remove")) {
    const v = rest[i + 1] as string;
    if (rest[i] === "--repo-add" ? !isRepoAdd(v) : !isSlug(v)) return false;
    if (rest[i] === "--repo-add") adds++;
    edits++;
    i += 2;
  }
  if (i === rest.length) return edits > 0;
  return fix && adds > 0 && i === rest.length - 1 && rest[i] === "--clone";
}

const REMOTE_VOLLEY_ARGS =
  "peer doctor --json [--supervisor-volley-dir <abs>] [--fix --yes] [--repo-add <owner/name>[=<abs>] | --repo-remove <owner/name>]... [--clone | --clone --origin <https URL>], peer doctor --json --probe-login <profile>, or a role move's step";

/**
 * The volley argv (after the CLI script) a paired machine runs: a role move's steps (SPEC
 * §4.6.24), peer_retarget's (§4.6.14), or the doctor.
 */
function remoteVolleyArgs(args: readonly string[]): boolean {
  if (isRoleRemoteVolley(args)) return true;
  const dir = args[3] === SUPERVISOR_VOLLEY_DIR ? (args[4] ?? "") : null;
  const rest = dir !== null ? [...args.slice(0, 3), ...args.slice(5)] : args;
  return (dir === null || isVolleyDir(dir)) && isRemoteDoctor(rest);
}

const remoteDeny = (v: Verdict): Verdict =>
  v.kind === "allow" ? v : { ...v, verb: `remote ${v.verb}` };

/** The remote login user's Claude Code config (bash -s starts in the home directory). */
export const REMOTE_CLAUDE_JSON = ".claude.json";
/** Where RemoteHost.recordTrust writes the new config before the compare-and-swap `mv`. */
export const REMOTE_CLAUDE_JSON_TMP = ".claude.json.volleyd.tmp";
/** The only argv that takes base64 on stdin without writing a file: the trust write's compare. */
const TRUST_COMPARE = ["cmp", "-s", "-", REMOTE_CLAUDE_JSON];
const TRUST_SWAP = ["mv", "-f", REMOTE_CLAUDE_JSON_TMP, REMOTE_CLAUDE_JSON];
/** The trust write's files in a profile the supervisor created on the box (absolute paths). */
const profileTrustFile = (path: string, name: string) =>
  path.endsWith(`/${name}`) && isRemoteProfileDir(path.slice(0, -(name.length + 1)));
/** A remote profile's `settings.json`, which its onboarding seed writes (RemoteHost.seedProfile). */
export const REMOTE_SETTINGS_JSON = "settings.json";
export const REMOTE_SETTINGS_JSON_TMP = "settings.json.volleyd.tmp";
/** The files a remote profile's compare-and-swap writes, each with its temp file. */
const PROFILE_SWAPS: readonly (readonly [string, string])[] = [
  [REMOTE_CLAUDE_JSON, REMOTE_CLAUDE_JSON_TMP],
  [REMOTE_SETTINGS_JSON, REMOTE_SETTINGS_JSON_TMP],
];
const isTrustCompare = (argv: readonly string[]) =>
  sameArgv(argv, TRUST_COMPARE) ||
  (sameArgv(argv.slice(0, 3), ["cmp", "-s", "-"]) &&
    argv.length === 4 &&
    PROFILE_SWAPS.some(([file]) => profileTrustFile(argv[3] as string, file)));
const isTrustSwap = (argv: readonly string[]) => {
  if (sameArgv(argv, TRUST_SWAP)) return true;
  const [mv, f, tmp, dst] = argv;
  return (
    argv.length === 4 &&
    mv === "mv" &&
    f === "-f" &&
    typeof tmp === "string" &&
    typeof dst === "string" &&
    PROFILE_SWAPS.some(
      ([file, temp]) =>
        profileTrustFile(dst, file) && tmp === `${dst.slice(0, -file.length)}${temp}`,
    )
  );
};
/** A remote profile's temp file for one of its compare-and-swap writes. */
const profileSwapTmp = (path: string) =>
  PROFILE_SWAPS.some(([, temp]) => profileTrustFile(path, temp));
const sameArgv = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The files volleyd writes in a worktree's `.volley/` (spawn.ts, pipeline.ts, identity.ts,
 * decisions.ts, retire.ts). fence-coverage.test.ts fails the build when one of those names a
 * file this set does not list.
 */
const VOLLEY_WRITES = new Set([
  "agent.json",
  "brief.md",
  "launch.sh",
  "mcp.json",
  "review.md",
  "findings.md",
  "findings.json",
  "rebase.md",
  "integrate.md",
  "decisions.md",
  "retired.json",
]);
/** … and the ones it reads there: those, and the repo's `.volley/brief-extra.md`. */
const VOLLEY_READS = new Set([...VOLLEY_WRITES, "brief-extra.md"]);

/**
 * True when the remote fence lets volleyd read or write `<dir>/.volley/<name>`
 * (fence-coverage.test.ts).
 */
export const fenceKnowsVolleyFile = (name: string): boolean => VOLLEY_READS.has(name);

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
    isBundlePath(path) ||
    profileSwapTmp(path) ||
    volleyPath(path, VOLLEY_WRITES, ["/ISSUE.md", "/info/exclude"])
  );
}

/** The files volleyd reads on a remote host (the brief, brief-extra, the exclude, the config). */
function readablePath(path: string): boolean {
  return (
    path === REMOTE_CLAUDE_JSON ||
    profileTrustFile(path, REMOTE_SETTINGS_JSON) ||
    volleyPath(path, VOLLEY_READS, ["/info/exclude"]) ||
    worktreeMcpJson(path)
  );
}

/** A worktree's own `.mcp.json` (the spawn's MCP approval check reads it): absolute, no `..`. */
function worktreeMcpJson(path: string): boolean {
  return absPath(path) && path.endsWith("/.mcp.json") && !path.split("/").includes("..");
}

/** One single-quoted bash word as `shq` renders it. */
const SHQ = "'(?:[^']|'\\\\'')*'";
const unshq = (q: string) => q.slice(1, -1).replace(/'\\''/g, "'");
const LAUNCH_EXPORT = new RegExp(`^export ([A-Z0-9_]+)=(${SHQ})$`);
const LAUNCH_HOOKS = new RegExp(`^export VOLLEY_HOOKS_DIR=(${SHQ})$`);
const LAUNCH_PROFILE = new RegExp(`^export CLAUDE_CONFIG_DIR=(${SHQ})$`);
/** The auto-compact window: a plain token count, never suffixed (`850k`) or signed. */
const LAUNCH_COMPACT = /^export CLAUDE_CODE_AUTO_COMPACT_WINDOW='([1-9][0-9]{5,6})'$/;
const LAUNCH_EXEC = new RegExp(
  `^exec claude .* --model (${SHQ}) --settings ${SHQ}( --strict-mcp-config)? --mcp-config=(${SHQ}) --name (${SHQ}) -- `,
);
/** What a `.volley/mcp.json` may run: some checkout's volley-mcp entry point. */
const MCP_ENTRY_SUFFIX = "/packages/volley-mcp/src/index.ts";
/** A remote host's launch.sh exports, in order: exactly what SshTmuxHost.launchEnv emits. */
const LAUNCH_ENV_KEYS = ["VOLLEY_BROKER_URL", "VOLLEY_NAMESPACE", "VOLLEY_AGENT_ID"];
/** The broker as a remote agent sees it: the reverse tunnel's end on the box's loopback. */
function isTunnelBrokerUrl(url: string): boolean {
  const m = /^mqtt:\/\/127\.0\.0\.1:([0-9]+)$/.exec(url);
  return m !== null && isPortArg(m[1]);
}

/**
 * The env block: none (local), or exactly the three keys for this agent through the tunnel; on a
 * host whose broker port is known, `VOLLEY_BROKER_URL` names exactly that port.
 */
function launchEnvAllowed(
  env: Record<string, string>,
  agentId: string,
  host?: ProfileHost,
): boolean {
  const keys = Object.keys(env);
  if (keys.length === 0) return true;
  const url = env.VOLLEY_BROKER_URL ?? "";
  return (
    keys.length === LAUNCH_ENV_KEYS.length &&
    keys.every((k, i) => k === LAUNCH_ENV_KEYS[i]) &&
    isTunnelBrokerUrl(url) &&
    (host?.broker_port === undefined || url === `mqtt://127.0.0.1:${host.broker_port}`) &&
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
 * A paired machine's launch script's `CLAUDE_CONFIG_DIR`: `<home>/.volley/claude/<id>`
 * (REMOTE_PROFILE_DIR) and exactly the `dir` the supervisor's registry recorded at sign-in for a
 * signed-in profile `<id>` kept on `host`, for a worktree under that host's `worktree_root` (and
 * neither inside the other). Nothing on this machine is consulted beyond the registry.
 */
function remoteProfileDirAllowed(dir: string, worktree: string, host: ProfileHost): boolean {
  try {
    if (host.name === "local" || !isRemoteProfileDir(dir)) return false;
    const root = host.worktree_root.replace(/(.)\/+$/, "$1");
    if (!absPath(root) || !absPath(worktree) || worktree === root || !within(worktree, root))
      return false;
    if (within(dir, worktree) || within(worktree, dir)) return false;
    const id = basename(dir);
    return readRegistry(canonicalRoot(claudeRoot())).accounts.some(
      (a) =>
        a.id === id && a.machine === host.name && a.dir === dir && a.signed_in_at !== undefined,
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
 * `profileDirAllowed`, with its credential env unset), optional auto-compact window (the line
 * after the profile block: an integer in Claude Code's 100000..1000000) and `worktree` — so
 * `--mcp-config=` names exactly `<worktree>/.volley/mcp.json` (with `--strict-mcp-config`, or
 * without it under `agent_mcp: inherit`, and `--` before the prompt). Parsed back into its
 * values and re-rendered, so not one byte can differ from a script volleyd writes.
 */
function isLaunchScript(content: string, worktree: string, host?: ProfileHost): boolean {
  const lines = content.split("\n");
  const hooks = LAUNCH_HOOKS.exec(lines[4] ?? "");
  const run = LAUNCH_EXEC.exec(lines.at(-2) ?? "");
  if (hooks === null || run === null) return false;
  if (!absPath(worktree) || unshq(run[3] as string) !== mcpConfigPath(worktree)) return false;
  // A Claude account profile: its CLAUDE_CONFIG_DIR export (re-rendered below with its unset).
  const profile = LAUNCH_PROFILE.exec(lines[5] ?? "");
  const claudeConfigDir = profile !== null ? unshq(profile[1] as string) : undefined;
  const at = profile !== null ? 7 : 5;
  const compact = LAUNCH_COMPACT.exec(lines[at] ?? "");
  const autoCompactWindow = compact !== null ? Number(compact[1]) : undefined;
  // `agent_mcp: inherit` (the user's MCP servers load too) renders no --strict-mcp-config.
  const strict = run[2] !== undefined;
  const env: Record<string, string> = {};
  // The exports end before launch.sh's `unset VOLLEY_COORDINATOR` and claude check.
  for (const line of lines.slice(compact !== null ? at + 1 : at, -4)) {
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
    ...(autoCompactWindow !== undefined ? { autoCompactWindow } : {}),
  };
  return (
    (claudeConfigDir === undefined ||
      (host === undefined
        ? profileDirAllowed(claudeConfigDir, worktree)
        : remoteProfileDirAllowed(claudeConfigDir, worktree, host))) &&
    (autoCompactWindow === undefined ||
      (autoCompactWindow >= COMPACT_MIN && autoCompactWindow <= COMPACT_MAX)) &&
    outsideVolley(vars.hooksDir) &&
    MODEL_ID.test(vars.model) &&
    AGENT_ID.test(vars.agentId) &&
    launchEnvAllowed(env, vars.agentId, host) &&
    renderLaunchScript(vars) === content
  );
}

/**
 * MCP_CONFIG: whether `content` is exactly `renderMcpConfig` of an absolute, clean volley-mcp
 * entry point outside any `.volley/` (claude runs that server for the agent), plus, after it, the
 * entries `agent_mcp_allow` copied from the machine's own MCP config. Those are checked for shape
 * only: the fence does not bound their `command` (nor check it came from the box's config), as
 * claude would start the same entry under `agent_mcp: inherit` anyway.
 */
function isMcpConfig(content: string): boolean {
  let entry: unknown;
  let extra: Record<string, unknown>;
  try {
    const { volley, ...rest } = JSON.parse(content)?.mcpServers ?? {};
    entry = volley?.args?.[1];
    extra = rest;
  } catch {
    return false;
  }
  return (
    typeof entry === "string" &&
    entry.endsWith(MCP_ENTRY_SUFFIX) &&
    outsideVolley(entry) &&
    Object.values(extra).every(isMcpServerEntry) &&
    renderMcpConfig(entry, extra) === content
  );
}

/** A write to a `.volley/launch.sh`: the file a tmux session's TMUX_LAUNCH_COMMAND runs. */
const isLaunchScriptPath = (path: string) => path.endsWith("/.volley/launch.sh");
/** A write to a `.volley/mcp.json`: the MCP servers claude starts for the agent. */
const isMcpConfigPath = (path: string) => path.endsWith("/.volley/mcp.json");

function remoteStep(step: RemoteStep, opts: FenceOptions): Verdict {
  if (step.cwd !== undefined && !REMOTE_PATH.test(step.cwd))
    return deny("remote cwd (not absolute)");
  if (step.env !== undefined) return remoteProfileStatus(step);
  const [prog, ...args] = step.argv;
  const io = step.stdin !== undefined || step.stdout !== undefined || step.append === true;
  if (io) {
    const b64 = step.stdin !== undefined && BASE64.test(step.stdin);
    if (isTrustCompare(step.argv) && step.stdout === undefined && step.append !== true)
      return b64 ? ALLOW : deny("remote cmp (base64 text on stdin only)");
    const coordinator = step.stdout !== undefined ? coordinatorFile(step.stdout, opts) : null;
    if (coordinator !== null) {
      return sameArgv(step.argv, ["base64", "-d"]) &&
        b64 &&
        step.append !== true &&
        coordinator.ok(Buffer.from(step.stdin ?? "", "base64").toString("utf-8"))
        ? ALLOW
        : deny(`remote ${coordinator.name} write (only what volleyd renders for the coordinator)`);
    }
    const signin = step.stdout !== undefined ? remoteSigninFile(step.stdout) : null;
    if (signin !== null) {
      return sameArgv(step.argv, ["base64", "-d"]) &&
        b64 &&
        step.append !== true &&
        signin.contents.includes(Buffer.from(step.stdin ?? "", "base64").toString("utf-8"))
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
      (step.append !== true ||
        (step.stdout !== REMOTE_CLAUDE_JSON_TMP && !profileSwapTmp(step.stdout)));
    if (!write)
      return deny("remote file write (base64 -d of base64 text to a file volleyd writes only)");
    const path = step.stdout ?? "";
    const content = () => Buffer.from(step.stdin ?? "", "base64").toString("utf-8");
    if (isLaunchScriptPath(path)) {
      const worktree = path.slice(0, -"/.volley/launch.sh".length);
      if (step.append === true || !isLaunchScript(content(), worktree, opts.remote?.host))
        return deny("remote launch.sh write (only a script renderLaunchScript renders)");
    }
    if (isMcpConfigPath(path) && (step.append === true || !isMcpConfig(content())))
      return deny("remote mcp.json write (only an mcp.json renderMcpConfig renders)");
    return ALLOW;
  }
  if (isTrustSwap(step.argv)) return ALLOW;
  return remoteDeny(remoteCommand(prog, args, opts));
}

/**
 * The one step with an env: `CLAUDE_CONFIG_DIR=<home>/.volley/claude/<acct> claude auth status`,
 * a remote profile's login state and plan (remote-signin.ts). No other key, value or argv.
 */
function remoteProfileStatus(step: RemoteStep): Verdict {
  const env = step.env as Record<string, unknown>;
  const keys = Object.keys(env);
  const dir = env.CLAUDE_CONFIG_DIR;
  return keys.length === 1 &&
    typeof dir === "string" &&
    isRemoteProfileDir(dir) &&
    sameArgv(step.argv, ["claude", "auth", "status"]) &&
    step.stdin === undefined &&
    step.stdout === undefined &&
    step.append === undefined
    ? ALLOW
    : deny("remote env (only CLAUDE_CONFIG_DIR=<home>/.volley/claude/<acct> claude auth status)");
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
      // on a remote box; merges, workflow runs and deletes stay denied (no tokens: a merge is
      // never authorized on a paired machine).
      // The issue lifecycle's writes run on the supervisor's own machine only.
      if (args[0] === "api") return deny("gh api (not on a remote machine)");
      return issueLifecycle(args) !== null
        ? deny(`gh ${args.slice(0, 2).join(" ")} (not on a remote machine)`)
        : gh(args, {});
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
      // Three digits: no setuid, setgid or sticky bit; only on the files volleyd writes, and 700
      // on a remote profile dir (the only directory).
      return /^[0-7]{3}$/.test(args[0] ?? "") &&
        paths(args.slice(1)) &&
        args
          .slice(1)
          .every(
            (a) =>
              writablePath(a) ||
              isSigninScriptFile(a) ||
              coordinatorFile(a, opts) !== null ||
              (args[0] === "700" && isRemoteProfileDir(a)),
          )
        ? ALLOW
        : deny("chmod (only <3 octal digits> <a file volleyd writes>…)");
    case "rm": {
      const t = opts.profileRemove;
      return t !== undefined &&
        profileRemovals.has(t) &&
        isRemoteProfileDir(t.dir) &&
        sameArgv(args, ["-rf", t.dir])
        ? ALLOW
        : deny("rm -rf (only <home>/.volley/claude/<acct>, with its removal token)");
    }
    case "ln":
      return coordinatorLink(args, opts)
        ? ALLOW
        : deny("ln (only -sfn <abs> <coordinator dir>/repos/<owner>/<name>, with its token)");
    case "printenv":
      // The PATH an ssh session gets on the box, for its tmux server (SshTmuxHost.launch), and
      // its HOME, where a sign-in's dir is (remote-signin.ts).
      return sameArgv(args, ["PATH"]) || sameArgv(args, ["HOME"])
        ? ALLOW
        : deny("printenv (only PATH or HOME)");
    case "claude":
      // The box's login state and plan (remote-signin.ts); a login runs only from signin.sh.
      return sameArgv(args, ["auth", "status"]) ? ALLOW : deny("claude (only auth status)");
    case "curl":
      return entryCurl(args, opts);
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
    case "ssh":
      return isSshBackProbe(args)
        ? ALLOW
        : deny("ssh (only -n -o BatchMode=yes -o ConnectTimeout=<s> <dest> true)");
    case "bun": {
      // The box's own checkout (remoteVolleyArgv), never a bare `volley` from its PATH (#550).
      const dir = opts.remote?.host?.volley_dir;
      const [script, ...rest] = args;
      return dir !== undefined &&
        isVolleyDir(dir) &&
        script === volleyCliPath(dir) &&
        remoteVolleyArgs(rest)
        ? ALLOW
        : deny(`bun (only <volley_dir>/packages/volley-cli/src/cli.ts ${REMOTE_VOLLEY_ARGS})`);
    }
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
    valued: ["-s", "-c", "-x", "-y"],
    values: { "-x": isTmuxSize, "-y": isTmuxSize },
    positional: (a) => a === TMUX_LAUNCH_COMMAND,
  },
  "capture-pane": { flags: ["-p", "-J"], valued: ["-t", "-S", "-E"] },
  "has-session": { valued: ["-t"] },
};

function tmux(args: string[], opts: FenceOptions): Verdict {
  const [sub, ...rest] = args;
  if (sub === undefined || sub.startsWith("-")) return deny(`tmux ${sub ?? ""}`.trim());
  const coordinator = coordinatorTmux(sub, rest, opts);
  if (coordinator !== null) return coordinator;
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
    if (tail.length === 1 && keyAllowed(tail[0] ?? "", opts)) return ALLOW;
    if (tail.length !== 3 || tail[0] !== "-l" || tail[1] !== "--") return deny("tmux send-keys");
    if (entryAllows(opts, (e) => e.session === target && e.code === tail[2])) return ALLOW;
    const why = typedTextRefusal(tail[2] ?? "", opts);
    return why === null ? ALLOW : deny(`tmux send-keys (${why})`);
  }
  if (sub === "resize-window") {
    // The Desk's Terminal popout size (#403): exactly `-t =<session>: -x <n> -y <n>`.
    const [t, target, x, cols, y, rows, ...more] = rest;
    return t === "-t" &&
      AGENT_PANE.test(target ?? "") &&
      x === "-x" &&
      isTmuxSize(cols ?? "") &&
      y === "-y" &&
      isTmuxSize(rows ?? "") &&
      more.length === 0
      ? ALLOW
      : deny(
          `tmux resize-window (only -t =<session>: -x <n> -y <n>, n ${TMUX_SIZE.min}..${TMUX_SIZE.max})`,
        );
  }
  if (sub === "new-session" && rest.at(-1) === SIGNIN_COMMAND)
    return remoteSigninSession(rest, opts);
  const spec = Object.hasOwn(TMUX_SPECS, sub) ? TMUX_SPECS[sub] : undefined;
  if (spec === undefined) return deny(`tmux ${sub}`);
  const v = checkArgs(`tmux ${sub}`, rest, spec);
  return v.kind === "allow" && sub === "new-session" ? newSessionSealed(rest, opts) : v;
}

/**
 * A local agent's tmux session (hosts/local-tmux.ts `localSessionName`):
 * `volley-<wave>-<task>-<role>[-<n>]`, at least three words after `volley-`. A sign-in's
 * `volley-signin-*` and the coordinator's `volley-coordinator-*` never are one, so a wave named
 * `signin`, `coordinator` or `coordinator-…` cannot run in local tmux.
 */
const AGENT_SESSION = /^volley-[a-z0-9][A-Za-z0-9_-]*-[A-Za-z0-9_]+-[A-Za-z0-9_]+$/;
const isAgentSession = (s: string | undefined): s is string =>
  s !== undefined &&
  s.length <= 200 &&
  AGENT_SESSION.test(s) &&
  !s.startsWith("volley-signin-") &&
  !s.startsWith("volley-coordinator-");
/** `capture-pane -S-<n>`: the last n lines (hosts/local-tmux.ts readScreen). */
const CAPTURE_START = /^-S-[1-9][0-9]{0,4}$/;

/**
 * Local tmux: agents' sessions under `fleet.local_terminal: tmux` (`localAgentTmux`), and Claude
 * account sign-in sessions (`volley-signin-<acct>`). A remote host's tmux is the REMOTE policy
 * (`tmux` above).
 */
function localTmux(args: string[], opts: FenceOptions): Verdict {
  const [sub, ...rest] = args;
  const coordinator = coordinatorTmux(sub, rest, opts);
  if (coordinator !== null) return coordinator;
  const agent = localAgentTmux(sub, rest, opts);
  if (agent !== null) return agent;
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
    case "send-keys": {
      // A sign-in waiting at `Paste code here`: Enter, and the pasted code with its token.
      const [t, s, ...tail] = rest;
      if (t !== "-t" || !SIGNIN_SESSION.test(s ?? "")) return deny(verb);
      if (sameArgv(tail, ["Enter"])) return ALLOW;
      return tail.length === 3 &&
        tail[0] === "-l" &&
        tail[1] === "--" &&
        entryAllows(opts, (e) => e.session === s && e.code === tail[2])
        ? ALLOW
        : deny("tmux send-keys (only a sign-in's pasted code, with its token)");
    }
    default:
      return deny(verb);
  }
}

/**
 * Local tmux for an agent session (AGENT_SESSION), each in exactly the shape LocalTmuxHost sends;
 * null when the command does not target one, for the sign-in rules to judge.
 */
function localAgentTmux(
  sub: string | undefined,
  rest: string[],
  opts: FenceOptions,
): Verdict | null {
  const session = (t: string | undefined) =>
    t?.startsWith("=") === true && isAgentSession(t.slice(1));
  const pane = (t: string | undefined) =>
    t?.startsWith("=") === true && t.endsWith(":") && isAgentSession(t.slice(1, -1));
  const verb = `tmux ${sub ?? ""}`.trim();
  switch (sub) {
    case "new-session": {
      if (rest.at(-1) !== TMUX_LAUNCH_COMMAND) return null;
      const sized = rest[1] === "-x";
      const [d, x, cols, y, rows] = rest;
      const [s, name, c, cwd, cmd, ...more] = rest.slice(sized ? 5 : 1);
      if (!isAgentSession(name)) return null;
      return d === "-d" &&
        (!sized ||
          (x === "-x" && isTmuxSize(cols ?? "") && y === "-y" && isTmuxSize(rows ?? ""))) &&
        s === "-s" &&
        c === "-c" &&
        cwd !== undefined &&
        cmd === TMUX_LAUNCH_COMMAND &&
        more.length === 0 &&
        sealedFor(opts, cwd)
        ? ALLOW
        : deny("tmux new-session (only in the worktree of a sealed launch script)");
    }
    case "has-session":
    case "kill-session": {
      if (!session(rest[1])) return null;
      if (!sameArgv(rest, ["-t", rest[1] ?? ""])) return deny(verb);
      return sub === "has-session" ? ALLOW : { kind: "consent", verb };
    }
    case "capture-pane": {
      const j = rest[1] === "-J" ? 1 : 0;
      const [p, t, target, start, ...more] = [rest[0], ...rest.slice(1 + j)];
      if (!pane(target)) return null;
      return p === "-p" && t === "-t" && CAPTURE_START.test(start ?? "") && more.length === 0
        ? ALLOW
        : deny(verb);
    }
    case "resize-window": {
      const [t, target, x, cols, y, rows, ...more] = rest;
      if (!pane(target)) return null;
      return t === "-t" &&
        x === "-x" &&
        isTmuxSize(cols ?? "") &&
        y === "-y" &&
        isTmuxSize(rows ?? "") &&
        more.length === 0
        ? ALLOW
        : deny(verb);
    }
    case "send-keys": {
      // As on a paired machine: a named (or picker) key, or TYPED_TEXT with its token.
      const [t, target, ...tail] = rest;
      if (t !== "-t" || !pane(target)) return null;
      if (tail.length === 1 && keyAllowed(tail[0] ?? "", opts)) return ALLOW;
      if (tail.length !== 3 || tail[0] !== "-l" || tail[1] !== "--") return deny(verb);
      const why = typedTextRefusal(tail[2] ?? "", opts);
      return why === null ? ALLOW : deny(`tmux send-keys (${why})`);
    }
    default:
      return null;
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
 * the worktree of a sealed launch script (tmux keeps the last `-c`, so does this). A launch size
 * is a pair: `-x` and `-y` together or neither.
 */
function newSessionSealed(args: readonly string[], opts: FenceOptions): Verdict {
  let cwd: string | undefined;
  const size = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-c") cwd = args[++i];
    else if (a.startsWith("-c")) cwd = a.slice(2);
    else if (a.startsWith("-x") || a.startsWith("-y")) {
      size.add(a.slice(0, 2));
      if (a.length === 2) i++;
    } else if (a === "-s") i++;
  }
  return args.at(-1) === TMUX_LAUNCH_COMMAND &&
    size.size !== 1 &&
    cwd !== undefined &&
    sealedFor(opts, cwd)
    ? ALLOW
    : deny("tmux new-session (only in the worktree of a sealed launch script)");
}

/**
 * The bash script for `ssh -T <target> bash -s`: `set -euo pipefail`, then one line per step,
 * every word single-quoted (so no path or value is ever shell syntax). A step with a `cwd` runs
 * in a subshell that `cd`s first; a file write runs `base64 -d` under `umask 077` from a quoted
 * heredoc (base64 text cannot contain its delimiter), into a file it first removes and then
 * creates under `set -C` (an append excepted), so the content never lands at an existing file's
 * looser mode or through a symlink. The trust compare is fed the same way, through `base64 -d |`. Every other step reads /dev/null: under `bash -s` a step that read its
 * stdin would consume the rest of the script.
 */
export function renderRemoteScript(script: RemoteScript): string {
  const lines = ["set -euo pipefail"];
  const heredoc = (s: RemoteStep) => `<<'VOLLEY_EOF'\n${s.stdin ?? ""}\nVOLLEY_EOF`;
  for (const s of script.steps) {
    const env = s.env !== undefined ? `CLAUDE_CONFIG_DIR=${shq(s.env.CLAUDE_CONFIG_DIR)} ` : "";
    const cmd = env + s.argv.map(shq).join(" ");
    if (s.stdout !== undefined) {
      // A whole write removes the file first, so it is created afresh under the umask: an
      // overwrite never keeps an earlier, looser mode while the new content lands. Noclobber
      // makes the create exclusive, so a symlink planted after the rm is refused, not followed.
      const out = shq(s.stdout);
      const write =
        s.append === true ? `${cmd} >> ${out}` : `set -C && 'rm' '-f' ${out} && ${cmd} > ${out}`;
      lines.push(`( umask 077 && ${write} ${heredoc(s)}\n)`);
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
