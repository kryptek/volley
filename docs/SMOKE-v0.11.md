# v0.11.0 owner smoke: install and machine roles

The release-level smoke for v0.11.0, on real machines. Run it on the release head before tagging,
top to bottom, and record the results at the end of each part.

- **Part A — Install**: blank machine to first wave with real Claude and GitHub, on a fresh macOS
  VM and a fresh Ubuntu VM: the one command, timed from Enter to the merged PR, with the counts
  the install's targets set. Part B does not depend on it.
- **Part B — Machine roles** (SPEC §4.6.24): the Desk, the supervisor and the broker each moved
  to a paired machine from the Desk, used there, then rolled back. The automated twin is
  `packages/volleyd/test/roles-e2e.test.ts` (the same three moves and rollbacks on fake machines,
  through real daemons and two brokers); this part is what fakes cannot show: launchd and
  systemd, real ssh tunnels, a phone on the LAN, Claude Code sessions, agents in tmux over ssh.

Each step says what to do and what you should see. Tick the box only when you saw it; a step's
**Pass** line is what must hold for the step to pass.

---

## Part A — Install

**Blank machine to first wave**, with real Claude and real GitHub: the install's manual canary
(the epic's Layer 5). About 90 minutes for both platforms. Each platform starts from a fresh VM,
gets the one command, and runs until the test wave's PR is merged, with a timer running from
Enter to the merged PR; then a reboot and a bare machine added. The automated twin is
`.github/workflows/install.yml` (Layer 1: fresh containers and a hosted Mac on every PR, with
volley-sim's fake `claude` and `gh`); this part is what fakes cannot show: the real sign-ins,
Claude Code's first-run screens, launchd and systemd across a reboot, a real merge.

The results go in the table at the end of this part, beside the targets, and the table goes in the
v0.11.0 tag annotation (#474).

### A0. What you need

- [ ] **A macOS VM from a clean image** with [Tart](https://tart.run) on the Mac, no Homebrew in it:
  `tart clone ghcr.io/cirruslabs/macos-sequoia-vanilla:latest volley-a && tart run volley-a`
  (user `admin`, password `admin`). A second clone, `volley-b`, for A5.
- [ ] **An Ubuntu 24.04 VM** with [multipass](https://multipass.run) on the Linux box:
  `multipass launch 24.04 --name volley-a --cpus 4 --memory 8G --disk 30G`, then
  `multipass shell volley-a`. A second, `volley-b`, for A5. (Debian 13 is covered by Layer 1; a
  Debian run here is a run-history entry, not a gate.)
- [ ] **The release candidate.** The release head is not on `main` yet, so the line you type
  differs from the README's in two places only: the release branch in the URL instead of `main`,
  and a candidate tag. On the Mac: `git tag v0.11.0-rc.1 <release head sha> && git push origin
  v0.11.0-rc.1` (delete it after the tag: `git push origin :v0.11.0-rc.1`). In each VM the line is

  ```sh
  curl -fsSL https://raw.githubusercontent.com/kryptek/volley/<release branch>/install.sh | VOLLEY_VERSION=v0.11.0-rc.1 sh
  ```

  Once the release is on `main`, the README's line is exactly
  `curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh` (A6 checks it).
- [ ] **Accounts:** a GitHub account and a Claude account you can sign in to from a browser on the
  VM (or on another device for a code).
- [ ] **A phone** on the same network as the Mac (the macOS VM's Desk; Tart's default network is
  NAT, so use `tart run --net-bridged=en0 volley-a` for the phone step, or skip the phone and
  note it).
- [ ] **A stopwatch**, and a notepad for the counts: every command you type, every question, every
  password prompt, every secret you copy.

### A1. The one command (macOS VM)

- [ ] In the VM's Terminal, start the stopwatch and press Enter on the line from A0. Type nothing
  else until the end of A2 unless the installer or setup asks; count each command you do type.
- [ ] The installer says `Installing Volley on macOS (arm64)` (or x86_64), says it installs
  Homebrew and that its installer asks for your password (the only sudo), then
  `brew install …` for bun, mosquitto, gh, git and tmux, then Claude Code's installer, the clone
  of `v0.11.0-rc.1` into `~/.volley/src`, `Wrote ~/.volley/bin/volley`, `Added ~/.volley/bin to
  PATH in ~/.zshrc`, and `Running ~/.volley/bin/volley setup`.
- [ ] Count Homebrew's own prompts (its password, its "Press RETURN") as one sudo prompt and the
  questions they are.

**Pass:** one command typed, one sudo prompt (Homebrew's), and setup started on its own.

### A2. What setup asks, to the merged PR (macOS VM)

- [ ] **Security**: `Let devices on your network reach …? [Y/n]`: Enter.
- [ ] **Sign-ins**: Claude Code's sign-in opens the VM's browser: sign in. GitHub's
  (`gh auth login --web`) shows a one-time code and opens the browser: enter it, authorize.
  Nothing else asks for a password or a token; no secret is shown for you to copy.
- [ ] **Claude Code**: `Coordinator name [coord-volley-a]:`: Enter.
- [ ] **Test wave**: `Run a 1-issue test wave now? [Y/n]`: Enter. It creates
  `<you>/volley-hello-<4>` (private), files `Add HELLO.md`, submits the wave and follows it.
- [ ] Each step's `Apply these <n> changes (<step>)? [y/N]` (`Apply this change (<step>)?` for
  one): answer `y` and count each as a question (the metric counts them). **Known miss:** on a
  blank machine six or more steps have changes, so `questions` reads about 9 until the follow-up
  folds the per-step confirms into one; record the number, and read a count over three as that
  gap, not a regression.
- [ ] It ends `Setup complete in <m> m <s> s (<n> questions, <n> sign-ins, <n> sudo); test wave
  merged in <m> m <s> s: https://github.com/<you>/volley-hello-…/pull/…`. Stop the stopwatch
  when the line appears. The PR on GitHub is merged into `release/<date>-hello-<4>` and adds
  `HELLO.md`.
- [ ] `cat ~/.volley/volleyd/setup-metrics.json`: `questions`, `sign_ins` and `sudo_prompts`
  match your notepad (the installer's sudo is not in it: add it), and `first_wave.merged` is
  `true`.
- [ ] **The Desk.** Open the `http://localhost:5199/#signin=…` link setup printed under *One-time
  admin token*: the Desk opens signed in as admin, the hello wave's window shows it merged.
  Scan the phone QR (with a bridged network): the phone opens the Desk signed in as steer.
- [ ] **Claude Code's first-run screens.** While the test wave runs, attach to its agent
  (`tmux ls`, then `tmux attach -t volley-hello-…`; detach with Ctrl-b d): it never sits at a
  first-run screen, **the browser-extension prompt included** (volleyd seeds them). Then open a
  new terminal and start `claude`: no first-run screen stops you there either, beyond the ones
  Claude Code shows any new user, and `/volley list` lists your session as `coordinator-…`.
  Write down any screen that did appear, and where: one stalls every unattended start.
- [ ] `volley setup --check`: every row `done`. A second `volley setup` and a second run of the
  line from A0 change nothing and say so.

**Pass:** the PR merged within 25 minutes of Enter; no more than three questions (beyond the
per-step `Apply` confirms, the known miss above) and two sign-ins in setup-metrics.json; at most one sudo prompt; no secret copied; `--check` all `done`.

### A3. The same on Linux (multipass VM)

- [ ] In `multipass shell volley-a`, start the stopwatch, press Enter on the line from A0.
- [ ] The installer prints `sudo is needed to:` and the list (the apt packages, GitHub's apt
  repository for gh, `snap install mosquitto`), asks for sudo once (the multipass user has
  password-less sudo: note `0`, and that a real machine asks once), installs, clones,
  adds the `PATH` line to `~/.bashrc` and starts setup.
- [ ] **The snap broker's config is root's.** If setup's Security step cannot write
  `/var/snap/mosquitto/common/mosquitto.conf`, run what docs/INSTALL.md's Linux notes say
  (`sudo ~/.volley/bin/volley setup --step detect --step security --step accounts`, then
  `volley setup`) and count both as commands typed and as sudo prompts.
- [ ] The sign-ins: the VM has no browser, so each prints a URL or code to open on another
  device: open them on the Mac. The rest as A2: three questions by Enter, each step's `y`.
- [ ] It ends with `Setup complete … test wave merged …`; stop the stopwatch. On Linux setup
  chooses tmux (the Terminal step never mentions cmux), and the services are `systemd --user`
  units: `systemctl --user is-active volleyd.service volley-desk.service` prints `active` twice.
- [ ] The Desk from the Mac's browser at `http://<VM address>:5199` with a link from
  `volley auth signin-link` (LAN access on): signed in, the hello wave merged.
- [ ] First-run screens as in A2 (`tmux attach -t volley-hello-…`), and `volley setup --check`
  all `done`.

**Pass:** the same targets as A2 on Linux.

### A4. Reboot survival (both VMs)

- [ ] macOS: `tart stop volley-a`, then `tart run volley-a`; Linux: `multipass restart volley-a`.
  Start the stopwatch when the VM is up (the login window, or `multipass shell` answering).
- [ ] Without starting anything: `volley setup --check` all `done` and the Desk answers
  (`curl -fsS http://localhost:5199/version.json`). Stop the stopwatch at the first all-`done`
  check. On Linux note whether lingering is on (`loginctl show-user $USER -p Linger`): without
  it the user services start at your first login, not at boot.

**Pass:** every service back and `--check` all `done` within 2 minutes of the VM being up.

### A5. Add a bare machine (both platforms)

- [ ] Boot `volley-b` (no Volley, nothing installed). VM plumbing, not counted: on Tart turn on
  Remote Login in `volley-b` (System Settings › General › Sharing); on multipass, put
  `volley-a`'s public key in `volley-b`'s `~/.ssh/authorized_keys` (multipass VMs take keys
  only).
- [ ] On `volley-a`, start the stopwatch: `volley machine add <user>@<volley-b address>` (or the
  Desk: Settings › Machines › **Add a bare machine…**). Answer only what ssh or sudo ask on the
  box, and the box's GitHub and Claude sign-ins.
- [ ] It ends with one row `volley-b (<user>@…): ready ✓`; stop the stopwatch. The Desk shows
  `volley-b`'s card `ready for agents`.

**Pass:** one command (or the form), at most two sign-ins on the box, `ready` within 10 minutes.

### A6. The printed command

- [ ] The README's Quickstart and `docs/INSTALL.md` print exactly
  `curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh`, and
  `install.sh --help` (`… | sh -s -- --help`) lists the flags `docs/INSTALL.md` documents.

**Pass:** the command is the same everywhere, and nothing in it names a version.

### A. Teardown

`gh repo delete <you>/volley-hello-… --yes` for each scratch repository the run made (setup's last
lines print them), `tart delete volley-a volley-b`, `multipass delete --purge volley-a volley-b`,
and the candidate tag: `git push origin :v0.11.0-rc.1`.

### A. Results

Fill in a column per platform. The targets are the install epic's.

| Metric | Target | macOS (Tart) | Ubuntu 24.04 (multipass) |
| --- | --- | --- | --- |
| Commands typed, blank machine → first wave | 1 (2 on the Homebrew path) | | |
| Questions asked, beyond the two sign-ins (setup-metrics `questions`) | ≤ 3, Enter answers each (known miss: the per-step `Apply` confirms count too) | | |
| Sign-ins (`sign_ins`) | 2: Claude Code, GitHub | | |
| sudo prompts (installer + `sudo_prompts`) | ≤ 1 | | |
| Secrets copied by hand | 0 | | |
| Wall time, Enter → first wave merged | ≤ 25 min | | |
| Reboot survival: services back, `--check` all `done` | ≤ 2 min after the VM is up | | |
| Add a bare machine: commands, sign-ins on the box, time to `ready` | 1, ≤ 2, ≤ 10 min | | |
| Browser-extension first-run prompt seen | no | | |

```
RESULTS (<date>, release head <sha>, v0.11.0-rc.1):
  A1. one command, setup started (macOS):
  A2. setup to merged PR (macOS), first-run screens:
  A3. the same on Ubuntu 24.04:
  A4. reboot survival (macOS / Linux):
  A5. bare machine added (macOS / Linux):
  A6. printed command:
  Issues found:
```

### A. Run history

Each run is one entry, newest last; a run on other hardware is an entry, not a new gate.

- *(the first run: both VMs, on the release head before the tag)*
- *(the owner's new workstation, when it arrives: the first real-hardware install, the line from
  A0 or the README's once released, timed and counted as above. An entry here, not a gate for
  this release)*

---

## Part B — Machine roles

About 45 minutes. Each move is rolled back before the next starts, so each starts from the
same place: everything on the Mac. A broker move goes from the supervisor's machine only, which is
why the supervisor comes back before the broker leaves.

### B0. What you need

- [ ] **The Mac** ("the Mac", `mac` below): volleyd and the Desk running this release head as
  services, the broker installed by `volley setup` with LAN access on (`volley setup --lan`, or
  yes to its LAN question: the phone needs it), Homebrew, port 1883, an admin Desk session
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
broker is left running until you stop it there.

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
