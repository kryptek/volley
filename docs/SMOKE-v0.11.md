# v0.11.0 owner smoke: install and machine roles

The release-level smoke for v0.11.0, on real machines. Run it on the release head before tagging,
top to bottom, and record the results at the end of each part.

- **Part A — Install** (#468): the install canary. Written by that issue; part B does not depend
  on it.
- **Part B — Machine roles** (SPEC §4.6.24): the Desk, the supervisor and the broker each moved
  to a paired machine from the Desk, used there, then rolled back. The automated twin is
  `packages/volleyd/test/roles-e2e.test.ts` (the same three moves and rollbacks on fake machines,
  through real daemons and two brokers); this part is what fakes cannot show: launchd and
  systemd, real ssh tunnels, a phone on the LAN, Claude Code sessions, agents in tmux over ssh.

Each step says what to do and what you should see. Tick the box only when you saw it; a step's
**Pass** line is what must hold for the step to pass.

---

## Part A — Install

Written by #468.

---

## Part B — Machine roles

About 45 minutes. Each move is rolled back before the next starts, so each starts from the
same place: everything on the Mac. A broker move goes from the supervisor's machine only, which is
why the supervisor comes back before the broker leaves.

### B0. What you need

- [ ] **The Mac** ("the Mac", `mac` below): volleyd and the Desk running this release head as
  services, the broker installed by `volley setup` (Homebrew, port 1883), an admin Desk session
  in a desktop browser. `volley role status` prints all three roles `on mac`.
- [ ] **A paired Linux box** (`box-a` below), paired with `volley peer join`, its card green
  (`ready for agents`): bun, git, tmux, gh (authenticated, write access to the smoke repository),
  claude (default profile signed in), mosquitto 2.1 or newer installed (`volley broker probe` on
  it prints `"mosquitto":"2.1.…"`), and a volley checkout of this release head. Key-based ssh
  both ways: `ssh -o BatchMode=yes <you>@box-a true` on the Mac, and the same to the Mac's
  address on box-a.
- [ ] **tmux on the Mac** (`brew install tmux`): after the supervisor's move the Mac is one of
  box-a's paired machines, and its agents run in tmux over ssh.
- [ ] **A phone** on the same Wi-Fi, signed in to the Desk on the Mac (Settings › Phone & sign-in
  links › the QR).
- [ ] **A throwaway GitHub repository** with two small open issues and a pushed release branch
  (`release/<yyyy-mm-dd>-smoke`), cloned on both machines (or named by `owner/name` with a
  repository added in Settings › Repositories).
- [ ] **A Claude Code session on the Mac** registered with Volley (`volley setup` done, `/volley
  list` answers).
- [ ] No wave running and no agent live (`volleyd status` lists none running). Shell variables
  in each terminal: `BOX=box-a`, `MAC=mac` (your `fleet.local_name`s).

### B1. The record

- [ ] Settings › Machines: the summary line reads `broker · mac — supervisor · mac — desk · mac`;
  the Mac's card has the three role chips, box-a's `no roles`. `volley role status --json` prints
  the record with `"version"` and `"updated_by"`.

**Pass:** the Desk and `volley role status` agree on all three roles.

### B2. Move the Desk to box-a, and sign the phone in

- [ ] box-a's card › **Move a role here…** › **Desk**. The sheet *Move the desk to box-a* lists
  the five steps, each with its machine (`install` and `check` on box-a; `record`, `signin` on the
  Mac; `unload` on the Mac last) and nothing under **Blocked**. **Move now**.
- [ ] The steps tick one by one; done shows the sign-in link for `http://box-a:5199` and its QR,
  and `volley role rollback desk-…` as the undo. Note the move id: `DESK_MOVE=desk-…`.
- [ ] The tab still on the Mac's address shows *The Desk now lives at http://box-a:5199 — open
  it there*. Open the link from the sheet: signed in as admin at the new address.
- [ ] Scan the QR with the phone: the Desk opens at box-a's address, signed in (steer), and the
  agents window lists the Claude Code session on the Mac.
- [ ] On the Mac, `volley role status` prints `desk on box-a (http://box-a:5199)`; on box-a,
  `systemctl --user is-active volley-desk.service` prints `active`; on the Mac the old Desk's
  service is stopped (`launchctl print gui/$(id -u)/systems.volley.desk` fails), not removed.

**Pass:** the Desk answers at box-a, the desktop and the phone are signed in there, and the role
chip moved to box-a's card.

### B3. Roll the Desk back

- [ ] In the sheet's done view (or from a terminal: `volley role rollback $DESK_MOVE`) **Undo
  this move**. It ends done; the old Desk answers at the Mac's address again and its tab works;
  box-a's Desk is uninstalled (`systemctl --user status volley-desk.service` on box-a: not
  found).
- [ ] `volley role status`: `desk on mac`. The original move's topic reads `rolled_back`
  (`volley sub "volley/_system/roles/moves/$DESK_MOVE" --max-messages 1 --timeout 5`).

**Pass:** the Desk is back on the Mac at its old address, and the phone signs in there again with
a fresh QR.

### B4. Move the supervisor to box-a; the Mac becomes its paired machine

- [ ] box-a's card › **Move a role here…** › **Supervisor**. The sheet lists the old supervisor's
  steps on the Mac (`bundle`, `handover`), box-a's (`copy`, `receive`, `working`, `record`) and
  `repair` on the Mac, nothing blocked, and **After the move** says the Mac becomes a paired
  machine and stopped waves resume with `volleyd resume`. **Move now**.
- [ ] The sheet reads *handing over to box-a…*, then the steps go on ticking (box-a's supervisor
  continues the same move) and end done. Note `SUP_MOVE=supervisor-…`.
