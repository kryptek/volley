# Changelog

All workspace packages share one version. Dates are release-tag dates.

## 0.6.1 — 2026-10-22

### Fixed

- **volleyd: a paired machine starts agents again.** Since 0.6.0 the spawn's MCP approval check reads the worktree's `.mcp.json`; the remote fence denied that `cat`, so every launch on a paired machine failed as an ssh error (`no result`). The fence now allows reading an absolute `<dir>/.mcp.json` with no `..` segment. (#393)

## 0.6.0 — 2026-10-22

### Added

- **volleyd, volley-cli: every machine reports which Claude account its logins belong to.** A
  login's `email` and `org` — exactly `oauthAccount.emailAddress` and
  `oauthAccount.organizationName` from the profile's `.claude.json`, nothing else of it — are
  stored in the registry at sign-in and carried on `claude_signin_done`, each `claude_accounts`
  row, `primary`, the new `machines` list, the retained usage record
  (`volley/_system/claude-accounts/<acct>`, `primary@<name>` from the machine record) and the
  machine record (`auth.claude_email` / `auth.claude_org`, from `volley peer doctor`, only while
  signed in). They are identity, never credentials, and never journaled; the schemas and SPEC
  §4.6.11, §4.6.12 and §4.6.15 say so. (#281)
- **volley-desk: Settings › Claude accounts & usage shows one card per Anthropic account.** Logins
  on every machine that share an e-mail (a peer's default login through its machine record's
  `auth.claude_email`) are one card: the e-mail masked (`o•••@example.com`) until its eye button
  shows it (never stored), the organisation, the meters from the freshest reading with any older
  reading that disagrees named stale with its age, and one row per machine holding the account
  (signed in or not, the profile there, its waves). A login whose e-mail is not reported yet keeps
  its own card; pickers and "Move a wave here…" still answer with account ids. (#282)
- **volleyd: `volley claude add <label> --machine <peer>` creates a Claude profile on a paired
  machine and signs it in there.** The profile is `~/.volley/claude/<acct>` on that machine, the
  account `<acct>@<peer>`: Claude Code's own `claude auth login` runs there in the tmux session
  `volley-signin-<acct>`, with the browser callback forwarded to the supervisor's machine, as a
  paired machine's own sign-in does. `claude_signin_done` carries the plan, e-mail and org, which
  the registry records; `claude_accounts` shows the row pending, then signed in. `volley claude
  signin <acct>@<peer>` refuses a profile already signed in there and names the
  `ssh <target> CLAUDE_CONFIG_DIR=… claude auth logout` to run first. The fence lets
  `claude auth status` carry exactly `CLAUDE_CONFIG_DIR=<home>/.volley/claude/<acct>` and nothing
  else. Such a profile is signed in and shown, not yet used by placement. (#283)
- **volley-desk: Add Claude account signs a profile in on any paired machine.** The dialog's first
  step picks the machine (this machine, or a paired host whose tunnel is up); on a peer it shows the
  same **Open sign-in ↗** and phone steps as Settings › Machines, never a code field, and the
  "run `volley claude add` there" hint is gone. Each account card has **Add to another machine…**,
  which opens the dialog with the label filled in as `<label> (<machine>)` (volleyd names a profile
  once across machines; this machine goes by its host name), following the machine you pick until
  you type your own, and the machines already holding the account greyed out. A paired host that
  has reported nothing yet is offered with "no record yet". (#284)
- **volley-desk: each account card shows every configured machine, and signs the account in on the
  ones missing it.** One row per machine (this machine, then each paired host): a filled dot and the
  profile where it holds the account, a hollow dot and **Sign in on <machine>** where it does not
  (disabled with "tunnel down" while the tunnel is down), with an `on 2 of 3 machines` chip, amber
  while one is missing. The button opens the Add dialog already at the sign-in step, titled with the
  masked account (`Sign in with o•••@example.com on peer-a`); a sign-in that finishes on another
  e-mail says `signed in as another account (p•••@example.com)` instead of filling the row. The new
  profile is named `<label> (<machine>)`, keeping one machine suffix (`Work (peer-a)` signs in on
  peer-b as `Work (peer-b)`). Each
  card in Settings › Machines gains a **Claude accounts** block with the same dots and button. (#297)
- **volley-cli: `volley claude list` prints `not on: peer-b`** under an account that a configured
  machine does not hold, and nothing when every machine does. (#297)
- **volley-desk + volley-cli: three usage meters per Claude account, Fable's weekly window
  included, each with the reading's age.** An account card in Settings › Claude accounts shows
  5-hour, 7-day and Fable (7-day) side by side. The Fable figure is the one the machine's usage
  probe last read, labelled `read 4 min ago on peer-a`. While the probe's last attempt failed, it
  reads `—` and says why (login expired, no credential, rate limited, probe failed), with when it
  last read. Every machine row on the card, and each held account on a Settings › Machines card
  (where it replaces the single 5-hour meter), shows the three figures compactly
  (`5h 37% · 7d 56% · Fable 12%`), plus `sampled 3 h ago` when that machine's own reading is
  older. `volley claude list` prints the same three windows on one line, for example
  `Fable 12% (resets in 4d 2h, read 4 min ago)` or `Fable — (login expired, last read 25 min ago)`,
  with the freshest machine on the line below it. A window whose reset has passed counts as 0%. (#298)
- **volley-desk: each agent's Claude account, why it was chosen, and autopilot's moves.** The
  agent window's account picker lists only the accounts of the agent's own machine, labelled
  `Work · 12% · peer-a`, with a tooltip saying why it runs there (the task role's latest
  `account_chosen`, or `moved off primary by autopilot: <why>` / `moved by <person>`); its
  Volley feed shows `Account ·` rows for those events; and an open `agent_account_limit` is a
  banner on the agent (what autopilot will do, or `Move to work (5h 12%, 7d 40%)` / Not now). Settings › Claude accounts
  renders the agent-level decision beside the wave-level one (`move to work (5h 12%, 7d 40%)`,
  `not now`) and, from `claude_balance`, says on each card which model families pick it next
  (`picks next: Fable, others`) and marks the machine rows that would (`next pick`). (#300)
- **volley-cli: `volley claude balance` shows what the next spawn would pick.** Per machine, the
  signed-in accounts ranked by headroom with their 5-hour, 7-day and Fable figures and agents,
  and an arrow on each model family's pick (`--model <m>` for one model, `--machine <name>` for
  one machine, `--json` for volleyd's answer; e-mails masked unless `--show-email`).
  An account with no reading yet shows `no usage yet` and still its agent count.
  `volley claude list` marks `next pick` on those logins (asking volleyd for at most 3 s). (#300)
- **volley-cli + volleyd: each machine reads its own Claude logins' usage, Fable's weekly window
  included.** `volley peer doctor` probes every Claude Code login on the machine (the default
  profile and each profile under `~/.volley/claude`). It reads the login's own stored token in
  memory, for one read-only request to Claude's usage endpoint, and reports only the 5-hour,
  7-day and per-model weekly windows in the machine record's `claude_logins` and in one
  `Claude usage:` line per login. The token is never refreshed, written, logged or sent, and
  never crosses ssh or the broker. An expired token is skipped, and the probe makes at most one
  request per login per 5 minutes, backing off after 429 or 5xx. volleyd folds the readings into
  the retained account records (`primary@<name>` / `<id>@<name>` for a paired machine's logins)
  as `model_weekly` and `probe`. A reading and a statusLine sample race for the 5-hour and
  weekly windows, and the freshest wins. SPEC §4.6.11 now allows this one read, and says why.
  (#306)
- **volleyd: a wave without `placement:` uses a paired machine.** The new tunable
  `placement.default` (`local` | `auto`, default `auto`) decides a wave file that sets no
  `placement:`: `auto` once a `hosts.<name>` is configured, `local` while none is; an explicit
  `placement:` is unchanged, and a later plan version of a running wave keeps the placement the
  wave already has, whatever its own `config: placement.default` says (its `run` prints no placement preview then). `volleyd validate` and `run` print the outcome
  (`placement: auto (placement.default; 1 paired machine)`, `placement: local (no paired machine)`). (#324)
- **volleyd: a paired machine's `max_agents` is derived from its size.** `volley peer join` sends
  the machine's total memory (when it can read it), and the join writes `hosts.<name>.max_agents =
  clamp(min(floor(cores / 3), floor(memory_total_mb / 4096)), 2, 16)` (a 32-core / 60 GB box: 10);
  unset, readiness derives it the same way from the machine record, and 4 applies only when the
  size is unknown. An explicit value always wins. `volley peer doctor` shows it on a new
  `machine.size` row (`max_agents 10 (derived from 32 cores, 60 GB)`). (#324)
- **volleyd: a local wave on an overloaded supervisor says what it leaves unused.** When the
  supervisor's load per core is over `placement.load_per_core_max` (the wave's own, when its
  `config:` sets one) while a ready, undrained peer
  has free slots, a running `placement: local` wave raises `alarm_raised { alarm:
  "peer_idle_under_load" }` once, and clears it (`alarm_cleared`) when the load has passed; while it
  holds, the wave state's new `alarms`, `volleyd status` and the digest show it. (#324)
- volley-issues: `wave-from-issues.ts --placement local|auto` pins a wave's placement. (#324)
- **volley-desk: demo mode shows autopilot, the Needs-you inbox, the digest and live machines.**
  `?demo=1` now loads the autopilot waves (chip, feed, merge queue, release train), the Needs-you
  inbox with its Dock tile, an ended wave with its morning digest card and, after 40 s, a running
  wave's morning digest. The Machines window's load and memory sparklines move: the machines beat
  every 5 s with a load walk, and box-a swells into its overload band and back. (#326)
- **volley-desk: sign out and switch account from Settings and the Dock.** Settings' account
  card and the Dock's new account menu (the avatar) offer **Sign out**, which forgets the stored
  login and its role and shows the sign-in form, and **Switch account…**, which redeems a
  sign-in link or one-time token over the running Desk and reconnects as the new account
  without a reload. Every read-only notice (Machines, Broker accounts, Supervisor, the
  Autopilot policy table) links to **Switch to an admin account**, and Setup & Security's
  admin-token sign-in uses the same entry. A Desk signed in by `VITE_VOLLEY_BROKER_*` says so and
  offers neither. (#328)
- **volleyd: `agent_mcp_allow` starts only the MCP servers a repository names under
  `agent_mcp: inherit`.** `inherit` alone starts every server in the owner's profile in every agent
  (one process each). A non-empty list (global or in a wave's `config:`) copies just those entries
  from the profile's `.claude.json` and the repository's `.mcp.json` (a paired machine's own) into
  the agent's `.volley/mcp.json` beside `volley` and launches it strict; a `.mcp.json` entry only
  when the profile approved it for the repository (`enabledMcpjsonServers` /
  `enableAllProjectMcpServers` in its `.claude.json`), since the file comes from the branch checked out. A name found nowhere is
  skipped and journaled once per wave and machine (`agent_mcp_allow_missing`, saying when the name is in `.mcp.json`
  but not approved); so is an entry of a shape volleyd does not copy (a string `command` with
  string `args` and `env`, or a string `url` with string `headers`), the same on every machine,
  and a broader scope's entry of that name is not used in its place.
  Only names are ever logged, and the agent's `mcp.json` is written owner-only (0600, on a paired
  machine too: a file volleyd writes there is replaced, never left at an older file's mode), since
  the copied entries can hold the user's tokens.
  `volleyd validate` prints `agent_mcp: inherit (allow: …)`, and the Desk's settings edit the list.
  (#331)
- **volleyd, volley-desk: held decisions: "waiting on <task|PR|issue>", never escalated,
  released when the blocker lands.** `volleyd hold <decision-id> --on <task|#pr|issue#n>`,
  `volleyd inbox hold`, and the Desk's **Hold · waiting on…** picker on a Needs-you row journal
  `decision_held`; a hold on a task that waits on the held decision's own task (through
  `after:` or a hold of its own) is refused, as it would never release; the decision and its inbox item carry `held`, and the Desk shows the item
  amber (`Held · waiting on T4 (#194) · 3 h`), never red, never pulsing. volleyd releases the
  hold (`decision_released`) when the task is done or cancelled, the PR merged or closed, or the
  issue closed (a PR or issue read once per CI poll interval), and autopilot's rule runs again,
  a red head's once its PR head is read again (green now: answered `re-verify`); `volleyd
  release` lifts one by hand. Autopilot holds a red head on its flake's fixer task itself, and
  lifts that hold when the fixer fails so the escalation reaches the owner (a hold the owner set
  on another blocker stands); `volleyd decisions` prints `held on …` and the digest lists held
  decisions under their own heading (the Desk's digest card too, its headline counting them
  like volleyd's summary line). A wave whose only open decisions are held shows `running`, not
  `awaiting_decision`. (#335)

### Changed

- **volley-cli: `volley claude list` shows one block per Anthropic account.** Logins are grouped
  by e-mail the way the Desk's account cards are: the heading names the account (its profile
  label, or `default login`; plan, org, e-mail masked as `o•••@example.com` unless `--show-email`), one line per machine holding
  it with its sign-in state and waves, and per usage window the freshest reading from the retained
  usage records, with where it came from and its age; a machine's older reading that disagrees is
  marked `(stale)`. An account whose e-mail is not reported yet keeps a block of its own.
  `--json` prints the `claude_accounts` answer plus the records it read as `records`. The masking
  rules are exported as `volley-mcp/mask`. (#285)
- **volley-desk: Settings sections drill into groups, like macOS System Settings.** Supervisor,
  Autopilot, Sound and Claude accounts open on a list of group rows with live summaries; a row
  opens the group's page with a back control (Escape goes back too); search opens the matching
  group. (#286)
- **volleyd: spawns balance across the Claude accounts signed in on each machine.** With
  `claude.default_account: null` (the default; `most_headroom` means the same) every spawn
  picks the account with the most headroom on the machine it runs on, by the 5-hour, 7-day and
  the model family's weekly windows (`rankAccounts`); a one-login machine runs as before, and
  `primary`, a registry id or a task or wave `account:` still pins. A paired machine's agents
  can run under the profiles kept for it (their `CLAUDE_CONFIG_DIR` there, sealed by the fence
  for that host only). Each pick is journaled as `account_chosen` with a one-line `why`
  (`agent_spawned.account_why`), and `claude_balance` answers each machine's ranking. (#299)
- **volleyd: autopilot moves a running agent off a hot account at the warn level.** A new
  task-level `agent_account_limit` decision opens when an agent's account reaches
  `claude.warn_at_pct` in a window that counts for it, suggesting another login on its machine;
  autopilot answers `move <agent> to <acct>` under the new `autopilot.account_move_max` budget
  (default 2 per task role) or waits (`not now`); an agent whose task, wave or
  `claude.default_account` names an account gets none (the wave-level `account_limit` covers
  it). A balanced wave gets no `move wave` decision, and placement judges a machine by its best
  login (`usage 12% (work)`). (#299)

### Fixed

- **volley-desk: the Desk no longer lags on a phone.** On a touch screen (or under
  `prefers-reduced-transparency`) windows, the dock, the sheets and the sign-in card drop their
  backdrop blur for an opaque-ish fill of the same colours, Liquid glass renders as Frosted glass,
  the Needs-you pulse animates opacity, and a pan or pinch moves the canvas directly, with the view
  committed on release. Desktop keeps the glass. (#295)
- **volleyd: an unreadable `gh run list` is not "no CI".** A CI read that fails (a rate limit,
  HTTP 403 / 429, a 502, output that is not JSON) is CI state `unknown`: it opens no decision,
  never starts or advances the `ci_none_grace_ms` clock (unreadable time is not counted: the next
  readable `none` starts it over), and is re-polled; the task reads
  `CI unreadable (<error>), retrying`. A rate-limited answer backs the wave's CI calls off for
  `ci_rate_limit_backoff_ms` (new tunable, default 300000), journaling one
  `github_rate_limited` alarm that the next readable answer clears. A head's runs are now read with
  one `gh api …/actions/runs?head_sha=` call on the supervisor, which lists no workflows. A red head whose release
  branch's CI cannot be read is not classified (no CI fixup or flake request on it): it is
  re-verified and classified once the release branch reads again; a blocked agent on such a head
  gets the plain `agent_blocked` question. (#310)
- **volleyd: a merge GitHub refuses for a reason other than "behind" no longer updates the branch.**
  A `merge_refused` alarm now carries `reason` (`behind`, `head_moved`, `retargeted`, `closed`,
  `checks` or `unknown`; GitHub's "Base branch was modified" is `behind`). Only `behind`,
  `head_moved`, `retargeted` and `closed` give up the merge turn. A refusal for required checks, branch
  protection or an unknown reason keeps the turn and the task's place in the queue, and the merge
  is tried again up to `autopilot.merge_retry_max`. A branch update starts only when the turn's
  rebase check counts commits the head lacks. A failed `git fetch` or `git log` is now a failed
  check, not "behind by 1". (#311)
- **volleyd: a merge at the gated head is never `merged_unverified_head`.** A person who merges
  the PR at the head volleyd gated while a branch update or fixup is still running completes the
  task (`artifact_verified { role: "merged" }`, then `done`; the digest counts it as a GitHub merge). No alarm is raised,
  and the running update or fixup agent is retired as `superseded`. A merge whose head GitHub does
  not report still alarms. (#311)
- **volleyd: a conflicting PR is brought up to date instead of waiting for CI that never runs.**
  GitHub runs no CI on a PR that conflicts with the release branch, so volleyd used to wait out
  `ci_none_grace_ms` and ask "No CI run exists … accept | cancel". The PR read now carries
  `mergeable` and `mergeStateStatus`: a `CONFLICTING` PR journals `pr_conflicting` and enters the
  branch-update step at once (under the wave's `branch_update`, its brief saying the PR conflicts),
  and `UNKNOWN` is re-polled like running CI. If the update step's own head still conflicts, it is
  not updated again: after the grace the owner is asked, and the question says the PR still
  conflicts with the release branch. (#312)
- **ci, volley-issues: release PRs pass the changelog guards by construction.** The `untouched`
  guard accepts a `release:` / `chore(release):` subject in any case, so a release PR squashed
  under `Release: <date> — <theme>` passes; the CI workflow re-runs on `labeled` / `unlabeled`, so
  adding `no-changelog` reaches the fragment check without a new push; `bun scripts/changelog-ci.ts
  labels --ensure` creates the `no-changelog` label when the repository lacks it; and the skill's
  release steps title and squash both release PRs `release: …` and label the release-prep PR
  `no-changelog`, naming each PR on `gh pr merge` (the skill validator checks each command and
  rejects a bare `gh pr merge`). (#313)
- **volleyd: cleanup keeps unfinished tasks' worktrees, and the pipeline reads GitHub from the
  repo root.** `volleyd cleanup` removes only the worktrees of tasks that are done or cancelled
  (an unfinished one prints `skip <task>: <stage>`; `--all` includes it), so a `merge_ready`
  task's worktree survives until it merges. The pipeline's `gh pr` / `gh run` reads run from the
  wave's repo root with `--repo <owner/repo>`, and its git checks fall back to the repo root
  (fetching the PR head; a failed fetch says so) when the head's worktree is gone: a removed
  worktree no longer fails every merge check with `ENOENT` and wedges the task short of `done`.
  (#314)
- **volleyd: a `spawn_budget_exhausted` raise is sized for the wave, not one spawn.** The offered
  `raise by <n>` now covers the spawns the wave's unfinished tasks still need (each implement and
  review stage not yet spawned, plus one fixup allowance per task), at least a quarter of the
  derived budget, capped by `autopilot.budget_raise_max` while that cap leaves room for one; one
  raise, by the owner or autopilot, lets every held spawn through instead of opening a new
  decision per spawn. (#315)
- **volleyd: `resolve` and the inbox refuse an answer a decision cannot apply.** `raise 120` was
  accepted, journaled and ignored; it is now read as `raise by 120`, and an answer that is neither
  an option nor a form the kind accepts (`spawn_budget_exhausted`, `machine_down`,
  `repo_untrusted`) is refused with `BAD_ANSWER` (`volleyd resolve` / `volleyd inbox answer` exit
  3), saying what to write, and nothing is journaled. `volleyd resolve --help` lists the answers
  each kind takes. (#315)
- **volleyd: a resolved decision's `.volley/decisions.md` reaches a remote task's worktree.**
  `resolve` wrote it with local file calls at the remote worktree's path, so the agent on the
  paired machine never saw it (and on macOS it failed with ENOTSUP). It now goes through the
  task's host, over ssh for a paired machine; a failed write is journaled once per decision as
  `alarm_raised { alarm: "decisions_file_unwritten" }` and never fails the resolve. (#316)
- **volleyd: a steer reaches the task's live agent of any role, and wakes it when it is idle.**
  `volleyd steer` targets the task's newest agent that is not retired, whatever its role, so a
  live rebase agent is no longer answered `queued for the next agent of the task`; `--role`
  accepts `rebase` and `release` (task `_release` for the release train's stage agent). A queued
  steer also goes to an agent already up at its next hook signal, not only to a newly registered
  one. When an idle agent's hooks do not ack a mailbox steer (a steer, the liveness nudge, an
  answer, `nudge again`) within `mailbox_wake_after_ms` (new tunable, default 20 s), volleyd
  types `Check your Volley mailbox.` + Enter into its session under a new fence `WakeToken`, once
  per message (one wake drains every message sent before it), and journals `agent_woken` (with
  `enter_failed: true` when the line was typed but its Enter failed: the next wake then sends only
  the Enter, never a second line); a working agent or one with a picker open is never typed into,
  and the pause steer to an agent whose hooks the broker refused arms no wake.
  `volleyd status` shows `steer unacked (<agent>)` until the woken message is acked (also after a
  newer message or a daemon restart), and the CLI prints
  `delivered · woke the agent` / `delivered (acked by …)` / `queued (no live agent)`. (#317)
- **volleyd: a retained `blocked` always gets a decision, and an undecided block is a stall.** A
  `blocked` status already retained when supervision attaches (a fast agent, every agent after a
  restart) is handled like a live one, and the watchdog is armed for it. A `blocked` the pipeline
  cannot own (a `merge_ready` or `done` task, a stale or accepted run, a pipeline error) journals
  `alarm_raised { alarm: "blocked_unhandled", agent_id, why }` and opens a daemon-level
  `agent_blocked` (`respawn | cancel`, or `manual | cancel` without parking a settled task or
  a stale run's) instead of returning silently or logging an error; a per-tick sweep asks for one
  never decided, waiting while a red head is still being classified.
  The watchdog counts only a decision or a retire as handling a `blocked`, and a blocked agent no
  decision names (open, or answered for that status) for `blocked_undecided_stall_ms` (new tunable, default 300000) is
  `agent_stalled` (`respawn | stop task`); that stall names the status too, so a steer that leaves
  the agent blocked is not asked again every window. (#318)
- **volleyd: spawns admitted together no longer fail on a fetch race.** Every `git fetch` volleyd
  runs into a clone (both hosts' worktree prepare, a continued branch's check, the pipeline's
  artifact probes, the release train's stage check) now waits its turn on a per-machine, per-clone lock, so two tasks admitted on
  the same tick no longer race `refs/remotes/origin/<branch>` (`incorrect old value provided`) into
  `BASE_STALE`. A fetch that still loses a ref-lock race to another git process is retried once
  after 500 ms and the spawn goes on, journaling `alarm_raised { alarm: "fetch_retried" }`. A fetch
  that never reached origin (`Could not resolve host`, `Connection timed out`) is refused as
  `BASE_UNREACHABLE` and retried with the usual backoff, instead of a `BASE_STALE` that says the
  base is old. A fetch under the lock that names no timeout of its own is bounded by
  `git_fetch_timeout_ms` with credential prompts off, so a hung fetch cannot hold the lock and stall
  every later spawn into that clone. (#319)
- **volley-cli, volleyd: peer readiness no longer keeps a stale doctor result until the service
  restarts.** `volley peer run` re-runs the doctor on the next heartbeat when the volley
  checkout's `package.json`, `bun.lock` or install marker changes, or when `volley peer doctor`
  ran (it writes `~/.volley/peer-doctor-ran`), and re-reads the versions it reports; `volley peer
  doctor --fix` says it is waiting (up to about 2 minutes), then prints `readiness republished`
  once the service's record carries the new run, else how to restart the service (and says it
  could not check when the broker refuses it). A Repair (`peer_doctor`) folds its report into
  the box's retained machine record and readiness verdict at once, and while the box's
  heartbeats still carry its service's older run the supervisor republishes them with the newer
  one, so neither the Desk nor readiness goes back to the stale checks. A record the supervisor
  republishes no longer counts as the box's heartbeat, nor brings a down box back up. A doctor
  report's `doctor_at` is now when its run started, so a run that began before a fix never reads
  as one after it, and runs are compared as instants. A Repair on a box whose tunnel is down
  leaves its record as it is. (#320)
- **volley-cli: the doctor checks every `volley` MCP entry on the machine against this checkout.**
  The `mcp` row covers each Claude account profile under the Volley home and the wave repo's
  `.mcp.json` as well as `~/.claude.json` (`mcp: own` skips only the latter): an entry that runs
  another checkout is a blocking failure (`✗ mcp: account profile acct-b runs
  /path/to/old-checkout`), and `--fix` re-points it, keeping its other keys (a `.mcp.json` git
  tracks is reported, never rewritten in the clone). volleyd's Repair passes the box's `volley_dir`
  (`--supervisor-volley-dir`), and a checkout other than that one fails naming both. (#321)
- **volley-cli: `volley peer join` finds the supervisor's volley without `--remote-volley`.** It
  runs `volley peer redeem` as `volley` when that is on the supervisor's non-interactive ssh
  `PATH`, else as `~/.volley/bin/volley`, where `volley setup` installs it. (#321)
- **volleyd: the hard ceiling counts the agents volleyd runs, not admitted tasks.** It counted every
  admitted, unsettled task of every loaded wave, so tasks awaiting a decision, blocked tasks whose
  agents had retired and the tasks of paused, stopped or ended waves held slots (`9/9 live` with 4
  running starved a new wave). It now counts supervised agents, those launching or spawning
  (release stages too), and one slot per admitted task of a running wave that will spawn its
  next agent (queued for its implementer, or between pipeline roles with a role still to
  come). A task whose agent died unverified, or whose next role was refused for good, holds
  nothing. A reviewer or fixup spawn and a queued task's first agent (a retry, a resumed
  wave's backlog) start only while the agents running or starting leave room, so neither
  overshoots and held slots never deadlock.
  A release stage's spawn checks the same, so another wave's held slots never hold a release.
  `volleyd admission` prints `ceiling: 4/12 live agents · 2 launching · by wave: …`
  (`launching`: not supervised yet, held slots included; the `admission` op and retained
  payload carry `ceiling`), and `volleyd status` prints `hard ceiling: 4/12`. (#322)
- **volleyd: a running task keeps its host across plan versions.** Switching an in-flight wave to
  `placement: auto` no longer fails the checks of the tasks already running locally with
  `host 'auto' is not configured`: a task that has spawned, or was spawning when the new version
  arrived, keeps the host it runs on (the wave
  state's `tasks[].host_actual`, the plan's own as `host_planned`), only unstarted tasks are
  placed, and `volleyd run` prints `T3: host kept local (already running; new plan says auto)`. (#323)
- **volley-mcp, volleyd, volley-desk: a live but quiet coordinator no longer reads "No coordinator ·
  claim it".** The MCP server publishes a `progress` heartbeat every `VOLLEY_HEARTBEAT_S` (default
  300 s) while registered, so a session blocked on `volley wait` stays alive; volleyd re-publishes
  the wave state's `coordinator.last_seen` at least every `claim_after_s / 4` while it hears the
  coordinator; and the Desk finds a coordinator-name owner through its bound agent
  (`coordinator.agent_id`) and trusts volleyd's fresh `last_seen`. A heartbeat no longer counts as a
  progress report on the Desk, and it leaves a coordinator waiting on the owner in `awaiting_input`
  ("needs you") rather than flipping it back to working. (#325)
- **volley-desk: the wave header's autopilot chip never truncates mid-word, and a long task id
  fits its dependency-graph node.** The chip shows the full sentence, or `⚙ 4 · ↑ 1` in a compact
  window, with the full text as its title; the owner chip has a title too. A graph node elides an
  id longer than it fits as `head…tail` (a flake-fixer's `fix-<slug>`), with the full id in its
  tooltip; the `#issue` link moves to the second line, and a synthetic task draws its wrench
  instead of `#0`. (#327)
- **volleyd, volley-hooks: a long foreground tool call no longer raises `hooks_silent`.** A full
  test suite or `gh run watch` kept the hooks quiet for 10 min while the screen changed, which
  opened a "hooks may be broken" decision that cleared itself when the tool returned. PreToolUse
  now publishes a tool boundary on every call (`activity` with `tool_use_id` and `tool`, outside
  the 5 s work-log limit) and PostToolUse's heartbeat carries the same `tool_use_id`; volleyd
  treats a tool in flight (each of several parallel calls until its own PostToolUse) as work, not silence, until the new `tool_in_flight_max_s` (default 2 h)
  with a static screen. With no tool in flight, `hooks_silent` now needs the screen to keep
  changing with no hook signal across two `heartbeat_alarm_s` windows (20 min by default). (#329)
- **volley-hooks: the lease hook matches the commands the shell would execute, not text that
  mentions them.** A pool's `match` regexes were tested against the whole Bash command string, so
  a heredoc writing a note, a `#` comment, a `git commit -m "… bun run test …"` or an `echo`
  queued behind real test runs. They now run against each executed command: the line is split on
  `;`, `&&`, `||`, `|`, newlines and `$(…)`, `sh -c` scripts are split in turn, and comments,
  heredoc bodies, `echo` / `printf` arguments and git / gh message text (`-m`, `-am`, `--body`,
  …) are dropped. (#330)
- **volleyd: a coordinator that ended while the daemon was down reads `gone` after the restart,
  whatever order the replays arrive in.** The retained statuses and registry entries replay on
  two subscriptions; when the `done` came first, the daemon forgot it (no coordinator name known
  yet) and the wave's `coordinator` then read `working` forever. A forgotten terminal status is
  now set aside (bounded) and taken back when the session's registry entry arrives (not by an
  entry that started after it: that id registered anew). (#332)
- volleyd tests: the broker and journal waits (`eventually`, `until`, `journalWait`) fail after
  5 s naming what they waited for and the last assertion error, never as a vitest timeout, and a
  grep guard keeps every test's wait helper on them; the spawn test's set-up moves to its hook
  and its cleared-topic reads run at once. (#332)

### Docs

- **repo: no home-directory paths in tracked files.** Docs, examples, `config.example.yaml`, the
  spec examples and the tests now write `/path/to/repo`, `/path/to/volley`, `/path/to/worktrees`
  and `/path/to/home` in place of invented `/home/<user>` and `/Users/<user>` paths, and the new
  `scripts/no-home-paths.test.ts` guard keeps them out. (#333)
- **spec: the decision kinds, wave events and tunables are one item per line, checked against
  the schemas.** Sibling PRs that each add a kind, event or key no longer edit the same line.
  `bun run check:spec-refs` fails, naming the item, when a list and its schema
  (`decision.schema.json`, `wave-event.schema.json`, `config.schema.json`) differ; the tunables
  list gains the missing `autopilot.digest_min_interval_s`. New `spec/RESERVED.md` reserves SPEC
  section numbers for an epic's parallel children, and the check fails when a sibling's heading
  takes a reserved number (or when `spec/RESERVED.md` is missing); `/volley-issues` says to reserve them in the epic's first PR. (#334)

## 0.5.0 — 2026-10-21

The Autopilot release: a wave runs unattended. volleyd answers routine decisions from a
reviewable policy table (#197), relaunches and respawns stalled agents (#200), heals red CI by
classifying it (#204) and fixing a flake with its own task (#207), merges each gated PR itself at
exactly its gated head (#198) through a merge queue (#203), runs the repository's release train
(#201, #205), and refers what needs a person to one needs-you inbox (#202, #206) that the Desk
answers from any screen, a phone included (#208, #209). A wave is owned by a stable coordinator
name, so its session can end (#199); the night is summed up in one digest and one push (#210);
`/volley-issues` submits and leaves (#211); a simulated soak runs a whole wave in CI (#212). The
owner's guide is [`docs/AUTOPILOT.md`](docs/AUTOPILOT.md) (#213). Owner smoke:
[`SMOKE.md`](SMOKE.md) Plan 13.

### Added

- **volleyd: archive ended waves.** `volleyd archive <wave> [--yes]` retires a stopped or
  complete wave: its open decisions close as `archived`, `wave_archived { by, reason,
  closed_decisions }` is journaled, its state is published once with `status: "archived"` and
  then cleared, and it leaves the live set (`volleyd status`, `decisions`, ticks, restarts) while
  its journal and evidence stay on disk. `volleyd status --all` still lists it; `run` refuses its
  id. An admin may archive any ended wave through its account-op topic. New tunables
  `archive_ended_after_h` (default 24; 0: never) and `archive_on_ack` (default true) archive
  ended waves automatically. A retained index, `volley/_waves/_archive` (`archive.schema.json`),
  lists archived waves (SPEC §4.6.20). **Behaviour change on upgrade:** the first tick archives
  every wave that ended more than 24 h ago in one pass; set `archive_ended_after_h: 0` first to
  keep them. (#192)
- **Desk: archived waves leave every Desk.** The coordinators window and the canvas drop an
  archived wave for every client, not just the browser that dismissed it, and the window's footer
  counts `N archived (volleyd archive)` from the index. Dismiss stays for ended waves not archived
  yet. (#192)
- volleyd: `volleyd run` warns when the wave it submits has no owner (nobody can answer its
  decisions), and `volleyd validate` notes that `run` needs one. (#192)
- volleyd: a terminal-status watchdog. A `done`, `blocked` or `failed` status that nothing in the
  wave journal names within 60 s (`terminal_unjournaled_alarm_ms`) raises
  `alarm_raised { alarm: "terminal_status_unjournaled" }` once, cleared when something does. (#196)
- **volleyd: the autopilot policy engine answers routine decisions from a reviewable table.**
  The table is data in one pure module (`src/autopilot/policy.ts`); a decision a rule matches is
  answered in the same turn, journaled `decision_auto_resolved { decision_id, kind, policy,
  answer, rationale, evidence, budget? }` and then `decision_resolved { by: "volleyd" }`, and does
  not ring. A decision no rule answers, an owner-only kind, a spent budget or an answer that could
  not be applied stays open as `decision_escalated { why }`, its question prefixed `Autopilot
  could not resolve this (<why>): `, and rings once. An answer is always one of the decision's
  own options. New `autopilot` tunables (SPEC §4.6.4, §4.6.16), global and per wave: `enabled`
  (default `true`), `owner_only`, and the per-wave budgets (`relaunch_max`, `nudge_max`,
  `respawn_max`, `rereview_max`, `question_max`, `budget_raise_max`), reduced from the journal so
  a restart keeps them. `volleyd policy [--json]` and the `policy` control op print the table;
  `volleyd status` prints `autopilot: on · N auto-resolved · M escalated` and the wave state
  carries `autopilot { enabled, auto_resolved, escalated, budgets }`. (#197)
- **volleyd: autopilot merging, behind the fence.** volleyd can merge a gated PR itself, exactly
  at the head its evidence describes: the gate mints a `MergeToken` for `{ wave, task, pr, head,
  release_branch }` after writing the evidence package, and the authority fence allows exactly
  `gh pr merge <n> --squash --match-head-commit <head> [--delete-branch]` with a token for that PR
  and head (never `--admin`, `--auto`, `--merge` or `--rebase`; `git merge`, `push` and `rebase`
  stay denied). A merge is journaled `merged_by_supervisor { task, pr, head, merge_sha, by }`,
  then `artifact_verified { role: "merged", via: "supervisor" }` and `done`. A merge GitHub
  refuses (head moved, checks required, branch protection) raises `merge_refused` and the PR is
  re-read; after `autopilot.merge_retry_max` (2) refusals decision `merge_refused` asks `retry`,
  `manual` or `cancel`. New wave-file key `merge: auto | manual` (default: the new tunable
  `autopilot.merge`, default `auto`); under `manual` nothing changes. For now volleyd merges only
  in a wave of one task (the merge queue that orders merges across tasks comes next). The
  evidence package says who merges. Before the gate and again right before `gh pr merge` the PR
  is re-read: a PR retargeted away from the release branch, or whose head moved, is never
  merged. **Behaviour change:** a one-task wave with no `merge:` key is now merged by volleyd
  after upgrading; set `merge: manual` in the wave file (or `autopilot.merge: manual`) to keep
  merging by hand. (#198)
- **volleyd: stable coordinator identity.** Set `VOLLEY_COORDINATOR` (e.g. `coord-main`) in the MCP
  registration's `env` and submit with `volleyd run --owner "$VOLLEY_COORDINATOR"`: the wave is
  owned by the name, which volleyd binds to the newest live registry entry carrying it (the MCP
  server publishes it as the registry entry's `coordinator`; `vol_register` returns it). A session
  whose MCP server restarts under a new agent id keeps its waves: volleyd journals
  `owner_reconnected { owner, agent_id, previous_agent_id }`, nothing is claimed, and the wave
  state's `coordinator.state` reads `reconnecting` (new) while the session is away, for
  `autopilot.reconnect_grace_s` (default 900), then `gone`. `volleyd status` prints
  `owner: coord-main (via coordinator-c7d9)`; the CLI picks the name up from `VOLLEY_COORDINATOR`
  or the session's registry entry. (#199)
- **volleyd: three stalls the pipeline now fixes itself.** An `agent_stalled` decision offers
  `nudge again`, `respawn` or `stop task`, and `respawn` relaunches the agent on its branch (the
  next attempt). A verify that finds an agent's artifacts missing offers `respawn` beside
  `re-verify` and `cancel`. A `ci_failed` decision offers `fixup`: a fixup agent gets the CI result
  (failing jobs, failing tests and the tail of the failed logs) as its directive; after a red first
  head the reviews run on the fix, and after a red fixup or rebase head the green fix goes straight
  to the gate. Autopilot answers them within budget: a second stall and a missing artifact get
  `respawn` (`respawn_max`), and a red head caused by the PR's own change gets `fixup`. (#200)
- **volleyd: the release train, part 1: a release playbook, the `releasing` status and the
  `release_go` / `stage_go` decisions.** A repository may ship `.volley/release.yaml`
  (`spec/schemas/release-playbook.schema.json`): named stages, each a `brief`, optional `run`
  argv lines, `verify` facts (`commits_on_release`, `tag`, `files`, `result`) and `gate: auto |
  owner`. A wave file's `playbook: <path> | none` overrides the default path. `volleyd validate`
  and `run` print `release playbook: <path> (N stages, M owner-gated)` or `none`; an invalid
  playbook refuses the wave with `RELEASE_PLAYBOOK_INVALID`. Under autopilot a settled wave with a
  playbook journals `release_started` instead of `wave_complete` and becomes `releasing` (wave
  state `release: { stage, stages }`; `volleyd status` prints `release: <stage> (k/N
  verified)`); once every stage is verified volleyd asks the owner `release_go` (`go` → `release_done`,
  `complete`; `hold` asks again). Stages are not run yet; that is the next part. (#201)
- **volleyd: the needs-you inbox, with volleyd as referee.** Everything waiting for a person is
  one retained record on `volley/_inbox/<id>` (`inbox-item.schema.json`, SPEC §4.6.18), published
  by volleyd only: `{ id, kind: decision | picker | handoff | release, version, owner_only, …,
  answered? }`. Every decision is mirrored as an item (`d-<wave>-<decision_id>`, `owner_only` from
  `autopilot.owner_only`). An answer is the mailbox op `inbox_answer { id, version, answer, where }`
  from any login that may steer, accepted only at the item's current version (compare-and-set);
  a late one is refused `already answered on <where>` (`desk·phone`, `<machine>·terminal`, `cli`,
  `autopilot`). Every path (`volleyd resolve [--where]`, autopilot, the Desk) closes the item
  through the same referee and journals `inbox_answered`. Answered items stay retained for the
  new tunable `autopilot.inbox_answered_ttl_s` (600), then are cleared. New `volleyd inbox
  [--json]` and `volleyd inbox answer <id> <answer> [--where] [--version]`; the Desk's store
  keeps the items in `state.inbox` (its window comes next); the broker roles let every account
  read the inbox and only the supervisors write it. (#202)
- **volleyd: the merge queue.** Under `merge: auto` volleyd merges a wave's gated tasks one at a
  time: ordered by dependency (tasks with more dependents first; never ahead of a task they come
  after), then by when they were queued, with one merge in flight per release branch across every
  wave on the daemon. After each merge the next task is checked against the release branch and,
  if behind, brought up to date under `branch_update` (`merge` recommended for unattended waves)
  before it gates again and merges: at most N−1 updates, serially. A rebase or merge agent that
  is blocked or fails while its task is queued opens `merge_conflict` (`respawn` | `manual` |
  `cancel`; autopilot answers `respawn` once). New: `merge_queued`, `merge_dequeued`,
  `merge_started` and `merge_ended` events, wave-state `merge_queue` and its `volleyd status`
  line, `volleyd merge <wave> <task>` (owner only; merges one gated task now, under
  `merge: manual` too) and `autopilot.delete_branch` (default `false`).
  A multi-task wave without `merge:` is now merged by volleyd (the `autopilot.merge` default,
  `auto`). A task whose turn checks keep failing gives up the turn and is passed over, so it never
  wedges the queue. (#203)
- **volleyd: self-healing CI, step one: a red head is classified before anyone is asked.** Own
  change (a failing test's file is in the PR) opens `ci_failed` with `fixup` first; a flake (a
  failing test the PR does not touch, or red on the release branch too) journals
  `remediation_requested { kind: fix_flake }` and offers `fix flake`; an infra incident (an
  infra-shaped run, or GitHub's status page reporting an Actions / API incident) holds the task in
  CI and re-checks it for up to `autopilot.incident_wait_max_s` (default 4 h) before asking. The
  decision carries `classification` and `evidence`; a blocked agent whose reason is a failing
  test on a red PR head is routed the same way (`agent_blocked_ci`). Nothing ever re-runs CI.
  (#204)
- **volleyd: the release train runs its stages.** A releasing wave spawns one `release` agent
  per playbook stage, serially, through the normal spawn path (`<wave>-release-<stage>-<n>` on
  `<wave>/release-<stage>-<n>`, cut from the release branch's tip, under the pseudo task
  `_release`). Its brief and `.volley/stage.md` carry the stage's brief, its `run` lines verbatim,
  the `verify` facts and the `stage` result contract (`review-result.schema.json`); a `heavy`
  stage takes its lease first. After its `done` volleyd verifies read-only (every command exited
  0, `commits_on_release`, `tag` through `gh api …/matching-refs/tags/`, `files` through `git
  show`, `result` fields), writes `$VOLLEYD_HOME/waves/<wave>/release/<stage>.{md,json}` and
  journals `release_stage_verified`; a missing fact gets one steer, then `release_stage_failed`
  and a wave-level `agent_blocked` decision (`respawn` / `skip` / `cancel`). An owner-gated stage
  waits on `stage_go` (`go` / `skip` / `hold`); `release_go`'s `stages` point at every stage's
  evidence, and `volleyd status` prints `release: smoke running (2/4 verified)`. SPEC §4.6.19. (#205)
- **volleyd, volley-hooks: Claude pickers and coordinator handoffs in the needs-you inbox.** Two new hooks on `AskUserQuestion` publish `progress/picker_opened { tool_use_id, questions }` and `picker_answered { tool_use_id, answers }`; volleyd opens a `p-<agent_id>-<tool_use_id>` item for every picker in any session, and an `h-<agent_id>-<seq>` item for a coordinator turn that ends on a question (a coordinator's own items are answered only by that session or the coordinator name bound to it). A Desk answer is carried out on the session's screen before it is accepted: volleyd checks the same picker is still shown (else `picker not on screen`) and selects the answer by keystroke, or types a handoff reply into an idle prompt below the question it asked (else `prompt not idle` / `the question is not on screen`); `Up`/`Down`/`Space` and the typed text pass the fence only with a `PickerToken` / `HandoffToken` for exactly that item and answer. The picker's own hook, the session's next prompt, or the session ending closes the item with `where: terminal` when it was answered there. The volley-issues skill asks go/no-go through `AskUserQuestion` (`go`, `hold`, `cancel`). (#206)
- **volleyd: self-healing CI, step two: a flake gets a dedicated fixer task, and its merge
  unblocks every PR that waited on it.** On a `fix_flake` request volleyd adds a synthetic task
  `fix-<slug>` to the wave (issue 0, the wave's pipeline, scheduled first, one per distinct test,
  at most `autopilot.fix_flake_max`, default 3, past which the red head is escalated
  `budget_exhausted`). Its implementer gets a root-cause brief instead of an issue: reproduce,
  find the cause, fix it test-first; never re-run, skip or quarantine. When the fixer is done,
  `remediation_closed` releases each blocked task: its decision is resolved `fix landed`, it
  updates from the release branch and is verified again. A fixer that is cancelled, blocked or
  escalated puts the blocked red heads back to the owner once. `volleyd status` shows
  `fixer for T3, T7 (flake: <test>)`. (#207)
- **volley-desk: the Needs you window.** One row per item in the needs-you inbox (decisions,
  pickers, handoffs, release go/no-go), filtered All / Only you / Pickers / Decisions / Handoffs.
  Each answer button sends `inbox_answer` to volleyd. A refusal ("already answered on …") flips
  the row to answered, and without broker credentials a row offers the `volleyd inbox answer`
  command to copy. The dock's Needs you tile and the top-bar pill count what needs a person, and
  owner-only items fire the browser notification. At phone width the rows are stacked cards with
  48 px targets. A release item shows the train as a Stepper, plus the changelog entries (a safe
  inline Markdown renderer), the staging smoke screenshots, and links to the release PR, the CI
  runs and the smoke log. A release guide is a link only. (#208)
- **volley-cli: `volley desk serve --evidence <volleyd home>`.** Serves
  `/evidence/<wave>/release/<file>` read-only (`.png .jpg .webp .txt .log .md .json` directly
  under `waves/<wave>/release/`, nothing else) for the Needs you window. It is off by default,
  a LAN-trust choice that `volley setup` names but does not turn on. (#208)
- **volley-desk: autopilot on the Desk.** A coordinator whose session is reconnecting (inside
  volleyd's `autopilot.reconnect_grace_s`) reads `Coordinator reconnecting · Nm` with a neutral
  chip, no `claim it` and no Needs-you banner, until volleyd says it is gone. The wave window gets
  an `autopilot on · N auto · M escalated` / `autopilot off` chip, the merge queue as one line, the
  release train's stages while releasing, a wrench and `fixer for …` on synthetic fixer tasks, and
  autopilot's `decision_auto_resolved` / `decision_escalated` events as feed lines (also in the
  agent window's feed), the evidence behind the row's disclosure. Settings › Autopilot has every
  `autopilot.*` tunable (`owner_only` as a multi-select of decision kinds) and the policy table
  from the `policy` op, read-only. (#209)
- **volleyd: the morning digest: one retained digest per wave, one push, `volleyd digest`, and
  the Desk's digest card.** volleyd computes, from a wave's journal, what shipped (each merged
  task with its PR, merge sha and who merged it), what autopilot handled on its own (decisions
  answered, flakes fixed, conflicts resolved, retries, merges) and what is waiting for the owner,
  and publishes it retained on `volley/_waves/<wave>/digest` (`digest.schema.json`), journaling
  `digest_published { trigger }`, when the wave completes or its release is done, its `release_go`
  opens, it is stopped, or it first needs the owner (an escalation; at most once per
  `autopilot.digest_min_interval_s`, default 1800, per trigger). Each publish sends one `progress`
  envelope of type `digest` whose `msg` is the one-line summary (`w1 complete: 27 shipped, 3 flakes
  fixed, 2 conflicts resolved, 1 waiting for you (release_go)`); `volley notify` rings for it by
  default (`--on` now defaults to `blocked,failed,reaped,digest`) and its desktop banner shows
  `msg`. `volleyd digest <wave> [--json]` prints it; the Desk shows it in the wave window while the
  wave has ended or a decision it lists is still open. Archiving a wave clears its digest. (#210)
- **volleyd: a simulated soak runs one whole wave unattended.** `bun run test:soak` (and CI's
  `soak` job) drives a wave through the real daemon against a simulated GitHub, with a flaky test,
  a merge conflict, launch timeouts, a dropped coordinator, slow screens, and stalled, failed and
  unparseable agents, and checks that every task merges and only `stage_go` and `release_go` are
  left for the owner. PR heads moved by release-only merges are opt-in (`SOAK_MOVED_HEADS=2`)
  until #269 and #271 are fixed, and CI gates on an 8-task run while the 32-task run is reported
  without gating until #269. `SOAK_TASKS` (default 32) and `SOAK_SEED` size and replay it. (#212)
- volley-desk: the agent window's title bar is two rows that never bunch: the status mark, the
  wave, role, stage and machine chips and the actions on the first; the headline in full (at
  most two lines), its issue and PR links and the account picker on the second. Under 420 px the
  window is compact (an icon-only account picker, shorter chips). The new machine chip says where
  the agent runs (a paired machine's name or `this machine`) with an up / down / overloaded dot,
  a why-here and load tooltip on hover or focus, and opens Settings › Machines at that machine's
  card; it replaces the footer's `on <host>`, and the body's purpose line now shows only when the
  headline does not already. (#220)
- volley-desk: GitHub links everywhere a wave shows work. A repo chip (the GitHub mark and
  `owner/repo`) on the wave window, each wave row of the Coordinators window and its Supervisor
  row (`N repositories` past two); every `#n` / `PR #n` on the agent window header, the
  dependency graph and the machine-down banner is a link named `Issue #n on GitHub` /
  `PR #n on GitHub`, opening in a new tab. Links come from the wave state's `github` only;
  without it the numbers render unlinked. (#225)
- volleyd: the wave state carries `github: { slug, url }`, the repository's `owner/repo` name and
  URL from the `gh repo view` volleyd already runs per wave version (now
  `--json nameWithOwner,url,visibility`, under every `public_hygiene` level); absent when it
  could not be read. `volleyd status` prints `github: owner/repo`. (#225)
- **`volley deploy [<tag>|--latest] [--dry-run]`.** One command takes the checkout this
  machine's volleyd and Desk services run from (read from volleyd's installed launchd plist or
  systemd unit; `--repo` overrides) to a release tag: fetch tags, check the tag out detached,
  `bun install --frozen-lockfile`, build the Desk (and write setup's `dist/.volley-build` stamp),
  self-check, restart both services and health-check them (volleyd is `working` again, the Desk serves
  the tag's `version.json`). A failure after the checkout repeats those steps at the previous
  ref and exits 1; a failed rollback prints the commands to run by hand. A checkout with local
  changes exits 3 unless `--force-clean` stashes them (never discards). Every command goes
  through one fence of exact argv shapes. `--dry-run` prints the steps and runs only read-only
  git commands. (#232)
- The Desk's build writes `dist/version.json`; `volley desk serve` warns at start (and still
  serves) when the build is stale against the checkout's Desk sources or the bundle's version is
  not the CLI's. `--quiet` silences both lines. (#232)
- volleyd: an adaptive hub. `fleet.local_agents: always | fallback | never` sets how the
  supervisor's own machine takes auto-placed tasks; `null`, the default, is `fallback` once any
  `hosts.<name>` is configured, else `always`. Under `fallback` the own machine takes a task only
  while no paired machine is eligible (a peer down for less than
  `placement.down_decision_after_s` may be back, so it waits), and then under a lighter profile:
  at most `fleet.fallback.max_agents` (default 3) of its own agents and
  `fleet.fallback.per_machine.<pool>` heavy slots (default 1). Nothing running is moved when a
  peer comes back. The candidate line says why (`local (fallback: no peer eligible: …)`,
  `ineligible: fallback: box-a is eligible`, `ineligible: local_agents: never`); the own
  readiness verdict carries `local_agents { mode, active, why? }`, `volleyd status` prints
  `local agents: fallback (active: …)`, and `volleyd validate` warns about a task pinned to
  `local` under `never`. `lease_pools.<pool>.per_machine_overrides: { <host>: n }` caps one
  machine's share of a pool (0 allowed, `local` names the supervisor's own), enforced by the lease
  book and shown in the pool state, `volley lease status` and the Desk's lease pools; the Desk's
  supervisor card shows the mode as a chip. (#233)
- **volley-desk: the context meter pulses from 70% and faster once red.** The agent window's (and
  a session's) `ctx` meter pulses its bar from 70% and faster from 85%; under
  `prefers-reduced-motion` it only changes colour. (#289)
- **volleyd: agents compact before they hit the context wall.** Every launch exports
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` as `agent_auto_compact_pct` (default 85, 0 to leave Claude
  Code's default; per wave through `config:`) of the model's context window in tokens;
  `agent_spawned` records it and the fence pins it. (#289)
- **volley-desk: a Machines window with load and memory sparklines per machine.** The dock's new
  Machines tile (badged with the machines that are down) opens one row per machine in the pool,
  this machine first: the health dot, `load <1-min>/<cores>`, `mem <used %>`, `<n>/<max> agents`,
  cores and memory, and two sparklines over the last 10 minutes (load per core in teal, memory
  used in coral) that turn amber at 70 % and red at 90 %. A down machine reads
  `down · last seen 6m ago` with flat grey lines; a click opens Settings › Machines at its card.
  The Desk keeps each machine's readings from the records it already receives. (#290)

### Changed

- **volley-issues: the autopilot flow is the default volleyd path.** `/volley-issues` submits the wave owned by the stable coordinator name (`--owner "$VOLLEY_COORDINATOR"`) and leaves: volleyd answers routine decisions and merges gated PRs itself, and what still needs the owner (owner-only kinds, escalations, `release_go`) is answered from the Desk's Needs-you window, `volleyd inbox answer` / `volleyd resolve`, or the terminal. The optional wait is one `volley sub` on `volley/_waves/<wave>/digest`; the per-event loop moves to "Driving a wave by hand" for `autopilot: off` waves. `scripts/wave-from-issues.ts` gains `--merge auto|manual` (writes `merge:`, default `auto`), `--autopilot on|off` and `--branch-update merge|rebase` (written into the wave's `config:`), and prints the submit line with its owner; the brief-preface template adds the go/no-go `AskUserQuestion` convention. (#211)
- **Changelog entries are per-PR fragments.** A PR records its change as a new file,
  `changes/<issue>.<added|changed|fixed|removed|docs>.md`, never by editing `CHANGELOG.md`, so two
  PRs in a wave never conflict on it. `bun run changelog --version <v> --date <YYYY-MM-DD>
  [--check] [--commit]` assembles the fragments into the release's section and deletes them. CI
  fails a PR that touches `packages/` or `spec/` without a fragment (unless labelled
  `no-changelog`), and a non-release commit that changes `CHANGELOG.md`. (#231)

### Fixed

- **volleyd: the auto-archive tests no longer time out under load.** They moved the fake clock
  24–48 h with every daemon interval firing on the way (several seconds per test), so a busy
  machine crossed the 15 s timeout. The TTL is wall-clock time, so the tests now let the host
  sleep across it, as a laptop does. (#192)
- **volleyd: a launch whose outcome is unknown is reconciled before any retry.** A `cmux
  new-workspace` that timed out (on the cmux side, or volleyd's new `launch_timeout_ms` bound)
  could still have started the agent, and the retry then ran a second session under the same
  agent id. A failed launch now says whether it created nothing (`refused`) or may have
  (`unknown`); for an unknown one volleyd looks the workspace up by name and waits
  `launch_reconcile_ms` for the agent's registration, then adopts it (`spawn_adopted`), closes
  the empty workspace (`launch_orphan_closed`) or, when the host cannot be asked, burns the
  attempt (`spawn_identity_burned`) so the retry takes the next agent id. A workspace title now
  carries the attempt after the first (`<wave> <task> <role> 2`), so the lookup never finds an
  earlier attempt's workspace; two workspaces with the same title burn the attempt too. Launches
  are serialized per host. (#193)
- **volleyd: a retire ends the agent's session, and cleanup stops its process.** After a retire
  volleyd closes the agent's workspace (cmux `close-workspace`, now bounded by a 15 s timeout, or
  tmux `kill-session`) and, on this machine, stops any `claude` process still running under the
  agent's worktree (matched by its `--mcp-config=` argv; SIGTERM, a grace, SIGKILL), journaled as
  `agent_session_closed`. After a daemon restart the workspace is re-found by its title. The new
  `retire_close_session` tunable (default `true`) keeps finished sessions open when `false`.
  Before deleting the agent's login the retire writes `<worktree>/.volley/retired.json`.
  `volleyd cleanup <wave> --yes` also stops the retired agents' processes still running under
  their worktrees (the dry run lists them). (#194)
- volley-hooks: the hooks of a retired agent (a `.volley/retired.json` naming their own agent id)
  exit 0 quietly, before any broker connect, with a one-time `{ code: "RETIRED" }` note in
  `hooks-error.json`, instead of printing the `AUTH_FAILED` advice for a login volleyd deleted on
  purpose. (#194)
- **volleyd: a `pr_head_moved` that only merged the release branch can be accepted.** When CI
  on the new head is green and the move is a merge of the release branch whose changed files the
  release branch changed too (a CHANGELOG conflict resolved in the merge counts), the decision
  offers `accept`: the gate moves to the new head with the reviews of the old one, and the
  evidence records who accepted it and the files the merge touched. A move that adds the PR's own
  changes is still `rereview | fixup | cancel`. (#195)
- **volleyd: a PR merged while its task is not at `merge_ready` is noticed.** The merge check
  runs in every stage short of `done` / `cancelled` (an open decision, the reviews, a fixup):
  the task's open decisions are resolved `superseded_by_merge`, its live agents retired, and it
  becomes `done` with `merged_unverified_head`, releasing its dependents. Before, a merged task
  waited on its decision and could only be recorded as `cancelled`. (#195)
- volleyd: an agent's `blocked` status was never journaled or decided, whatever its role, so a
  stuck task (a rebase agent, on a downstream wave) stayed silently in its stage. Every role's
  `blocked` now opens an `agent_blocked` decision with the agent's reason (`continue | respawn |
  cancel`); the agent is not retired while it is open (SPEC §5.2). (#196)
- volley-desk: Arrange & fit and the first fit framed only the arranged (unpinned) windows, so a
  window pinned in place could be left off-screen; the view now frames the pinned windows with
  the rest, and the layout is chosen to fit beside them. (#221)
- **volley deploy: the volleyd health check no longer reports a live broker as unreachable at
  the end of its wait.** The check polls until its deadline, and a last poll that started with
  a few milliseconds left gave its broker connection only that long, so a slow moment turned
  "volleyd has not re-registered" (or "its status is spawning") into "the broker is
  unreachable". Each connection attempt now gets at least a second. (#232)
- **volley-desk: the version.json build test passes on macOS.** It built from a temp directory
  under the `/var` → `/private/var` symlink, which vite refused; it now uses the real path. (#232)
- **volleyd: reviews and verification work on a paired machine.** The remote fence allows the
  read-only `gh` verbs a reviewer's verification needs (never `gh api`, merges or workflow runs),
  and a remote worktree for a PR head sha is created at that commit instead of an
  `origin/<sha>` ref that does not exist. (#223)
- **volleyd: a flake fixer for a long test id spawns its reviewers.** An agent id whose task part
  leaves no room for its role (a fixer's `fix-<test>` under `spec_reviewer` or
  `quality_reviewer`) now has that task part cut and replaced by a short hash, so every role of
  every task gets a valid, unique id; ids that already fit are unchanged. A spawn refused because
  its agent id cannot be formed is no longer retried with backoff forever: it fails once and its
  decision says the retries stopped, which the autopilot escalates. (#268)
- **volleyd: one merge_ready invariant breach opens one decision.** When a PR head moved while
  the reviewers worked, the invariant asked the same `rereview` question three times in one
  instant: autopilot answered the first two, which spent `rereview_max` and started two review
  rounds, and escalated the third to the owner. The question for a head is now asked once until
  its answer is handled, so one `rereview` starts one round and the wave goes on unattended. (#269)
- **volleyd: a release-only head move accepted while the reviewers still run no longer strands the
  task in review.** When a PR takes an "Update branch" during `spec_review` and autopilot (or the
  owner) answers `accept`, the reviews that arrive afterwards for the old head count at the new one:
  the task's head stays at the moved head, the move is not reported a second time, and the task goes
  on to the gate there instead of sitting in `spec_review` for good. (#270)
- **volleyd: a queued PR's head move seen by two checks on one tick is handled once.** When the
  merge check and the turn's gate check both see a queued PR's head move (an "Update branch"), the
  gate check no longer raises its own `pr_head_moved` alarm and re-verifies the implementer while
  the `pr_head_moved` decision is open or its `accept` is still being recorded: the accept keeps the
  reviews and the PR merges without a re-review, instead of the move voiding both reviews and the
  task escalating `budget_exhausted`. (#271)
- **volleyd, volley-desk, volley-cli: a Desk login answers a wave's Needs-you items from any
  screen.** The Desk sends `inbox_answer` and `resolve` on its own account-op topic, where the
  broker names the sender, and volleyd treats a Desk login's answer (a `steer` or `admin`
  account, or the fixed `desk` identity) as the owner's; a mailbox answer still needs the owner.
  The `desk` role gains its own `volley/_system/auth/ops/%u`: an existing broker reports the role
  as drifted, and `volley auth migrate --roles --yes` applies it (its holders reconnect); until
  then the broker drops a Desk answer, and the Desk's "did not answer" names that step to a steer
  or admin login. (#274)
- **volley-desk: Settings › Autopilot's policy table fits the pane.** Its columns are fixed widths
  (rationale gets the most room) and long monospace strings wrap, comma-joined kind lists after
  their commas, so the rationale column is no longer cut off; a pane narrower than the table
  scrolls it sideways instead of clipping it, and at phone width each rule is a stacked block. (#278)
- **volleyd: autopilot merges a task whose agents ran on a paired machine.** The merge (`gh pr
  merge --squash --match-head-commit`) went through the task's own exec, so for a task placed
  on a paired machine it ran there, where the fence never holds a MergeToken, and was refused
  (`FENCE_DENIED: remote gh pr merge`). A merge is the supervisor's act: it now always runs on
  the supervisor, in the wave's repo.

### Docs

- **docs: the autopilot release, documented.** `docs/AUTOPILOT.md`, a one-page owner's guide
  (what runs unattended, what still asks, how to opt a wave out, how to read the digest), linked
  from the root README's first use case; the volleyd README's Autopilot section opens with a map
  of every piece and its Contents lists them; the Desk README points at the Needs you window and
  Settings › Autopilot; SPEC §11.6 (conforming supervisors) gathers the autopilot MUST and MAY
  lines of §4.6.16 and §4.6.17, and the wave state's `gates` says who merges in each mode.
  [`SMOKE.md`](SMOKE.md) Plan 13 is the owner's real unattended run against a scratch repository,
  with the metrics for the tag annotation and a run-history table. (#213)
- volleyd's implementer and fixup briefs, the volley-issues skill, its brief-preface template and
  README tell agents to write a `changes/` fragment and never edit `CHANGELOG.md`; the release
  step runs `bun run changelog`. (#231)

## 0.4.0 — 2026-10-20

The Fleet release: volleyd judges which machines can run an agent, places a wave's tasks across
them and says why, and asks the owner before anything is re-placed when a machine goes down,
gets busy or leaves. A paired machine is checked, repaired and signed in to Claude from the Desk.
Owner smoke: [`SMOKE.md`](SMOKE.md) Plan 12.

### Added

- **SPEC §4.6.15 Fleet**, with the machine record's doctor fields, the new readiness verdict
  schema, placement in the wave file and wave state, `per_machine` lease caps, the
  `machine_down` decision and the Fleet tunables, each with valid and invalid examples. (#112)
- **`volley peer doctor [--fix] [--clone] [--json]`**: one line per check (tools, the
  non-interactive ssh PATH, the volley checkout and version, the repo clone and origin, GitHub
  push access, the Claude sign-in and folder trust, memory and disk), the fix for each, and
  `--fix` applying only the safe ones. `peer join` runs it first; every heartbeat carries its
  result. `volley peer invite --for <name>` / `join --replace` re-pair a machine. (#113)
- **The peer's Claude profile:** the doctor's `skills`, `hooks`, `mcp` and `sharing` rows, and
  `--fix` provisioning them, so a session on a paired machine has `/volley` and the hooks
  without reading a README. (#117)
- **Readiness:** volleyd publishes a record for its own machine and a retained verdict per
  machine (`volley/_system/machines/<name>/readiness`): ready or not in plain words, eligible
  for placement or not, from the doctor and its own probe of the ssh PATH an agent gets.
  `hosts.<name>.max_agents` and `hosts.<name>.drain`; the admin op `peer_doctor` (Repair). (#116)
  Repair's clone clones from the running wave's origin (`--clone --origin <https URL>`). (#188)
- **Placement:** `placement: auto` in a wave file (or `host: auto` on a task) places each task
  at admission on the best eligible machine, scored from CPU, slots, memory and usage headroom,
  with `placement_prefer` / `placement_avoid` and `heavy: true`. Every candidate gets a "why
  here" line; `volleyd validate` / `run` preview the placement and `volleyd status` prints it.
  A peer's own load and memory gate its admissions. (#118)
- **Machine-aware leases:** each lease holder's host, and a pool's `per_machine` cap. (#114)
- **A fresh base:** `require_fresh_base` (a worktree is cut from a freshly fetched release
  branch), `base_sha` on every task, and a steer to running implementers whose files overlap a
  PR that just merged (`placement.nudge_on_merge`). (#115)
- **Down, overload, drain, remove:** a machine down for 5 minutes opens one `machine_down`
  decision per wave (wait, re-place queued tasks, cancel); an overloaded machine takes no new
  agents until three clean heartbeats; respawn decisions offer `respawn on <best>`;
  `volley peer remove --drain | --now`. A running agent is never moved. (#120)
- **The Desk's Machines v2:** readiness and doctor rows on each card, the cap editor,
  **Repair…**, **Re-pair…** and **Remove…** sheets, Add a machine's checks / Claude / ready
  steps, lease pools grouped by host, a host chip with "why here" on each task, and the
  `machine_down` banner with re-place pre-selected. (#121)
- **Signing a paired machine in to Claude from the Mac:** **Sign in on <machine>** runs Claude
  Code's own `claude auth login` on the machine in tmux and forwards its localhost callback for
  the length of the sign-in (one fenced, transient `ssh -L`), with a phone fallback that types
  the code into a terminal, never into Volley. (#122)
- **Desk sound themes:** twelve themes of short generated clips (Synthwave by default) for 28 Desk events: clicks, drags,
  tethers, panels, agents spawning, finishing and failing, reviews, decisions, CI, gates, merges, waves, steering, account
  limits, machines and the broker, and anything that needs you. Settings › Sound picks a theme, plays any clip of any theme,
  and has master volume, mute, per-event switches, only-when-hidden, quiet hours, reduced motion and vibrate. A burst plays
  once and is read out ("12 agents completed"). The clips are generated with the ElevenLabs Sound Effects API from
  `sounds/prompts.yaml` (`bun run sounds:generate`, `sounds:pick`, `sounds:check`). The Desk's old chime is gone; the
  legacy dashboard keeps its own. (#171)

## 0.3.2 — 2026-10-20

Fixes found running a downstream project's wave through volleyd 0.3.0.

### Fixed

- An agent that ends its turn to wait on its own background work (a long test run, `gh run watch`) is no longer nudged or
  reported as stalled. volleyd reads the hooks' `background_wait` flag, a lease the agent holds, the running shells in its
  terminal footer, and recent writes under its worktree; `volleyd status` says `idle N min: <reason>`. A real stall's
  repeated `agent_stalled` decisions of one idle back off (each waits twice as long, capped by the new
  `stall_backoff_max_s`); the new `background_wait_max_s` bounds how long any of that evidence holds off the nudge, counted
  from the start of the idle (SPEC §4.3, §4.6.4). (#177)
- **CI gate stuck red on a superseded run:** volleyd judges CI on a head by the latest run per workflow and trigger event. A run
  cancelled by `concurrency: cancel-in-progress` and replaced by a newer run on the same head no longer opens `ci_failed`
  (re-verify looped on it forever), and restart reconciliation ignores its cancelled check. A cancelled run that nothing
  replaced still fails, and now says to re-run it rather than to check the provider's status page. The evidence package lists
  superseded runs under `ci.superseded` (SPEC §4.6.8). (#176)
- **Reviewer hygiene follows the repository's visibility** (`public_hygiene: auto | on | off`, tunable, default `auto`). Under
  `auto` volleyd reads the repository's visibility once per wave version (`gh repo view`, journaled as
  `repo_visibility_detected`): a public repository, or one whose visibility cannot be read (`repo_visibility_unknown` alarm),
  keeps the P1 hygiene check and the required `hygiene` block; a private or internal one gets a non-blocking P3 note and an
  optional block. `on` forces P1, `off` drops the check. The wave state carries `repo_visibility` and `hygiene_level`;
  `volleyd status` prints `hygiene: P1 (public)` / `P3 (private)` / `off`. `review-result.schema.json` no longer lists
  `hygiene` as required (SPEC §4.6.4, §4.6.8). (#178)
- `volleyd steer` to a task between stages no longer goes to the retired agent's mailbox, where it was lost. With no live agent
  the steer is queued (`steering_queued`), the CLI says so, and the task's next agent (of the `--role`, when given) gets it when
  it registers, with the same `seq` / `supersedes` chain. `volleyd status` shows `steer queued (n)`; a cancelled or done task,
  or a stopped wave, drops the queue (`steering_dropped`). `--urgent` with no live agent is an error (SPEC §4.4, §4.6.3). (#179)

## 0.3.1 — 2026-10-20

Fixes from the owner's real-machine smoke of 0.3.0, and the first changes found by running a
downstream project's dispatch through volleyd.

### Added

- **`branch_update: rebase | merge`** (tunable, config or wave file). `merge` updates a PR branch by merging the release branch in
  and pushing normally, for repositories that allow no force-push of any kind. Verification accepts a merge commit and rejects
  rewritten history (SPEC §4.6.4, §4.6.8). (#155)
- **`agent_mcp: strict | inherit`** (tunable). `inherit` lets launched agents load the user's own MCP servers (plugin servers,
  connectors) alongside volleyd's `volley` server. Every Volley server in the session carries the agent's identity. (#155)
- **Desk window pinning:** pin a window in place, or anchor it to the screen; fit and arrange leave pinned windows alone. Pins
  follow the task slot, so a respawned agent keeps its window's pin. (#154)
- **What each agent is doing:** agent windows lead with a purpose line: the task title for wave agents, an optional `title` on
  `vol_register` for others, then the worktree name, never blank. The agent id becomes secondary. Needs-you notifications use
  the same label. (#169)
- **Sessions:** interactive Claude Code sessions registered by the hooks show as `session`, in their own group, titled from the
  cmux workspace. volley-hooks publishes a rate-limited, redacted work log (one line per tool call, never prompt text) and flips
  status between working and idle. A dispatched agent that reports no progress for 10 minutes gets a badge. (#169)
- The Terminal tab says why an agent launched outside volleyd has no screen. (#169)

### Fixed

- `volley setup` reruns are idempotent for the launchd services. Setup checks cmux socket access and explains Automation mode.
  `peer join` checks `claude`, `bun` and `tmux` on the non-interactive ssh PATH. Peer errors are faster and clearer. Device
  admin sign-ins expire, and in-use ones are never offered for revocation. (#151)
- The Desk's first load no longer flashes every retained (finished) agent, a reconnect over a slow link no longer empties the
  canvas, and agents with a registry entry but no status still get their window. The Desk also gains wave status chips with an
  "Ended" group, canvas drag that never selects text, and glow styles without scrollbars. (#152)
- Test suites no longer leak temp directories. A leak guard in CI fails a run that leaves any behind. (#170)
- An intermittent volleyd test ("sweeps once at start") was made deterministic. (#151)

## 0.3.0 — 2026-10-19

The onboarding release: a fresh machine reaches a phone-signed-in Desk, a paired second machine
and a second Claude account without reading source. It is also the first tag of everything listed
under 0.2.0, which was never tagged on its own. Owner smoke: [`SMOKE.md`](SMOKE.md) Plan 11 (and
[`docs/SMOKE-v0.2.md`](docs/SMOKE-v0.2.md) for the supervisor).

### Added

- **`volley setup`**, the first-run and repair wizard: broker (mosquitto ≥ 2.1), security (the
  Dynamic Security config with the diff shown and the old file backed up, a restart, both
  listeners checked against anonymous clients, and a choice about LAN access to the WebSocket
  listener), accounts (roles, fixed identities, the macOS keychain, a one-time admin token),
  services (volleyd, the hooks, the Desk served by `volley desk serve` on port 5199, and
  `volley` / `volleyd` installed in `~/.volley/bin`, runnable on any `PATH`), the admin token
  printed as a link to the Desk, and a phone sign-in QR code. Every step says
  what it will change before changing it, and a rerun changes nothing.
- **The Desk's onboarding**: the first-run setup wizard (the same five steps through volleyd's
  `setup_plan` / `setup_apply`), one-time sign-in links and admin tokens (`#signin=<token>`),
  Settings › Broker accounts, Setup & Security, Machines and Claude accounts & usage.
- **Broker accounts and one-time tokens** on mosquitto 2.1 Dynamic Security: `volley auth add |
  rotate | revoke | list | token | signin-link | redeem`, `volley auth migrate` from a
  `password_file` / `acl_file` setup.
- **Paired machines**: `volley peer invite | join | list | remove | run`: one code gives a
  second machine its own account, an ssh tunnel service and a health heartbeat.
- **Several Claude accounts**: `volley claude add | signin | list | sync | move`, usage meters
  from the statusLine, and an `account_limit` decision at `claude.warn_at_pct` (volleyd never
  switches accounts by itself).

- **SPEC** §4.6.9 Brief preface, §4.6.10 Accounts and one-time tokens, §4.6.11 Claude account
  profiles, §4.6.12 Usage metering, §4.6.13 Broker logins and §4.6.14 Machines and pairing, with
  their JSON Schemas.
- The Desk's **Settings window** (General, Appearance, Supervisor, About, sidebar search) and the
  slimmed dock; the agent window's **context meter and Claude account picker**.
- volleyd's **per-repo brief preface** (`.volley/brief-preface.md` in the wave's repo).

### Changed

- **Bun 1.3 and 1.4** are supported (`engines.bun` is `>=1.3 <1.5`); CI runs both.
- Broker auth needs **mosquitto 2.1 or newer** with the Dynamic Security plugin (no password or
  ACL files); an older broker is refused with `BROKER_TOO_OLD`.

## 0.2.0 — never tagged (shipped in 0.3.0)

The supervisor release: Volley grows from a messaging protocol into a dispatch system that
survives the coordinator session. Owner smoke path: [`docs/SMOKE-v0.2.md`](docs/SMOKE-v0.2.md).

### Added

- **`volleyd`** (`packages/volleyd`), the durable wave supervisor: wave files and an append-only
  journal per wave, a dependency scheduler, an authority fence over every external command,
  agent spawning (worktree, identity, cmux launch, registration check, per-worktree lock), the
  implement → review → fixup → merge-ready pipeline with merge detection, decisions, ownership and
  claim, pause/stop and the kill switch, steering with acks, heavy-operation leases, load-aware
  spawn admission, recovery (heartbeat alarms, known screens, credit exhaustion, sleep/wake,
  restart reconciliation), versioned wave files, screen tails, remote hosts over ssh + tmux, and a
  launchd service.
- **`volley-hooks`** (`packages/volley-hooks`): Claude Code hooks that register the real model,
  drain and ack the mailbox from a persistent session, persist steering, report idle /
  awaiting-input / heartbeats, and wrap heavy commands in leases.
- **Volley Desk** (`packages/volley-desk`), the new dashboard behind `volley dash`: an infinite
  canvas of wave and agent windows, attention tiers, steering, settings, arrange & fit,
  appearance, phone layout. The old dashboard stays reachable with `volley dash --legacy`.
- **Broker authentication and ACLs**: `volley auth init | add-agent | rm-agent`, the reference
  ACL in `examples/mosquitto-auth/`, credentials in every client. The bundled
  `examples/mosquitto-localhost.conf` now refuses anonymous clients.
- **Must-deliver mailbox** (SPEC §4.4): persistent sessions, message ids and end-to-end acks.
- SPEC §4.6 supervisor topics and their JSON Schemas; `/volley-issues` submits waves to volleyd.
- `volley lease` (`run`, `acquire`, `release`, `status`); `volley lease run --coordinator` for
  coordinator sessions. A refused login fails closed.
- `bun run check:spec-refs`: SPEC numbering and every `SPEC §` reference in the repo are checked
  in CI.

### Changed

- CI runs on `release/**` branches and pull requests to them, not only `main`.
- Every package reports the shared version from its `package.json` (`volley --version`,
  `volleyd --version`, the MCP server's version, the legacy dashboard's top bar).
- The parity test only rewrites `packages/volley-issues/parity-report.md` on request
  (`bun run parity:update`).

### Licensing

- The vendored React Bits components in `packages/volley-desk/src/rb/` keep their upstream
  licence (MIT + Commons Clause), documented in
  [`packages/volley-desk/THIRD_PARTY_NOTICES.md`](packages/volley-desk/THIRD_PARTY_NOTICES.md).

## 0.1.3 — 2026-05-16

`volley notify` and dashboard browser notifications. Earlier 0.1.x releases: see the git tags.
