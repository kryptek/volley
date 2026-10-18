# v0.2.0 owner smoke

The release-level smoke for **v0.2.0**: `volleyd` + `volley-hooks` + broker auth + the Volley
Desk, end to end, on real machines. Run it on the release head before tagging `v0.2.0`, top to
bottom, and record the results at the end. The narrower per-package checklists
(`packages/*/SMOKE.md`) and the v0.1 notify smoke ([`SMOKE.md`](../SMOKE.md)) are separate.

What it covers, in order:

1. a password-protected broker on **private ports** (your everyday broker is never touched);
2. `volley auth init`: the fixed identities and their files;
3. the `volleyd` launchd service, then the daemon for the wave;
4. the coordinator's hooks;
5. Desk sign-in on the laptop and on a phone over the LAN;
6. a 3–4 issue wave with half its tasks on a second machine (ssh + tmux host);
7. injected scenarios: kill an agent, orphan + claim, config change mid-wave, urgent steer,
   pause/resume;
8. merge-ready gates, auto-admitted dependents, wave completion, cleanup.

Each step says what to run and what you should see. Tick the box only when you saw it.

---

## 0. What you need

- [ ] **Laptop** (macOS; runs the broker, `volleyd`, the coordinator session and the Desk) with
  `bun`, `mosquitto` (`brew install mosquitto`), `cmux`, `claude`, `gh` (authenticated), `git`.
