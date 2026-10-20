---
name: volley-issues
description: Dispatch GitHub issues to autonomous Claude agents, each in its own git worktree and cmux workspace, coordinated via Volley. By default emits a wave file and submits it to the volleyd supervisor; the hand-launched legacy path remains. Replaces the claude-peers/ScheduleWakeup polling loop with sub-5s volley wait notifications. Use when the user asks to dispatch issues, work on issues, or launch agents for issues.
user_invocable: true
version: 0.4
---

# /volley-issues

Launches one or more autonomous `claude` CLI instances — each in its own cmux workspace and git worktree — to implement GitHub issues. Coordinates via the Volley protocol: each agent calls `vol_register` + `vol_publish` for status, and the coordinator backgrounds a `volley wait` process per agent. Replaces the legacy `dispatch-issues` skill's claude-peers + ScheduleWakeup polling loop.

There are two dispatch paths (see **Choosing a dispatch path**): the **volleyd path** (default), where this skill turns the issues into a wave file and the `volleyd` supervisor spawns, reviews and gates every agent; and the **legacy path**, where this session launches each agent and runs the coordinator loop by hand.

## Prerequisites

Before invoking `/volley-issues`:

**This skill is current.** This file declares `version: 0.4` in its frontmatter. From the volley checkout, `bash packages/volley-issues/scripts/install.sh --check` prints the installed and repo versions and exits 1 when `~/.claude/skills/volley-issues` is missing or older (a v0.1 copy knows only the legacy path). Then run `bash packages/volley-issues/scripts/install.sh` (it re-points the skill at the checkout), and restart Claude Code.

1. **Mosquitto running.** `brew services start mosquitto`. If any tool call returns `{ code: "BROKER_DOWN" }`, follow the cross-cutting rule from `/volley`'s SKILL.md: print the install hint, stop, do not retry.

2. **volley-mcp registered in this session.** Claude Code stores MCP servers separately from `settings.json` and manages them via the `claude mcp` CLI (`mcpServers` is NOT a valid top-level `settings.json` field). Register the server at user scope with `env.VOLLEY_AGENT_ID` set to the coordinator's role prefix (e.g. `coordinator`) and `env.VOLLEY_NAMESPACE=example-dispatch`:

   ```sh
   claude mcp add-json -s user volley '{"command":"bun","args":["run","<volley-repo>/packages/volley-mcp/src/index.ts"],"env":{"VOLLEY_AGENT_ID":"coordinator","VOLLEY_NAMESPACE":"example-dispatch","VOLLEY_AUTH_USERNAME":"coordinator","VOLLEY_AUTH_PASSWORD":"<coordinator password>"}}'
   ```

   Then quit Claude Code (Cmd-Q) and reopen. Verify with `claude mcp list` — expect `volley: ... ✓ Connected`. Run `bash packages/volley-issues/scripts/install.sh` to get a ready-to-paste command with the absolute path baked in. If `vol_list_agents`, `vol_subscribe`, etc. are missing from the available MCP tools after the restart, the server isn't registered — stop.

   The `env` block sets this MCP server's agent_id **prefix**.
   `vol_register` reads `VOLLEY_AGENT_ID` from env at startup and appends a
   fresh `-XXXX` (4 lowercase-alphanumeric chars from `[a-z0-9]`) suffix — so this coordinator's agent_id is
   `coordinator-XXXX` (the suffix changes on each MCP restart). Two Claude Code
   sessions on this machine sharing one user-scope MCP registration get DIFFERENT
   agent_ids (each MCP server picks its own suffix), so two coordinators no longer
   collide. To discover the auto-generated id, call `vol_register` (its response
   includes `agent_id`) or `vol_list_agents` and look for the entry whose
   `capabilities` include `coordinator`.

   **Broker credentials in the shell.** The reference broker config requires a login (`examples/mosquitto-auth/`). The MCP registration's `env` block reaches only the MCP server, not this session's Bash tool, so export the same identity in your shell profile and restart the session:

   ```sh
   export VOLLEY_AUTH_USERNAME=coordinator
   export VOLLEY_AUTH_PASSWORD='<coordinator password from `volley auth init`>'
   ```

   Without them every `volley wait` / `volley sub` exits `1` with `AUTH_FAILED` at once (which looks like a wake but is not one), and `mosquitto_pub` cleanup is refused.

3. **gh + claude + cmux on PATH.** Run `command -v gh claude cmux` and confirm all three resolve. If any is missing, tell the user how to install (`brew install gh`; the `claude` CLI ships with Claude Code; cmux install instructions live in the `cmux` repo).

4. **Coordinator registered as a Volley agent.** Before dispatching anything, call `vol_register({ capabilities: ["coordinator", "dispatch-issues"], cwd: <your-repo-root>, model: "claude-opus-4-7", title: "coordinator — dispatching <what this batch is>", links: { repo: "<owner/name>" } })`. `title` is one line (1–120 characters, no newline) naming what this session is doing — the Desk shows it as the window's name; keep it generic (`coordinator — dispatching #22, #23`), never paste an issue title into it unsanitised. `<owner/name>` is `gh repo view --json nameWithOwner -q .nameWithOwner`. For `<your-repo-root>`, use the absolute path of the downstream repo you're dispatching from — the output of `pwd` in this Claude Code session. The response is `{ agent_id, namespace }`. The `agent_id` is the
   auto-suffixed value `coordinator-XXXX` (NOT the literal env prefix);
   this is the value to embed in dispatched children's spawn brief as
   their `parent_id`.

## Usage

The user can ask in several shapes:

- **Single issue:** `/volley-issues #22` or "dispatch issue #22"
- **By label:** `/volley-issues --label enhancement` or "dispatch all enhancement issues"
- **Multiple explicit:** `/volley-issues #22,#23,#25`
- **All open:** `/volley-issues --all` or "dispatch all open issues"

