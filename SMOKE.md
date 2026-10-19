# Manual smoke checklist (release-level)

This file collects feature-level smoke recipes that span multiple packages — the per-package SMOKE.md files under `packages/*/SMOKE.md` cover narrower scopes (volley-issues dispatch, volley-skill / volley-wait skill installation, etc.). Add a new section per plan that ships a release tag.

**v0.3.0** (onboarding: `volley setup`, the Desk's setup wizard and sign-in links, pairing, Claude accounts) is [Plan 11](#plan-11--onboarding-v030) below. **v0.2.0** (volleyd, volley-hooks, broker auth, the Desk) has its own owner smoke path: [`docs/SMOKE-v0.2.md`](docs/SMOKE-v0.2.md).

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
   checkout with <your bun>)` and loads volleyd and the Desk. Phone prints a QR code. Last line: `Setup complete.` Anything that asks you to read
   source or guess is a fail: note the step.
2. **Phone sign-in, then stop the stopwatch.** Right away (the QR lasts 10 minutes), scan the QR
   with the phone camera and open the link.
   **Pass:** within about 10 s the Desk loads signed in (Settings › account row: a `steer`
   account, *Desk on iPhone* or similar). **Stop the stopwatch and write the time down
   (target ≤ 10 min).** Scan the same QR again: the card says the link was already used and
   what to do next. (If the QR expired before you scanned it, that is a fail of the 10-minute
   target; `volley setup` again issues a new one.)
3. **Rerun and PATH.**
   `echo 'export PATH="$HOME/.volley/bin:$PATH"' >> ~/.zshrc && exec zsh`, then
   `volley --version` → `0.3.0`, and `volley setup --repair` → every step `✓ already done`.
4. **Expiry.** `volley auth signin-link --role steer --label expiry-check --ttl 5` prints a
   token. Wait 10 s, then on the phone open `http://<the Mac's LAN IP>:5199/#signin=<token>` in a
   **new tab** (`ipconfig getifaddr en0` gives the IP).
   **Pass:** the card says the link was used already or has expired, and what to do next.
5. **Admin sign-in, laptop.** Open the `Open the Desk with it on this machine:` link from step 1
   in a private browser window. If 10 minutes have passed since setup, run `volley auth token`
   first: it prints a new link.
   **Pass:** the Desk opens signed in, the sidebar says *Admin · manages accounts and setup*, and
   Setup & Security shows both listeners refusing anonymous clients and no pending Security
   change. Paste the same link into another private window: *already used*.
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
    that PATH either. Before **Remove**, copy
    `smoke.yaml` to `peer.yaml` with a new `wave:` id and `T1: { issue: <n>, host: <the
    machine's name> }`, then `volleyd validate peer.yaml && volleyd run peer.yaml`.
    **Pass:** the task's agent starts on that machine, registers, and shows in the Desk under
    the wave. After **Remove**: `volley auth list` no longer has the machine, and its service has
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
  1. setup (each step explained before changing? admin link printed?):
  2. phone QR (time from clone: __ min; reuse refused):
  3. PATH / --version / --repair:
  4. expired link refused:
  5. admin link (fresh window / reuse refused / nothing pending):
  6. keychain:
  7. Desk wizard on the phone (paste box):
  8. Settings search / tunable from the phone:
  9. second account / wave on second / account_limit prompt, nothing switched / move + resume note:
  10. paired machine: invite / join / up / wave task on it / remove + revoked:
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
