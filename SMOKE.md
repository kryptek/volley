# Manual smoke checklist (release-level)

This file collects feature-level smoke recipes that span multiple packages — the per-package SMOKE.md files under `packages/*/SMOKE.md` cover narrower scopes (volley-issues dispatch, volley-skill / volley-wait skill installation, etc.). Add a new section per plan that ships a release tag.

**Next release:** deploy the tag to the supervisor's machine with `volley deploy v<X.Y.Z>` (after a `--dry-run`), then confirm the Desk shows the new version in Settings › About, `volley desk serve`'s log has no stale-build warning, and `volleyd status` answers. See [`volley deploy`](#deploying-a-release-volley-deploy) below.

**Presence (#483)** (an owner who leaves has nothing to keep alive: reconnecting, away, gone only when something waits, back online by name) is [Presence](#presence-483) below. **v0.5.0** (Autopilot: an unattended night against a scratch repository, merges by the supervisor, a planted flake fixed, the release train, the digest and the Needs you window on the phone) is [Plan 13](#plan-13--autopilot-v050) below. **v0.4.0** (the Fleet: pairing from the Desk, doctor and Repair, signing a paired machine in to Claude, automatic placement, a machine going down, overloaded and removed) is [Plan 12](#plan-12--fleet-v040) below. **v0.3.0** (onboarding: `volley setup`, the Desk's setup wizard and sign-in links, pairing, Claude accounts) is [Plan 11](#plan-11--onboarding-v030) below. **v0.2.0** (volleyd, volley-hooks, broker auth, the Desk) has its own owner smoke path: [`docs/SMOKE-v0.2.md`](docs/SMOKE-v0.2.md).

---

## Deploying a release (`volley deploy`)

Owner checklist on the supervisor's machine, once per release tag (about 5 minutes):

1. `volley deploy v<X.Y.Z> --dry-run` from any directory: it names the services checkout (from
   volleyd's installed service), the current tag and the target, and lists every command. Nothing
   changes (a dirty checkout exits 3 and lists the paths).
2. `volley deploy v<X.Y.Z>`: one `ok` line per step, ending
   `deployed v<X.Y.Z> (was v<previous>); waves continue (volleyd reconciles on start)`.
3. Open the Desk: Settings › About shows the new version, and the release's UI is there.
4. `volleyd status` answers; a wave that was running before the deploy is still running.
5. Optional, rollback: in a scratch clone, break the Desk build of a test tag and deploy it with
   `--repo <clone>`: the deploy reports the failed step and `rolled back to <previous>`.

---

## Presence (#483)

**Done means:** an owner who leaves has nothing to keep alive. The Desk and `volleyd status` read
the coordinator's presence from its MCP connection's will: `reconnecting`, then `away
(autopilot)`, `gone` only while something waits that only the owner can answer, and back to
`online` as soon as a session with the same `VOLLEY_COORDINATOR` connects. A connected session
that stays quiet stays `Working`. About 15 minutes for steps 1–4 (step 5 runs on its own for two
hours), with an autopilot wave running against a scratch repository and the Desk open. The
owner's guide is [`docs/AUTOPILOT.md`](docs/AUTOPILOT.md#presence-nothing-to-keep-alive).

Before you start, shorten the grace so the plan fits: `volleyd config set
autopilot.reconnect_grace_s 120` (restore it afterwards with `volleyd config set
autopilot.reconnect_grace_s 900`). Remove any cron job, launchd agent or scheduled prompt left
over from an earlier release that republishes the coordinator's status; nothing below needs one.

- [ ] **1. Leave.** End the coordinator's Claude Code session (`/exit`), or restart its MCP
  server. **Pass:** at once on `/exit` (within about 90 s, the MQTT keepalive × 1.5, if the
  connection just drops) the Desk's coordinators window reads `Coordinator reconnecting · 0m`
  with a neutral `reconnecting` chip and no `claim it`, and `volleyd status <wave>` prints
  `owner: <name> (via <agent id>) · reconnecting`. After `reconnect_grace_s` the row reads `Owner
  away · autopilot · last seen 2m ago`, with no Needs-you banner and nothing ringing, and `volleyd
  status <wave>` prints `· away (autopilot) · last seen …`. Note both times.
- [ ] **2. No claim while reconnecting.** Repeat step 1 and, inside the grace, run `volleyd claim
  <wave> --by smoke`. **Pass:** refused, `wave is owned by <name> (via <agent id>), reconnecting
  (gone <n>m ago, grace 2m); claim allowed at <time> unless it reconnects`; the wave keeps its
  owner.
- [ ] **3. Gone only when something waits.** While away, open an owner-only decision (e.g. let
  the release train reach its `release_go`, or open a `stage_go`). **Pass:** the row turns `No
  coordinator · claim it` with a `needs you` chip, the wave window shows the Needs-you banner, the
  phone rings once, and `volleyd status <wave>` prints `· gone · 1 decision waits for you`. Answer
  it from the Desk's Needs-you window: the row goes back to `Owner away · autopilot`.
- [ ] **4. Come back.** Start a Claude Code session whose MCP server has the same
  `VOLLEY_COORDINATOR`. **Pass:** within seconds the row reads `Working` and `volleyd status
  <wave>` prints `· online`; `volleyd events <wave> --cursor smoke` shows `owner_reconnected {
  owner, agent_id, previous_agent_id }`; nothing was claimed.
- [ ] **5. Quiet is not gone.** Leave that session connected and idle for two hours. **Pass:**
  `volley sub --pattern 'volley/+/<agent id>/progress' --timeout 7200` prints nothing (exit
  `124`: the session published nothing to stay present), and the row stays `Working` throughout.

### Results

| Step | Time | Result | Notes |
|---|---|---|---|
| 1. leave: reconnecting at / away at | | | |
| 2. claim refused while reconnecting | | | |
| 3. gone with a decision; away after answering | | | |
| 4. online, `owner_reconnected` | | | |
| 5. two hours quiet: nothing published, still `Working` | | | |

---

## Plan 13 — Autopilot (v0.5.0)

**Done means:** the owner dispatches ten or more small issues at night against a scratch
repository, goes to bed, and in the morning finds them merged by the supervisor, the planted
flake fixed by its own fixer task, and the release train waiting on the owner's go, with
everything that needed a person answered from the phone or the terminal, without reading
source. The simulated soak (`bun run test:soak`, CI's `soak` job) is the acceptance gate for the
code; this plan is the owner's real run on real GitHub. Every step is a checkbox with what a
pass looks like. A red item is a bug: file it, fix it in its own PR, re-run the step, and tag
`v0.5.0` only once every box is ticked. The owner runs this plan and tags; production is always
the owner's.

The owner's guide to what is being exercised is [`docs/AUTOPILOT.md`](docs/AUTOPILOT.md).

**You need:**

- **Plan 12's machine** (the Mac with volleyd and the Desk running this release head: the
  services' checkout on the release branch, volleyd and the Desk restarted), and optionally the
  paired second machine; the phone from Plan 11 with the Desk open once and notifications
  allowed.
- **`VOLLEY_COORDINATOR`** set (e.g. `coord-main`) in the volley MCP registration's `env` and in
  your shell profile, as in the root README's Quickstart step 4. `volleyd status` lists waves
  owned by that name after a submit.
- **A scratch repository**: a throwaway **public** GitHub repository you create for this run
  (nothing else lives there), cloned on the supervisor's machine, with CI on pull requests and
  on pushes to `release/**`, a test suite, and:
  - **a flaky test planted on purpose**: one test, in a file no issue touches, that fails about
    one run in three (e.g. it asserts a random draw is above 0.33). Push it to `main` and check
    CI goes red on it at least once in a few re-runs;
  - **ten or more small open issues** (one function, one file, one test each; two of them
    touching the same file so the merge queue has a conflict to update; three with
    `Depends on: #<n>` lines so the order matters);
  - **a release playbook**, `.volley/release.yaml` on `main`, with a version bump, a changelog,
    a smoke stage and **one owner-gated stage**:

    ```yaml
    version: 1
    stages:
      - name: bump
        brief: Bump the version to the release version and commit it to the release branch.
        run:
          - [bun, run, bump, --version, 0.1.0]
        verify: { commits_on_release: true }
      - name: changelog
        brief: Write CHANGELOG.md's 0.1.0 section from the merged PRs and commit it.
        verify: { commits_on_release: true, files: [CHANGELOG.md] }
      - name: smoke
        brief: Run the smoke script against the release branch and report the result.
        run:
          - [bun, run, smoke]
        verify: { result: { smoke: passed } }
      - name: tag
        brief: Tag the release branch's tip v0.1.0 and push the tag.
        gate: owner
        verify: { tag: "v0.1.*" }
    ```

    Use whatever commands the scratch repository has; what matters is two plain stages, a stage
    that reports a result, and one `gate: owner` stage. `volleyd validate` on the wave file
    prints `release playbook: .volley/release.yaml (4 stages, 1 owner-gated)`.
- A pushed release branch `release/<yyyy-mm-dd>-autopilot-smoke` cut from `main`.
- A notebook for the metrics below; note the wall-clock time of each step.

**Before you start:** `volleyd policy` prints the table with `autopilot: on`; `volleyd config
get` shows `autopilot.merge: auto`; the Desk's Settings › Autopilot shows the same table. Clear
the inbox: `volleyd inbox` lists nothing open.

### (a) Dispatch at night and leave

- [ ] In a Claude Code session in the scratch clone (the coordinator), run `/volley-issues` with
  every issue number and the release branch. The skill writes the wave file with `merge: auto`
  and `branch_update: merge`, asks go / hold / cancel with an `AskUserQuestion` picker, and
  submits with `--owner "$VOLLEY_COORDINATOR"`.
  **Pass:** the picker is also a row in the Desk's Needs you window (kind `picker`); answer
  `go` **in the terminal**. The Desk row flips to `answered on <machine>·terminal` and fades; the
  session submits, prints the wave id and where to watch it, and does not start a per-event
  loop.
- [ ] End the coordinator session (`/exit`). **Pass:** `volleyd status <wave>` still names the
  coordinator name as owner; the Desk shows the coordinator as reconnecting, then away
  (autopilot), and the wave keeps running (no `claim it` needed). Note the time: this is the
  start of the run.
- [ ] Go to bed. Leave the Mac awake and on the network; leave the phone where it can ring.

### (b) Overnight, without you (check in the morning)

- [ ] **Merges by the supervisor.** `volleyd events <wave> | grep merged_by_supervisor` has one
  line per merged task; on GitHub each PR is squash-merged, at the head its evidence package
  names.
- [ ] **The flake.** The planted test went red on some PR's head: `volleyd events <wave>` has
  `remediation_requested { kind: fix_flake }` for it, a `fix-<slug>` task ran, its PR fixed the
  root cause (no skip, no retry wrapper, no quarantine) and merged, and the PRs that waited on it
  merged after it.
- [ ] **The conflict.** The two issues touching one file: the second was brought up to date by a
  merge of the release branch (a normal push, no force-push), re-checked by CI and merged.
- [ ] **Answers given by autopilot** are in `volleyd events <wave> | grep decision_auto_resolved`
  (each with its policy and rationale); nothing it answered rang the phone.
- [ ] **What rang.** The phone got at most one digest push plus one per genuine escalation. Each
  escalation's question starts `Autopilot could not resolve this (<why>): `.

### (c) The morning: digest and Needs you on the phone

- [ ] **The digest.** Read the push on the phone first, then `volleyd digest <wave>` and the
  Desk's digest card. **Pass:** the three agree: shipped (each task with its PR, merge sha and
  `merged_by: supervisor`), handled by autopilot (decisions, the flake with its fixer and the
  PRs it released, the conflict, retries, merges), waiting for you (the release train's
  `stage_go` for `tag`, or `release_go`, owner-only).
- [ ] **Needs you on the phone.** Open the Desk on the phone and the Needs you window (Dock tile).
  **Pass:** stacked full-width cards, buttons at least thumb size; the release item shows the
  stages with their evidence.
- [ ] **`stage_go` from the phone.** The train stops before the owner-gated `tag` stage. Answer
  its `stage_go` **go** from the phone. **Pass:** the row reads `answered on desk·<device> · go`;
  `volleyd events <wave>` has its `inbox_answered` with the Desk as `where`; the `tag` stage's agent runs
  and the tag `v0.1.0` exists on GitHub at the release branch's tip.
- [ ] **`release_go` from the phone.** Every stage verified; `release_go` opens (one more push).
  Answer **go** from the phone. **Pass:** `release_done`, the wave is `complete`, and a second
  answer of the same item from `volleyd inbox answer <id> go` is refused `already answered on
  desk·<device>`.

### (d) One picker from the Desk, one from the terminal

- [ ] Start a coordinator session again (same `VOLLEY_COORDINATOR`). Ask it for something that
  ends on an `AskUserQuestion` picker (e.g. "ask me with AskUserQuestion which issue to look at
  next"). Answer it **from the Desk's Needs you window**. **Pass:** the session's picker moves
  to the chosen option and continues within a few seconds; the row reads `answered on desk·…`;
  the item is gone from `volleyd inbox` and from the phone's Needs you window.
- [ ] Ask for a second picker and answer it **in the terminal**. **Pass:** the Desk and the
  phone flip the row to `answered on <machine>·terminal` and drop it; `volleyd inbox` lists
  nothing open; a Desk click on the stale row (if still shown) is refused with that line.

### Metrics for the tag annotation

Record these in the `v0.5.0` tag's annotation (`git tag -a v0.5.0`), one per line. If the tag
lands on a later day than the `## 0.5.0 — <date>` heading in `CHANGELOG.md` (its dates are
release-tag dates), correct that date in a `release:` commit before tagging.

```
tasks: <n> (issues <n>, fixer tasks <n>)
merged by supervisor: <n> / <n> (merged by anyone else: <n>)
flakes fixed: <n>
merge conflicts updated: <n>
decisions auto-resolved: <n>
escalations: <n> (<kinds>)
owner decisions answered: <n> (desk·phone <n>, desk·desktop <n>, terminal <n>, cli <n>)
pushes received on the phone: <n>
wall time: submit <hh:mm> → last merge <hh:mm> → release_go <hh:mm> (<h> h <m> m)
```

### Run history

| Date | Release head | Tasks | Merged by supervisor | Flakes fixed | Escalations | Owner decisions (where) | Wall time | Result |
|---|---|---|---|---|---|---|---|---|

### Results

```
OWNER RESULTS (<date>, release head <sha>, scratch repository created for the run):
  before: policy table shown (CLI, Desk); inbox empty:
  (a) picker in terminal + Desk row flipped: / session ended, wave kept running, reconnecting → away:
  (b) merges by supervisor __/__: / flake fixer task merged, waiting PRs released: / conflict updated by merge, no force-push:
      auto-resolved __, none rang: / pushes overnight __:
  (c) digest = push = card: / phone layout: / stage_go from the phone, tag pushed: / release_go from the phone, late answer refused:
  (d) Desk picker answered, closed everywhere: / terminal picker answered, closed everywhere:
  Red items (issue, fix PR, step re-run):
```

---

## Plan 12 — Fleet (v0.4.0)

**Done means:** the owner pairs a real second machine from the Desk, repairs it, signs it in to
Claude from the Mac's browser and from a phone, runs a wave that places itself, and watches a
machine go down, get busy and leave, without reading source. Every step below is a checkbox
with what a pass looks like. A red item is a bug: file it, fix it in its own PR, re-run the step,
and tag `v0.4.0` only once every box is ticked.

Anything Plan 11 already covers (setup, the phone sign-in, the credential audit's setup, the
second Claude account) is not repeated: run [Plan 11](#plan-11--onboarding-v030) first on the same
release head, or have its results for it.

**You need:** the Mac from Plan 11 (volleyd, the Desk, an admin Desk session, the coordinator
login exported as in its step 9), a phone on the same Wi-Fi, and **one real second machine**,
called `box-a` below (Linux or macOS): bun, git, tmux, `gh` signed in with push access to the
test repo, `claude` installed but **not signed in** and, to begin with, **not on the
non-interactive ssh PATH** (only in the interactive shell's, e.g. `~/.zshrc`), a Volley checkout
of this release with `bun install` run, and key-based ssh both ways with the Mac. The test repo
from Plan 11 with **three** small open issues and a pushed release branch
`release/<yyyy-mm-dd>-fleet-smoke`. Keep a stopwatch; note the time each step takes.

`volley peer join` runs the doctor and the ssh PATH check before it uses the code, and stops on
any blocking row, so a machine cannot pair broken. Step (a) therefore sees join refuse first,
pairs a clean machine, then breaks three things on purpose (the PATH, the install, the clone) so
the Desk's rows and **Repair** have something real to show and fix.

**Before you start** (on the Mac): a heavy pool with one slot per machine, in
`$VOLLEYD_HOME/config.yaml` (default `~/.volley/volleyd/config.yaml`), then restart volleyd
(`launchctl kickstart -k gui/$UID/systems.volley.volleyd`; to move it to a release instead, `volley deploy <tag>`):

```yaml
lease_pools:
  smoke-heavy: { capacity: 2, per_machine: 1, match: ["^sleep 90$"] }
```

`volleyd config get` shows the pool, and the Desk's Settings › Supervisor › Lease pools has a
`smoke-heavy` card reading `0/2` with `1 per machine`.

### (a) Pair from the Desk, then break it and repair it

- [ ] Settings › Machines › **+ Add a machine**. Step 1 shows a code; step 2 the command
  `volley peer join <code> --to <you@mac>` with **Copy** (fill in the ssh address first). Run it
  on `box-a` with `--repo <path for the clone>`, a clone of the test repo you make first
  (`git clone <test repo> <path>`).
  **Pass:** join stops before using the code: `claude` is not on the PATH of a non-interactive
  ssh session, with the exact line for the login shell's file (zsh: `~/.zshenv`; bash: the top
  of `~/.bashrc`), and says the code is still valid. A plain `bun install` (not the doctor's)
  also stops it on `volley.installed` with `volley peer doctor --fix` to run: run that if so.
- [ ] Add the printed line on `box-a` and run the same join again. **Pass:** `paired`; the Desk's
  step 3 (Checks) shows `box-a`'s rows from its first heartbeat within 60 s. Time from the
  first join to this.
- [ ] **Break the PATH.** Take the line out again (`ssh box-a 'command -v claude'` prints
  nothing). **Pass:** within one PATH probe (`path_probe_interval_ms`, at most 5 min) the card's
  verdict reads `not ready` with a line naming `claude` and the ssh PATH (the supervisor's probe
  decides), and the `claude_on_path` row is `!` once the next doctor run sees it, with the
  command (Linux: `sudo ln -s ~/.local/bin/claude /usr/local/bin/claude`; macOS: the
  `~/.zshenv` line) and **Copy**. Run the command on `box-a`, then **Check again** (step 4 of
  the Stepper) or **Repair…** without applying (both run a dry doctor; a Repair also has volleyd
  probe the PATH again on its next re-compute).
  **Pass:** the row turns ✓ and the reason is gone. Time it.
- [ ] **Break the install and the clone.** On `box-a`:
  `rm <volley checkout>/node_modules/.volley-lock-sha256` (what a `git pull` without a reinstall
  looks like to the doctor) and `mv <clone> <clone>.bak`. On the next heartbeat `volley.installed` and `repo.clone` are ✗.
  **Repair…** opens the plan sheet: "This will:" lists `bun install --frozen-lockfile` in the
  volley checkout; "You run on box-a:" lists the rest (the Claude sign-in). Turn on **Also clone
  the wave repo**, **Apply** with no wave running.
  **Pass:** refused before anything runs on `box-a`: `the wave repo's origin is not known (no
  running wave's clone reports one) …` (the clone comes from the running wave's origin).
  Now start a wave of the test repo on the Mac (Plan 11's `smoke.yaml` with a new `wave:` id and
  `host: local` on its task: `volleyd run <file>`), wait until the Mac's card shows the repo's
  `repo.origin` ✓, then **Repair…**, **Also clone the wave repo**, **Apply** again.
  **Pass:** the sheet waits (a doctor run may take minutes), then the rows re-render:
  `volley.installed` ✓, `repo.clone` / `repo.origin` ✓ (a fresh clone at the path), nothing new
  red; `volleyd events _system | tail` has
  `peer_doctor_run { … fix: true, clone: true, ok: true }`; on `box-a`,
  `git -C <clone> remote get-url origin` is `https://<the test repo's host/path>` (volleyd
  passes the running wave's origin as `--clone --origin <https URL>`, #188).
  Time it. Remove `<clone>.bak`.
- [ ] **Repair…** again and **Apply**. **Pass:** every fix says "already done". Then
  `volleyd stop <wave>` the wave you started.

### (b) Provisioning rows

- [ ] On the `box-a` card, the `skills`, `hooks`, `mcp` and `sharing` rows. **Pass:** all four
  ✓ after (a)'s Repair (if one is `!`, **Repair…** once more must turn it ✓; record which).
- [ ] On `box-a`, in the clone, start an interactive `claude` session (it will ask you to sign
  in: do that in (c) first if you prefer, then come back) and run `/volley list`.
  **Pass:** it lists the Mac's agents and `box-a`'s own session; `/volley-issues` is also
  offered.

### (c) GUI sign-in from the Mac

- [ ] The card's line says Claude is not signed in. **Sign in on box-a**: the sheet goes
  *Starting…* → **Open sign-in ↗**. Open it in the Mac's browser and sign in.
  **Pass:** the sheet shows *Signed in · <plan>* and the card turns green
  (`Claude signed in · <plan>`, the verdict `ready for agents` once nothing else blocks). Time it.
- [ ] **The forward is gone:** on the Mac, `ps -ax | grep -- '-N -L 127.0.0.1'` shows no
  `ssh -N -L` left, and on `box-a` `tmux ls` has no `volley-signin-primary`.
- [ ] **Audit: nothing credential-shaped kept.** On the Mac and on `box-a`:
  `grep -rIl -E 'sk-ant-|oauth|refresh_token|access_token' ~/.volley` → nothing (the sign-in's
  `~/.volley/signin/primary/` on `box-a` holds only `signin.sh`, `browser.sh` and the url file);
  `volleyd events _system | grep -i -E 'sk-ant-|token"'` → only `claude_signin_*` events with
  `acct` and `plan`, never a URL with a code or a token; `volley sub 'volley/_system/claude/#'`
  for the next sign-in shows the localhost sign-in URL and the attach command, never a
  credential.

### (d) Phone fallback

- [ ] Sign `box-a` out of Claude (`/logout` in a `claude` session there), wait for the card's
  line to say so (or **Repair…** without Apply to refresh), then **Sign in on box-a** again and
  open **From a phone instead**.
  **Pass:** the sheet shows the phone link and the copyable
  `ssh <box-a> -t tmux attach -t volley-signin-primary`, and has no text field of any kind.
- [ ] Open the link on the phone and sign in; run the attach command in a terminal on the Mac;
  type the code the phone shows **into that terminal**.
  **Pass:** the terminal's `claude` accepts it, the sheet and the card turn green. Time it.

### (e) Automatic placement

- [ ] `fleet.yaml` (the three issues; T1's issue asks the agent to run `sleep 90` once, the
  heavy command):
  ```yaml
  wave: <yyyy-mm-dd>-fleet-smoke
  repo: <abs path of the test repo on the Mac>
  release_branch: release/<yyyy-mm-dd>-fleet-smoke
  model: claude-opus-5-5
  pipeline: [implement, merge_ready]
  placement: auto
  placement_avoid: [<the Mac's machine name>]   # the "this one" card's name
  heavy_pools: [smoke-heavy]
  tasks:
    T1: { issue: <n1>, heavy: true }
    T2: { issue: <n2> }
    T3: { issue: <n3>, host: box-a }   # pinned: waits behind box-a's cap of 1
  ```
  `volleyd validate fleet.yaml`. **Pass:** `ok`, and the preview
  `if admitted now: T1 → <machine> (<score>), T2 → <machine> (<score>)` with the note that the
  real decision is made at admission (each line is that task alone, so both may name `box-a`).
- [ ] `volleyd config set hosts.box-a.max_agents 1` (put it back afterwards), then
  `volleyd run fleet.yaml`. Avoiding the Mac sends the first task admitted to `box-a`; with
  `box-a` then full, the Mac is the only eligible machine left for the other.
  **Pass:** T1 and T2 start on **different** machines; the second one's line for
  `box-a` reads `ineligible: 1/1 agents (max_agents)`. `volleyd status` prints, under each,
  `on <machine> (auto, <score>)` and every candidate's line; the Desk's host chip on each task
  (`T1 · box-a`) opens a popover with `placed automatically at admission` and the **same lines,
  in the same order**. The agent windows' footers read `on <machine>`.
- [ ] When T1's agent runs `sleep 90`: **Pass:** Settings › Supervisor › Lease pools ›
  `smoke-heavy` shows `1/2` with the holder grouped under T1's machine (`volley lease status` agrees,
  grouped by host).

### (f) Down

One of T1 / T2 is running on `box-a` and T3 is pinned there, waiting behind its cap of 1.

- [ ] Stop the peer service on `box-a` (`systemctl --user stop volley-peer.service`, or
  `launchctl bootout gui/$UID/systems.volley.peer`). **Pass:** within 90 s the card greys out
  (`down · last seen … · no heartbeat`), spawns for `box-a` park, and the parked task's
  `why_waiting` names `box-a`.
- [ ] Wait. **Pass:** about 5 minutes after it went down a `machine_down` Needs-you appears on
  the wave: the host, how long it has been down, the tasks there (running ones named as left
  alone), and **re-place queued tasks** pre-selected. Time from the stop to the banner.
- [ ] **Answer** with re-place. **Pass:** the queued task is placed again without `box-a`
  (T3's chip reads `re-placed by owner on <date>`) and spawns on the Mac; `volleyd events <wave>`
  has `task_placed { by: "decision", from: "box-a" }`.
- [ ] Start the service again. **Pass:** the card is live within a heartbeat; an agent that was
  running on `box-a` before the stop is still the same agent (same id, same tmux session, its
  work carried on): **nothing running was touched**.

### (g) Overload

- [ ] `volleyd config set hosts.box-a.max_agents 4` again. With an agent running on `box-a`
  (from (e), or a new one-task wave with `host: box-a`), load it:
  `for i in $(seq $(nproc 2>/dev/null || sysctl -n hw.ncpu)); do yes > /dev/null & done`. **Pass:** within two heartbeats the card
  reads `overloaded: load … on … cores · no new agents`; a task that becomes ready meanwhile
  goes to the Mac or waits (`why_waiting` names `box-a: overloaded …`), never to `box-a`; the
  running agent keeps narrating.
- [ ] `kill %1 %2 …` (or `pkill yes`). **Pass:** the card reads `recovering: … clear for 1/3
  samples`, then `2/3`, and `box-a` is eligible again after the third clean heartbeat.

### (h) Drain and remove

- [ ] With exactly one agent running on `box-a`: Machines › `box-a` › **Remove…** →
  **Drain, then remove**. **Pass:** the card reads `draining · 1 agent left`; nothing new is
  placed there.
- [ ] Let that agent finish. **Pass:** `box-a` disappears from Machines; `volley auth list` has
  no `box-a` account; the service on `box-a` stops itself within 60 s ("this machine was
  unpaired"); `volleyd events _system` has `peer_drain_started`, then `peer_removed`.

### Results

```
OWNER RESULTS (<date>, release head <sha>, box-a: <os/arch, cores>):
  setup: smoke-heavy pool shown (0/2, 1 per machine):
  (a) join refused on the PATH: / paired, rows in step 3 (time __): / PATH broken: not ready + claude_on_path row, Check again green (time __):
      Repair: clone refused with no wave: / bun install + clone applied (time __); second Repair all "already done":
  (b) skills / hooks / mcp / sharing green: / /volley list on box-a:
  (c) GUI sign-in (time __), card green with plan: / forward gone (ps, tmux ls): / audit (~/.volley, journal, broker):
  (d) phone fallback (time __), no input in the sheet, card green:
  (e) preview printed: / T1 and T2 on different machines: / why-here = volleyd status: / heavy lease under its host:
  (f) parked within 90 s: / machine_down after __ min, re-place pre-selected: / re-placed, spawned on the Mac: / back, nothing touched:
  (g) overloaded within __ s, nothing new placed, running agent kept going: / eligible after 3 heartbeats:
  (h) draining · 1 agent left: / removed after it finished, account revoked, service exited:
  Red items (issue, fix PR, step re-run):
```

---

## Desk sound themes (#171)

**Done means:** every theme sounds right to the owner, and the Desk's sound rules hold in a real
browser. About 15 minutes, in the Desk's demo mode (`volley dash`, then add `?demo=1`), with the
speakers on.

1. Open Settings › Sound. Pick **Arcade 8-bit**: its card lights up, a thin bar runs until it has
   loaded, and the browser's Network panel shows one `manifest.json` and up to 28 `.ogg` clips from
   `sounds/arcade/` (under 200 KB) and nothing from any other theme.
2. On every theme card, press each chip of its audition row. Each plays once, in that theme, and the
   picked theme does not change. Note any clip to re-roll as `<theme>/<event>` in a comment on
   #171; the comment that has none reads "audition passed".
3. Close Settings, click a dock item and drag a window by its title bar: a click, a lift and a drop.
   Toggle the tethers in the dock: on and off sound differently.
4. Wait for the demo wave to put something into Needs you (the top-bar pill counts up): the
   Needs-you sound plays once, however many items arrived together.
5. Turn on **Only when the Desk tab is hidden**. Agent and wave sounds stop while the tab is in
   front; switch to another tab and they play again; clicks never play there. Turn it off.
6. Turn on **Mute all**: nothing plays, but the audition chips still do. Turn it off.
7. Turn on reduced motion in the OS: nothing plays. Turn off **Follow reduced motion**: sounds
   play again.

---

## Plan 11 — Onboarding (v0.3.0)

**Done means:** a fresh machine gets to a Desk signed in on a phone, with a paired second machine
and two Claude accounts, without anyone reading source. The target is **10 minutes** from
`git clone` to the phone signed in.

**Run it on a release head that has #133** (`volley setup` installs `volley` / `volleyd` in
`~/.volley/bin`, as scripts that run bun by its full path, and puts it on the services' PATH)
**and #138** (the admin token printed as a link, setup's install recorded for the Desk). Without #133 every Desk sign-in by link fails on a
fresh machine (part A, first run).

The smoke has two parts:

- **A. Automated.** Run on a throwaway Linux "fresh machine" (a container: mosquitto 2.1 and bun,
  nothing else) and a second container as the paired machine, on a private Docker network. It
  publishes no host ports, so the everyday broker on `1883` / `9001` is never touched. The
  recorded runs are under [A. Results](#a-results); [A. How to rerun it](#a-how-to-rerun-it)
  rebuilds them.
- **B. Owner.** The part that needs real hardware and real accounts: a Mac (launchd, the macOS
  keychain), a phone on the LAN, a real second machine and a second Claude account. About 30
  minutes. Every step says what to type or click and what a pass looks like. Its commands were
  dry-run in part A wherever a container can run them.

### A. What the automated run covers

| | Check | Pass |
|---|---|---|
| (a) | `volley setup` on a clean anonymous broker, timed from `git clone` | config diff shown, old config backed up, both listeners refuse anonymous clients, services up, rerun changes nothing |
| (a) | the one-time admin token's link, in a fresh desktop browser (Playwright) | signed in as `admin`, Setup & Security opens with nothing pending; reuse refused |
| (a) | the phone QR link, in phone emulation (390×844, touch) | signed in as `steer`; reuse refused; a link opened after its lifetime refused |
| (a) | an admin token on the phone: typed into the open tab, opened in a new tab, pasted in Setup & Security | open tab: nothing happens (by design, see step 6); new tab and paste box: signed in as `admin` |
| (b) | Settings: each of the 8 sections found from the sidebar search by one of its keywords | listed, opens |
| (b) | Supervisor › Hard ceiling changed with the keyboard | `applied · v2`; volleyd's `config.yaml` and `volleyd config get` agree |
| (c) | pair a second machine with a code, then remove it | `tunnel up` + heartbeat; after `remove`: account gone, broker refuses it, its service stops itself |
| (e) | credential audit | no Volley process opens or stats a Claude credential file (strace, decoys planted, positive control) |
| B | the owner steps' commands | the step 8–9 wave files pass `volleyd validate`; `volley claude list` needs the coordinator's login first |

Not automated, so in part B: the macOS keychain and launchd paths, a real phone over Wi-Fi, a
wave task on the paired machine (it needs `claude` signed in there, and a container must never
hold Claude credentials), and all of (d), which needs a second real Claude account.

### A. Results

```
RESULTS 1 (2026-10-19, release/2026-10-18-onboarding @ 02d4d70, then with #133 applied):
  Environment: eclipse-mosquitto:2.1.2-alpine + bun 1.3.14 (musl), user `owner` (not root),
  layout `container`, a systemctl stand-in that runs the unit files setup writes. Second
  machine: the same image. Docker network only, no published ports.

  (a) volley setup --yes --layout container on an anonymous broker (1883 + 9001 open):
      run 1   Broker found 2.1.2, both listeners "accepts anonymous clients". Security showed the
              config diff, wrote it, backed the old one up to
              mosquitto.conf.volley-backup-<timestamp>, created the Dynamic Security state file +
              admin login, then stopped: "restart your container yourself" (container layout).
      restart the broker by hand (about 2 s)
      run 2   7 s: both listeners "refuses anonymous clients" (also the LAN address); roles +
              volleyd/desk/coordinator created, passwords printed once; admin token printed;
              volleyd + volley-desk user services started; hooks installed; Desk built;
              phone QR printed; "Setup complete".                                         PASS
      rerun   1 s, every step "already done".                                             PASS
      anonymous mosquitto_pub -> "Connection Refused: not authorised".                    PASS
      RED, fixed in #133: the admin token and the phone link were both refused
              ("Executable not found in $PATH: \"volley\""). volleyd redeems tokens with
              `volley auth`, and nothing put `volley` on the services' PATH. Then the auth dir
              (`--layout` / `--dir` did not reach volleyd's `volley auth`). Every result below is
              with #133.
      admin token, fresh desktop browser (1440x900)     signed in as admin in 5.1 s         PASS
      the same token again                              refused: "token … was already used" PASS
      phone link, phone emulation (390x844, touch)      signed in as steer in 6.1 s         PASS
      the same link again                               refused: "token … was already used" PASS

  (b) Settings search (admin session): every section listed and opened from one keyword:
      narration→General, background→Appearance, ceiling→Supervisor,
      weekly→Claude accounts & usage, rotate→Broker accounts, pair→Machines,
      qr→Setup & Security, license→About Volley (8/8; each search listed only that section). PASS
      Supervisor › Hard ceiling 12 → 13 (ArrowRight on the slider): "applied · v2",
      config.yaml `hard_ceiling: 13`, `volleyd config get` says version 2, updated_by the
      admin account.                                                                     PASS

  (c) pairing (second container, key-based ssh both ways):
      peer invite (admin account)                       code printed                        PASS
      peer join <code> --to owner@<host> --repo …       paired in 2 s, peer.json 0600,
                                                        trust line printed                  PASS
      first try without --remote-volley: "bash: line 6: volley: command not found" (`volley` is
      not on the supervisor's non-interactive ssh PATH; #138 now says to pass --remote-volley).
      peer list on the host                             "tunnel up, linux 32 cores, load …,
                                                        last seen …" (after the
                                                        container's sshd allowed forwarding) PASS
      peer remove machine-b                             "account revoked, hosts.machine-b
                                                        removed, machine record cleared"    PASS
      the peer's login afterwards                       "not authorised"                    PASS
      the peer's service                                stopped by itself within 60 s: "the
                                                        broker refused machine-b: this
                                                        machine was unpaired"               PASS
      a wave task on the paired machine                 NOT RUN here (needs claude signed in
                                                        on the peer): part B, step 10

  (e) credential audit: decoys planted at ~/.claude/.credentials.json and a profile's
      .credentials.json. strace (open/openat/stat*/access*/readlink/execve, -f) over:
      volleyd for 75 s (it redeemed a phone link from a browser, ran `volley auth redeem` and
      `volley auth list`), the SessionStart and PostToolUse hooks, the statusline publisher,
      `volley claude list`, `volley auth list`, `volley setup --repair`, `volley desk serve`:
      48,592 syscalls, 0 touching a credentials file. Positive control: `cat` of the decoy
      under the same strace shows up.                                                  PASS
      Source check: the only `security` calls are for Volley's own `volley-broker` item;
      volleyd reads `~/.claude.json` (folder trust, the `mcpServers` section) and never
      `.credentials.json` (claude/sharing.ts); usage comes from the statusLine's stdin.

RESULTS 2 (2026-10-19, release @ c58d168 + #133 + #138 + this PR, the three merged together
cleanly; on that tree volley-cli 386, volleyd 1433 and volley-desk 914 tests pass). bun lives in
/opt/bun: on the interactive PATH, not on sshd's default PATH (as on a Mac).
  (a) timed, fresh container, anonymous broker running:
        git clone (an archive of the tree)  0.5 s
        bun install                         2.9 s
        volley setup --yes, run 1           0.1 s   (stops: restart the container's broker)
        broker restart (by hand)            1.6 s
        volley setup --yes, run 2           7.8 s   (prints the admin token's links and the QR)
        phone link redeemed (Playwright)    2.1 s
        TOTAL, clone to phone signed in    15.0 s   machine time; the 10-minute target is the
                                                     owner's clock in part B (reading, typing)
      Accounts prints "Open the Desk with it on this machine: http://localhost:5199/#signin=…"
      and "From another device: http://<LAN address>:5199/#signin=…". Services prints
      "Installed volley and volleyd in ~/.volley/bin (scripts that run this checkout with
      /opt/bun/bun)"; `env -i PATH=/usr/bin:/bin ~/.volley/bin/volley --version` → 0.3.0. The
      volleyd unit has ~/.volley/bin first on PATH and VOLLEY_AUTH_DIR; the config header names
      `volley setup`; $VOLLEYD_HOME/setup.json records the container layout.             PASS
      admin token's link (desktop)       signed in as admin; Setup & Security lists no pending
                                         Security change (it said "2 pending" before #138)  PASS
      the same link again                refused, "already used"                          PASS
      phone QR link                      signed in as steer                               PASS
      an admin link typed into that open phone tab
                                         nothing happens: still steer (the Desk reads a link
                                         only when a page loads)                          AS DESIGNED
      the same admin link in a new tab   signed in as admin                               PASS
      a steer phone pasting an admin token in Settings › Setup & Security › Admin token,
      "Sign in with token"               signed in as admin                               PASS
      `volley auth signin-link --ttl 5`, opened a minute later
                                         refused: "it was used already or it has expired",
                                         with what to do next                             PASS
  (c) pairing on that tree (the host's ssh PATH has no bun):
      peer invite                        "volley peer join <code> --to owner@machine-a"   PASS
      join without --remote-volley       "`volley` is not on owner@<host>'s PATH for a
                                         non-interactive ssh command. Pass … --remote-volley
                                         '~/.volley/bin/volley' … the code is still valid"  PASS
      join --remote-volley '~/.volley/bin/volley' (plus VOLLEY_AUTH_DIR=… in front only
      because this broker is the container layout, see Open)
                                         paired, tunnel service up, "Registered … (tunnel up)" PASS
      peer list / peer remove            tunnel up / account revoked; the service stopped   PASS
  Owner-step dry runs:
      step 9–10 wave files (`smoke.yaml`, with `account: second`, with `host: <machine>`):
      `volleyd validate` → ok. The template without top-level `model` and `pipeline` that an
      earlier draft used → "must have required property 'model' / 'pipeline'".           PASS
      `volley claude list` without a login → "refused anonymous access"; with the coordinator's
      login exported → lists the profiles. Step 9 exports it first.                     PASS

  Open (for the coordinator, not fixed in this PR):
    - account_limit names no account to move to when the other account has never run an
      agent (no usage record yet), or when its usage is above `warn_at_pct` (step 9 lowers that
      to 1). The banner then says no other account has headroom and offers only "Not now".
      Step 9 accepts that; a signed-in account with no sample could count as 0 %.
    - `volley auth init` / `migrate` on a broker `volley setup --lan` opened rewrites the
      config to the local-only listener (LAN access closed again).
    - `volley peer redeem` over ssh finds coordinator.json only through VOLLEY_AUTH_DIR or the
      default auth dir, not setup.json (a `--dir` / container setup needs it on the
      --remote-volley command, as above).
  Fixed since run 1 (the three Open items above: #140): account_limit offers a signed-in
  account with no usage yet, labelled so; `auth init` / `migrate` keep the WebSocket
  listener's LAN bind and print the config diff first; `peer redeem` reads the auth dir from
  setup.json. Also in #133 the services' PATH and auth dir, and ~/.volley/bin scripts that
  run bun by its full path; in #138 the --remote-volley hint, the container layout's "2
  pending", the admin token's links, `unknown@<host>` in `peer invite`, the config header
  naming its writer, SMOKE-v0.2's skill version; in #139 Settings' account row for a
  password-signed-in admin on Machines.
```

### A. How to rerun it

Docker, about 5 minutes. Everything runs inside the containers, on a Docker network of its own.

1. An image: `FROM eclipse-mosquitto:2.1.2-alpine`; `apk add bash git openssh openssh-server tmux
   procps strace curl libstdc++ libgcc coreutils shadow`; bun's `bun-linux-x64-musl` build in
   `/usr/local/bin/bun`; a user `owner` (`usermod -p '*' owner` so sshd accepts its key) owning
   `/mosquitto`; `systemctl` replaced by a stand-in. Containers have no systemd, so the
   stand-in handles `--user is-active | daemon-reload | enable | restart | stop` and runs a
   unit's `ExecStart` with its `Environment=`, `WorkingDirectory=` and
   `StandardOutput=append:`, exactly as `volley setup` wrote them.
2. `docker network create vsmoke`, then
   `docker run -d --name vsmoke-a --hostname machine-a --network vsmoke -e USER=owner <image> sleep infinity`.
   Start mosquitto with an anonymous config (`listener 1883`, `listener 9001` +
   `protocol websockets`, `allow_anonymous true`). Then, timed: copy this checkout in
   (`git archive HEAD`), `bun install`.
3. As `owner`: `bun packages/volley-cli/src/cli.ts setup --yes --layout container`. Restart
   mosquitto when it says so, then run it again.
4. From the host, Playwright (Chromium) opens `http://<container IP>:5199/#signin=<token>`. The
   container IP is reachable from the host on the bridge, and the page then uses
   `ws://<container IP>:9001`, the container's broker. Use one fresh browser context per sign-in.
   More tokens: `VOLLEY_AUTH_DIR=/mosquitto/config/volley volley auth token --json` and
   `… auth signin-link --role steer --label <x> [--ttl 5] --json`.
5. A second container `vsmoke-b`, with sshd on both (`AllowTcpForwarding yes` on the
   supervisor's; Alpine's default is `no`) and each one's key in the other's
   `authorized_keys`. Then `volley auth add <admin> --role admin`, `volley peer invite`,
   `volley peer join …`, `volley peer list`, `volley peer remove`.
6. Audit: plant decoy `.credentials.json` files, run each Volley process under
   `strace -f -e trace=openat,open,stat,statx,lstat,newfstatat,access,faccessat,faccessat2,readlink,execve`,
   then `grep credentials.json` the traces, and `cat` a decoy under the same strace as the
   positive control.
7. `docker rm -f vsmoke-a vsmoke-b && docker network rm vsmoke`.

### B. Owner checklist (Mac + phone, about 30 minutes)

You need: a Mac with Homebrew, bun 1.3 or 1.4, `gh` and `claude` signed in. An iPhone or Android
phone on the same Wi-Fi. A second machine (Linux or macOS) with `claude` signed in, bun, git, tmux,
a clone of a throwaway test repo, a Volley checkout of this release (`bun install` run), and
key-based ssh both ways with the Mac. A second Claude account you can sign in with. The test repo
on GitHub with one small open issue and a pushed release branch
`release/<yyyy-mm-dd>-onboarding-smoke`, cloned on the Mac.

0. **Before the clock: the broker.** `brew install mosquitto && brew services start mosquitto`;
   `mosquitto -h | head -1` says `mosquitto version 2.1.x`.
1. **Fresh setup. Start the stopwatch now.**
   ```sh
   git clone https://github.com/kryptek/volley.git && cd volley && bun install
   bun packages/volley-cli/src/cli.ts setup
   ```
   Answer **yes** to the LAN question, and **yes** to each step.
   **Pass:** each step lists what it found and what it will change *before* asking. Security
   names the `mosquitto.conf.volley-backup-<timestamp>` it made and ends with `Listener 1883:
   refuses anonymous clients` and the same for 9001 and the LAN address. Accounts prints three
   passwords once and, under *One-time admin token*, the lines `Open the Desk with it on this
   machine: http://localhost:5199/#signin=vly_admin_…` and `From another device:
   http://<LAN address>:5199/#signin=vly_admin_…` (keep the terminal open: you use them in step
   5). Services says `Installed volley and volleyd in ~/.volley/bin (scripts that run this
   checkout with <your bun>)` and loads volleyd and the Desk; its hooks change says your status
   line keeps working. Setup checks cmux the way volleyd's service uses it (`cmux capabilities`
   and `cmux list-workspaces`, from outside cmux), not with `cmux ping`. With cmux on its default
   socket mode, Services says cmux lets only its own programs in (`cmux's socket control mode:
   cmux processes only`), recommends **Automation mode** with the menu path (cmux → Settings… →
   Automation → Socket control mode → Automation mode) and offers *Make volleyd's service reach
   cmux (choose Automation mode …)*; Password mode is named as the alternative. Choose Automation
   mode in cmux, answer yes: it says `volleyd's service reaches cmux now (cmux's socket control
   mode: Automation mode)`, asks no password, and `~/.volley/volleyd/setup.json` records
   `"cmux_socket_mode": "automation"`. (Password mode instead: the same change asks for the
   password at a hidden prompt, checks it and stores it; a wrong one is refused quoting cmux,
   storing nothing.) Phone prints a QR code. Last line: `Setup complete.` Anything that asks you
   to read source or guess is a fail: note the step.
2. **Phone sign-in, then stop the stopwatch.** Right away (the QR lasts 10 minutes), scan the QR
   with the phone camera and open the link.
   **Pass:** within about 10 s the Desk loads signed in (Settings › account row: a `steer`
   account, *Desk on iPhone* or similar). **Stop the stopwatch and write the time down
   (target ≤ 10 min).** Scan the same QR again: the card says the link was already used and
   what to do next. (If the QR expired before you scanned it, that is a fail of the 10-minute
   target; `volley setup` again issues a new one.)
3. **Rerun and PATH.**
   `echo 'export PATH="$HOME/.volley/bin:$PATH"' >> ~/.zshrc && exec zsh`, then
   `volley --version` → `0.3.0`, and `volley setup --repair` → every step `✓ already done`, also
   from a terminal outside cmux (Terminal.app). Services' found lines include `cmux: volleyd's
   service reaches it (cmux's socket control mode: Automation mode)`, and the Desk's Setup &
   Security › Services shows the same line. **A rerun that changes the Desk's service while it
   is loaded** (the smoke's `Bootstrap failed: 5: Input/output error`): edit one character in
   `~/Library/LaunchAgents/systems.volley.desk.plist`, run `volley setup --step services --yes`.
   **Pass:** it rewrites the plist, waits for launchd to let the old Desk go and loads the new
   one: exit 0, `launchctl print gui/$UID/systems.volley.desk` succeeds, the Desk answers on
   :5199. Run `volleyd install` twice in a row: both exit 0 and volleyd stays loaded. (Should a
   load ever fail, the run exits non-zero and says it restored the previous plist and loaded it
   again: the service is never left down.) With no VOLLEY_AUTH_* exported, `volleyd config get` and `volley list`
   work (the saved coordinator login). Start any server on 127.0.0.1:5199 beside the Desk
   (`python3 -m http.server 5199 --bind 127.0.0.1`): `volley setup --repair` stops at Services
   naming `python3 (PID …)` and `kill …`; stop it and the rerun passes again.
4. **Expiry.** `volley auth signin-link --role steer --label expiry-check --ttl 5` prints the
   ready-to-open link `http://<the Mac's LAN IP>:5199/#signin=<token>` (the address setup
   recorded) and its QR code, like setup's phone step. Wait 10 s, then scan the QR with the phone
   (or open the link in a **new tab**).
   **Pass:** the card says the link was used already or has expired, and what to do next.
5. **Admin sign-in, laptop.** Open the `Open the Desk with it on this machine:` link from step 1
   in a private browser window. If 10 minutes have passed since setup, run `volley auth token`
   first: it prints a new link.
   **Pass:** the Desk opens signed in, the sidebar says *Admin · manages accounts and setup*, and
   Setup & Security shows both listeners refusing anonymous clients and no pending Security
   change. Paste the same link into another private window: *already used*. Settings › Broker
   accounts lists every `admin-<id>` device sign-in; one volleyd has not seen for over a day
   (counted from volleyd's start at the earliest) is flagged **stale**, and *Revoke the N stale
   sign-ins…* (after a confirm) removes them all at once (the next day, the ones a headless
   browser left are flagged; a Desk window still open is not, nor is any right after a volleyd
   restart).
6. **Keychain** (never tested on a real Mac before). `security find-generic-password -s
   volley-broker -a coordinator -w` prints the same password as `coordinator.json` in the auth
   dir that setup named (`/opt/homebrew/etc/mosquitto/volley/` on Apple Silicon).
   **Pass:** identical, and no keychain dialog other than one "allow" for `security` itself.
7. **The Desk wizard from the phone.** On the laptop Desk: Settings › Setup & Security ›
   **Issue new token**. Get the token to the phone (AirDrop it, or copy on the Mac and paste on
   the iPhone with Universal Clipboard; typing the `vly_admin_…` token works too). On the phone:
   Settings › Setup & Security › **Admin token**, paste, **Sign in with token**. Do not type
   `…#signin=<token>` into the tab that is already open: the Desk reads a link only when a page
   loads, so that does nothing. A link in a **new** tab works.
   **Pass:** the phone's account row says *Admin*. Then **Run setup again**: the five steps fit
   the phone screen, each says *already done* (or shows exactly what it would change and why),
   Apply never dead-ends, and errors say what to do next.
8. **Settings.** On the phone: type `ceiling`, `pair`, `qr` and `weekly` in the Settings search,
   one at a time: each shows its section. Supervisor › Hard ceiling +1 → `applied`. Put it
   back.
9. **Second Claude account (d).** In a Mac terminal, sign in to the broker as the coordinator
   first (`volley claude` and `volleyd` need a login):
   ```sh
   export VOLLEY_AUTH_USERNAME=coordinator
   export VOLLEY_AUTH_PASSWORD="$(sed -n 's/.*"password": *"\([^"]*\)".*/\1/p' /opt/homebrew/etc/mosquitto/volley/coordinator.json)"
   ```
   Laptop Desk: Settings › Claude accounts & usage › **+ Add Claude account**, label `second`,
   **Sign in on this machine**, then **Open Anthropic sign-in ↗** and sign in with the *second*
   account.
   **Pass:** the card shows `second` signed in; `volley claude list` lists both profiles.
   - **On a paired machine (owner-run; needs a paired peer with its tunnel up).** On the
     `second` card, **Add to another machine…**: the label reads `second (<peer>)` (volleyd names
     a profile once across machines), `this machine` is
     greyed out ("already holds this account"). Pick the peer, **Sign in on <peer>**: the dialog
     shows **Open sign-in ↗** and **From a phone instead** (the manual URL and the `ssh … tmux
     attach` command), and no field. Sign in with the *second* account.
     **Pass:** the dialog reaches `Added: second (<peer>)` and `signed in on <peer>`; the `second` card
     lists both machines.
   - **The account matrix (owner-run; needs two paired peers, or one peer and `this machine` without
     the account).** Each card lists every configured machine; one missing the account has a hollow
     dot and **Sign in on <machine>**, and the head chip reads `on N of M machines` in amber. Click
     it: the dialog opens at the sign-in step titled `Sign in with s•••@… on <machine>` (no label or
     machine to pick). Sign in with the *same* account.
     **Pass:** the row fills, the chip turns plain, Settings › Machines' card for that machine lists
     the account with a filled dot under **Claude accounts**, and `volley claude list` prints no
     `not on:` line under it (before, it printed `not on: <machine>`).
   Write `smoke.yaml` (the issue and branch from "You need"):
   ```yaml
   wave: <yyyy-mm-dd>-onboarding-smoke
   repo: <abs path of the test repo on the Mac>
   release_branch: release/<yyyy-mm-dd>-onboarding-smoke
   model: claude-opus-5-5
   pipeline: [implement, merge_ready]
   tasks:
     T1: { issue: <n> }
   ```
   `volleyd validate smoke.yaml` → `ok: wave … 1 task(s)`.
   - **The threshold prompt, before `second` has any usage.** Run it now, while `second` is
     signed in but has not run an agent: its card shows no 5-hour or weekly meter. (If it does,
     from an earlier run, add another account with a new label, e.g. `third`, the same way, and
     read `third` for `second` below.) `volleyd config set claude.warn_at_pct 1`, then
     `volleyd run smoke.yaml` (the primary account) and let the agent work until the primary's
     card shows its 5-hour window at 1 % or more.
     **Pass:** Settings › Claude accounts & usage shows an *account_limit* banner for the
     primary account that reads "Move wave <w> to second (no usage yet)? …" and offers
     **Move to second** and **Not now**. **Fail:** the banner names `second` with a percentage
     ("(N% used)"), or says no other account has headroom and offers only **Not now**, while
     `second`'s card still shows no meter (item 3 of #140 has regressed). Those two are what
     an account that already has a sample gets (under 1 %, and at 1 % or more), which is why this
     runs before the wave on `second`. **Nothing moves by itself:** the agent stays on the
     primary. Answer **Not now** and leave the wave running.
   - **A wave on `second`.** Copy `smoke.yaml` to `second.yaml` with a new `wave:` id and the
     line `account: second` (above `tasks:`), then `volleyd run second.yaml`.
     **Pass:** its agent starts, and Settings › Claude accounts & usage shows it (and the wave)
     on the `second` card, not the primary's. `volleyd stop <that wave>`.
   - **Moving an agent.** In the primary wave's agent window, pick `second` in the account
     picker in its title and confirm.
     **Pass:** the agent restarts under `second`, in the same worktree, and
     `<worktree>/.volley/brief.md` ends with a resume note.
   Afterwards: `volleyd stop <wave>` and `volleyd config set claude.warn_at_pct 90`.
10. **Pair the second machine (c).** Follow
    [`docs/SMOKE-v0.2.md` → Paired machine](docs/SMOKE-v0.2.md#paired-machine-volley-peer)
    (invite as an admin account / join / up / down / remove). On `join`, add
    `--remote-volley '~/.volley/bin/volley'` (quoted, so the Mac's shell expands `~`) when
    `volley` is not on the Mac's non-interactive ssh PATH: without it the join says exactly that,
    and that the code is still valid. The script runs bun by its full path, so bun need not be on
    that PATH either. Before redeeming, join checks that `claude`, `bun` and `tmux` are on the
    second machine's **non-interactive ssh PATH** (how volleyd starts agents there). To see it,
    try once without them there (e.g. `claude` only in `~/.zshrc`'s PATH): join stops, names
    what is missing and prints the exact line for the login shell's file (zsh: `~/.zshenv`;
    bash: the top of `~/.bashrc`), and the code stays valid. With an unknown host key, join
    says the host key is not trusted yet and gives `ssh <host> true`, not "set up key-based ssh".
    `volley peer invite` with a non-admin login (e.g. `--username` of a steer account) refuses
    at once, not after 30 s. Before **Remove**, copy
    `smoke.yaml` to `peer.yaml` with a new `wave:` id and `T1: { issue: <n>, host: <the
    machine's name> }`, then `volleyd validate peer.yaml && volleyd run peer.yaml`.
    **Pass:** the task's agent starts on that machine, registers, and shows in the Desk under
    the wave. (Were `claude` missing from the session's PATH, its tmux session would show
    `volleyd: cannot start the agent: claude is not on this session's PATH …` and the Desk's
    decision would quote it, never just "did not start (screen: empty)".) After **Remove**: `volley auth list` no longer has the machine, and its service has
    stopped itself.
11. **Credential audit (e), macOS.** Claude Code keeps its login in the keychain (item *Claude
    Code-credentials*) and sometimes in `.credentials.json` files; Volley must touch neither.
    - **Decoys** (only where no file exists, so a real one is never overwritten):
      ```sh
      for f in ~/.claude/.credentials.json ~/.volley/claude/second/.credentials.json; do
        [ -e "$f" ] || { echo '{"decoy":true}' > "$f"; echo "planted $f"; }; done
      ```
    - **Watch** in two terminals: `sudo fs_usage -w -f pathname | grep -F .credentials.json`, and
      `sudo eslogger exec | grep -o '"path":"[^"]*security"[^}]*' ` (every `security` run, with
      its arguments).
    - **Positive control:** `cat ~/.claude/.credentials.json >/dev/null` must show in the first
      terminal, and `security find-generic-password -s volley-broker -a coordinator >/dev/null`
      in the second. If either stays silent, fix the watch before going on.
    - **Run Volley:** `volley setup --repair`, `volley auth token` and open its link in a
      private window (step 5), Settings search on the laptop (step 8), and let a wave agent run
      for a minute (`volleyd run smoke.yaml`; `volleyd stop` after).
    - **Pass:** no `.credentials.json` line from a `bun` process, and no `security` run with
      `Claude Code-credentials` (or any service but `volley-broker`). Claude Code reading its own
      login is the `claude` process, not Volley. Remove the decoys you planted.
12. **Record** the results below, then **clean up**: `volley peer remove` anything left over,
    revoke the smoke accounts (`volley auth list`, `volley auth revoke <name>`).

```
OWNER RESULTS (<date>, release head <sha>):
  1. setup (each step explained before changing? admin link printed? cmux: Automation mode recommended, mode recorded?):
  2. phone QR (time from clone: __ min; reuse refused):
  3. PATH / --version / --repair / rerun with the Desk loaded (exit 0, Desk up):
  4. signin-link prints link + QR / expired link refused:
  5. admin link (fresh window / reuse refused / nothing pending / stale sign-ins flagged + revoked):
  6. keychain:
  7. Desk wizard on the phone (paste box):
  8. Settings search / tunable from the phone:
  9. second account / wave on second / account_limit prompt, nothing switched / move + resume note:
  10. paired machine: invite / join (PATH check, host-key wording, non-admin invite refused fast) / up / wave task on it / remove + revoked:
  11. credential audit (positive control seen? any hit?):
  Issues found:
```

---

## Plan 9 — `volley notify` (v0.1.3)

Verifies the CLI subcommand and the dashboard browser-notification feature against a live mosquitto + a real `volley pub` publisher.

### Pre-reqs

- [ ] `brew services start mosquitto`. Both `:1883` (TCP) and `:9001` (WebSocket) listeners up:
   ```sh
   lsof -nP -iTCP:1883 -sTCP:LISTEN
   lsof -nP -iTCP:9001 -sTCP:LISTEN
   ```
   If `:9001` isn't listening, see the root [README §2](README.md) — the bundled `examples/mosquitto-localhost.conf` configures it.
- [ ] **Broker credentials.** Since v0.2 the bundled config refuses anonymous clients. In every terminal below, export the `coordinator` identity that `volley auth init` printed (the CLI reads it from the environment; `mosquitto_pub` needs it as flags):
   ```sh
   export VOLLEY_AUTH_USERNAME=coordinator VOLLEY_AUTH_PASSWORD='<coordinator password>'
   ```
   On a broker that still allows anonymous clients, skip this and drop the `-u`/`-P` flags in Cleanup.
- [ ] `brew install terminal-notifier` (macOS-only; needed for the desktop surface — webhook + bell work without it).
- [ ] Repo at `v0.1.0-plan9` (or HEAD with Plan 9 phases 1–4 merged); `bun install` clean.
- [ ] In one terminal: a tiny netcat-based webhook capture listener:
   ```sh
   nc -lk 9999
   ```
   Leave this running; it will print every webhook POST the notify loop fires.

### CLI surface — `volley notify`

- [ ] In a second terminal, launch the notify loop with all three CLI surfaces:
   ```sh
   bun run packages/volley-cli/src/cli.ts notify \
     --pattern 'volley/+/+/status' \
     --surface bell,desktop,webhook \
     --webhook-url http://localhost:9999
   ```
   Confirm stderr prints no startup warnings (if you see `terminal-notifier not found`, install it and restart).

- [ ] In a third terminal, publish a sequence of synthetic status envelopes for a fake agent:
   ```sh
   for type in working blocked done failed reaped; do
     bun run packages/volley-cli/src/cli.ts pub \
       --agent-id smoke-alpha --namespace default \
       --channel status --type "$type" \
       --payload "{\"summary\":\"smoke $type\"}"
     sleep 1
   done
   ```

- [ ] Observe the notify terminal:
   - `working` should NOT fire (not in default `--on`).
   - `blocked` / `failed` / `reaped` each fire: bell rings, a macOS banner appears, a JSON line lands on stdout listing `surfaces: ["bell","desktop","webhook"]`, and the netcat terminal prints a POST request with the envelope body.
   - `done` should NOT fire under the default `--on`.

- [ ] Subjective latency from `volley pub` → bell + banner: should be **< 3s**. Record the wall-clock observation here:
   - `<TBD — fill after smoke>`

- [ ] SIGINT the notify loop (Ctrl-C). Confirm stderr prints `[notify] shutting down` and the process exits cleanly (`echo $?` → 0).

### Dashboard surface — browser notifications

- [ ] Start the dashboard. These notifications live in the legacy dashboard (`volley dash` opens the Desk since v0.2):
   ```sh
   bun run packages/volley-cli/src/cli.ts dash --legacy --no-open
   ```
   Open http://localhost:5173/ in a browser (or whatever port Vite picked). On an auth broker, sign in as `desk` with the password `volley auth init` printed.

- [ ] In the top bar (right side, near the broker LED), click the bell icon. Confirm the popover renders with:
   - "Browser notifications" switch
   - "Sound" switch (on by default)
   - "Trigger events" group with three checkboxes (blocked / failed / reaped, all on)

- [ ] Toggle "Browser notifications" on. The browser should prompt for Notification permission — grant it.

- [ ] In a terminal, publish a `blocked` status:
   ```sh
   bun run packages/volley-cli/src/cli.ts pub \
     --agent-id smoke-beta --namespace default \
     --channel status --type blocked --payload '{"reason":"smoke"}'
   ```
   Confirm:
   - A native browser notification appears: title `Volley: smoke-beta`, body `blocked`.
   - The chime plays once.
   - Record subjective latency: `<TBD — fill after smoke>`

- [ ] Reload the dashboard tab. Click the bell again — settings should persist (Browser notifications still on, Sound on, all three trigger events checked). This verifies localStorage round-trip.

- [ ] Open DevTools → Rendering → "Emulate CSS media feature prefers-reduced-motion" → set to `reduce`.

- [ ] Publish another matching event (e.g. `failed`):
   ```sh
   bun run packages/volley-cli/src/cli.ts pub \
     --agent-id smoke-beta --namespace default \
     --channel status --type failed --payload '{"reason":"smoke 2"}'
   ```
   Confirm:
   - The native browser notification still fires.
   - The chime is **silenced** under reduce-motion.

### Cleanup

- [ ] SIGINT the dashboard, the netcat listener, and (if still running) the notify loop.
- [ ] Clear retained registry slots from the smoke run:
   ```sh
   mosquitto_pub -u coordinator -P "$VOLLEY_AUTH_PASSWORD" -t "volley/_system/registry/smoke-alpha" -n -r
   mosquitto_pub -u coordinator -P "$VOLLEY_AUTH_PASSWORD" -t "volley/default/smoke-alpha/status" -n -r
   mosquitto_pub -u coordinator -P "$VOLLEY_AUTH_PASSWORD" -t "volley/_system/registry/smoke-beta" -n -r
   mosquitto_pub -u coordinator -P "$VOLLEY_AUTH_PASSWORD" -t "volley/default/smoke-beta/status" -n -r
   ```

### Results

Run the smoke at tag time. Record results inline below before annotating the `v0.1.3` tag:

```
RESULTS (2026-05-16):
  - CLI notify: published 5 envelopes for smoke-alpha (working / blocked / done / failed / reaped).
    Surfaces fired exactly on blocked + failed + reaped (3/3 expected). working + done correctly
    suppressed by default --on. Each fired envelope: bell + desktop banner + webhook POST
    (verified via nc -lk 9999 capture — 3 smoke-alpha POSTs). Stdout: 3 JSON lines, each with
    surfaces:["bell","desktop","webhook"]. SIGINT shutdown clean ('[notify] shutting down' + exit 0).
    Subjective latency from `volley pub` → bell + banner: well under 1s.
  - Dashboard: popover renders correctly with solid surface + visible Radix Switch/Checkbox controls
    (required one CSS follow-up commit during smoke — see 1fa5567). Hook fired exactly per spec
    against a stubbed Notification API (WKWebView denies permission, so stubs were necessary):
    2 banners on 2 matching publishes (blocked, failed), 0 banner for non-matching working / progress.
    new Notification('Volley: smoke-beta', {body: <type>, tag: 'smoke-beta'}) — matches §4.3 byte-for-byte.
  - prefers-reduced-motion: under reduce-motion=false, audio.play() fired once on a blocked publish.
    Under reduce-motion=true (forced via matchMedia stub), failed publish still fired the banner but
    audio.play() count stayed at 1 — chime correctly silenced (WCAG SC 2.3.3).
  - Cleanup: retained registry + status slots cleared for smoke-alpha and smoke-beta via
    `mosquitto_pub -t <topic> -n -r`. netcat listener killed.
  - One real issue surfaced: shadcn's stock Tailwind tokens (bg-popover, bg-primary, bg-input,
    bg-background) don't resolve in the project's OKLCH design system, so the popover content
    rendered visually transparent and switches were invisible. Fixed in commit 1fa5567 with
    scoped overrides on .vd-notify-popover. Tests still pass (134 dashboard tests).
```
