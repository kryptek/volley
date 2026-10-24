# Manual smoke checklist for the /volley-issues skill

These steps verify the volley-issues skill against a real downstream repo + live mosquitto + an actual `claude` CLI subprocess. The synthetic parity test covers latency; this checklist covers the end-to-end dispatch flow. Run before tagging a Volley release (most recently updated in `v0.1.0-plan6` for the auto-suffix flow) and before any cutover from the legacy dispatch-issues skill.

## Setup (once)

- [ ] Volley installed with the one command (the root README's Quickstart), or `volley setup` run on this machine: `volley setup --check` reports every row `done`. That covers the broker, this skill linked, and volley-mcp registered with Claude Code at user scope (no password in it, `VOLLEY_AGENT_ID=coordinator`, `VOLLEY_NAMESPACE=default`). Run `claude mcp list` — you should see `volley: ... ✓ Connected`. If missing, `volley setup --step claude-code`, then restart Claude Code (exit the session and start `claude` again). Do NOT hand-edit `~/.claude/settings.json` — Claude Code rejects `mcpServers` as an unknown top-level field; MCP servers are stored in a separate config managed by the `claude mcp` CLI. The MCP server picks a fresh `-XXXX` suffix at every startup, so this coordinator's actual agent_id is `coordinator-XXXX` — discoverable via vol_register's response.
- [ ] In Claude Code: confirm `vol_register`, `vol_list_agents`, `vol_subscribe`, `vol_send_mailbox`, `vol_query`, `vol_tap` appear in the available MCP tools list.
- [ ] Pick a small, real, low-risk downstream issue to dispatch. (A typo fix or one-line config change is ideal.)

## Coordinator registration

- [ ] In Claude Code: call `vol_register({ capabilities: ["coordinator", "dispatch-issues"], cwd: "<your-cwd>", model: "<the model this session runs>" })`. Confirm the response's `agent_id` matches the pattern `coordinator-[a-z0-9]{4}` (auto-suffix). Record this exact id — it's the `parent_id` you embed in dispatched children's spawn briefs.

## Single-issue dispatch

- [ ] In Claude Code: `/volley-issues #<chosen-issue>`.
- [ ] Confirm the skill: (a) creates a worktree under `/private/tmp/example-issue-<N>/`, (b) writes ISSUE.md there, (c) launches a cmux workspace with a `claude --dangerously-skip-permissions` subprocess.
- [ ] Confirm a NEW agent appears in `vol_list_agents({ namespace: "default" })` within ~5s. The new agent's `parent_id` should equal the coordinator's recorded agent_id, and its `cwd` should equal `/private/tmp/example-issue-<N>`. The child's `agent_id` will be `coordinator-YYYY` (a different suffix from the coordinator) — record it for the wait-latency check.
- [ ] Let the agent work. Watch progress: `/volley watch <child-agent-id>` (uses the `/volley` skill), substituting the discovered child agent_id.
- [ ] When the agent publishes terminal `done`, confirm the coordinator wakes within **< 5s** (this is the whole point of the dogfood). The coordinator reads the agent's worktree, reviews the diff, and proceeds to commit + PR per the Coordinator loop.
- [ ] Verify the PR was created on GitHub against the right base branch (main for single-issue, release branch for batch).
- [ ] Verify the `DEPLOY.md` contents were embedded in the PR body under `## Deployment Requirements`.

## Crash detection check

- [ ] Pick another simple issue. `/volley-issues #<issue>`.
- [ ] Once the dispatched agent reaches `working` status: open a terminal, find the `claude` PID, and `kill -9 <pid>`.
- [ ] Within ~60-90s (MQTT keepalive 60s × mosquitto's 1.5× deadline tolerance + LWT propagation), confirm the coordinator wakes with the agent's status flipped to `reaped`. The coordinator should open the workspace and report the crash to you. If it takes >90s, mosquitto may be configured with a longer keepalive-tolerance multiplier — not a bug.
- [ ] Do NOT auto-restart. The crash-detection test passes if the wake happened; you decide manually whether to relaunch.

## Batch dispatch (if time permits)

- [ ] Pick 2 small issues. `/volley-issues #<N1>,#<N2>`.
- [ ] Confirm a release branch was created.
- [ ] Both agents launch in parallel; coordinator backgrounds two `volley wait` processes.
- [ ] As each agent terminates, the coordinator processes them independently (one PR each, both targeting the release branch).
- [ ] When both are done + merged, the coordinator prompts you to deploy the release branch to staging.

## Autopilot dispatch (volleyd path)

The sections above exercise the legacy path. With `volleyd status` exiting 0 and `VOLLEY_COORDINATOR` set in the MCP registration's `env` and exported in the shell:

- [ ] `/volley-issues #<N1>,#<N2>`: the generated wave file carries `merge: "auto"` and, as passed, `config: {"autopilot":{"enabled":true},"branch_update":"merge"}`; the helper's last stderr lines are `submit: volleyd run <file> --owner "$VOLLEY_COORDINATOR"` and `owner: <your coordinator name> (VOLLEY_COORDINATOR)`.
- [ ] The skill asks the go-ahead with an `AskUserQuestion` go/no-go picker (`go`, `hold`, `cancel`), which also shows in the Desk's Needs-you window; answer it there and confirm the session acts on it.
- [ ] After `volleyd run`, the skill says the wave is submitted and leaves: no per-event loop, no `volley wait` per agent. Ending the session does not stop the wave.
- [ ] Anything owner-only (or an escalation) shows in the Desk's Needs-you window and in `volleyd inbox`; answering it with `volleyd inbox answer <id> <answer>` resolves it.
- [ ] Asked to wait, the skill arms one `volley sub --pattern "volley/_waves/<wave>/digest"` and, on the wake, relays `volleyd digest <wave>`.
- [ ] Re-run with `--autopilot off`: the wave file carries `config: {"autopilot":{"enabled":false}}`, and the skill follows **Driving a wave by hand** (decisions and merge-ready gates).

## Tear-down

- [ ] After verification: clean up retained agent registry entries. Substitute `<child-A-id>` and `<child-B-id>` with the `coordinator-XXXX` ids you recorded across the Single-issue dispatch and Crash detection sections above (the auto-suffixed ids the child MCPs picked at startup — discovered post-dispatch via `vol_list_agents`):
   ```sh
   mosquitto_pub -t "volley/_system/registry/<child-A-id>" -n -r
   mosquitto_pub -t "volley/_system/registry/<child-B-id>" -n -r
   mosquitto_pub -t "volley/default/<child-A-id>/status" -n -r
   mosquitto_pub -t "volley/default/<child-B-id>/status" -n -r
   ```

## Sign-off

- [ ] All boxes ticked. Tick this last box AND record the date + HEAD commit + the measured single-issue wake latency in this section before committing the ticked-checklist file. Example: `Smoke passed 2026-05-16 against HEAD abcdef0. Wake latency: 1.2s.`

---

### Run history

#### 2026-05-15 — PARTIAL pass against a downstream repo (single-issue, frontend fix)

**Validated (HEAD before this commit: `05e7133`):**

- Coordinator `vol_register` succeeds end-to-end on a fresh downstream Claude Code session against a live mosquitto.
- Two volley-mcp processes sharing one `VOLLEY_AGENT_ID` can coexist on the broker (verifies `05e7133`'s random-clientId-suffix fix).
- Release-branch + worktree + ISSUE.md + cmux-workspace launch path runs to completion in ~6 minutes (mostly Claude in the downstream session deliberating about how to construct the cmux `bash -c` launch — see Plan 6 prereqs #3).
- Child claude subprocess launched in the cmux workspace was reachable, registered, and self-published a terminal status — round-trip from child-launch to retained terminal status: **17 seconds**.
- ★ The "MANDATORY post-dispatch identity check" added in `12aa257` (volley-issues opus review) **worked as designed**. The dispatched child detected that its `vol_register` response returned `agent_id="coordinator-base"` instead of an issue-scoped id, refused to write any code, published `status=failed` with reason `env-injection-failed-registered-as-coordinator`, and exited. No source files were modified, no DEPLOY.md written, no PR opened.

**Not validated (deferred to post-Plan-6):**

- End-to-end wake latency measurement. Requires a *successful* dispatch (child does real work, publishes `status=done`). The v0.1 architecture cannot support this on a user-scope MCP setup because Claude Code's MCP launcher passes the registration's `env` block verbatim to every spawned MCP, overriding any `VOLLEY_AGENT_ID` the coordinator tries to inject via `bash -c export`. See Plan 6 prereqs item #1 (per-process agent_id) for the architectural fix.
- Coordinator-wakes-on-child-terminal-status loop (`volley wait` backgrounded subscribe).
- Crash-detection check (`kill -9` the child, observe `reaped`).
- Batch dispatch.

**Conclusion:** Tagged `v0.1.0-plan5` with this partial sign-off. The Volley coordination plumbing (broker connect, vol_register, retained registry, identity-collision safeguard) is empirically sound; the dispatched-child wake-latency claim from the parity-report is unverified against a real dispatch and remains valid only against the synthetic parity test. Re-run this SMOKE end-to-end after Plan 6 ships the per-process `VOLLEY_AGENT_ID` auto-suffix, then update this section with the measured wake latency.

#### 2026-05-15 — FULL pass against a downstream repo (single-issue, frontend fix), Plan 6

**HEAD before this commit:** `3f01271` (Plan 6 complete; auto-suffix + broker staleness + docs).

- Coordinator `coordinator-0t71` registered at 22:56:33Z (downstream cwd, capabilities `coordinator + dispatch-issues`).
- `/volley-issues #<N>` dispatched a child cmux workspace. Child `coordinator-0u2p` (parent_id `coordinator-0t71`, cwd `/private/tmp/example-issue-<N>`, capabilities `implements-issue + frontend`) appeared in `vol_list_agents` within ~5s.
- Plan 6 auto-suffix verified: coordinator and child both spawned from the same user-scope MCP registration (`VOLLEY_AGENT_ID=coordinator`) and received distinct `-0t71` and `-0u2p` suffixes automatically. No shared-clientId kick, no env-injection-failed safeguard trip.
- Child went `working` at 23:00:26Z, terminal `done` at 23:05:20Z. Self-published a clean, scope-disciplined summary (called out pre-existing test failures as out-of-scope rather than touching them).
- **Coordinator wake-latency: ~1–2s** (subjective, observed by the operator — felt "immediate" between child `done` and coordinator's next action). The < 5s SPEC budget is met.
- Coordinator opened a PR against the downstream `main` with DEPLOY.md embedded under `## Deployment Requirements`.
- **End-to-end wall clock from `/volley-issues #<N>` to PR opened: 5m20s.**

**Conclusion:** Plan 5's headline wake-latency claim is now empirically validated against a real dispatched child doing real frontend work end-to-end. Tagging `v0.1.0-plan6`. Sign-off below.

Smoke passed 2026-05-15 against HEAD `3f01271`. Wake latency: ~1–2s. End-to-end: 5m20s.