- [ ] On the Mac, `launchctl print gui/$(id -u)/systems.volley.volleyd` fails (unloaded); on
  box-a `systemctl --user is-active volleyd.service` prints `active`. `volley role status` (either
  machine) prints `supervisor on box-a`.
- [ ] Settings › Machines: box-a's card has the supervisor chip, and a card for the Mac is there,
  `ready for agents` once its first doctor run is in (re-paired as an ssh + tmux machine, tunnel
  none: the broker is still on the Mac).
- [ ] **A wave of two tasks on the Mac.** On box-a (the supervisor's machine), a wave file
  naming the smoke repository with both issues and `host: mac` on each task (or `placement: auto`
  with `placement_prefer: [mac]`); `volleyd run smoke-roles.yaml`. Both agents launch on the Mac
  in tmux sessions (`tmux ls` on the Mac), register, and their task rows' host chips read `mac`.
  Let them finish (or stop the wave: `volleyd stop smoke-roles`, and wait for both agents to end).

**Pass:** box-a supervises, the Mac is its paired machine, and a wave's two tasks ran on the Mac in
tmux over ssh.

### B5. Roll the supervisor back

- [ ] With no wave running and no agent live: the move's **Undo this move** (or `volley role
  rollback $SUP_MOVE`). The sheet reads *handing over to mac…*; the supervisor on the Mac starts
  again (its launchd service loaded), re-pairs box-a, and the rollback ends done. The original
  move reads `rolled_back`.
- [ ] `volley role status`: `supervisor on mac`; box-a's card is back as a paired machine,
  `ready for agents`. A stopped `smoke-roles` wave replays as stopped on the Mac (`volleyd status
  smoke-roles`).

**Pass:** the supervisor runs on the Mac again with box-a paired, and the journal has
`role_rolled_back` for `$SUP_MOVE` (`grep role_rolled_back "${VOLLEYD_HOME:-$HOME/.volley/volleyd}/waves/_system/journal.jsonl"`).

### B6. Move the broker to box-a; the Desk stays

- [ ] box-a's card › **Move a role here…** › **Broker**, **Also move the supervisor** unchecked.
  The move keeps the broker's LAN setting (on since `volley setup`, B0's phone needs it), so the
  phone reaches the WebSocket listener on box-a; from a terminal the same move is `volley role
  move broker --to box-a --lan`. The sheet lists `stop`,
  `bundle`, `tunnel`, `health`, `desk`, `record` on the Mac, `copy` and `receive` on box-a, a
  `retarget-N` per paired machine; the warning that the broker leaves the supervisor's machine;
  and under **After the move** the one line for your sessions on the Mac. On a snap or distribution
  mosquitto on box-a, **You run on box-a** shows the `sudo volley broker receive …` line: run it
  there when the move waits for it. **Move now**. Note `BROKER_MOVE=broker-…`.
- [ ] The page loses the broker for a minute (every connection ends with the old broker), then the
  Desk, still on the Mac, reconnects through box-a's listener and the move reads done.
  `volley role status`: `broker on box-a` with its address, `desk on mac`, `supervisor on mac`.
- [ ] On the Mac, `brew services list` shows mosquitto stopped, and volleyd reaches the broker
  through its tunnel (`volley broker tunnel --show` prints `{"host":"<you>@box-a",…}`).
- [ ] **The phone**: reload the Desk; it connects and lists the agents and machines.
- [ ] **The Mac's own sessions after the one-line fix.** The Claude Code session on the Mac lost
  its broker. Run the line from the sheet's **After the move**:
  ```sh
  volley setup --step claude-code --broker-url mqtt://127.0.0.1:1883
  ```
  quit Claude Code and reopen it: `/volley list` answers, and the session shows on the Desk.

**Pass:** the broker runs on box-a, every machine and volleyd reach it, the Desk stayed on the Mac,
the phone works, and the Mac's sessions work again after that one line.

### B7. Roll the broker back

- [ ] **Undo this move** (or `volley role rollback $BROKER_MOVE`). The page loses the broker
  again for a minute, then the rollback reads done: the Mac's tunnel down, its mosquitto started
  (`brew services list`: started), every machine back on the tunnel it had, the Desk told the
  Mac's host.
- [ ] `volley role status`: all three `on mac`; the original move reads `rolled_back`. The phone
  reconnects after a reload. Re-register the Mac's sessions as before the move (`volley setup
  --step claude-code`) and `/volley list` answers. Stop the broker left on box-a there.

**Pass:** everything is on the Mac again, the phone and the Mac's sessions work, and box-a's
broker is only stopped by hand.

### B. Teardown

Delete the smoke wave's branches and PRs if you no longer want them; `volley peer remove mac` is
not needed (the rollbacks re-paired box-a as before). A move's kept copy goes after 7 days on its
own.

### B. Results

```
RESULTS (<date>, release head <sha>, machines <mac> + <box-a>):
  B1. record (Desk == volley role status):
  B2. Desk → box-a, desktop + phone signed in there:
  B3. Desk rolled back, old address works:
  B4. supervisor → box-a, mac re-paired (tmux), two-task wave on mac:
  B5. supervisor rolled back, box-a re-paired:
  B6. broker → box-a (lan), Desk stayed, phone ok, mac sessions after the one line:
  B7. broker rolled back:
  Issues found:
```

### B. Run history

Each run is one entry, newest last; a run on other hardware is an entry, not a new gate.

- *(the first run, on the release head before the tag)*
- *(later: the owner's new workstation, when it arrives, as the target of each move: an entry
  here, not a gate for this release)*
