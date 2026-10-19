# Manual smoke checklist (release-level)

This file collects feature-level smoke recipes that span multiple packages — the per-package SMOKE.md files under `packages/*/SMOKE.md` cover narrower scopes (volley-issues dispatch, volley-skill / volley-wait skill installation, etc.). Add a new section per plan that ships a release tag.

**v0.3.0** (onboarding: `volley setup`, the Desk's setup wizard and sign-in links, pairing, Claude accounts) is [Plan 11](#plan-11--onboarding-v030) below. **v0.2.0** (volleyd, volley-hooks, broker auth, the Desk) has its own owner smoke path: [`docs/SMOKE-v0.2.md`](docs/SMOKE-v0.2.md).

---

## Plan 11 — Onboarding (v0.3.0)

**Done means:** a fresh machine gets to a Desk signed in on a phone, with a paired second machine
and two Claude accounts, without anyone reading source. The target is **10 minutes** from
`git clone` to the phone signed in.

The smoke has two parts:

- **A. Automated.** Run on a throwaway Linux "fresh machine" (a container: mosquitto 2.1 and bun,
  nothing else) and a second container as the paired machine, on a private Docker network. It
  publishes no host ports, so the everyday broker on `1883` / `9001` is never touched. The
  recorded run is under [A. Results](#a-results); [A. How to rerun it](#a-how-to-rerun-it)
  rebuilds it.
- **B. Owner.** The part that needs real hardware and real accounts: a Mac (launchd, the macOS
  keychain), a phone on the LAN, a real second machine and a second Claude account. About 30
  minutes. Every step says what to type or click and what a pass looks like.

### A. What the automated run covers

| | Check | Pass |
|---|---|---|
| (a) | `volley setup` on a clean anonymous broker | config diff shown, old config backed up, both listeners refuse anonymous clients, services up, rerun changes nothing |
| (a) | the one-time admin token, redeemed in a fresh desktop browser (Playwright) | signed in as `admin`, Setup & Security opens |
| (a) | the phone QR link, redeemed in phone emulation (390×844, touch) | signed in as `steer`; the same link again is refused ("already used") |
| (b) | Settings: each of the 8 sections found from the sidebar search by one of its keywords | listed, opens |
| (b) | Supervisor › Hard ceiling changed with the keyboard | `applied · v2`; volleyd's `config.yaml` and `volleyd config get` agree |
| (c) | pair a second machine with a code, then remove it | `tunnel up` + heartbeat; after `remove`: account gone, broker refuses it, its service stops itself |
| (e) | credential audit | no Volley process opens or stats a Claude credential file (strace, with decoys planted) |

Not automated, so in part B: the macOS keychain and launchd paths, a real phone over Wi-Fi, a
wave task on the paired machine (it needs `claude` signed in there, and a container must never
hold Claude credentials), and all of (d), which needs a second real Claude account.

### A. Results

```
RESULTS (2026-10-19, release/2026-10-18-onboarding @ 02d4d70 + the fix in #133):
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
              `volley auth`, and nothing put `volley` on the services' PATH. With that fixed,
              the next failure was the auth dir (`--layout` / `--dir` did not reach volleyd's
              `volley auth`). #133 links volley/volleyd into ~/.volley/bin, puts it on the
              services' PATH and sets VOLLEY_AUTH_DIR. Every result below is with #133.
      admin token, fresh desktop browser (1440x900)     signed in as admin in 5.1 s         PASS
      the same token again                              refused: "token … was already used" PASS
      phone link, phone emulation (390x844, touch)      signed in as steer in 6.1 s         PASS
      the same link again                               refused: "token … was already used" PASS
      Time, machine side, `bun install` to the phone signed in: under 30 s plus the broker
      restart (bun install 2.8 s, setup 7 s, sign-in 6 s). The 10-minute target is the owner's
      clock in part B.

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
      first try without --remote-volley: "bash: line 6: volley: command not found". `volley`
      is not on the supervisor's non-interactive ssh PATH. Needs --remote-volley
      ~/.volley/bin/volley (polish, see below).
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
                                                        on the peer): part B, step 9

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

  Polish found (not fixed here; for the coordinator):
    - `volley peer join`: when `volley` is not on the host's ssh PATH, the error does not
      suggest --remote-volley (and with #133 the obvious value is ~/.volley/bin/volley).
    - The Desk's Setup & Security reads "Security: 2 pending" right after a clean
      `volley setup --layout container`: volleyd plans with the layout it detects, not the
      one setup was given. Brew and snap detect the same layout both ways.
    - `volley auth token` says "paste it into the Desk's sign-in", but the sign-in form has
      only username and password. What works is `<desk>#signin=<token>`, or Setup & Security's
      paste box once signed in. Setup could print the link.
    - `volley peer invite` prints `--to unknown@<host>` when $USER is unset (seen in a
      container; a login shell sets it).
    - The broker config's header says "generated by `volley auth init`" when setup wrote it.
  Fixed in this PR: the Settings sidebar showed a password-signed-in admin as
    "Agent identity" while Machines was open. It now follows Machines' admin check.
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
   `docker run -d --name vsmoke-a --hostname machine-a --network vsmoke <image> sleep infinity`.
   Copy this checkout in (`git archive HEAD`), `bun install`. Start mosquitto with an anonymous
   config (`listener 1883`, `listener 9001` + `protocol websockets`, `allow_anonymous true`).
3. As `owner`: `bun packages/volley-cli/src/cli.ts setup --yes --layout container`. Restart
   mosquitto when it says so, then run it again.
4. From the host, Playwright (Chromium) opens `http://<container IP>:5199/#signin=<token>`. The
   container IP is reachable from the host on the bridge, and the page then uses
   `ws://<container IP>:9001`, the container's broker. Use one fresh browser context per sign-in.
5. A second container `vsmoke-b`, with sshd on both (`AllowTcpForwarding yes` on the
   supervisor's; Alpine's default is `no`) and each one's key in the other's
   `authorized_keys`. Then `volley auth add <admin> --role admin`, `volley peer invite`,
   `volley peer join …`, `volley peer list`, `volley peer remove`.
6. Audit: plant decoy `.credentials.json` files, run each Volley process under
   `strace -f -e trace=openat,open,stat,statx,lstat,newfstatat,access,faccessat,faccessat2,readlink,execve`,
   then `grep credentials.json` the traces.
7. `docker rm -f vsmoke-a vsmoke-b && docker network rm vsmoke`.

### B. Owner checklist (Mac + phone, about 30 minutes)

You need: a Mac with Homebrew, bun 1.3 or 1.4 and `claude` signed in. An iPhone or Android phone
on the same Wi-Fi. A second machine (Linux or macOS) with `claude` signed in, bun, git, tmux, a
clone of a throwaway test repo, a Volley checkout of this release (`bun install` run), and
key-based ssh both ways with the Mac. A second Claude account you can sign in with. Start a
stopwatch at step 1 and stop it at step 5.

1. **Fresh setup.** On the Mac:
   ```sh
   brew install mosquitto && brew services start mosquitto     # mosquitto -h | head -1 → 2.1.x
   git clone https://github.com/kryptek/volley.git && cd volley && bun install
   bun packages/volley-cli/src/cli.ts setup
   ```
   Answer **yes** to the LAN question, and **yes** to each step.
   **Pass:** each step lists what it found and what it will change *before* asking. Security
   names the `mosquitto.conf.volley-backup-<timestamp>` it made and ends with `Listener 1883:
   refuses anonymous clients` and the same for 9001 and the LAN address. Accounts prints three
   passwords once and an admin token. Services links `volley`/`volleyd` into `~/.volley/bin` and
   loads volleyd and the Desk. Phone prints a QR code. Last line: `Setup complete.` Anything
   that asks you to read source or guess is a fail: note the step.
2. **Rerun.** `bun packages/volley-cli/src/cli.ts setup --repair` → every step `✓ already done`.
   Then `echo 'export PATH="$HOME/.volley/bin:$PATH"' >> ~/.zshrc && exec zsh` and
   `volley --version` → `0.3.0`.
3. **Keychain** (never tested on a real Mac before). `security find-generic-password -s
   volley-broker -a coordinator -w` prints the same password as `coordinator.json` in the auth
   dir that setup named. **Pass:** identical, and no keychain dialog other than one "allow"
   for `security` itself.
4. **Admin sign-in, laptop.** In a private browser window, open
   `http://localhost:5199/#signin=<the admin token from step 1>`.
   **Pass:** the Desk opens signed in, the sidebar says *Admin · manages accounts and setup*,
   and Setup & Security shows both listeners refusing anonymous clients. Paste the same URL
   into another private window: *already used*.
5. **Phone sign-in.** Scan the QR from step 1 with the phone camera.
   **Pass:** within about 10 s the Desk loads signed in (Settings › account row: the `steer`
   account, *Desk on iPhone* or similar). **Stop the stopwatch and write the time down
   (target ≤ 10 min).** Scan the same QR again: the card says the link was already used and
   what to do next. (If the QR expired before you scanned it: `volley setup` again issues a new
   one.)
6. **The Desk wizard from the phone.** On the laptop Desk: Settings › Setup & Security ›
   **Issue new token**. On the phone, open `http://<the Mac's LAN IP>:5199/#signin=<that token>`.
   Then Settings › Setup & Security › **Run setup again**.
   **Pass:** the five steps fit the phone screen, each says *already done* (or shows exactly
   what it would change and why), Apply never dead-ends, and errors say what to do next.
7. **Settings.** On the phone: type `ceiling`, `pair`, `qr` and `weekly` in the Settings search,
   one at a time: each shows its section. Supervisor › Hard ceiling +1 → `applied`. Put it
   back.
8. **Second Claude account (d).** Laptop Desk: Settings › Claude accounts & usage › **+ Add
   Claude account**, label `second`, **Sign in on this machine**, then **Open Anthropic sign-in
   ↗** and sign in with the *second* account.
   **Pass:** the card shows `second` signed in; `volley claude list` lists both accounts.
   Write a one-task wave file `smoke.yaml` (an open issue of the test repo, and a release branch
   pushed there):
   ```yaml
   wave: <yyyy-mm-dd>-onboarding-smoke
   repo: <abs path of the test repo on the Mac>
   release_branch: release/<yyyy-mm-dd>-onboarding-smoke
   tasks:
     T1: { issue: <n>, pipeline: [implement, merge_ready] }
   ```
   From a shell with the coordinator's login (README step 4:
   `VOLLEY_AUTH_USERNAME=coordinator`, `VOLLEY_AUTH_PASSWORD`):
   `volleyd config set claude.warn_at_pct 1`, then `volleyd run smoke.yaml`, and let the agent
   work for a minute under the primary account.
   **Pass:** a Needs-you banner (*account_limit*) suggests `second`, and **nothing moves by
   itself**: the agent stays on the primary until you answer. Answer **Not now**. Then pick
   `second` in the agent window's title and confirm.
   **Pass:** the agent restarts under `second`, in the same worktree, and
   `<worktree>/.volley/brief.md` ends with a resume note. Afterwards:
   `volleyd stop <wave>` and `volleyd config set claude.warn_at_pct 90`.
9. **Pair the second machine (c).** Follow
   [`docs/SMOKE-v0.2.md` → Paired machine](docs/SMOKE-v0.2.md#paired-machine-volley-peer)
   (invite / join / up / down / remove). Add `--remote-volley ~/.volley/bin/volley` to `join`
   when `volley` is not on the Mac's non-interactive ssh PATH: without it the join says
   `volley: command not found`. Before **Remove**, submit `smoke.yaml` again under a new
   `wave:` id, with `host: <the machine's name>` added to `T1`.
   **Pass:** the task's agent starts on that machine, registers, and shows in the Desk under
   the wave. After **Remove**: `volley auth list` no longer has the machine, and its service has
   stopped itself.
10. **Credential audit (e), macOS.** In one terminal:
    `sudo fs_usage -w -f pathname | grep -E 'credentials\.json|Keychains/.*Claude'`. In another,
    repeat steps 4 and 7 and let a wave agent run for a minute.
    **Pass:** no line from a `bun` process. (Claude Code itself reads its own credentials; that
    is `claude`, not Volley.)
11. **Record** the results below, then **clean up**: `volley peer remove` anything left over,
    revoke the smoke accounts (`volley auth list`, `volley auth revoke <name>`).

```
OWNER RESULTS (<date>, release head <sha>):
  1. setup (each step explained before changing?):
  2. rerun / PATH / --version:
  3. keychain:
  4. admin token (fresh window / reuse refused):
  5. phone QR (time from clone: __ min; reuse refused):
  6. Desk wizard on the phone:
  7. Settings search / tunable from the phone:
  8. second account / account_limit prompt, nothing switched / move + resume note:
  9. paired machine: invite / join / up / wave task on it / remove + revoked:
  10. credential audit:
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
