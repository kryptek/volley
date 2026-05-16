# volley-dash

Real-time MQTT monitoring web UI for Volley agents (Vite + React + Tailwind + shadcn/ui + GSAP).

## Browser notifications

A bell-icon control in the top bar (right side, near the broker LED) opens a small popover with three toggles:

- **Browser notifications** — on toggle-on, requests `Notification.requestPermission()`. If you grant, agent transitions matching the trigger set fire as browser banners (`Volley: <agent_id>` with the lifecycle type as the body). If you deny, the toggle snaps back to off and a caption explains.
- **Sound** — plays a short bundled chime on each matching transition. Respects the OS `prefers-reduced-motion: reduce` setting — the chime is silenced under reduce-motion while the banner still fires (the chime is the motion-equivalent affordance, per WCAG SC 2.3.3).
- **Trigger events** — three checkboxes for `blocked`, `failed`, `reaped`. All on by default. The popover does not expose `working` / `done` / `spawning` deliberately — those would create noise during dispatch loops. Need to notify on every transition? Use the [`volley notify`](../volley-cli/README.md#volley-notify) CLI subcommand from a terminal instead.

Settings persist in `localStorage["volley-dash:notify"]` as `{enabled, sound, on}`. They are per-origin: a dashboard served at a different port has its own preferences.

**Supported browser floor:** Safari 16+, Firefox 47+, all Chromium. Legacy Safari ≤ 15's callback-only permission API is not supported (intentional — see `src/lib/notify-permission.ts`).

When the dashboard tab is hidden or closed, the browser surface silently misses transitions — the banner queue is the OS's, not ours. For ambient observability that survives a closed tab, run `volley notify` in a terminal tab.

## Asset credits

- `public/notify.mp3` — soft two-tone chime (B5 → E6, ~140 ms) synthesized
  with `ffmpeg`'s `sine` filter for Plan 9. Released under
  [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) by
  the Volley project. No attribution required.
