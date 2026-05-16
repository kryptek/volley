# Manual smoke checklist (release-level)

This file collects feature-level smoke recipes that span multiple packages — the per-package SMOKE.md files under `packages/*/SMOKE.md` cover narrower scopes (volley-issues dispatch, volley-skill / volley-wait skill installation, etc.). Add a new section per plan that ships a release tag.

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

- [ ] Start the dashboard:
   ```sh
   bun run packages/volley-cli/src/cli.ts dash --no-open
   ```
   Open http://localhost:5173/ in a browser (or whatever port Vite picked).

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
   mosquitto_pub -t "volley/_system/registry/smoke-alpha" -n -r
   mosquitto_pub -t "volley/default/smoke-alpha/status" -n -r
   mosquitto_pub -t "volley/_system/registry/smoke-beta" -n -r
   mosquitto_pub -t "volley/default/smoke-beta/status" -n -r
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
