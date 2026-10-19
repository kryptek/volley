# v0.2.0 owner smoke

The release-level smoke for **v0.2.0**: `volleyd` + `volley-hooks` + broker auth + the Volley
Desk, end to end, on real machines. Run it on the release head before tagging `v0.2.0`, top to
bottom, and record the results at the end. The narrower per-package checklists
(`packages/*/SMOKE.md`) and the v0.1 notify smoke ([`SMOKE.md`](../SMOKE.md)) are separate.

What it covers, in order:

1. a mosquitto 2.1 broker with Dynamic Security on **private ports**;
2. `volley auth init`: the shared roles, the fixed identities and their files;
3. the `volleyd` launchd service (fresh machines only), then the daemon for the wave;
4. the coordinator's hooks;
5. Desk sign-in on the laptop and on a phone over the LAN;
6. a 3–4 issue wave with half its tasks on a second machine (ssh + tmux host);
7. injected scenarios: kill an agent, urgent steer, orphan + claim, config change mid-wave,
   pause/resume;
8. merge-ready gates, auto-admitted dependents, wave completion, cleanup.

Each step says what to run and what you should see. Tick the box only when you saw it.

**Your everyday setup is never touched.** Everything the smoke creates lives under one new
directory, `$SMOKE`: the broker, its Dynamic Security state file, volleyd's journals, the `volley` /
`volleyd` links, the coordinator's hook and MCP settings. The smoke does not stop, restart,
reinstall or signal your everyday broker, does not touch an installed volleyd service, and does
not write to `~/.claude/settings.json`, your user-scope MCP config or anything on your `PATH`.
Teardown (§8) prints what it will remove and asks before removing it.

---

## 0. What you need

- [ ] **Laptop** (macOS; runs the broker, `volleyd`, the coordinator session and the Desk) with
  `bun`, **mosquitto 2.1 or newer** (`brew install mosquitto`; `mosquitto -h | head -1` says
  `mosquitto version 2.1.x`), `cmux`, `claude`, `gh` (authenticated), `git`.