Parse the user's input to determine: single-issue vs. batch (≥2 issues), and whether a release branch is needed (see Batch setup).

If neither a `#N` nor a `--flag` is supplied, print the usage shapes above and stop.

## Choosing a dispatch path

Run `volleyd status` before dispatching anything:

- **Exit 0** (the daemon answered): use the **Volleyd path** below. This is the default.
- **Anything else** (daemon not installed, not running, or unreachable): tell the user, then use the **Legacy path**. Do not start a daemon on the user's behalf; `volleyd install` (macOS) or `volleyd daemon` is theirs to run.

The user can force the legacy path ("dispatch the old way", `--legacy`). Never mix the two for one wave: an agent volleyd spawned is volleyd's to steer, retire and clean up.

## Volleyd path

The `volleyd` supervisor owns everything the legacy path does by hand: worktrees, ISSUE.md, cmux workspaces, spawn briefs, registration checks, the implement → review → fixup pipeline, retries, and retiring agents (including clearing their retained records). This skill is the front door: it turns the issues into a wave file, submits it, and then waits on **decisions** and **merge-ready gates**, not on per-agent terminal statuses.

`volleyd` and `volley` below mean the CLIs on `PATH`; without them, substitute `bun run <volley-repo>/packages/volleyd/src/cli.ts` and `bun run <volley-repo>/packages/volley-cli/src/cli.ts`.

### Volleyd prerequisites

- Prerequisites 1–4 above (broker, volley-mcp, shell credentials, coordinator registered). The coordinator's auto-suffixed `agent_id` from Prerequisites step 4 becomes the wave's **owner**.
- `volleyd status` exits 0 (see Choosing a dispatch path). Use the same `VOLLEY_BROKER_URL` / `--namespace` the daemon uses, and run on the daemon's host with the daemon's `VOLLEYD_HOME`: `volleyd events` and `volleyd ack` read the journal there directly, not over the broker.
- A release branch the wave's PRs target: create or reuse one exactly as in **Batch setup** step 1, after the **Global open-PR check**. A wave always has a release branch, even for one issue.
- Repo-specific brief extras live in the repo, not in this skill: put the **Migration number reservation** block (or any other per-repo notes) in `<repo>/.volley/brief-extra.md` (kept out of git); volleyd appends it to every brief it renders. Run the migration counter init (**Batch setup** step 2) yourself before submitting if the repo uses it. volleyd's briefs already carry the narration contract. To enforce it anyway (say, against a customised template), install the skill's gate as volleyd's brief gate: `ln -s <skill-dir>/scripts/validate-brief.sh "${VOLLEYD_HOME:-$HOME/.volley/volleyd}/brief-gate"`. volleyd refuses to launch an agent whose brief fails it. The gate accepts volleyd's own briefs: their session hooks register the agent, so the brief's "already registered" line stands in for the legacy `vol_register` step (volleyd briefs must never ask the agent to register). Do not "fix" a refused volleyd brief by appending `brief/NARRATION_BLOCK.txt`: its step 1 is `vol_register`.

### Step 1: collect issues

Write the issues as one JSON array of `{ number, title, body }`:

```bash
# Explicit issues (#22,#23,#25):
for n in 22 23 25; do gh issue view "$n" --json number,title,body; done | jq -s . > /tmp/wave-issues.json
# By label:
gh issue list --state open --label enhancement --limit 200 --json number,title,body > /tmp/wave-issues.json
```

### Step 2: derive dependencies

Each issue becomes a task named by the task tag its title starts with (`O0: …`, `T3b — …`, `D10 - …` give `O0`, `T3b`, `D10`: one to three capitals, one to three digits, an optional lower-case letter, then `:`, a dash or `—`), or `i<N>` when the title has none. A product or format name that fits the pattern (`S3:`, `EC2 -`, `K8s:`, `UTF8 -`) is not read as a tag. When two issues would get the same id (two `O1:` titles, or ids that differ only in case), the tagged ones fall back to `i<N>` and the helper prints a warning naming them: retitle one if you want the tag ids. A `Depends on: #101, #102` or `deps: #101` line in an issue body (markdown emphasis and parentheticals allowed, e.g. `**Depends on:** #5 (T3)`) becomes `after:` with those issues' task ids (`after: [i101, i102]`, or `after: [O0, T4]` for tagged titles): that task starts only once its dependencies are `done` (see the gate note in Step 5). `Depends on: none` (or `n/a`) declares no dependencies. An empty `Depends on:` label reads the `- #N` list items under it. `owner/repo#N` and issue URLs are accepted when `--repo-slug` names this repository; any other repository is an error.

- A dependency line the helper cannot read (`Depends on: T3`, free text next to the references) is an error naming the issue, never a silently dropped dependency. Rewrite the line as `#N` references (or `none`) in the issue, or fix the JSON, and re-run.
- A dependency on an issue **outside** the set is an error that names it. Either add that issue to the set, or, if it is already merged (`gh issue view <N> --json state` is `CLOSED` and its PR is in the release branch), pass it with `--satisfied <N,...>` so it is dropped.
- Issues with **no** dependency line are listed on stderr (`note: no Depends on:/deps: line in ...`). Ask the user how they are ordered (or confirm they are independent), then add `after:` lines to the wave file by hand before Step 4.

### Step 3: write the wave file

The wave id is `<date>-<theme>` (lowercase, `[a-z0-9][a-z0-9_-]*`, at most 63 chars), the same theme as the release branch. The file goes in the repo at `.volley/waves/<date>-<theme>.yaml`:

