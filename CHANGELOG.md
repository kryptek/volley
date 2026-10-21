# Changelog

All workspace packages share one version. Dates are release-tag dates.

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