- [ ] **Second machine** ("the box"; Linux or macOS) reachable by key-based, non-interactive ssh
  from the laptop (`ssh -o BatchMode=yes <target> true` succeeds), with every prerequisite in
  [volleyd README → Remote hosts](../packages/volleyd/README.md#remote-hosts-ssh--tmux): `bash`,
  `bun`, `claude` (logged in, on the PATH of a non-interactive ssh session, volley MCP server
  registered at user scope), `gh`, `git`, `tmux`, `nc`, `base64`, `cmp`, a clone of the test repo
  and a volley checkout of this release with `bun install` run.
- [ ] **A phone** on the same Wi-Fi as the laptop.
- [ ] **A throwaway GitHub repo** you can open PRs and merge into, cloned on both machines, with
  3–4 small open issues. Make one depend on another (`Depends on: #<n>` in its body) and leave
  at least two independent. Push a release branch for the wave, e.g.
  `release/<date>-smoke`.
- [ ] This repo at the release head, `bun install` clean, and `volley` **and** `volleyd` on your
  PATH (`volleyd` shells out to `volley auth add-agent` to mint agent credentials):
  ```sh
  ln -sf "$PWD/packages/volley-cli/src/cli.ts" /usr/local/bin/volley
  ln -sf "$PWD/packages/volleyd/src/cli.ts" /usr/local/bin/volleyd
  volley --version && volleyd --version     # both print 0.2.0
  ```

Throughout, one shell block sets the smoke's private paths and ports. Paste it into **every**
terminal you open for the smoke:

```sh
export SMOKE=$HOME/volley-smoke                     # everything the smoke creates lives here
export BROKER_PORT=22883 WS_PORT=29001              # private: not 1883 / 9001
export LAN_IP=$(ipconfig getifaddr en0)             # the laptop's Wi-Fi address
export VOLLEY_BROKER_URL=mqtt://127.0.0.1:$BROKER_PORT
export VOLLEY_AUTH_DIR=$SMOKE/auth                  # passwd, acl.conf, coordinator.json
export VOLLEYD_HOME=$SMOKE/volleyd                  # journals, config.yaml, broker.json
```

---

## 1. A private broker with auth

- [ ] Create the identities **before** the broker exists (mosquitto refuses to start without its
  password file):
  ```sh
  mkdir -p "$SMOKE/data" "$VOLLEYD_HOME"
  volley auth init --dir "$VOLLEY_AUTH_DIR" --coordinator-file --volleyd-file --no-reload
  ```
  It prints three passwords **once** (`volleyd`, `desk`, `coordinator`): write them down.
  Expect `passwd` and `acl.conf` in `$VOLLEY_AUTH_DIR` (directory mode 0700, files 0600),
  `coordinator.json` beside them (0600), and volleyd's credentials in
  `$VOLLEYD_HOME/broker.json` (0600):
  ```sh
  ls -la "$VOLLEY_AUTH_DIR" "$VOLLEYD_HOME/broker.json"
  ```
- [ ] Write the private broker's config. TCP stays on loopback; the WebSocket listener binds the
  LAN address so the phone can reach it. Both require a password and the shipped ACL. Do this on a
  network you trust and stop the broker when you are done:
  ```sh
  cat > "$SMOKE/mosquitto.conf" <<EOF
  allow_anonymous false
  password_file $VOLLEY_AUTH_DIR/passwd
  acl_file $VOLLEY_AUTH_DIR/acl.conf
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

`volley auth add-agent` (which volleyd runs for every spawn) reloads mosquitto with `pkill -HUP -x
mosquitto`. That signal reaches **every** mosquitto on the laptop, including your everyday
broker; each one only re-reads its own files, so this is harmless.

---

## 2. The volleyd service

- [ ] The launchd plist carries no secret:
  ```sh
  volleyd install --dry-run | grep -i -E "password|AUTH"     # prints nothing
  ```
- [ ] Install and load it, and check that it authenticated (its credentials come from
  `$VOLLEYD_HOME/broker.json`):
  ```sh
  volleyd install
  volleyd status                                    # exit 0: the daemon answered
  tail -n 20 "$VOLLEYD_HOME/volleyd.log"           # no AUTH_FAILED
  ```
  **If you already run the volleyd service for real work, skip `install`** (it replaces the
  installed service) and use the foreground daemon below for the whole smoke.
- [ ] Restart it and see it come back: `launchctl kickstart -k gui/$UID/systems.volley.volleyd`,
  then `volleyd status` again.
- [ ] For the wave, run the daemon in the foreground instead, so it mints agents into the smoke's
  password file (the plist does not carry `VOLLEY_AUTH_DIR`, so the service would mint into the
  default `<mosquitto etc>/volley`):
  ```sh
  volleyd uninstall
  volleyd daemon 2>&1 | tee "$SMOKE/volleyd-foreground.log"   # leave this terminal running
  ```

---

## 3. The coordinator's hooks

- [ ] Install the coordinator hooks (they find their credentials in `$VOLLEY_AUTH_DIR/coordinator.json`,
  so no password goes into `settings.json`):
  ```sh
  packages/volley-hooks/scripts/install.sh --dry-run | grep -c volley-hooks   # > 0
  packages/volley-hooks/scripts/install.sh
  grep -c -i password ~/.claude/settings.json                                  # 0
  ```
- [ ] Start the coordinator session in the test repo from a terminal that has the smoke block and
  the `VOLLEY_AUTH_*` exports above. The volley MCP server must not hard-code
  `VOLLEY_BROKER_URL` / `VOLLEY_AUTH_*` in its env block (or give the test repo a project-scope
  `.mcp.json` with the smoke values).
  ```sh
  cd <test-repo> && claude
  ```
  The MCP server auto-registers the session (`vol_register` updates it); check
  `volley list` shows `coordinator-xxxx` with the model you are actually running.
- [ ] Lease wrapping in coordinator mode: run a command that matches a lease pool (set one with
  `volleyd config set lease_pools '{ build: { capacity: 1, match: ["npm run build"] } }'`). The
  hook rewrites it to `volley lease run … --coordinator -- …`, and it waits for and gets a lease
  (`volley lease status` while it runs). A broker that refuses the credentials makes the wrapped
  command fail with exit 1; it is never run unleased.

---

## 4. Desk sign-in: laptop and phone

- [ ] Start the Desk reachable from the LAN, pointed at the private WebSocket listener:
  ```sh
  volley dash --broker-url "ws://$LAN_IP:$WS_PORT" --host --no-open
  ```
  (Without a `--host` flag in your build: `cd packages/volley-desk && VITE_VOLLEY_BROKER_URL="ws://$LAN_IP:$WS_PORT" bun x vite --host`.)
- [ ] **Laptop:** open `http://$LAN_IP:<port>/`. The sign-in form appears. A wrong password is
  refused and not remembered; `desk` + its password connects, and a reload stays signed in.
- [ ] **Phone:** open the same URL. Sign in as `desk`. The layout fits the phone width; panning,
  window focus and the coordinators window work by touch.
- [ ] Both show the coordinator, and `volleyd` with its retained config.

---

## 5. A wave across two machines

- [ ] Describe the box in volleyd's config (paths are on the box and must be absolute):
  ```sh
  volleyd config set hosts '{ box: { target: "<user>@<box>", repo: "/abs/path/test-repo",
    volley_dir: "/abs/path/volley" } }'
  ```
- [ ] In the coordinator session, run `/volley-issues` for the 3–4 issues. It takes the volleyd
  path (`volleyd status` exits 0), writes `.volley/waves/<wave>.yaml`, and submits it with
  `--owner <coordinator id>`. Before it submits, add `host: box` to half the tasks in the wave
  file (at least one independent task and the dependent one), then `volleyd validate` it.
- [ ] Spawns: local tasks get a cmux workspace each; box tasks get a tmux session
  (`ssh <box> tmux ls` shows `<wave>-<task>-implementer`). Each agent's worktree has
  `.volley/agent.json` (mode 0600; on the box with `broker_url mqtt://127.0.0.1:21883`, the
  reverse tunnel). `volley list` shows each agent under its assigned id with the real model;
  heartbeats flow (`volley sub --pattern 'volley/+/+/progress'`).
- [ ] The Desk shows the wave window (dependency graph, owner chip = the coordinator), an agent
  window per agent with live narration and a Terminal tab (box agents: `source: tmux`).
- [ ] The dependent task stays `queued` with a reason until its dependency is done.

---

## 6. Injected scenarios

Run them while agents are working. After each, note in Results what you saw.

### Kill an agent

- [ ] Kill one local agent's `claude` process (close its cmux workspace) and one box agent's
  (`ssh <box> tmux kill-session -t =<wave>-<task>-<role>`).
- [ ] Within the keepalive window its status goes `reaped` (LWT). volleyd holds the reap for its
  grace, then retires the agent and opens an `agent_blocked` decision ("… failed. Respawn …, or
  cancel the task?"). The Desk raises it under **Needs you**; the coordinator loop sees
  `decision_opened`.
- [ ] Resolve it with `respawn` (`volleyd resolve <id> respawn --wave <wave>` from the coordinator,
  or from the Desk). A fresh agent spawns with the next attempt number and carries on.

### Orphan + claim

- [ ] Make claims quick for the smoke: `volleyd config set claim_after_s 120`.
- [ ] Exit the coordinator session (its status goes `done`/`reaped`, or it falls silent). Within
  `claim_after_s` the Desk shows **Needs you: no coordinator** for the wave.
- [ ] Claim it from the Desk. The owner chip becomes `desk`, the **no coordinator** warning
  clears, and `volleyd status <wave>` shows the new owner. `volleyd events` shows
  `owner_claimed`. Agents still ack the new owner's steering ("Delivered by hook").
- [ ] Restore: `volleyd config set claim_after_s 1800`.

### Config change mid-wave

- [ ] In the Desk settings modal, change a global tunable (e.g. `heartbeat_alarm_s` to 900) and a
  wave-scoped one. Both apply without a restart: `volleyd config get heartbeat_alarm_s` and
  `volleyd config get --wave <wave>` show them, the `_system` journal has `config_changed`, and
  the Desk shows the new values. The reply came from `volleyd` (the modal reports it applied).
- [ ] An invalid value (e.g. `-1`) is rejected with the field named; nothing changes.

### Urgent steer

- [ ] On a wave the Desk owns (after the claim above), open a working agent's steering panel and
  send an **urgent** steer. The agent is interrupted (Escape) and the message arrives. Delivery
  states go Sent → Delivered by hook → Agent acknowledged, and the steer reached the agent you
  picked (check its role in the result), not another stage's agent.
- [ ] An urgent `/stop` from the Desk on a coordinator-owned wave is refused (only the owner may
  interrupt); it names the owner.

### Pause / resume

- [ ] `volleyd pause <wave> --by <owner>`: no new tasks are admitted (queued tasks say why);
  running agents carry on.
- [ ] `volleyd resume <wave> --by <owner>`: admission resumes.
- [ ] Optional kill switch: `volleyd stop --all`, then `volleyd run` is refused until
  `volleyd resume --all`.

---

## 7. Gates, merges, completion

- [ ] A task reaches `merge_ready`: its evidence package (`volleyd status <wave> --json` →
  `tasks[].evidence_path`) has the PR, the head sha, CI on that exact head, both reviews and how
  each P1 was resolved.
- [ ] Merge that PR into the release branch by hand. Within about a minute the task is `done`
  (`stage_entered {stage: "done", merged: true}`) and its dependent is admitted and spawned **by
  volleyd** (do not `volleyd spawn` it).
- [ ] After the last merge the wave completes (`wave_complete`); the Desk shows it finished, and
  admission stops sampling CI for its repo.
- [ ] `volleyd cleanup <wave>` lists what it would remove; `volleyd cleanup <wave> --yes` removes
  the retired worktrees and workspaces on both machines, keeps the branches, and every minted
  agent identity is revoked:
  ```sh
  grep -c -- "-implementer-" "$VOLLEY_AUTH_DIR/passwd"    # 0
  ```

---

## 8. Teardown

```sh
volleyd stop <wave> --by <owner> 2>/dev/null   # if anything is still running
# stop the foreground daemon (Ctrl-C) and the Desk (Ctrl-C)
kill "$(pgrep -f "mosquitto -c $SMOKE/mosquitto.conf")"
packages/volley-hooks/scripts/install.sh --uninstall   # if you do not want the hooks installed
rm -rf "$SMOKE"
```

---

## Results

Record what you saw, step by step, with timings where a step has one, before tagging `v0.2.0`.

```
RESULTS (<date>, release head <sha>):
  1. broker:
  2. service:
  3. hooks + lease:
  4. Desk laptop / phone:
  5. wave spawn (local / box):
  6. kill / claim / config / urgent / pause:
  7. gates, merges, completion, cleanup:
  Issues found:
```