```bash
WAVE=$(date +%Y-%m-%d)-<theme>
mkdir -p .volley/waves
bun run <skill-dir>/scripts/wave-from-issues.ts /tmp/wave-issues.json \
  --wave "$WAVE" \
  --repo "$(git rev-parse --show-toplevel)" \
  --release-branch release/$WAVE \
  --model claude-opus-4-7 \
  --repo-slug "$(gh repo view --json nameWithOwner -q .nameWithOwner)" \
  [--satisfied 5,6] [--namespace example-dispatch] \
  [--pipeline '["implement",["spec_review","quality_review"],"fixup","merge_ready"]'] \
  --out .volley/waves/$WAVE.yaml
```

The default pipeline is `[implement, [spec_review, quality_review], fixup, merge_ready]` (the nested array runs both reviewers in parallel). A pipeline without the review group (`["implement","merge_ready"]`) is honoured only because the file says so: volleyd marks each such task `reviews skipped by plan`, and otherwise never gates a task without both reviews for its current head. Exit 1 means a dependency or issue problem (the message names the issue; an issue both in the set and in `--satisfied` is one); exit 2 is a usage error (including a `--pipeline` that is not a JSON array). Show the user the generated file.

**The brief preface: public-repo hygiene rules go here.** The wave file carries `brief_preface: ".volley/brief-preface.md"` (`--brief-preface <path>` names another file, relative to the repo or absolute). volleyd puts that file, byte for byte, at the top of **every** brief it writes — implementer, both reviewers, fixup, rebase — above the role's own template. It is the only way to give volleyd-spawned agents the rules you would otherwise put in a hand-written brief, so rules like "this repository is public: no person names, no local usernames, no machine paths, no private hostnames or IPs" belong in it. When the repo is on this machine and the file does not exist, the helper writes it from `templates/brief-preface.md` and says so on stderr (`wrote <path> from the template`); an existing preface is never changed (`brief preface: <path> (kept)`). Show it to the user and add the repository's own rules under its `## Repository rules` heading:

```bash
cat "$(git rev-parse --show-toplevel)/.volley/brief-preface.md"
```

```markdown
# Rules for this repository (read before anything else)
...
## Public-repo hygiene

This repository is public. Never put any of these into code, comments, docs, test fixtures,
commit messages, branch names or PR text:

- a person's name (write "the owner", "a maintainer" or "the user" instead);
- a local username, or an email address that is not a project address;
- a machine path: home directories, temp paths, worktree paths;
- a private hostname, internal domain or IP address;
...
## Repository rules

<!-- build and test commands, gates, files that must not change, conventions -->
```

The preface is copied verbatim (no `{{placeholder}}` expansion) and is capped at `brief_preface_max_bytes` (16 KiB by default; a larger file refuses `volleyd validate` and `volleyd run` with `BRIEF_PREFACE_TOO_LARGE`). `.volley/brief-extra.md` is different: optional per-repo *notes* (build commands, gates) appended as a "Repository notes" section at the end of each brief. Rules go in the preface; notes in the extra. Reviewers also check public hygiene on their own (a line in their briefs), following volleyd's `public_hygiene` tunable (`auto` by default): for a public repository — or one whose visibility volleyd could not read — a leak is a P1 even in a repo with no preface; for a private or internal one it is a non-blocking P3 note; `public_hygiene: on` in the wave's `config:` forces P1, `off` drops the check. The preface's rules still apply verbatim to every brief either way.

### Step 4: validate and submit

```bash
volleyd validate .volley/waves/$WAVE.yaml
# ok: wave <wave> v1 — <n> task(s), critical path <k>, release branch release/<wave>
# brief preface: <repo>/.volley/brief-preface.md (<bytes> B, sha256 <12 hex>)
volleyd run .volley/waves/$WAVE.yaml --owner <COORDINATOR-AGENT-ID>
```

`volleyd validate` needs no daemon and reports path-qualified errors (unknown `after:` target, cycle, bad id); fix the file and re-run until it prints `ok`. Check its `brief preface:` line: `brief preface: none (no <path>)` means the agents get no repo rules — write the preface first (above). `volleyd status "$WAVE"` shows the same line under its header for the running wave, with the sha256 of the file the agents got. `volleyd run` validates again, submits, and returns as soon as the daemon has journaled the wave; it prints any overlap warnings with other running waves (advisory). `--owner` is the coordinator's auto-suffixed id: only the owner may resolve, pause, stop or steer the wave. Those commands identify the caller by `--by`, else `VOLLEY_AGENT_ID`, else the session registered for this directory; if the shell's `VOLLEY_AGENT_ID` is not the suffixed id, export it (`export VOLLEY_AGENT_ID=<COORDINATOR-AGENT-ID>`) or pass `--by <COORDINATOR-AGENT-ID>`.

### Step 5: volleyd coordinator loop

**You are done when every task is merged, not when `volleyd run` returns.** The loop waits on the wave's event stream and acts on two things: **decisions** and **merge-ready gates**. Do not background `volley wait` per agent; volleyd watches the agents.

`volley/_waves/<wave>/events` is a live, non-retained mirror of the wave's journal, so it is only the **wake signal**. The record is the journal, read with a named cursor that you advance only after acting. Arm the wake first, let it subscribe, then catch up, so nothing published in between is missed:

```bash
# 1. Arm the wake: exits on the next wave event (0), or after 5 min (124) as a fallback heartbeat.
volley sub --pattern "volley/_waves/$WAVE/events" --max-messages 1 --timeout 300 &
# 2. Give it time to connect and subscribe: `volley sub` prints nothing until a message arrives,
#    and an event published before its SUBSCRIBE lands would wake nobody.
sleep 2
# 3. Catch up: every journal event after the cursor, one JSON object per line.
volleyd events "$WAVE" --cursor coordinator
```

