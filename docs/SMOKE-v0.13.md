# v0.13.0 owner smoke: Getting started, reach from anywhere, the coordinator from a phone

The release-level smoke for v0.13.0, on real machines. Run it on the release head before tagging,
top to bottom, and record the results at the end of each part; the [results table](#results) goes
into the v0.13.0 tag annotation.

- **Part A — Getting started**: a fresh macOS VM and a fresh Ubuntu VM, the one install command,
  then the Desk's first-launch wizard from Welcome to *You're good to go!*, timed and counted.
- **Part B — Reach from anywhere**: Tailscale on the always-on machine and the laptop, the app on
  the phone; the Desk over HTTPS at the machine's name from cellular, with browser notifications
  allowed.
- **Part C — The coordinator** (SPEC §4.6.25): the always-on machine picked in Access, the
  laptop's lid closed, and the phone on cellular opening the coordinator from the Claude app,
  dispatching a one-task wave that merges.
- **Part D — It survives**: the coordinator's server killed, a new link on the phone within two
  minutes, the handoff text naming the previous session, and a volleyd restart that adopts the
  session instead of restarting it.

The automated twins are `.github/workflows/install.yml` (Layer 1: the one command in fresh
containers and on a hosted Mac, with volley-sim's fake `claude`, `gh` and `tailscale`), the Desk's
Getting started tests in `packages/volley-desk/test/` and volleyd's coordinator tests in
`packages/volleyd/test/`. This smoke is what fakes cannot show: real sign-ins, a real tailnet and
its certificates, a phone on a cellular network, a laptop asleep, Claude Code's Remote Control and
the Claude app.

Machines are named by their part, never by a real hostname: **the always-on machine** (a desktop
or a mini that stays on: the supervisor, the broker and the Desk run there), **the laptop** (a
machine with a battery, paired to it) and **the phone**. Examples use `example.ts.net` for the
tailnet and RFC 5737 addresses. Each step says what to do and what you should see. Tick the box
only when you saw it; a step's **Pass** line is what must hold for the step to pass.

---

## Part A — Getting started

**Blank machine to a finished wizard**, with real Claude and real GitHub. About 60 minutes for
both platforms. Each platform starts from a fresh VM, gets the one command, lets `volley setup`
run, then finishes Getting started in the Desk; the stopwatch runs from Enter to *You're good to
go!*'s **Open the Desk**.

### A0. What you need

- [ ] **A macOS VM from a clean image** with [Tart](https://tart.run), no Homebrew in it:
  `tart clone ghcr.io/cirruslabs/macos-sequoia-vanilla:latest volley-a && tart run volley-a`. A
  second clone, `volley-b`, is the machine the wizard's Your machines step adds.
- [ ] **An Ubuntu 24.04 VM** with [multipass](https://multipass.run):
  `multipass launch 24.04 --name volley-a --cpus 4 --memory 8G --disk 30G`, and a second,
  `volley-b`, reachable from `volley-a` over ssh (put `volley-a`'s public key in its
  `~/.ssh/authorized_keys`; VM plumbing, not counted).
- [ ] **The release candidate.** The release head is not on `main` yet, so the line you type
  differs from the README's in two places only: the release branch in the URL and a candidate
  tag (`git tag v0.13.0-rc.1 <release head sha> && git push origin v0.13.0-rc.1`; delete it
  after the tag). In each VM the line is

  ```sh
  curl -fsSL https://raw.githubusercontent.com/kryptek/volley/<release branch>/install.sh | VOLLEY_VERSION=v0.13.0-rc.1 sh
  ```

  Once the release is on `main`, the README's line is exactly
  `curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh`.
- [ ] **Accounts:** a GitHub account and a Claude account you can sign in to from a browser.
- [ ] **A stopwatch**, and a notepad for three counts: every **question** (setup's and the
  wizard's, Enter or a click on a default included), every **command** you type, and every
  **copy of a secret by hand** (a password, a token, a key: a sign-in link opened by a click or
  a scan is not a copy).

### A1. The one command, to the Desk (macOS VM)

- [ ] Start the stopwatch and press Enter on the line from A0. Answer what the installer and
  setup ask (Homebrew's password, setup's questions by Enter, each `Apply these <n> changes (…)?
  [y/N]` with `y`, the Claude Code and GitHub sign-ins in the VM's browser). At the Network
  question, `Reach this machine from outside this network? [Tailscale (recommended) / my own VPN
  / no]`, answer `no`: Part B covers Tailscale on real machines, and the wizard's Access step
  asks again.
- [ ] Setup ends with `Setup complete in <m> m <s> s (…)`, the test wave's merged PR, and under
  *One-time admin token* the line `Open the Desk with it on this machine:
  http://localhost:5199/#signin=…`.
- [ ] Click that link (no copying). The Desk signs in as admin, the token leaves the address bar
  and **Getting started opens on Welcome** with the otter raft tossing its ball, the rail on the
  left listing the seven steps.

**Pass:** one command typed, the Desk opened from the printed link without copying a secret, and
Getting started open on Welcome.

### A2. Every step to finished (macOS VM)

- [ ] **Welcome** › **Let's go**: *Step 1 of 6*, **This computer**.
- [ ] **This computer**: the card is titled with the VM's machine name and lists the message
  broker (`mosquitto 2.1.…`), `bun`, `gh`, `tmux` (or `cmux`) and Claude Code with their
  versions, each ✓, and Volley services `done`. The security, accounts and services plans read
  `already done`. Rename it in **Name this computer** (e.g. `mac-vm`) and press Enter: the card's
  title follows within a heartbeat.
- [ ] **Your machines**: no paired machine yet. Pick **SSH key** (or **Username and password**
  with `volley-b`'s login) and add `volley-b` by its address. The steps tick to `ready`, and
  `volley-b` is listed with its OS, cores and tunnel state. With a password: nothing on screen
  or in `~/.volley/volleyd/` keeps it afterwards.
- [ ] **Repos**: the GitHub card reads *✓ Signed in on mac-vm*. Add the hello wave's repository
  from GitHub (`<you>/volley-hello-…`): *✓ Found on GitHub · private*.
- [ ] **People**: *You* first. **Create invite link** for `Tester`, Standard: a link and a QR,
  the row reads *invite link made*. (Do not open it; it is a count of zero copies.)
- [ ] **Access**: pick **This network only** (Part B does Tailscale): the plan shows, **Apply this
  change**, the report. The coordinator picker lists `mac-vm` and `volley-b`; leave it off.
- [ ] **You're good to go!**: the summary lists Computers (`mac-vm`, `volley-b`), Connected by,
  Repos, People (`Tester (Standard)`), Away from home (`This network only`) and Coordinator
  (`off`). **Make a pairing code** fills the second of the two lines; **Copy both lines** copies
  them. **Open the Desk**: stop the stopwatch.
- [ ] Reload: Getting started does not reopen. Settings › Setup & Security › **Getting started**
  reads *Finished <date>*, and **Open…** reopens it at You're good to go!.

**Pass:** every step reached and finished, nothing asked for a password or token beyond
`volley-b`'s own login, and the wizard stays finished across a reload.

### A3. The same on Linux (multipass VM)

- [ ] In `multipass shell volley-a`, start the stopwatch, press Enter on the line from A0. The
  installer prints `sudo is needed to:` and its list, asks once, installs, starts setup. The VM
  has no browser: the sign-ins print a URL or code to open on another device.
- [ ] The setup's end prints the admin link at `http://localhost:5199/#signin=…`: open the Desk
  from the Mac's browser at `http://<VM address>:5199` with a fresh link from
  `volley auth signin-link` there instead (LAN access on). That copy of a link is VM plumbing,
  not counted.
- [ ] Getting started opens on Welcome; run A2's steps. This computer reads `tmux`, not `cmux`;
  Your machines adds `volley-b` by SSH key.

**Pass:** the same as A1 and A2 on Linux.

### A. Teardown

`gh repo delete <you>/volley-hello-… --yes` for each scratch repository (setup's last lines print
them), `tart delete volley-a volley-b`, `multipass delete --purge volley-a volley-b`.

### A. Results

| Metric | Target | macOS (Tart) | Ubuntu 24.04 (multipass) |
| --- | --- | --- | --- |
| Install to finished: Enter → **Open the Desk** | ≤ 30 min | | |
| Questions (setup's and the wizard's) | record it | | |
| Commands typed | 1 | | |
| Copies of a secret by hand | 0 | | |

```
RESULTS (<date>, release head <sha>, v0.13.0-rc.1):
  A1. one command, Desk from the link, Welcome (macOS):
  A2. every step to finished, stays finished (macOS):
  A3. the same on Ubuntu 24.04:
  Issues found:
```

### A. Run history

Each run is one entry, newest last; a run on other hardware is an entry, not a new gate.

- *(the first run: both VMs, on the release head before the tag)*

---

## Part B — Reach from anywhere

About 30 minutes, on real hardware. The always-on machine and the laptop join one tailnet; the
phone opens the Desk at the always-on machine's name over HTTPS from cellular.

### B0. What you need

- [ ] **The always-on machine**, set up with this release head (`volley setup` done, volleyd and
  the Desk running as services, Getting started finished or skipped), on mains power. It
  supervises: the broker, volleyd and the Desk run here.
- [ ] **The laptop**, paired to it (Getting started › Your machines, or `volley machine add`),
  its card `ready for agents`; it has a battery, so its record says `laptop: true`.
- [ ] **The phone**, with Wi-Fi you can turn off and mobile data on.
- [ ] **A Tailscale account**, with HTTPS certificates turned on once in the admin console
  (DNS › HTTPS Certificates) and MagicDNS on.

### B1. Tailscale on the always-on machine

- [ ] On the always-on machine: `volley setup --network tailscale` (or Getting started › Access ›
  **Tailscale** › **Apply this change**). It installs Tailscale when missing (on Linux it prints
  the `sudo` line to run), prints `Sign in to Tailscale: <url>`: open it, sign in.
- [ ] The Services step plans `Serve the Desk on your private network (https://<name>)`; apply
  it (on Linux it runs `tailscale serve` under `sudo`). The end prints both addresses,
  `Desk: http://<lan>:5199 · https://always-on.example.ts.net` (your machine's name).
- [ ] `tailscale serve status` lists exactly two targets, `https://<name>` → `127.0.0.1:5199`
  and `https://<name>:8443` → `127.0.0.1:9001`; `tailscale funnel status` shows nothing public.

**Pass:** the Desk is served at the machine's tailnet name over HTTPS, through two loopback-only
serves and no funnel.

### B2. Tailscale on the laptop and the phone

- [ ] On the laptop: `volley setup --peer --network tailscale` (or `install.sh --peer --network
  tailscale` on a fresh one); sign in through the printed link, to the same account.
- [ ] `volley peer doctor` on the laptop: the `network.private` row is OK (Tailscale running,
  the laptop's private name recorded).
- [ ] On the phone: install the Tailscale app, sign in to the same account, turn it on. The
  admin console lists three machines.

**Pass:** the always-on machine, the laptop and the phone are on one tailnet.

### B3. The Desk from cellular

- [ ] On the always-on machine, `volley auth signin-link --role steer --label phone`: it prints
  the private link first (`https://always-on.example.ts.net/#signin=…`) and a QR. Scan it with
  the phone while on Wi-Fi (the scan is not a copy).
- [ ] Turn the phone's Wi-Fi off (mobile data only). Start the stopwatch and open
  `https://always-on.example.ts.net`; stop it when the canvas shows live windows (the agents
  window lists the always-on machine's sessions). That is the **cellular Desk load time**.
- [ ] The address bar shows a valid certificate (no warning), Settings › About shows the broker
  URL `wss://always-on.example.ts.net:8443` *(served)*, and the Desk stays connected while you
  pan and open a window for a minute.

**Pass:** the Desk loads and stays live over HTTPS from cellular, signed in, with no certificate
warning.

### B4. Notifications allowed on the phone

- [ ] On the phone's Desk (signed in by B3's link), turn on browser notifications (Settings ›
  General, or the top bar's bell) and allow them when the browser asks. The page is a secure context over HTTPS, so
  the browser offers the permission (over plain `http://` on the LAN it does not).
- [ ] Leave the Desk open in the phone's browser for Part C: the coordinator's first link is an
  owner-only notice, and C2 checks it arrives as a notification.

**Pass:** notifications are granted for the Desk's private address on the phone (the arrival is
checked in C2).

### B. Results

```
RESULTS (<date>, release head <sha>):
  B1. tailscale on the always-on machine, two serves, no funnel:
  B2. laptop + phone on the tailnet:
  B3. Desk over HTTPS from cellular (load time <s> s):
  B4. notifications granted:
  Issues found:
```

### B. Run history

- *(the first run, on the release head before the tag)*

---

## Part C — The coordinator

About 40 minutes. The coordinator role keeps a Claude Code Remote Control server alive on the
always-on machine; the phone opens it from the Claude app while the laptop sleeps.

### C0. What you need

- [ ] Part B done: the phone on the tailnet with the Desk signed in, notifications allowed.
- [ ] **The Claude app** on the phone, signed in to the Claude account the always-on machine's
  Claude Code uses.
- [ ] **A scratch repository** with one small open issue (`Add SMOKE.md`) and a pushed release
  branch, cloned on the always-on machine and added in Settings › Repositories (or Getting
  started › Repos), so the coordinator's directory links it under `repos/<owner>/<name>`.
- [ ] No wave running (`volleyd status`).

### C1. Pick the always-on machine in Access

- [ ] In the Desk on the laptop: Settings › Setup & Security › Getting started › **Open…**, then
  **Access** (or `#getting-started` in the address bar). Under *Keep a Claude coordinator session
  running on…*: the laptop is greyed (*a laptop: sleeps and travels*); pick the always-on
  machine. Then **You're good to go!**: Coordinator names it.
- [ ] Within a minute, `volley coordinator status` prints `coord-<name> on <machine>: running
  since … · https://claude.ai/code/…`, and Settings › Machines' Coordinator card reads `running
  on <machine> since …`.
- [ ] If the state reads `needs_terminal` (`trust` or `consent`), the first Remote Control run
  on that Claude profile asks once: `tmux attach -t volley-coordinator-<name>` on the always-on
  machine, answer it, detach (Ctrl-b d). Count it.

**Pass:** the role runs on the always-on machine with a link, and the laptop was refused in the
picker.

### C2. The link reaches the phone

- [ ] The phone shows the notification `Needs you · Coordinator on <machine>: open it` (B4's
  check). A tap opens the coordinator's link. The Desk's Needs you window has the notice with
  **Open** and **Dismiss**; dismiss it.

**Pass:** the coordinator's link arrived on the phone as a notification and opened.

### C3. The lid closes; the phone opens the coordinator from cellular

- [ ] Close the laptop's lid. Wait two minutes: the Desk on the phone shows the laptop's machine
  as down (Settings › Machines), and nothing else changes.
- [ ] Phone on cellular (Wi-Fi off). In the Claude app's Code sessions, the coordinator is listed
  by its name (`coord-<name>`). Open it.
- [ ] Its first turn holds the handoff text: `You are the coordinator coord-<name> of this
  Volley fleet, running on <machine> in <dir> (repos under repos/)`, the running waves (none),
  the open Needs-you items, and `Use /volley and /volley-issues as usual.`
- [ ] Ask it `/volley list`: it answers with the fleet's agents.

**Pass:** with the laptop asleep, the phone on cellular opens the coordinator by name and it
knows the fleet.

### C4. A one-task wave from the phone

- [ ] In the coordinator session on the phone: `cd repos/<owner>/<name>` (ask it to), then
  `/volley-issues #<n>` for the scratch issue. It plans, submits the wave and follows it.
- [ ] The Desk on the phone shows the wave's window and its agent working on the always-on
  machine (the machine chip names it). The wave ends with its PR merged into the release branch.
- [ ] The next morning (or `volleyd digest <wave>` once it ends), read the wave's morning digest
  in the Desk on the phone.
- [ ] Back on the laptop (lid open), the Desk's top bar **Open coordinator** opens the same
  session the phone used (the same `https://claude.ai/code/…` link as `volley coordinator open`).

**Pass:** a wave dispatched from the phone merged with no terminal involved, and Open coordinator
reaches the same session.

### C. Results

```
RESULTS (<date>, release head <sha>):
  C1. coordinator on the always-on machine, laptop refused:
  C2. link notification on the phone:
  C3. lid closed, coordinator opened from cellular, handoff text:
  C4. one-task wave from the phone merged, digest read, Open coordinator = same session:
  Issues found:
```

### C. Run history

- *(the first run, on the release head before the tag)*

---

## Part D — It survives

About 20 minutes. The phone stays on cellular with the Desk open; the laptop's lid may stay
closed.

### D1. Kill the server

- [ ] Note the current link: `volley coordinator status --json` on the always-on machine
  (`session_url`, `restarts`) and the coordinator session's agent id (`/volley list` from the
  phone, the `coordinator-…` entry).
- [ ] Start the stopwatch and kill the server's session on the always-on machine:
  `tmux kill-session -t volley-coordinator-<name>`.
- [ ] Within two minutes the Desk's Needs you window has the notice `Coordinator on <machine>:
  open it` with a **new** link, and the phone shows its notification. Stop the stopwatch at the
  notification: that is **kill to new link**. `volley coordinator status` reads `running` with
  `restarts` one higher.
- [ ] Tap the notification: the Claude app opens the new session. Its first turn's handoff text
  names the previous session's agent id (the one you noted).

**Pass:** a new link on the phone within two minutes of the kill, and the handoff names the
previous session.

### D2. Restart volleyd; the session is adopted

- [ ] Note the session's start: `tmux display -p -t volley-coordinator-<name> '#{session_created}'`.
- [ ] Restart volleyd on the always-on machine: `launchctl kickstart -k
  gui/$(id -u)/systems.volley.volleyd` (macOS) or `systemctl --user restart volleyd` (Linux).
- [ ] Within a minute `volley coordinator status` reads `running` with the same `session_url`,
  the same `since` and the same `restarts`; the tmux session's `session_created` is unchanged;
  no new notice opened on the phone; the session on the phone still answers.

**Pass:** volleyd's restart adopted the running session: no restart, no new link.

### D. Teardown

`volleyd config set coordinator.machine null` if you want the role off (the session ends, the
topic clears), delete the scratch repository's branches or the repository, and turn the phone's
Wi-Fi back on.

### D. Results

```
RESULTS (<date>, release head <sha>):
  D1. kill → new link on the phone (<s> s), handoff names the previous session:
  D2. volleyd restart adopted the session:
  Issues found:
```

### D. Run history

- *(the first run, on the release head before the tag)*

---

## Results

The rows that go into the v0.13.0 tag annotation, beside their targets:

| Metric | Target | Result |
| --- | --- | --- |
| Install to finished (A, Enter → Getting started finished), macOS / Ubuntu | ≤ 30 min | |
| Copies of a secret by hand (A) | 0 | |
| Cellular Desk load (B3, address opened → live canvas) | ≤ 10 s | |
| Kill to new link (D1, kill → notification on the phone) | ≤ 2 min | |
| Coordinator adopted across a volleyd restart (D2) | yes | |