- [ ] **Second machine** ("the box"; Linux or macOS) reachable by key-based, non-interactive ssh
  from the laptop (`ssh -o BatchMode=yes <target> true` succeeds), with every prerequisite in
  [volleyd README → Remote hosts](../packages/volleyd/README.md#remote-hosts-ssh--tmux): `bash`,
  `bun` and `claude` (logged in; both on the PATH of a non-interactive ssh session), `gh`, `git`,
  `tmux`, `nc`, `base64`, `cmp`, a clone of the test repo and a volley checkout of this release
  with `bun install` run (it runs the agents' MCP server; user-scope MCP servers are not loaded).
- [ ] **A phone** on the same Wi-Fi as the laptop.
- [ ] **A throwaway GitHub repo** you can open PRs and merge into, cloned on both machines, with
  3–4 small open issues. Make one depend on another (`Depends on: #<n>` in its body) and leave
  at least two independent. Push a release branch for the wave, e.g.
  `release/<yyyy-mm-dd>-smoke`.
  If you push it from another clone, §5 has a step that makes it a local branch here.
- [ ] This repo at the release head, with `bun install` clean.
- [ ] **Step 0: the skills are this release's.** An older `~/.claude/skills/volley-issues` (the
  v0.1 skill knows only the legacy cmux + `volley wait` path) makes the coordinator ignore
  volleyd. From the repo root, install all three skills (each installer is idempotent and
  replaces a stale copy, keeping a backup of a non-symlink one), then check:
  ```sh
  bash packages/volley-issues/scripts/install.sh
  bash packages/volley-skill/scripts/install.sh
  bash packages/volley-wait/scripts/install.sh
  bash packages/volley-issues/scripts/install.sh --check   # "installed 0.2, repo 0.2", exit 0
  ```
  `--check` changes nothing and exits 1 when the installed `/volley-issues` is missing or older
  than this checkout's (`version:` in its `SKILL.md` frontmatter).
- [ ] **The flags this smoke needs exist in this build.** Broker auth for volleyd
  (`volley auth init --volleyd-file`, `$VOLLEYD_HOME/broker.json`) and the Desk's LAN flag
  (`volley dash --host <addr>`) land in separate fixes for this release. From the repo root:
  ```sh
  bun packages/volley-cli/src/cli.ts auth --help | grep -- --volleyd-file    # prints the flag
  bun packages/volley-cli/src/cli.ts dash --help | grep -- --host            # prints the flag
  ```
  If either prints nothing, stop: this build is not ready for the smoke.

One shell block sets the smoke's private paths and ports. **Edit the four marked lines once**,
then paste it into **every** terminal you open for the smoke (laptop only):

```sh
export VOLLEY_REPO=/abs/path/to/volley                 # EDIT: this checkout
export TEST_REPO=/abs/path/to/test-repo                # EDIT: the test repo's clone on the laptop
export BOX=user@box.local                              # EDIT: the box's ssh target
export WAVE=yyyy-mm-dd-smoke                           # EDIT: the wave id (same theme as the release branch)
export SMOKE=$HOME/volley-smoke-v0.2                   # everything the smoke creates lives here
export BROKER_PORT=22883 WS_PORT=29001                 # private: not 1883 / 9001
export LAN_IP=$(ipconfig getifaddr en0)                # the laptop's Wi-Fi address
export VOLLEY_BROKER_URL=mqtt://127.0.0.1:$BROKER_PORT
export VOLLEY_AUTH_DIR=$SMOKE/auth                     # admin.json, coordinator.json, accounts
export VOLLEYD_HOME=$SMOKE/volleyd                     # journals, config.yaml, broker.json
export PATH=$SMOKE/bin:$PATH                           # the smoke's volley and volleyd
```

- [ ] Create `$SMOKE` (once, in the first terminal). `mkdir` without `-p` fails if the directory
  already exists: then it is left from an earlier smoke, so run that smoke's teardown (§8) or
  choose another `SMOKE` path. It must be new, because teardown deletes it.
  ```sh
  mkdir -m 0700 "$SMOKE" && mkdir "$SMOKE/bin" "$SMOKE/data" "$VOLLEYD_HOME"
  ```
- [ ] Put this checkout's `volley` and `volleyd` on the smoke's `PATH` (volleyd runs
  `volley auth` for account ops). The links live in `$SMOKE/bin`, so any
  `volley` / `volleyd` you already have installed stays as it is:
  ```sh
  ln -s "$VOLLEY_REPO/packages/volley-cli/src/cli.ts" "$SMOKE/bin/volley"
  ln -s "$VOLLEY_REPO/packages/volleyd/src/cli.ts" "$SMOKE/bin/volleyd"
  volley --version && volleyd --version     # both print 0.2.0
  ```
- [ ] Nothing signals your everyday broker: logins are created and deleted over the smoke
  broker's own control topic, and neither `volley auth` nor volleyd sends any process a signal.

---

## 1. A private broker with Dynamic Security

- [ ] Create the plugin's state file and its admin login **before** the broker exists, for the
  smoke's own paths (`--no-config`: the smoke writes its broker config itself, below):
  ```sh
  volley auth init --dir "$VOLLEY_AUTH_DIR" --no-config \
    --state-file "$SMOKE/data/dynamic-security.json" --coordinator-file --volleyd-file
  ```
  It refuses a mosquitto older than 2.1 (`BROKER_TOO_OLD`, with install instructions) before
  changing anything. Otherwise it creates `$SMOKE/data/dynamic-security.json`, stores the admin
  login in `$VOLLEY_AUTH_DIR/admin.json` (0600), cannot reach the broker yet, and says so: "Next:
  restart the broker … then run `volley auth init` again" (exit 1, expected here).
- [ ] Write the private broker's config. The plugin comes **before** any listener with
  `per_listener_settings false` (the shipped `examples/mosquitto-localhost.conf` is the same, on
  the default ports). TCP stays on loopback; the WebSocket listener binds the LAN address so the
  phone can reach it. Do this on a network you trust and stop the broker when you are done:
  ```sh
  cat > "$SMOKE/mosquitto.conf" <<EOF
  per_listener_settings false
  plugin $(brew --prefix)/opt/mosquitto/lib/mosquitto_dynamic_security.so
  plugin_opt_config_file $SMOKE/data/dynamic-security.json
  allow_anonymous false
  set_tcp_nodelay true
  max_queued_messages 10000
  pid_file $SMOKE/mosquitto.pid
  listener $BROKER_PORT 127.0.0.1
  listener $WS_PORT $LAN_IP
  protocol websockets
  persistence true
  persistence_location $SMOKE/data/
  autosave_interval 30
  autosave_on_changes false
  log_dest file $SMOKE/mosquitto.log
  EOF
  mosquitto -c "$SMOKE/mosquitto.conf" -d
  cat "$SMOKE/mosquitto.pid"                        # the smoke broker's pid
  ```
- [ ] Rerun `init` against it: it creates the eight shared roles and the fixed identities, and
  prints three passwords **once** (`volleyd`, `desk`, `coordinator`): write them down. Expect
  `coordinator.json` in `$VOLLEY_AUTH_DIR` (0600) and volleyd's login plus the admin login it mints
  agents with in `$VOLLEYD_HOME` (`broker.json`, `dynsec-admin.json`, 0600). A second rerun says
  "Nothing to do" and changes no password:
  ```sh
  volley auth init --dir "$VOLLEY_AUTH_DIR" --no-config \
    --state-file "$SMOKE/data/dynamic-security.json" --coordinator-file --volleyd-file
  ls -la "$VOLLEY_AUTH_DIR" "$VOLLEYD_HOME/broker.json" "$VOLLEYD_HOME/dynsec-admin.json"
  volley auth init --dir "$VOLLEY_AUTH_DIR" --no-config --state-file "$SMOKE/data/dynamic-security.json"
  volley auth list-agents --dir "$VOLLEY_AUTH_DIR"  # No agent logins.
  ```
- [ ] Both listeners are up, and the broker refuses anonymous and wrong-password clients:
  ```sh
  lsof -nP -iTCP:$BROKER_PORT -sTCP:LISTEN; lsof -nP -iTCP:$WS_PORT -sTCP:LISTEN
  volley list                                       # exit 1: AUTH_FAILED (no credentials)
  VOLLEY_AUTH_USERNAME=coordinator VOLLEY_AUTH_PASSWORD=wrong volley list   # exit 1: AUTH_FAILED
  ```
- [ ] Export the coordinator identity for the rest of this terminal (and every later one):
  ```sh
  export VOLLEY_AUTH_USERNAME=coordinator VOLLEY_AUTH_PASSWORD='<coordinator password>'
  volley list                                       # exit 0, no agents yet
  ```

---

## 2. The volleyd service

The service label (`systems.volley.volleyd`) is fixed, so a second, smoke-only service cannot
sit beside an installed one. The plist check runs everywhere; the install / restart / uninstall
round trip runs **only on a machine with no volleyd service**, and the block below checks that
for you. Your installed service, if you have one, is never stopped, replaced or removed.

- [ ] The launchd plist carries no secret (`--dry-run` only prints it; nothing is written):
  ```sh
  volleyd install --dry-run | grep -i -E "password|AUTH"     # prints nothing
  ```
- [ ] Service round trip, fresh machines only. Paste the whole block; on a machine that already
  has the service it prints one line and does nothing else:
  ```sh
  if [ -e "$HOME/Library/LaunchAgents/systems.volley.volleyd.plist" ] ||
     launchctl print "gui/$UID/systems.volley.volleyd" >/dev/null 2>&1; then
    echo "volleyd service already installed: skipping the round trip (it is not touched)"
  else
    volleyd install && touch "$SMOKE/service-installed"
    sleep 3; volleyd status; echo "status exit $?"                     # 0: the daemon answered
    grep -c AUTH_FAILED "$VOLLEYD_HOME/volleyd.log"                     # 0 (creds from broker.json)
    launchctl kickstart -k "gui/$UID/systems.volley.volleyd"
    sleep 3; volleyd status; echo "status exit $?"                     # 0 again after the restart
    volleyd uninstall && rm "$SMOKE/service-installed"                 # removes the smoke's own install
  fi
  ```
  If you skipped it, write "skipped (service already installed)" in Results.
- [ ] For the wave, run the daemon in the foreground, so it uses the smoke's `VOLLEYD_HOME` and
  mints agents on the smoke broker with `$VOLLEYD_HOME/dynsec-admin.json`. An everyday service you already
  run is on your everyday broker and carries on unaffected:
  ```sh
  volleyd daemon 2>&1 | tee "$SMOKE/volleyd-foreground.log"   # leave this terminal running
  ```
  In another smoke terminal: `volleyd status` exits 0.

---

## 3. The coordinator's hooks

The coordinator session gets its hooks and its MCP server from files in `$SMOKE`, passed on the
`claude` command line, so `~/.claude/settings.json` and your user-scope MCP config (which may
hard-code your everyday broker's credentials) are left alone.

- [ ] Write the coordinator's hook settings. The hooks find their credentials in
  `$VOLLEY_AUTH_DIR/coordinator.json`, so no password goes into the file. If your user settings
  already carry volley-hooks, those run in the smoke session anyway (with the smoke's environment),
  so the smoke file stays empty to avoid running every hook twice:
  ```sh
  if grep -q volley-hooks "$HOME/.claude/settings.json" 2>/dev/null; then
    echo '{}' > "$SMOKE/coordinator-settings.json"
    echo "reusing the volley-hooks in your user settings (not touched)"
  else
    CLAUDE_SETTINGS="$SMOKE/coordinator-settings.json" "$VOLLEY_REPO/packages/volley-hooks/scripts/install.sh"
  fi
  grep -c volley-hooks "$SMOKE/coordinator-settings.json"     # > 0, or 0 when reusing yours
  grep -c -i password "$SMOKE/coordinator-settings.json"      # 0
  ```
- [ ] Write the smoke's MCP config (mode 0600: it holds the coordinator password):
  ```sh
  (umask 077 && cat > "$SMOKE/mcp.json" <<EOF
  { "mcpServers": { "volley": {
      "command": "bun",
      "args": ["run", "$VOLLEY_REPO/packages/volley-mcp/src/index.ts"],
      "env": { "VOLLEY_BROKER_URL": "$VOLLEY_BROKER_URL", "VOLLEY_NAMESPACE": "default",
               "VOLLEY_AGENT_ID": "coordinator",
               "VOLLEY_AUTH_USERNAME": "coordinator", "VOLLEY_AUTH_PASSWORD": "$VOLLEY_AUTH_PASSWORD" } } } }
  EOF
  )
  grep -c '"VOLLEY_AGENT_ID": "coordinator"' "$SMOKE/mcp.json"   # 1
  ```
  `VOLLEY_AGENT_ID` is the agent-id **prefix**: the MCP server appends a fresh `-xxxx` at every
  start, so the session registers as `coordinator-xxxx`. Without it the id is named after the
  working directory (`<test-repo>-xxxx`), which reads as just another agent, while every later
  check here (`volley list`, the `--owner` you pass to `volleyd run`, the Desk's owner chip and
  `★ yours`) expects the `coordinator-` id. The smoke broker carries no other traffic, so
  `VOLLEY_NAMESPACE` stays `default`; on a shared broker, give the smoke its own namespace here
  and in the wave file's `namespace:`.
- [ ] **First-run browser prompt.** When it finds Chrome, Claude Code asks once per user profile
  whether to use Claude in Chrome, and waits for a key, so an unattended start (this
  coordinator, or an agent volleyd spawns under the same profile) hangs on it. It is asked while
  `claudeInChromeDefaultEnabled` is unset in the profile's `~/.claude.json`
  (`$CLAUDE_CONFIG_DIR/.claude.json` with a custom config dir); answering records the choice
  there. Check, in the environment the unattended start uses (same `HOME` and
  `CLAUDE_CONFIG_DIR`); if it prints `null` (also printed when the file does not exist yet),
  answer it once in an interactive `claude` (or set *Claude in Chrome → Enabled by default* in
  `/config`), then quit:
  ```sh
  bun -e 'const f = `${process.env.CLAUDE_CONFIG_DIR ?? process.env.HOME}/.claude.json`; let c = {}; try { c = JSON.parse(require("node:fs").readFileSync(f, "utf8")) } catch {} console.log(f, c.claudeInChromeDefaultEnabled ?? null)'
  # <file> true, or <file> false; not null
  ```
  Passing `--no-chrome` to `claude` also skips it, for that session only. Do the same on the box
  for the user its agents run as.
- [ ] Start the coordinator session in the test repo, from a terminal that has the smoke block
  and the `VOLLEY_AUTH_*` exports above:
  ```sh
  cd "$TEST_REPO" && claude --settings "$SMOKE/coordinator-settings.json" \
    --mcp-config "$SMOKE/mcp.json" --strict-mcp-config
  ```
  The MCP server auto-registers the session (`vol_register` updates it); check
  `volley list` shows `coordinator-xxxx` with the model you are actually running. Note its id:
  `export OWNER=coordinator-xxxx` in your other smoke terminals.
- [ ] Lease wrapping in coordinator mode: run a command that matches a lease pool (set one with
  `volleyd config set lease_pools '{ build: { capacity: 1, match: ["npm run build"] } }'`). The
  hook rewrites it to `volley lease run … --coordinator -- …`, and it waits for and gets a lease
  (`volley lease status` while it runs). A broker that refuses the credentials makes the wrapped
  command fail with exit 1; it is never run unleased.

---

## 4. Desk sign-in: laptop and phone

- [ ] Start the Desk reachable from the LAN, pointed at the private WebSocket listener:
  ```sh
  cd "$VOLLEY_REPO" && volley dash --broker-url "ws://$LAN_IP:$WS_PORT" --host 0.0.0.0 --no-open
  ```
  It prints the URL it serves on (port 5174 unless you pass `--port`).
- [ ] **Laptop:** open `http://$LAN_IP:5174/` (or the port it printed). The sign-in form appears.
  A wrong password is refused and not remembered; `desk` + its password connects, and a reload
  stays signed in.
- [ ] **Phone:** open the same URL. Sign in as `desk`. The layout fits the phone width; panning,
  window focus and the coordinators window work by touch.
- [ ] Both show the coordinator, and `volleyd` with its retained config.

---

## 5. A wave across two machines

- [ ] Describe the box in volleyd's config (paths are on the box and must be absolute; edit them):
  ```sh
  volleyd config set hosts "{ box: { target: \"$BOX\", repo: \"/abs/path/on/box/test-repo\",
    volley_dir: \"/abs/path/on/box/volley\" } }"
  ```
- [ ] In the coordinator session, run `/volley-issues` for the 3–4 issues with wave id `$WAVE`,
  and tell it to **stop after writing the wave file** (before `volleyd run`). It takes the volleyd
  path (`volleyd status` exits 0) and writes `.volley/waves/$WAVE.yaml`. Then, in a smoke
  terminal, add `host: box` to half the tasks (at least one independent task and the dependent
  one) and validate:
  ```sh
  cd "$TEST_REPO" && volleyd validate ".volley/waves/$WAVE.yaml"
  ```
- [ ] **Brief preface.** The wave file has `brief_preface: ".volley/brief-preface.md"`, and the
  skill wrote that file from its template (`wrote … from the template` on its stderr) unless it
  already existed. Add one repo rule under `## Repository rules`, then re-validate: the output
  ends with `brief preface: $TEST_REPO/.volley/brief-preface.md (<bytes> B, sha256 <12 hex>)`,
  and the sha256 prefix matches `sha256sum "$TEST_REPO/.volley/brief-preface.md"`.
- [ ] **Tracking branch** (remove this step once volleyd fetches a release branch that exists
  only on origin): a release branch pushed from another clone is only `origin/release/<x>` in
  the laptop's clone, and `volleyd run` needs it as a local branch. If
  `git -C "$TEST_REPO" branch --list release/<yyyy-mm-dd>-smoke` prints nothing:
  ```sh
  git -C "$TEST_REPO" fetch origin
  git -C "$TEST_REPO" branch --track release/<yyyy-mm-dd>-smoke origin/release/<yyyy-mm-dd>-smoke
  ```
- [ ] Tell the session to continue: it submits with `volleyd run .volley/waves/$WAVE.yaml --owner
  <its coordinator id>`.
- [ ] Spawns: local tasks get a cmux workspace each; box tasks get a tmux session
  (`ssh "$BOX" tmux ls` shows `$WAVE-<task>-implementer-1`, with the task id as the wave file
  spells it, e.g. `T1`; agent ids are its lower-cased form, `t1`). Each agent's worktree has
  `.volley/agent.json` (mode 0600; on the box with `broker_url mqtt://127.0.0.1:21883`, the
  reverse tunnel). `volley list` shows each agent under its assigned id with the real model;
  heartbeats flow (`volley sub --pattern 'volley/+/+/progress'`).
- [ ] The Desk shows the wave window (dependency graph, owner chip = the coordinator), an agent
  window per agent with live narration and a Terminal tab (box agents: `source: tmux`).
- [ ] The dependent task stays `queued` with a reason until its dependency is done.
- [ ] **The preface reached every agent.** `volleyd status "$WAVE"` shows
  `brief preface: <path> (<bytes> B, sha256 <12 hex>)` under the header (the same as
  `validate`). Every agent's `.volley/brief.md` starts with the preface's exact bytes, then a
  `---` rule, then its role's template — check the implementers now, and each reviewer, fixup and
  rebase brief as they spawn in section 7 (`ssh "$BOX" cat …` for box worktrees):
  ```sh
  P="$TEST_REPO/.volley/brief-preface.md"
  for b in <worktree_root>/"$WAVE"/*/.volley/brief.md; do
    cmp -n "$(wc -c < "$P")" "$P" "$b" && echo "ok $b"
  done
  ```
  Both reviewer briefs also carry the `Public hygiene: flag as P1 …` line, and their `result`
  carries `hygiene: { checked: true, … }`.

---

## 6. Injected scenarios

Run them while agents are working, in this order (the urgent-steer refusal needs the wave still
owned by the coordinator, so it comes before the claim). After each, note in Results what you saw.

### Kill an agent

- [ ] Kill one local agent's `claude` process (close its cmux workspace) and one box agent's
  (`ssh "$BOX" tmux kill-session -t "=$WAVE-<task>-<role>-<attempt>"`, the name `tmux ls` shows).
- [ ] Within the keepalive window its status goes `reaped` (LWT). volleyd holds the reap for its
  grace, then retires the agent and opens an `agent_blocked` decision ("… failed. Respawn …, or
  cancel the task?"). The Desk raises it under **Needs you**; the coordinator loop sees
  `decision_opened`.
- [ ] Resolve it with `respawn` (`volleyd resolve <decision-id> respawn --wave "$WAVE"` from a
  smoke terminal, or from the Desk). A fresh agent spawns with the next attempt number and
  carries on.

### Urgent steer on a coordinator-owned wave

- [ ] While the coordinator still owns the wave, send an urgent `/stop` from the Desk to one of
  its working agents. It is refused (only the owner may interrupt), and the refusal names the
  owner (`$OWNER`). The agent is not interrupted.

### Orphan + claim

- [ ] Make claims quick for the smoke: `volleyd config set claim_after_s 120`.
- [ ] Exit the coordinator session (its status goes `done`/`reaped`, or it falls silent). Within
  `claim_after_s` the Desk shows **Needs you: no coordinator** for the wave.
- [ ] Claim it from the Desk. The owner chip becomes `desk`, the **no coordinator** warning
  clears, and `volleyd status "$WAVE"` shows the new owner. The journal has the claim (the
  `smoke` cursor is only read here, never acked, so no other reader's cursor moves):
  ```sh
  volleyd events "$WAVE" --cursor smoke | grep owner_claimed     # one line
  ```
  Agents still ack the new owner's steering ("Delivered by hook").
- [ ] Restore: `volleyd config set claim_after_s 1800`.

### Urgent steer on a Desk-owned wave

- [ ] On the wave the Desk now owns, open a working agent's steering panel and send an
  **urgent** steer. The agent is interrupted (Escape) and the message arrives. Delivery states go
  Sent → Delivered by hook → Agent acknowledged, and the steer reached the agent you picked (check
  its role in the result), not another stage's agent.

### Config change mid-wave

- [ ] In the Desk's **Settings › Supervisor** (dock → Settings, or a wave's ⚙ → *Global
  settings…*), change a global tunable (e.g. `heartbeat_alarm_s` to 900). It applies without a
  restart, the Desk shows the new value, and the reply came from `volleyd` (the row reports
  `applied · v<version>`). Wave-scoped values come from the wave file's `config:` block; a wave's
  ⚙ shows them read-only:
  ```sh
  volleyd config get heartbeat_alarm_s                              # 900
  volleyd config get --wave "$WAVE"                                 # the wave's effective config
  volleyd events _system --cursor smoke | grep config_changed       # one line per change
  ```
- [ ] An invalid value (e.g. `-1`) is rejected with the field named; nothing changes.

### Pause / resume

The wave's owner is `desk` since the claim:

- [ ] `volleyd pause "$WAVE" --by desk`: no new tasks are admitted (queued tasks say why);
  running agents carry on.
- [ ] `volleyd resume "$WAVE" --by desk`: admission resumes.
- [ ] Optional kill switch: `volleyd stop --all`, then `volleyd run` is refused until
  `volleyd resume --all` (and the stopped wave stays stopped until `volleyd resume "$WAVE" --by
  desk`).

---

## 7. Gates, merges, completion

- [ ] A task reaches `merge_ready`: its evidence package (`volleyd status "$WAVE" --json` →
  `tasks[].evidence_path`) has the PR, the head sha, CI on that exact head, both reviews and how
  each P1 was resolved.
- [ ] Merge that PR into the release branch by hand. Within about a minute the task is `done`
  (`stage_entered {stage: "done", merged: true}`) and its dependent is admitted and spawned **by
  volleyd** (do not `volleyd spawn` it).
- [ ] After the last merge the wave completes (`wave_complete`); the Desk shows it finished, and
  admission stops sampling CI for its repo.
- [ ] `volleyd cleanup "$WAVE"` lists what it would remove; `volleyd cleanup "$WAVE" --yes`
  removes the retired worktrees and workspaces on both machines and keeps the branches.
- [ ] Every login minted for the wave (implementers, reviewers, fixups, rebases) is gone: volleyd
  deleted each one when it retired its agent (the agent's retained status flipped to `reaped
  {reason: credentials_deleted}` and its records were cleared, with no broker reload), and the
  sweep caught any leftover. The login count is back at its baseline from before the wave:
  ```sh
  volley auth list-agents --dir "$VOLLEY_AUTH_DIR"   # No agent logins.
  volleyd status | head -1                          # agent logins: 0 live, <n> swept
  ```
- [ ] `volleyd stop` leaves no login behind either: start a second, one-task wave, and once its
  agent is working run `volleyd stop <that wave> --by desk`. Its agent is retired at once
  (`agent_retired {status: stopped}` in its journal) and `volley auth list-agents` is empty again.

---

## 8. Teardown

Removes only what this smoke created, after showing you the list.

1. Stop what is still running, each in its own terminal: the wave (`volleyd stop "$WAVE" --by
   desk`, if anything is still running), then the foreground daemon (Ctrl-C), the Desk (Ctrl-C)
   and the coordinator session (`/exit`).
2. Review, then confirm. Run from a smoke terminal:
   ```sh
   echo "Will stop:   the smoke broker, pid $(cat "$SMOKE/mosquitto.pid") ($SMOKE/mosquitto.conf)"
   [ -e "$SMOKE/service-installed" ] && echo "Will remove: the volleyd service the smoke installed in §2"
   echo "Will delete: $SMOKE, containing:"; ls -A "$SMOKE"
   printf 'Proceed? [y/N] '; read -r ok
   if [ "$ok" = y ]; then
     kill "$(cat "$SMOKE/mosquitto.pid")"
     [ -e "$SMOKE/service-installed" ] && volleyd uninstall
     rm -rf "$SMOKE"
   fi
   ```
   (`service-installed` only exists if §2's round trip installed the service and stopped before
   its own `uninstall`. If §2 printed "already installed", your service was never touched and
   there is nothing to restore.)
3. Left in place, because they are yours or the test repo's: the test repo's clones, branches and
   `.volley/waves/` file on both machines, and the box's volley checkout. The tmux sessions and
   worktrees on the box went with `volleyd cleanup`.

---

## Results

Record what you saw, step by step, with timings where a step has one, before tagging `v0.2.0`.

```
RESULTS (<date>, release head <sha>):
  1. broker:
  2. service (round trip / skipped):
  3. hooks + lease:
  4. Desk laptop / phone:
  5. wave spawn (local / box), brief preface on every role's brief:
  6. kill / urgent refused / claim / urgent / config / pause:
  7. gates, merges, completion, cleanup:
  Issues found:
```