The 5-minute heartbeat bounds the cost of a slow subscribe: an event that slipped between the catch-up and the subscription is picked up by the next catch-up, at most one heartbeat later. Nothing is lost either way; the journal is the record.

For each event printed, by `type`:

- **`decision_opened`**: `volleyd decisions "$WAVE"` lists the open ones (id, task, kind, question, options, evidence pointers). Read the evidence. Answer what is within the coordinator's authority; ask the user for anything else (`repo_untrusted`, `model_switch`, `plan_change` and `wave_complete` are always the user's). Then:
  ```bash
  volleyd resolve <decision-id> <answer...> --wave "$WAVE" --rationale "<why>"
  ```
  The task resumes and the answer reaches its next stage.
- **`stage_entered` with `data.stage` = `merge_ready`**: a gate. volleyd never merges. Read the task's evidence package (`volleyd status "$WAVE" --json` → `tasks[].evidence_path`, and `pr`): PR url, head sha, CI on that exact head, both reviews' findings and how each P1 was resolved, and whether the branch is current with the release branch. A PR that touches `packages/` or `spec/` adds a `changes/` fragment and leaves `CHANGELOG.md` alone (CI's Changelog fragment job checks it; see `changes/README.md`). If it holds up, merge the PR into the release branch by hand (`gh pr merge <pr-number> --squash`), or hand it to the user if they merge themselves. If it does not, `volleyd steer "$WAVE" <task> "<what to fix>"`. Then see **Merges and dependents** below.
- **`alarm_raised`**, **`task_cancelled`**, **`wave_stopped`**: tell the user what happened and where to look (`volleyd status "$WAVE"`). Skip `alarm_raised { alarm: "reviews_skipped_by_plan" }`: it marks a gate the wave file asked for (a pipeline without reviews), not a fault. A `merge_ready_invariant` alarm comes with an `agent_blocked` decision (`rereview` / `cancel`): a head nobody reviewed (usually a push outside the pipeline) must be reviewed again before the gate.
- **`stage_entered` with `data.stage` = `done`** (`data.merged: true`): volleyd saw the task's PR merged into the release branch. Informational; its dependents are admitted on their own (see **Merges and dependents**).
- **`wave_complete`**: every task is settled; go to Step 6. Before acting on it (and if it never arrives), confirm with your own check: every task is `done` or `cancelled` in `volleyd status "$WAVE"`, and every PR is merged (`gh pr view <pr> --json state`).
- Anything else (spawns, stage changes, leases): informational.

**Merges and dependents.** volleyd never merges, but it checks every `merge_ready` task's PR about once a minute. When the PR is merged into the release branch the task moves to `done` (`stage_entered {stage: "done", merged: true}`), and every queued task whose `after:` dependencies are now all `done` is admitted and spawned by volleyd itself, through normal admission. **Do not start dependents yourself**: `volleyd spawn "$WAVE" <task>` bypasses admission and would race volleyd's own spawn of the same task. A PR closed unmerged raises a `pr_closed_unmerged` alarm, and one merged at a different head than the gate saw still counts but raises `merged_unverified_head`; a PR merged into some other branch does not count. `volleyd spawn` is only for a task you deliberately want to start outside admission (say, to retry one volleyd has given up on); check `volleyd status "$WAVE"` first that nothing is already running for it.

After acting on everything printed, advance the cursor to the last `seq` you handled, then loop back to 1 when the backgrounded `volley sub` exits:

```bash
volleyd ack "$WAVE" --cursor coordinator --seq <last-seq>
```

`volley sub` exit `124` is the fallback heartbeat: re-arm and run the catch-up anyway. Exit `1` is an error (broker down, or `AUTH_FAILED`: the shell lacks `VOLLEY_AUTH_*`), not a wake; fix it before re-arming. `volleyd status "$WAVE"` is the human-readable view at any time ("are they done?"); `volleyd pause "$WAVE"` / `volleyd stop "$WAVE"` stop admitting or cancel the wave.

### Step 6: volleyd cleanup

After the user has merged the last gate (and the release branch, per **Release branch merge**):

```bash
volleyd cleanup "$WAVE"        # dry run: lists the retired agents' worktrees and workspaces
volleyd cleanup "$WAVE" --yes  # removes them; live agents and dirty worktrees are skipped
```

volleyd already cleared each retired agent's retained records when it retired it, so the retained-record sweep in **Cleanup** is only needed for agents the legacy path launched. Branches are kept; delete them per **Cleanup** once merged.

## Legacy path

The sections from **Batch setup** through **Cleanup** below are the **legacy path**: this session launches every agent itself and runs the per-agent coordinator loop. Use it only when Choosing a dispatch path says so. **Batch setup** step 1 (release branch), the **Global open-PR check**, **Release branch merge** and the retained-record rules in **Cleanup** also apply to the volleyd path where it points to them.

## Batch setup

When dispatching 2 or more issues:

1. **Create a release branch** from main:
   ```bash
   DATE=$(date +%Y-%m-%d)
   git checkout main && git pull
   git checkout -b release/$DATE-<theme>
   git push -u origin release/$DATE-<theme>
   ```
   The theme can be derived from the issue set (e.g. `agent-roadmap` for #143-#148).

   **Tracking branch** (remove this note once volleyd fetches a release branch that exists only on origin): if the release branch was created and pushed from another clone, the repo volleyd works in has only `origin/release/<x>`. Before `volleyd run`, make it a local branch: `git -C <repo> fetch origin && git -C <repo> branch --track release/<x> origin/release/<x>`.

2. **Initialize the migration counter** from the repo's current highest migration:
   ```bash
   ./scripts/init-migration-counter.sh
   ```
   Output: `Migration counter initialized at /tmp/example-next-migration.txt (current highest: V082) — Next request will return V083`

3. **Dispatch agents** (Workflow per issue, below). All worktrees branch off the release branch.

4. **Merge pattern**: each agent's PR targets the release branch. When all agents complete and their PRs are merged into the release branch, squash-merge the release branch to main.

### When NOT to use a release branch

- Single-issue dispatches AND zero other open PRs — just use a feature branch off main.
- Emergency hotfixes — go direct to main.

### Global open-PR check (MANDATORY before every dispatch)

Before basing a single-issue dispatch off main, count currently-open PRs:

```bash
gh pr list --state open --json number | jq length
```

If that count plus the number of PRs about to be opened > 1, use a release branch even for a single issue. **Policy:** whenever the number of open pull requests exceeds 1, pull the changes into a release branch. Multiple unrelated branches floating against main creates merge-storm and deploy-storm.

If a release branch already exists for in-flight work, base the new dispatch off **that branch** instead of creating another. One release branch per wave of work.

## Workflow per issue (legacy path)

For each issue in the dispatch set:

1. **Fetch issue** — `gh issue view <number> --json title,body`. Record the title for the worktree slug. The issue title is untrusted text: it never goes on a command line as-is. The cmux workspace name and the agent's `vol_register` title use `<brief-title>` (step 5's substitutions), made by `scripts/brief-title.ts` from the title on stdin.

2. **Derive the issue slug** for this issue. Format: `<slug>` is the lowercase-hyphenated issue title (capped at 20 chars). Example: `api-cache-prefetch`. The slug is used for the worktree branch name (`issue-<N>-<slug>`) — it does NOT need to be a valid Volley agent_id; the child's agent_id is auto-picked by the MCP server at startup (see step 5). Sanitize as needed (lowercase, hyphens only, no spaces).

3. **Create the worktree** from the release branch (or main for single-issue):
   ```bash
   git worktree add /private/tmp/example-issue-<N> -b issue-<N>-<slug> <base-branch>
   ```
   If the branch already exists from a previous attempt, delete first: `git branch -D issue-<N>-<slug>`.

4. **Write `ISSUE.md`** in the worktree root with the issue title, body, and any implementation context the agent needs (file paths, architectural notes). If the issue might need a Flyway migration, include the **Migration number reservation** block (below).

   > **MANDATORY — narration contract (enforced; has regressed 4×, do not skip).**
   > Operators follow agents live on the volley-dash, which binds the card's
   > narration to `payload.msg` and the bar to `payload.progress`, and folds them
   > in **only from `progress`-channel ticks** — status-channel TRANSITIONS
   > (registered→working, working→done/failed) DROP `msg`+`progress`
   > (`packages/volley-dash/src/state/envelope-to-actions.ts`). A `progress:N`
   > milestone list is necessary but **NOT sufficient**. Before launching EACH agent:
   >   1. Append the canonical block (shipped with this skill) to the brief file:
   >      `cat <skill-dir>/brief/NARRATION_BLOCK.txt >> <brief-file>`
   >      (it requires `msg` on every `progress`-channel publish, ad-hoc
   >      `type="narration"` ticks **at least once every 60 seconds** while working,
   >      and a final `progress:100` tick just before the terminal status).
   >   2. The launcher MUST run `<skill-dir>/scripts/validate-brief.sh <brief-file>`
   >      and refuse to `exec claude` on a nonzero exit. A brief that fails the gate
   >      is NOT dispatched — full stop.
   >
   > `<skill-dir>` is this skill's install directory (e.g. `~/.claude/skills/volley-issues`).

5. **Launch the agent via cmux** with a Volley-aware spawn brief. cmux does not
   accept `--env` flags, and the parent process's exported VOLLEY_AGENT_ID
   would not reach the child's MCP server anyway (Claude Code passes the
   user-scope MCP registration's `env` block verbatim to spawned MCP
   subprocesses). Instead, embed the coordinator's literal `agent_id` in the
   spawn brief as the child's `parent_id`. The child's MCP server picks its
   own auto-suffixed id at startup; the coordinator discovers it post-dispatch
   via `vol_list_agents`.

   ```bash
   cmux new-workspace \
     --cwd /private/tmp/example-issue-<N> \
     --name "<brief-title>" \
     --command "claude --dangerously-skip-permissions 'Read ISSUE.md and implement GitHub issue <N>. Use ultrathink for complex decisions. Do NOT commit or push. When done, write a DEPLOY.md listing all deployment steps required but do NOT git add or commit DEPLOY.md.

   IMMEDIATELY on startup, in this order:
     1. Call vol_register with capabilities=[\"implements-issue\", \"runs-mvn-verify\"], parent_id=\"<COORDINATOR-AGENT-ID>\", cwd=\"/private/tmp/example-issue-<N>\", model=\"claude-opus-4-7\", title=\"<brief-title>\", links={ repo: \"<owner/name>\", issue: <N> } (the Desk shows the title on your window; your agent id says nothing about the work). The response includes your auto-suffixed agent_id (e.g. coordinator-7b9c). Confirm it starts with `coordinator-` — if it starts with anything else, abort: the MCP env block isn't what the dispatch flow expects.
     2. Call vol_publish with channel=\"status\", type=\"working\", payload={ issue: <N>, started_at: <ISO timestamp> }.

   AT MEANINGFUL CHECKPOINTS, publish progress via vol_publish. Include a numeric progress field (0-100) in every payload so dashboards / coordinators can render a determinate progress bar instead of an indeterminate sweep. Suggested progression for a coding task — adjust the percentages to match the actual work shape, but always include the field:
     - channel=\"progress\", type=\"prereqs-verified\", payload={ progress: 15 } — after prereq verification in step 1 / step 2 of your brief
     - channel=\"progress\", type=\"scope-read\", payload={ progress: 25 } — after reading plan + linked docs
     - channel=\"progress\", type=\"implementation-started\", payload={ progress: 40 } — first file edit
     - channel=\"progress\", type=\"implementation-complete\", payload={ progress: 60 } — last file edit
     - channel=\"progress\", type=\"tests-green\", payload={ progress: 75 } — when test suite first passes
     - channel=\"progress\", type=\"mvn-verify-done\", payload={ progress: 75 } — when mvn verify passes (Java projects)
     - channel=\"progress\", type=\"gates-green\", payload={ progress: 85 } — lint + typecheck + tests all clean
     - channel=\"progress\", type=\"commit-made\", payload={ progress: 95 } — work committed to the branch
     - channel=\"progress\", type=\"diff-ready\", payload={ progress: 95 } — implementation complete (alias for commit-made when no commit is made yet)
   The final 100% comes from the terminal `status` envelope below, not a progress event.

   You MAY also include `progress: N` in your `working`-state `status` envelope payload at startup or any time you publish a status tick — the dashboard reads `payload.progress` from any envelope.

   ON TERMINAL COMPLETION (successful, blocked, OR failed): you MUST call vol_publish ONCE with channel=\"status\" and one of:
     - type=\"done\", payload={ summary: \"<one-line>\", worktree: \"/private/tmp/example-issue-<N>\", deploy_md_path: \"./DEPLOY.md\" }
     - type=\"blocked\", payload={ reason: \"<one-line>\", worktree: \"/private/tmp/example-issue-<N>\" }
     - type=\"failed\", payload={ reason: \"<one-line>\", worktree: \"/private/tmp/example-issue-<N>\" }

   Do not exit or idle without publishing the terminal status. The coordinator depends on this exact publish to wake up; without it, your work is invisible to the dispatch flow. Volley auto-arms an LWT so if your process dies hard (OOM, kill -9), the broker publishes type=\"reaped\" automatically — but a graceful done/blocked/failed is strictly preferable.'"
   ```

   Substitutions before invocation:
   - `<N>`: the issue number, digits only.
   - `<brief-title>`: the output of
     `gh issue view <N> --json title -q .title | bun <skill-dir>/scripts/brief-title.ts <N> implementer`
     — never the raw issue title. The helper reads the title on stdin and prints one line,
     `#<N> <issue title> — implementer` (an issue title that starts with a task tag keeps it:
     `#<N> O0: <rest> — implementer`), with every character special inside shell quotes removed
     (`'` `"` `` ` `` `$` `\`), control characters and newlines turned into spaces, whitespace
     collapsed, cut to 120 characters (`vol_register`'s `title` limit). That is what makes it safe
     inside both the single-quoted prompt and the double-quoted `--command` / `--name`: a raw
     title with an apostrophe ends the prompt early, and a backtick or `$(…)` in it would run in
     your shell. The helper refuses a non-numeric `<N>` (exit 2).
   - `<owner/name>`: the repository, `gh repo view --json nameWithOwner -q .nameWithOwner`.
   - `<COORDINATOR-AGENT-ID>` from the coordinator's own `vol_register` response (Prerequisites step 4) — the auto-suffixed value, e.g. `coordinator-a3f1`.
   - `<ISO timestamp>` left as literal text for the child to interpolate at startup.

   **POST-DISPATCH IDENTITY DISCOVERY.** Because the child's MCP server auto-
   suffixes its agent_id, the coordinator does NOT know the child's exact id
   ahead of time. After step 5's `cmux new-workspace` returns, wait ~3-5
   seconds for the child to vol_register, then:

   ```
   vol_list_agents({ namespace: "example-dispatch" })
   ```

   Find the entry whose `parent_id` equals the coordinator's agent_id AND
   whose `cwd` equals `/private/tmp/example-issue-<N>`. That entry's `agent_id`
   IS the child's. Record it — you'll pass it to `volley wait`.

   If NO entry matches: the child hasn't registered yet. Retry the
   `vol_list_agents` call after another 2 seconds. If still no match after
   3 retries (total ~10s wait), the dispatch likely failed silently;
   investigate the cmux workspace (the child claude may be stuck at a
   permission prompt despite `--dangerously-skip-permissions`, or hit a
   network issue). **Abort the dispatch**: do NOT background `volley wait`
   under a guessed id; the rest of the coordinator loop assumes the
   per-agent registry slot exists.

   If MULTIPLE entries match: that's a coordinator bug — two children with
   the same parent_id + cwd. Investigate; do not proceed.

6. **Rename workspace + open ISSUE.md panel** — these are cosmetic UX steps unchanged from legacy:
   ```bash
   cmux rename-workspace --workspace <ref> "<brief-title>"
   cmux markdown /private/tmp/example-issue-<N>/ISSUE.md --workspace <ref>
   ```

### Parallel launch is mandatory for batches

When dispatching multiple issues, run steps 1–6 (especially step 5's `cmux new-workspace` and its immediate `volley wait &` backgrounding from the Coordinator loop) once per issue in quick succession — do NOT wait for one agent to finish before launching the next. There is no sequential dependency between agents: each runs in its own worktree + workspace, and each has its own backgrounded `volley wait` process. The whole point of this skill is parallel autonomous work.

### Migration number reservation

**Problem**: parallel agents picking the next migration number from main's state will collide.

**Solution**: on-demand assignment via a shared atomic counter. The coordinator initializes the counter once before dispatching (Batch setup, step 2). Agents call `./scripts/next-migration-number.sh` from their worktree on demand:

```markdown
## Migration number (if needed)

If your implementation requires a new Flyway migration, DO NOT pick a number yourself.
Run this command from the worktree root to atomically reserve the next number:

    ./scripts/next-migration-number.sh

It will output a 3-digit zero-padded number (e.g. `083`). Use EXACTLY that number for:
- `backend/admin-api/src/main/resources/db/migration/V<NUM>__<slug>.sql`
- `infrastructure/migrations/<NUM>_<slug>.sql`

Only call once, only if you actually need a migration.
```

Embed this block verbatim in any ISSUE.md where a migration is plausible.

## Coordinator loop (legacy path)

**You are not done dispatching when the workspaces launch. You are done when every dispatched agent has published a terminal status AND its PR is merged.** Sitting idle between those two points is a failure mode the user has called out repeatedly. Volley replaces the legacy polling loop with a per-agent wake, but the rule about who's responsible for the cycle is the same.

### Per-agent background wait (the load-bearing call)

Background one `volley wait` process per dispatched agent **immediately after each `cmux new-workspace` returns** — before launching the next workspace. All N `volley wait` processes end up running in parallel this way, each blocked on its agent's terminal status. The reason to NOT batch this (i.e., don't wait until all workspaces are up before starting any `volley wait`) is the race window: the first agent could finish before the last workspace launches, and you'd miss its terminal status.

Each `volley wait` call blocks until that specific agent publishes a terminal status (`done`, `blocked`, `failed`, OR `reaped`) or the 4-hour fallback elapses.

```bash
# For each dispatched agent's id (call this AFTER post-dispatch identity
# discovery resolves the child's auto-suffixed agent_id):
bun run packages/volley-cli/src/cli.ts wait \
  --agent-id <discovered-child-id> \
  --namespace example-dispatch \
  --terminal-states done,blocked,failed,reaped \
  --timeout 14400 &
```

An exit code `1` from `volley wait` is an error (broker down, or `AUTH_FAILED`: the shell lacks `VOLLEY_AUTH_*`, see Prerequisites), **not** a terminal wake. Query the agent's status before treating it as finished, and fix the credentials before re-backgrounding the wait.

Background-and-detach (`&`) is the entire mechanism. Each background bash exits the moment its agent's retained `status` topic flips to a terminal value. **The Claude Code harness task-notification fires on the bash exit**, which is what wakes the coordinator — same way an interactive subprocess completion surfaces. There is no polling: the wakeup is driven by the broker's retained-message delivery to the `volley wait` subscription.

Record each agent's `agent_id` + the bash process id (`$!` immediately after backgrounding) so you can correlate the wake notifications.

### On every wake (i.e., every backgrounded `volley wait` exit)

The exit corresponds to ONE agent reaching terminal. For that agent:

1. Read the retained terminal status to confirm the type:
   ```
   vol_query({ topic: "volley/example-dispatch/<agent-id>/status" })
   ```
   The response's `payload.type` is one of `done | blocked | failed | reaped`.

2. **If `done`**:
   - `cd` to the agent's worktree (`/private/tmp/example-issue-<N>`).
   - `git status && git diff` to inspect the changes.
   - Read the agent's `DEPLOY.md` (do not commit it).
   - Changelog: when the diff touches `packages/` or `spec/` it must add a fragment, `changes/<N>.<added|changed|fixed|removed|docs>.md` (see `changes/README.md`); if the agent wrote none, add one from its summary. Never edit `CHANGELOG.md` (CI rejects a non-release commit that does).
   - If the diff looks good: `git add -A && git commit -m "feat: implement <issue-title>"` then `git push origin issue-<N>-<slug>` and `gh pr create --base <release-branch-or-main> --title "feat: <issue-title>" --body "<...>"`, where `<issue-title>` is `gh issue view <N> --json title -q .title | bun <skill-dir>/scripts/brief-title.ts <N>` (no role: `#<N> <issue title>`, shell-safe like `<brief-title>`). Embed the `DEPLOY.md` contents in the PR body under a `## Deployment Requirements` section.

3. **If `blocked`**:
   - Open the workspace (`cmux focus-workspace --workspace <ref>`).
   - Read the worktree's transcript or ISSUE.md to understand what the agent's stuck on.
   - Either send a steering mailbox (`vol_send_mailbox({ to_agent_id: "<id>", type: "steering", payload: { text: "<guidance>" } })`) and re-background `volley wait`, OR abandon (close the workspace, reopen the issue on GitHub with a comment summarizing what was tried).

4. **If `failed`**:
   - Read the retained `result` topic (`vol_query({ topic: "volley/example-dispatch/<agent-id>/result" })`) for any artifact pointer the agent left behind.
   - Tell the user what failed and where to look. Do not auto-retry; failure is a coordination signal that needs human review.

5. **If `reaped`** (broker-detected disconnect — LWT fired):
   - The agent's `claude` CLI crashed or was killed. Open the workspace, examine the transcript for any partial work, decide whether to relaunch (new agent_id, new `vol_register`, new `volley wait` background) or abandon. Reaped agents have a `payload.reason` of `"disconnect"` set by `lifecycle.ts`'s LWT.

6. **After processing**: clean up the agent's worktree + workspace:
   ```bash
   git worktree remove /private/tmp/example-issue-<N> --force
   cmux close-workspace --workspace <ref>
   ```

### Until every agent terminates

The coordinator's job stays open until every dispatched agent has reached a terminal state AND been processed. As each agent terminates, its `volley wait` background exits and you wake to handle it. There is no separate polling loop; the broker's retained-message delivery to `volley wait`'s open subscription is the entire signaling fabric.

If the user asks "are they done?" mid-dispatch, call `vol_list_agents({ namespace: "example-dispatch" })` and render an `/volley list`-style table — that's the canonical real-time view.

### Crash detection is free

If a `claude` CLI agent dies (OOM, kill -9, segfault, SIGSEGV), MQTT keepalive expires and the broker publishes the agent's LWT — its retained `status` flips to `reaped`. With the default 60s keepalive, mosquitto waits up to 1.5× that before declaring the client dead, so the full kill→reaped propagation is **typically 60-90 seconds**. The coordinator's backgrounded `volley wait` wakes on that exactly like any other terminal state. **This is a net new capability vs. the legacy claude-peers loop, which silently never woke on agent death.**

## Release branch merge

Once every dispatched agent has reached `done` AND its PR is merged into the release branch:

1. **Deploy the release branch to staging** for end-to-end testing:
   ```bash
   gh workflow run deploy-backend.yml --ref release/<date>-<theme> -f environment=staging
   gh workflow run deploy-portal.yml --ref release/<date>-<theme> -f environment=staging
   gh workflow run deploy-admin-frontend.yml --ref release/<date>-<theme> -f environment=staging
   ```

2. **Assemble the changelog** on the release branch, before the version bump commit:
   ```bash
   bun run changelog --version <v> --date <YYYY-MM-DD> --commit
   ```
   It turns every `changes/` fragment into the `## <v> — <date>` section of `CHANGELOG.md` and commits `release: changelog for <v>`; then bump the `package.json` versions in the same release PR. The volley-cli version test checks that the newest section matches the root version.

3. **After staging verification**, squash-merge the release branch into main:
   ```bash
   gh pr create --base main --head release/<date>-<theme> --title "Release: <date> — <theme>"
   gh pr merge --squash
   ```

4. **Delete the release branch** after merge:
   ```bash
   git branch -D release/<date>-<theme>
   git push origin --delete release/<date>-<theme>
   ```

5. **Remove the migration counter** (cleanup):
   ```bash
   rm -f /tmp/example-next-migration.txt /tmp/example-next-migration.txt.lock.d
   ```

### Post-merge deployment

When the user says to deploy after merging:

1. `git pull --rebase origin main`
2. Aggregate `## Deployment Requirements` sections from each merged PR via `gh pr view <N> --json body`.
3. Dedupe across PRs: migrations sorted by number, one entry per deploy target.
4. Write `/tmp/deploy-plan.md` and open with `cmux markdown /tmp/deploy-plan.md` for user review.
5. **Wait for user approval.** Execute in order: migrations → backend → frontend → terraform.
6. **Tag the release** after deploy succeeds:
   - Read latest tag: `git tag --list 'v*' --sort=-v:refname | head -1`.
   - Minor bump for features; patch bump for bug-fix-only releases.
   - Update `APP_VERSION` in `frontend-admin/src/changelog.js` to match; add changelog entries; commit + push.
   - `git tag v<X.Y.Z> -m "Release v<X.Y.Z> — <summary>" && git push origin v<X.Y.Z>`.

### Rollback

When the user asks to roll back:

1. Identify the target tag: `git tag --list 'v*' --sort=-v:refname`.
2. Write `/tmp/rollback-plan.md` and open for user review.
3. **Wait for user approval.**
4. `git checkout v<X.Y.Z>`, rebuild + redeploy from that tag.
5. **Migrations are NOT auto-rolled-back** — flag any migrations between target and current; user decides.

## Cleanup

After review and merge of an individual agent's work, clean up that agent's resources:

```bash
git worktree remove /private/tmp/example-issue-<N> --force
git branch -D issue-<N>-<slug>
cmux close-workspace --workspace <ref>
```

**MANDATORY: once an agent's work is complete, clear its retained MQTT records.** "Complete" means its terminal status has been processed: PR filed or merged, review read, fixup retired. Do this at every retire step, and sweep once more at wave or release cleanup:

```bash
# Clear every retained record of one finished dispatched agent.
for t in "volley/_system/registry/<agent-id>" volley/<ns>/<agent-id>/{status,result,mailbox,capability}; do
  mosquitto_pub -u "$VOLLEY_AUTH_USERNAME" -P "$VOLLEY_AUTH_PASSWORD" -t "$t" -n -r
done
```

(`-n` sends an empty payload and `-r` retains it; per MQTT semantics, an empty retained payload clears the slot.)

Rules:
- Clear only agents whose latest status is `done`/`failed`/`blocked`/`reaped`. Never clear a `registered` or `working` agent, or the coordinator.
- Clear only after the coordinator has consumed the agent's terminal event.
- **Don't select agents by `parent_id` alone.** Agents from older waves have been seen carrying the current coordinator's id. Also require the agent's `cwd` to be one of this run's worktrees.
- Records left by other sessions or waves aren't yours. Ask before sweeping them.

## Conformance with Volley v0.1

Per SPEC §11 (Conformance), the dispatched agents are conforming Volley agents and MUST satisfy:

- **MUST** register on startup before publishing any other channel (spawn brief: vol_register is step 1).
- **MUST** publish a terminal `status` (`done` | `blocked` | `failed`) before clean exit (spawn brief: "ON TERMINAL COMPLETION").
- **MUST** set MQTT LWT on connect for crash detection — handled automatically by `volley-mcp`'s `startLifecycle()`; the spawn brief doesn't need to mention it.
- **MUST** refuse unknown `schema_version` major versions — built into `parseEnvelope` per Plan 2.
- **SHOULD** publish progress milestones at meaningful checkpoints (spawn brief: tests-green / mvn-verify-done / diff-ready).
- **SHOULD** include `parent_id` if spawned by another Volley agent (spawn brief: parent_id is the coordinator's agent_id).
- **MAY** subscribe to its own mailbox and respond to steering messages. On the volleyd path the `volley-hooks` drain does it (persistent session, ack, injected into the session); legacy-path briefs do not ask for it.

This skill itself (the coordinator) is also a conforming Volley agent: it registers via Prerequisites step 4 and inherits the same MUST clauses.
