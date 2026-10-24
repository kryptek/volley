# Desk browser checks

Playwright scripts for the Desk behaviours jsdom can't show: the first frame against a broker holding hundreds of retained agents, text selection, how each window style draws, window pinning, pan performance on a phone, the agent windows' Clawd characters, and the theme token layer and its text contrast. They are not part of `bun run test`, and the workspace has no Playwright dependency. Each check loads Playwright from the directory it is run in.

Use a **private** broker on ports of your own. Never point them at a shared or live broker.

```sh
# Once, in a scratch directory outside the repo:
cd "$(mktemp -d)" && npm init -y >/dev/null && npm i playwright@1.59.1 && npx playwright install chromium
CHECKS=<repo>/packages/volley-desk/scripts/browser-check

# From the repo: a private broker (MQTT 31883, WebSocket 31884), paced 1 ms per frame like a
# remote Desk's network; a localhost broker delivers a whole replay inside one flush and hides
# first-load bugs. Then the Desk against it.
bun packages/volley-desk/scripts/browser-check/broker.mjs 31883 31884 1 &
(cd packages/volley-desk && VITE_VOLLEY_BROKER_URL=ws://127.0.0.1:31884 bunx vite --port 31885 --strictPort --host 127.0.0.1 &)

# Seed it:
bun packages/volley-desk/test/fixtures/seed-retained-burst.ts mqtt://127.0.0.1:31883   # 300 finished + 3 live agents
bun packages/volley-desk/scripts/browser-check/seed-waves.mjs mqtt://127.0.0.1:31883   # a running, a stopped and a complete wave

# Then, from the scratch directory (DESK_URL defaults to http://127.0.0.1:21320/;
# CHROME=<path> uses another Chromium binary):
export DESK_URL=http://127.0.0.1:31885/
node $CHECKS/first-load.mjs <out dir>      # no finished agent ever in the DOM, desktop and phone
node $CHECKS/coordinators.mjs <out dir>    # chips, the Ended group, Show and its fit, Dismiss across a reload
node $CHECKS/selection.mjs <out dir>       # canvas and chrome drags select nothing; a feed row selects
node $CHECKS/pinning.mjs <out dir>         # anchor the coordinators top-left: arrange, pan, resize, reload; pin a wave in place
node $CHECKS/styles-audit.mjs <out dir>    # every window style: box, hover overflow, paint under the body
node $CHECKS/sheet.mjs <out dir>           # the comparison sheet from the audit
node $CHECKS/pan-perf.mjs <out dir> [tag]  # demo, no broker: phone pan frame times (4x CPU) and backdrop filters, desktop window crop
node $CHECKS/popovers.mjs <out dir>        # demo, no seeding: the why-here cards on screen, outside every window, at desktop, phone, zoomed out
node $CHECKS/clawd.mjs <out dir>           # demo, no seeding: each agent window's Clawd, title bars as tall as Classic, no glow on a phone, still under reduced motion
node $CHECKS/themes.mjs <out dir> [tag] [theme...]  # demo: agent, wave, dock, Needs you, Settings and sign-in crops per theme (a light one with Clawd and Classic) and the computed tokens; axe color-contrast and the measured text contrast (text-contrast.mjs) per view; fails on text below AA beyond Volley's own
```

Re-run `seed-waves.mjs` before `styles-audit.mjs`, because the seeded wave goes stale and grows a banner. Each check prints a JSON report and writes its screenshots to the output directory. Stop the broker and the dev server afterwards.
