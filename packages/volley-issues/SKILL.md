---
name: volley-issues
description: Dispatch GitHub issues to autonomous Claude agents, each in its own git worktree and cmux workspace, coordinated via Volley. Replaces the claude-peers/ScheduleWakeup polling loop with sub-5s volley wait notifications. Use when the user asks to dispatch issues, work on issues, or launch agents for issues.
user_invocable: true
---

# /volley-issues

Launches one or more autonomous `claude` CLI instances — each in its own cmux workspace and git worktree — to implement GitHub issues. Coordinates via the Volley protocol: each agent calls `vol_register` + `vol_publish` for status, and the coordinator backgrounds a `volley wait` process per agent. Replaces the legacy `dispatch-issues` skill's claude-peers + ScheduleWakeup polling loop.

## Prerequisites

Before invoking `/volley-issues`:

1. **Mosquitto running.** `brew services start mosquitto`. If any tool call returns `{ code: "BROKER_DOWN" }`, follow the cross-cutting rule from `/volley`'s SKILL.md: print the install hint, stop, do not retry.

2. **volley-mcp registered in this session.** Claude Code stores MCP servers separately from `settings.json` and manages them via the `claude mcp` CLI (`mcpServers` is NOT a valid top-level `settings.json` field). Register the server at user scope with `env.VOLLEY_AGENT_ID` set to the coordinator's role prefix (e.g. `coordinator`) and `env.VOLLEY_NAMESPACE=example-dispatch`:

   ```sh
   claude mcp add-json -s user volley '{"command":"bun","args":["run","<volley-repo>/packages/volley-mcp/src/index.ts"],"env":{"VOLLEY_AGENT_ID":"coordinator","VOLLEY_NAMESPACE":"example-dispatch"}}'
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

3. **gh + claude + cmux on PATH.** Run `command -v gh claude cmux` and confirm all three resolve. If any is missing, tell the user how to install (`brew install gh`; the `claude` CLI ships with Claude Code; cmux install instructions live in the `cmux` repo).

4. **Coordinator registered as a Volley agent.** Before dispatching anything, call `vol_register({ capabilities: ["coordinator", "dispatch-issues"], cwd: <your-repo-root>, model: "claude-opus-4-7" })`. For `<your-repo-root>`, use the absolute path of the downstream repo you're dispatching from — the output of `pwd` in this Claude Code session. The response is `{ agent_id, namespace }`. The `agent_id` is the
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

## Workflow per issue

For each issue in the dispatch set:

1. **Fetch issue** — `gh issue view <number> --json title,body`. Record the title for the worktree slug and cmux workspace name.

2. **Derive the issue slug** for this issue. Format: `<slug>` is the lowercase-hyphenated issue title (capped at 20 chars). Example: `api-cache-prefetch`. The slug is used for the worktree branch name (`issue-<N>-<slug>`) and cmux workspace name — it does NOT need to be a valid Volley agent_id; the child's agent_id is auto-picked by the MCP server at startup (see step 5). Sanitize as needed (lowercase, hyphens only, no spaces).

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
     --name "Issue-<N>: <short-title>" \
     --command "claude --dangerously-skip-permissions 'Read ISSUE.md and implement GitHub issue <N>. Use ultrathink for complex decisions. Do NOT commit or push. When done, write a DEPLOY.md listing all deployment steps required but do NOT git add or commit DEPLOY.md.

   IMMEDIATELY on startup, in this order:
     1. Call vol_register with capabilities=[\"implements-issue\", \"runs-mvn-verify\"], parent_id=\"<COORDINATOR-AGENT-ID>\", cwd=\"/private/tmp/example-issue-<N>\", model=\"claude-opus-4-7\". The response includes your auto-suffixed agent_id (e.g. coordinator-7b9c). Confirm it starts with `coordinator-` — if it starts with anything else, abort: the MCP env block isn't what the dispatch flow expects.
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
   - `<N>` and `<short-title>` from the issue.
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
   cmux rename-workspace --workspace <ref> "Issue-<N>: <short title>"
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

## Coordinator loop

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
   - If the diff looks good: `git add -A && git commit -m "feat: implement #<N> — <title>"` then `git push origin issue-<N>-<slug>` and `gh pr create --base <release-branch-or-main> --title "feat: #<N> — <title>" --body "<...>"`. Embed the `DEPLOY.md` contents in the PR body under a `## Deployment Requirements` section.

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

2. **After staging verification**, squash-merge the release branch into main:
   ```bash
   gh pr create --base main --head release/<date>-<theme> --title "Release: <date> — <theme>"
   gh pr merge --squash
   ```

3. **Delete the release branch** after merge:
   ```bash
   git branch -D release/<date>-<theme>
   git push origin --delete release/<date>-<theme>
   ```

4. **Remove the migration counter** (cleanup):
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
  mosquitto_pub -t "$t" -n -r
done
```

(`-n` sends an empty payload and `-r` retains it; per MQTT semantics, an empty retained payload clears the slot.)

Rules:
- Clear only agents whose latest status is `done`/`failed`/`blocked`/`reaped`. Never clear a `registered` or `working` agent, or the coordinator.
- Clear only after the coordinator has consumed the agent's terminal event.
- **Don't select agents by `parent_id` alone.** Agents from older waves have been seen carrying the current coordinator's id. Also require the agent's `cwd` to be one of this run's worktrees.
- Records left by other sessions or waves aren't yours. Ask before sweeping them.

## Conformance with Volley v0.1

Per design doc §7.5, the dispatched agents are conforming Volley agents and MUST satisfy:

- **MUST** register on startup before publishing any other channel (spawn brief: vol_register is step 1).
- **MUST** publish a terminal `status` (`done` | `blocked` | `failed`) before clean exit (spawn brief: "ON TERMINAL COMPLETION").
- **MUST** set MQTT LWT on connect for crash detection — handled automatically by `volley-mcp`'s `startLifecycle()`; the spawn brief doesn't need to mention it.
- **MUST** refuse unknown `schema_version` major versions — built into `parseEnvelope` per Plan 2.
- **SHOULD** publish progress milestones at meaningful checkpoints (spawn brief: tests-green / mvn-verify-done / diff-ready).
- **SHOULD** include `parent_id` if spawned by another Volley agent (spawn brief: parent_id is the coordinator's agent_id).
- **MAY** subscribe to its own mailbox and respond to steering messages (not in v0.1 spawn brief — defer to v0.2 if the dispatch-issues UX wants it).

This skill itself (the coordinator) is also a conforming Volley agent: it registers via Prerequisites step 4 and inherits the same MUST clauses.
