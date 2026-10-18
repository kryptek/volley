# volley-desk

The Desk: an infinite canvas of live wave and agent windows, driven straight off the Volley MQTT topics. There's no backend: the browser subscribes to the broker over WebSocket. The approved interactive prototype is the visual and interaction spec, and this package ports it piece by piece.

**Status:** `volley dash` opens the Desk. It ships the canvas (pan and zoom, touch and keyboard), the window frame, the MQTT store, demo mode, the wave, agent and coordinators windows, attention tiers, arrange & fit, steering (the chat glyphs) with delivery acks, settings, and the look (backgrounds, window styles, effects, tethers, the dock). It works at phone width, without WebGL, with reduced motion, and by keyboard and screen reader. The classic dashboard (`packages/volley-dash`) is deprecated and stays reachable as `volley dash --legacy` until it is removed.

## Run it

```sh
bun install                         # from the repo root
volley dash                         # = bun run dev in this package (see volley-cli's README for flags)
cd packages/volley-desk
bun run dev                         # http://localhost:5174 — live, ws://localhost:9001
open "http://localhost:5174/?demo=1"   # demo mode: sample data, no broker
volley dash --host 0.0.0.0          # serve on the LAN: open http://<LAN IP>:5174 on a phone (see LAN use)
```

| Setting | How |
|---|---|
| Broker | `VITE_VOLLEY_BROKER_URL=ws://host:9001 bun run dev` (default: port 9001, mosquitto's WebSocket listener, on the host the page was loaded from, so a phone that opens `http://<laptop>:5174` connects to `ws://<laptop>:9001`, or `wss://` for a page served over https; see [LAN use](#lan-use)) |
| Demo mode | `?demo=1` in the URL, or `VITE_VOLLEY_DEMO=1 bun run dev` |
| Broker credentials | The sign-in form on first load (see [Sign-in](#sign-in)), stored in localStorage under `volley-desk:broker-auth` as `{"username":"desk","password":"…"}`. For local `bun run dev` only, `VITE_VOLLEY_BROKER_USERNAME=desk VITE_VOLLEY_BROKER_PASSWORD=… bun run dev` skips the form. Vite inlines `VITE_*` values into a built bundle, so `volley dash --build` drops both. |

## Sign-in

The broker requires credentials (`examples/mosquitto-auth/`), so on first load the Desk asks for them before it connects: sign in as the `desk` identity that `volley auth init` printed. The username becomes the Desk's identity, the sender of everything it publishes; it must be a valid agent id. The credentials are kept in this browser's localStorage, so a reload signs straight in. If the broker refuses them (AUTH_FAILED), the Desk forgets the password and shows the form again with the broker's reason and the username filled in. An empty username connects anonymously, for a broker that still allows it; that Desk is read-only. Demo mode never asks.

localStorage is readable by any script on the Desk's origin, the same trust boundary as the Desk itself.

### LAN use

`volley dash --host 0.0.0.0` serves the page on the LAN, but a phone also has to reach the broker, and `examples/mosquitto-localhost.conf` binds its WebSocket listener to `127.0.0.1`. Add a second WebSocket listener on the machine's LAN address:

```conf
listener 9001 192.0.2.10   # this machine's LAN IP (or no address for every interface)
protocol websockets
```

- **Broker accounts are required.** That listener exposes the broker to everyone on the LAN. Keep `allow_anonymous false` and the `volley auth` password file and ACL (mosquitto's auth settings are global, so they cover the new listener too). Never open a LAN listener on an anonymous broker.
- **Cleartext.** Over `ws://` the `desk` password and every message cross the network unencrypted. Use a trusted network, or put TLS in front (mosquitto `certfile`/`keyfile` on the listener, the page over https, so the Desk dials `wss://`).
- **Open the page by IP** (`http://192.0.2.10:5174`). Vite refuses host names other than `localhost` and IP addresses.

Demo mode never opens a broker connection. It starts from the prototype's sample state (3 waves, 5 agents), advances narration, heartbeats and terminal lines every 2.6 s, and spawns a spec reviewer after 22 s. All of this runs as Volley envelopes through the same reducer the live path uses.

## Gestures

- Drag empty space to pan. A plain wheel or two-finger scroll also pans.
- Zoom around the cursor with ⌘/Ctrl + wheel or a trackpad pinch. Scale is clamped to 0.3–1.6.
- Drag a title bar to move a window. The move is divided by the zoom, so the window tracks the pointer. A pointer-down anywhere on a window brings it to the front.
- Touch: one finger on empty canvas pans; two fingers pinch-zoom around their midpoint and pan with it, on empty canvas or over a window (anywhere but its title bar, a slider or a text field). Lifting one finger carries on panning with the other, without a jump, if it is on empty canvas.

### Keyboard

| Key | Does |
|---|---|
| Tab | Moves through the canvas, then the windows (their buttons, tabs and fields), the top bar and the dock |
| Arrow keys | Pan, while the canvas (the `Desk canvas` region) has focus |
| `+` / `=`, `-` | Zoom in / out around the centre of the screen |
| `f` | Arrange & fit |
| Escape | Closes the top dialog: the settings modal, then the steering panel, then Appearance |

`+`, `-` and `f` are ignored while typing in a text field, and keys with ⌘, Ctrl or Alt are left to the browser. The settings modal keeps Tab inside itself until it closes, and gives focus back to the gear.

### Arrange & fit

Each visible wave forms a cluster: the wave window with its agents to the right, in task order (then implementer, fixup, rebase, spec review, quality review), each agent dropped into the shortest column. The coordinators window is a cluster of its own, placed first. Arrange tries from 1 agent column up to 3 or the most agents any cluster has, whichever is more, and every number of rows of clusters. It keeps the placement that fits the screen at the largest zoom (capped at 1.1), then animates the windows and the view there. So one big wave spreads to the screen's shape instead of a tall strip. Arrange and the coordinators window's go-to zoom out as far as 0.05 to show everything, below the wheel's 0.3 minimum; from there the wheel zooms back in smoothly.

### Finished agents

Agents that finished (`done`, `failed` or `reaped`) more than 10 minutes ago leave the canvas, so a long-running Desk shows the work still in flight. **Show finished agents** at the foot of the coordinators window brings them back, and says how many are hidden. The grace period is set under Layout in the Appearance panel (0–1440 minutes). Both settings are saved per browser in the `volley-desk-look` localStorage entry. A hidden agent is still in the store, and still counts towards Needs you and notifications.

Auto-arrange is ON by default and saved per browser (`autoArrange` in the `volley-desk-look` localStorage entry). While it is on, arrange runs 400 ms after the first layout, 120 ms after a window opens or closes, a wave is hidden or shown, or the coordinators window is toggled, and 200 ms after the browser stops resizing. As in the prototype, only the first schedule waits 400 ms; any change after load waits 120 ms. Dragging a window never re-arranges; the next structural change does. A broker reconnect neither re-arranges nor resets the view: while its retained replay settles the layout is held, and only windows that really appeared or went away re-arrange once it has.

## Phone width

Below 700 px (`NARROW_PX` in `useViewport.ts`) the Desk starts at scale 0.5 (offset 8, 70, as in the prototype), the top bar drops its counts but keeps the needs-you pill and its toggles, and every window is clamped to `min(460, 100vw - 24)`. The Appearance panel becomes a bottom sheet above the dock, so the dock stays reachable; the steering bar, the settings modal (one column) and the Needs-you actions (wrapping) fit the viewport. Rotating or resizing across the threshold switches layouts live.

## Without WebGL

On load the Desk asks a canvas for a WebGL context (`hasWebGL` in `look/Background.tsx`). Without one, the picker lists only the backgrounds that work without WebGL (Grid Motion, Shape Grid and None) with a note, a saved WebGL background renders as None, and the Liquid glass window style renders as Frosted glass and is not offered. The saved look is left alone, so the same browser profile on a machine with WebGL keeps its picks. The background's error boundary stays as the last line (a context lost later, or a driver that fails to compile a shader).

## Reduced motion

With `prefers-reduced-motion: reduce` the new-window entrance, the waiting Clawd's hop, the Needs-you pulse (a steady ring instead), the terminal caret, the tethers' flow and the arrange animation all stop (`styles/responsive.css` gathers the prototype's rules), and the narration line drops `DecryptedText` / `ShinyText` for plain text whatever the Appearance setting.

## Accessibility

Windows are `section`s named by their wave, task and role; the agent tabs are `tablist` / `tab` with `aria-selected`; progress bars are `progressbar`s with `aria-valuenow` (indeterminate until the agent reports progress); narration is `aria-live="polite"` and the Needs-you banners are `role="status"`; the dock is a labelled `nav`. The settings modal traps focus and owns the keyboard while open (only Escape, which closes it alone, reaches the Desk); the steering panel is a non-modal dialog, so it does not trap focus, and Escape closes it. `test/a11y.test.tsx` runs axe on the demo canvas (and with Appearance, a steering panel and the settings modal open) and checks WCAG AA text contrast (4.5:1) for `--ink`, `--mute` and `--dim` on every window chrome over the Desk ground; `--dim` was lightened from the prototype's `#6f7890` to `#7c859d` to pass.

## Layout

```
src/canvas/useViewport.ts   pan / wheel / zoomAt / fitTo (port of the prototype App.tsx), touch pan +
                            two-finger pinch, panBy, phone width (useViewportWidth, clampWindowWidth)
src/a11y/keys.ts            keyboard: arrow-key pan, +/- zoom, f arrange, Escape, focus trap
src/a11y/motion.ts          useReducedMotion (prefers-reduced-motion for JS effects)
src/styles/responsive.css   phone layout (< 700 px) and the reduced-motion rules
src/canvas/World.tsx        the transformed world layer (world--anim while arranging)
src/layout/arrange.ts       pure arrange & fit: per-wave clusters, shortest-column packing,
                            rows × columns chosen for the largest zoom (port of the prototype)
src/layout/useAutoArrange.ts auto-arrange triggers (the ON/OFF setting is the look's autoArrange)
src/canvas/Frame.tsx        window frame: drag, focus (useFocusOrder), win--born (4 s), onSize,
                            chromes glass | liquid | spotlight | glow | solid, Needs-you
                            effect pulse | electric | star (attnStyle; wrapAttention overrides)
src/store/mqtt-client.ts    mqtt.js wrapper (port of volley-dash): subscribes to every Desk topic,
                            passes cleared retained topics through as envelope null
src/store/reducer.ts        pure reducer → { waves, agents, coordinators, config, leases, admission }
src/store/types.ts          payload types mirroring spec/schemas (T1)
src/store/fixtures.ts       demo state + tick simulation (the prototype's data.ts, as envelopes)
src/store/context.tsx       <DeskStoreProvider> / useDesk(): live or demo
src/styles/desk.css         base rules ported from the prototype styles.css
src/windows/agent/          agent window: AgentWindow (title, pipeline, narration, tabs, footer),
                            Feed (envelopes + JSON), Terminal (screen tail), Pipeline
src/styles/agent.css        agent window rules
src/attention.ts            pure attention tiers (you | coordinator | info | none) per wave and agent,
                            coordinator staleness (claim_after_s), escalation (escalate_after_min)
src/windows/coordinators/   coordinators window: state per wave, progress, go-to, show/hide
src/windows/wave/NeedsYou   Needs-you / no-coordinator banners, agent attention line
src/topbar/TopBar.tsx       top bar: counts, "N need you" pill, coordinators/notify/sound toggles
src/notify/                 notification + chime on a move into "you" (volley-dash's settings key)
src/styles/attention.css    pulse (default Needs-you effect), banners, coordinators, pill
src/settings/               settings modal (wave gear): rows built from spec/schemas/config.schema.json
                            (schemaRows), config_set requests + acks (configTransport), SettingsModal
src/styles/settings.css     settings modal rules
src/steer/SteerPanel.tsx    steering panel: quick pills, PromptBar (/stop /wrap-up /pause /status,
                            Mailbox | Urgent), delivery steps, read-only copy fallback; ClaimButton
src/steer/transport.ts      T0 mailbox envelopes as the Desk (seq + supersedes per target), the urgent
                            Escape request and volleyd control requests (claim)
src/steer/ackState.ts       pure delivery state: sending → sent → delivered → acked (| superseded | failed)
src/steer/useSteering.tsx   App glue: steering log, transport over the store's writer, panel()
src/steer/demoClient.ts     demo-mode writer: simulated hook ack + steering_acked through the reducer
src/styles/steer.css        steering panel rules
src/look/options.ts         chrome, Needs-you and narration option tables (labels, keys, types)
src/look/useLook.ts         the look, persisted in localStorage `volley-desk-look`: bg, dim,
                            chrome, attn, narr, tethers, autoArrange (defaults = prototype LOOK0)
src/look/backgrounds.ts     all 63 free React Bits backgrounds + None, each lazy (its own chunk)
src/look/Background.tsx     background layer: error boundary → no-WebGL message, or a failed chunk
                            load → "Couldn’t load" + Retry; bg-dim overlay; WebGL detection
                            (hasWebGL, needsWebGL) and the degraded look (degradeLook)
src/look/Appearance.tsx     Appearance panel: background search + list, dim, window style,
                            auto-arrange, Needs-you effect, narration effect
src/look/Tethers.tsx        SVG cubic per agent, wave window → agent, in the wave accent
src/look/DeskDock.tsx       React Bits Dock (coordinators + needs-you badge, appearance, tethers,
                            arrange & fit, auto-arrange, zoom in/out) and SwipeToast notices
src/windows/agent/Narration narration effect: DecryptedText | ShinyText | plain (plain under reduced motion)
src/styles/look.css         background, tethers, chromes, dock and Appearance rules
src/rb/                     React Bits components (installed from the shadcn registry, see below)
scripts/check-react-bits.ts allow-list check, run in CI
scripts/sync-react-bits-backgrounds.ts
                            diffs reactbits.dev/llms.txt "Backgrounds" against the registry;
                            CI runs it as an optional (warning) step
```

### Subscriptions

`volley/_system/registry/+`, `volley/+/+/{status,progress,result,mailbox,screen}`, `volley/_waves/+/state`, `volley/_waves/+/decisions/+`, `volley/_waves/_config`, `volley/_system/leases/+`, `volley/_system/admission`.

### Store semantics

- **Agents** are keyed by the topic's `<agent_id>` segment. A mailbox envelope names its sender, and a screen envelope names the supervisor that captured it.
- **Feed:** each agent keeps a ring of its last 200 envelopes. Screen tails are stored separately and stay out of the feed.
- **Narration and progress:** the latest `payload.msg` on `progress` or `status` sets the narration, and `payload.progress` sets the progress.
- **Heartbeat:** taken from `progress/heartbeat`.
- **Wave assignment:** agents get their wave, task and role from `tasks[].agents` in the wave state. An agent keeps its wave after its role slot moves on to a new agent. An agent that no wave references belongs to the `unassigned` pseudo-wave (see `agentsByWave`).
- **Coordinators:** there is one entry per wave owner. The owner's own topics win when they report something: a terminal status means `gone`, an outstanding `awaiting_input` means awaiting input, and `resumed` clears it. If the owner's topics are silent, the store falls back to the supervisor's `coordinator` in the wave state. A wave the Desk claimed (its owner is the Desk's own identity) is coordinated by the person at the Desk, so it shows as `working` and ★ yours.
- **Cleared topics:** a cleared retained topic removes what it held. That covers registry → agent, wave state → wave (its agents return to `unassigned`), decision, lease pool and screen.

### Attention

Each wave and agent window gets a tier. **Needs you** (pulsing border): the wave's coordinator is waiting for an answer or is gone (reaped, or silent for longer than `claim_after_s`), an open decision on a wave this browser owns (`?me=`), or a stuck agent with no live coordinator. On a wave the Desk claimed, its open decisions, merge-ready gates and stuck agents are all Needs you: nobody else coordinates it. **Coordinator handling** (amber ring): an open decision, a merge-ready gate or a stuck agent while the coordinator is live; after 15 minutes unresolved it becomes Needs you. (The Desk also reads `escalate_after_min` from the wave's `effective_config` or the retained config, but that key is not yet a SPEC §4.6.4 tunable, so volleyd never publishes it and 15 minutes always applies.) Coordinator silence counts only time the Desk was connected and settled, so a broker outage or a sleeping laptop does not make every coordinator look gone. A finished (`complete` / `stopped`) wave needs nobody: it shows Complete / Stopped in the coordinators window and no banner. **Info**: an open PR or a lease wait. The top-bar pill counts everything at Needs you. A browser notification and the chime fire when something moves into Needs you (one per wave: agents inside a wave that already needs you are covered by it), never while the store is settling after page load or a reconnect; the bell and speaker toggles share volley-dash's `volley-dash:notify` setting.

### Steering

The chat glyph on a wave window messages its coordinator session; on an agent window it steers that agent. Each message is a SPEC §4.4 mailbox envelope published by the browser as the Desk's broker identity (`desk`), with a fresh UUID `correlation_id` and a `seq` per target (in memory: it restarts at 1 on reload, where SPEC §4.4 asks for per-sender monotonic). `supersedes` chains `steering` only: a steering message supersedes the previous steering message to the same target, while a `nudge` or `cancel` supersedes nothing, so `/status` never retires a standing directive. `/stop` sends a `cancel`, `/wrap-up` and `/pause` are steering, `/status` is a `nudge`.

`/stop` and Urgent mode first ask volleyd to interrupt the session (a mailbox `query` to `volleyd`: `op: "steer"`, `urgent: true`, `escape_only: true`, `wait_ack_ms: 0`, `wave`, `task`, and `role`, the agent's pipeline role, so volleyd interrupts that agent and not whichever agent drives the task's current stage). volleyd presses Escape through its interrupt hook and delivers nothing itself; once it answers, the Desk publishes its own message, so the agent gets exactly one. The panel then says **Interrupted (Escape), then delivered**, or **Delivered (not interrupted: …)** when volleyd has no interrupt wired, refuses, does not answer, reports that it interrupted a different agent, or the target has no wave task (a coordinator).

**A stale window is never interrupted.** volleyd interrupts whoever holds the task's role slot now, and an agent window outlives its slot (a fixup round or model switch gives the slot to a new agent). So the Desk sends the interrupt only while the agent it shows still holds `tasks[].agents[role]`; otherwise `/stop` asks volleyd for nothing, delivers the `cancel` to that agent's own mailbox, and says **Delivered (not interrupted: <agent> no longer holds the <role> slot on <task> (now <agent>))**. The read-only copy command is withheld for the same reason, since `volleyd steer --role` reaches the slot's new agent.

**volleyd refuses the Desk's interrupt on a wave a coordinator owns.** Urgent steering is a mutation, and volleyd accepts mutations only from the wave's owner, so on a coordinator-owned wave the panel reports **Delivered (not interrupted: …)** with volleyd's reason, and the message still goes out. Claim the wave first to interrupt its agents from the Desk.

After the Desk claims a wave it is the owner, and there is no coordinator session to message: the wave chat turns read-only rather than messaging the Desk's own mailbox. The same goes for a coordinator that is gone.

The panel tracks the last message: **Sent** (PUBACK) → **Delivered by hook** (the recipient's hook acked it to the Desk's own mailbox, `volley/<ns>/desk/mailbox`) → **Agent acknowledged** (the model published `progress/steering_acked` with the message id). For a coordinator the steps read **Shown in your Claude session** and **Coordinator replied** (its next `resumed` / `working`, or a mailbox reply correlated to the message). Only answers from the addressed agent that arrive on the Desk's own mailbox count (never the Desk's own echo), and a retained `working` replayed after a reconnect is not a reply. The store keeps these receipts in `state.steering`, and nothing on the Desk's own mailbox becomes an agent window.

**Hook acks need `--ack-to desk`.** On the auth broker a per-agent identity may only write the mailboxes it was minted to ack (`examples/mosquitto-auth`). Mint agents with `volley auth add-agent <id> --ack-to desk`, or their hook acks to the Desk are dropped silently and **Delivered by hook** never lights (Agent acknowledged still does).

The no-coordinator banner's **Claim this wave** sends `volleyd claim <wave>` as a daemon control request (`op: "claim"`) and shows volleyd's answer.

**Read-only without credentials.** On an anonymous connection the panel publishes nothing: its pills fill a text field and it offers `Copy "volleyd steer <wave> <task> \"…\" --role <role>"` instead, and the claim banner keeps only its copyable command. Demo mode writes to a simulated client whose acks run through the same reducer.

## Settings

The gear on a wave window opens the settings modal. Its rows come from the config schema, so a new tunable shows up without Desk changes: a bounded number gets a stepped slider, a string gets a text field, and each lease pool gets a capacity row. Hints come from the schema descriptions.

- **Global** shows the retained `volley/_waves/_config`. Once the Desk has signed in, a change sends one `config_set` request to the daemon's mailbox in volleyd's namespace (from its registry entry): `volley/<ns>/volleyd/mailbox`, `payload: { op, text, patch, by }`. Only volleyd's answer on the Desk's own mailbox counts. A slider sends once the user lets go: presses and drags within 400 ms of each other become one request with the settled value. The row then shows the ack: `applied · v<version>`, the rejected paths with their reasons, `failed ·` for a refused publish or daemon error, or `no answer ·` when volleyd does not reply in time (the change may still have applied).
- **This wave** shows the wave's `effective_config` and is read-only. volleyd applies `config_set` to the global config only. Per-wave values come from the wave file's `config:` block.
- **Without broker credentials** (an anonymous sign-in) or in demo mode the modal sends nothing. A global row still takes a new value, and then offers the exact `volleyd config set <path> <value>` line that sets it to copy (nothing to copy until the value differs from the current one). Without the async Clipboard API (plain `http://` from another device) the button selects the line and falls back to a legacy copy, or asks you to copy it by hand.

## React Bits

Components come from the [React Bits](https://reactbits.dev) shadcn registry (`@react-bits`, `https://reactbits.dev/r/{name}.json`). Install the TypeScript + CSS variant into its own folder under `src/rb/`, from this package directory:

```sh
bunx --bun shadcn@latest add @react-bits/<Name>-TS-CSS --path src/rb/<Name> --yes
```

The command was verified with Dock: `@react-bits/Dock-TS-CSS --path src/rb/Dock` writes `src/rb/Dock/Dock.tsx` and `src/rb/Dock/Dock.css`. It also adds the component's npm dependencies through bun. Record every component you install here:

| Component | Install command | Used by |
|---|---|---|
| StatusMark | `bunx --bun shadcn@latest add @react-bits/StatusMark-TS-CSS --path src/rb/StatusMark --yes` | agent window title (`src/windows/agent/AgentWindow.tsx`) |
| ElasticSlider | `bunx --bun shadcn@latest add @react-bits/ElasticSlider-TS-CSS --path src/rb/ElasticSlider --yes` | settings rows (`src/settings/SettingsModal.tsx`) |
| PromptBar | `bunx --bun shadcn@latest add @react-bits/PromptBar-TS-CSS --path src/rb/PromptBar --yes` | steering panel (`src/steer/SteerPanel.tsx`) |
| Dock | `bunx --bun shadcn@latest add @react-bits/Dock-TS-CSS --path src/rb/Dock --yes` | dock (`src/look/DeskDock.tsx`) |
| SwipeToast | `bunx --bun shadcn@latest add @react-bits/SwipeToast-TS-CSS --path src/rb/SwipeToast --yes` | notices (`src/look/DeskDock.tsx`) |
| GlassSurface | `bunx --bun shadcn@latest add @react-bits/GlassSurface-TS-CSS --path src/rb/GlassSurface --yes` | liquid-glass chrome (`src/canvas/Frame.tsx`) |
| SpotlightCard | `bunx --bun shadcn@latest add @react-bits/SpotlightCard-TS-CSS --path src/rb/SpotlightCard --yes` | spotlight chrome (`src/canvas/Frame.tsx`) |
| BorderGlow | `bunx --bun shadcn@latest add @react-bits/BorderGlow-TS-CSS --path src/rb/BorderGlow --yes` | border-glow chrome (`src/canvas/Frame.tsx`) |
| ElectricBorder | `bunx --bun shadcn@latest add @react-bits/ElectricBorder-TS-CSS --path src/rb/ElectricBorder --yes` | electric Needs-you effect (`src/canvas/Frame.tsx`) |
| StarBorder | `bunx --bun shadcn@latest add @react-bits/StarBorder-TS-CSS --path src/rb/StarBorder --yes` | star Needs-you effect (`src/canvas/Frame.tsx`) |
| DecryptedText | `bunx --bun shadcn@latest add @react-bits/DecryptedText-TS-CSS --path src/rb/DecryptedText --yes` | decrypt narration (`src/windows/agent/Narration.tsx`) |
| ShinyText | `bunx --bun shadcn@latest add @react-bits/ShinyText-TS-CSS --path src/rb/ShinyText --yes` | shiny narration (`src/windows/agent/Narration.tsx`) |
| every background (63, the list in `src/look/backgrounds.ts`) | `bunx --bun shadcn@latest add @react-bits/<Name>-TS-CSS --path src/rb/<Name> --yes` | background picker (`src/look/backgrounds.ts`) |

**Vendored code.** Components are kept as the registry ships them, so they can be re-installed or diffed against upstream. The registry code isn't written for this repo's strict compiler flags (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), so each component installed from D7 on gets one first line, `// @ts-nocheck: vendored React Bits component …`; its exported prop types still check the Desk's call sites. Biome skips the vendored components (a `biome.json` override on `src/rb/`) but still lints `StatusMark` and `ElasticSlider`, which were adapted by hand. The registry install also rewrites `react-dom` to a range and adds `ogl`, `three` and `vgpu` unpinned: restore `react-dom` and pin new dependencies to exact versions at least two weeks old.

**Reduced motion.** The prototype's CSS rules stop the Desk's own animations (see [Reduced motion](#reduced-motion)). Most React Bits components check `prefers-reduced-motion` themselves; `ColorBends` (a continuously animated background), `BorderGlow` and `GlassSurface` don't.

**Backgrounds stay complete.** `bun run sync:react-bits-backgrounds` compares the `## Backgrounds` section of https://reactbits.dev/llms.txt with `src/look/backgrounds.ts` and exits 1 when React Bits lists one the picker lacks (CI shows it as a warning). To add one: install it, add it to the allow-list and to `BACKGROUNDS` (components with a required prop get a generated input in `p`, as `GridDistortion.imageSrc` does).

**Allow-list.** Only the free components that the approved prototype uses are allowed. The list is in `scripts/check-react-bits.ts` (`REACT_BITS_ALLOW_LIST`). `bun run check:react-bits` fails when any entry under `src/rb/` is not on it, and CI runs it as the *React Bits allow-list* job. Pro components are never allowed.

## Tests

```sh
bun run test         # vitest + jsdom; mqtt-client runs against an in-process Aedes broker
bun run typecheck
```
