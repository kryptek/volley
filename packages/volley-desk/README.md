# volley-desk

The Desk: an infinite canvas of live wave and agent windows, driven straight off the Volley MQTT topics. There's no backend: the browser subscribes to the broker over WebSocket. The approved interactive prototype is the visual and interaction spec, and this package ports it piece by piece.

**Status:** foundation only. The package currently ships the canvas (pan and zoom), the window frame, the MQTT store, demo mode and the agent window, plus one plain placeholder window per wave. The real wave and coordinator windows, the backgrounds, the dock, settings and auto-arrange come in later tasks. Steering (the chat glyphs) is in, with delivery acks. `volley dash` still opens the classic dashboard (`packages/volley-dash`) until the cutover.

## Run it

```sh
bun install                         # from the repo root
cd packages/volley-desk
bun run dev                         # http://localhost:5174 — live, ws://localhost:9001
open "http://localhost:5174/?demo=1"   # demo mode: sample data, no broker
```

| Setting | How |
|---|---|
| Broker | `VITE_VOLLEY_BROKER_URL=ws://host:9001 bun run dev` (default `ws://localhost:9001`, mosquitto's WebSocket listener) |
| Demo mode | `?demo=1` in the URL, or `VITE_VOLLEY_DEMO=1 bun run dev` |
| Broker credentials (steering) | `VITE_VOLLEY_BROKER_USERNAME=desk VITE_VOLLEY_BROKER_PASSWORD=… bun run dev`, or `{"username":"desk","password":"…"}` stored in localStorage under `volley-desk:broker-auth`. Without them the Desk connects anonymously and is read-only. |

Demo mode never opens a broker connection. It starts from the prototype's sample state (3 waves, 5 agents), advances narration, heartbeats and terminal lines every 2.6 s, and spawns a spec reviewer after 22 s. All of this runs as Volley envelopes through the same reducer the live path uses.

## Gestures

- Drag empty space to pan. A plain wheel or two-finger scroll also pans.
- Zoom around the cursor with ⌘/Ctrl + wheel or a trackpad pinch. Scale is clamped to 0.3–1.6.
- Drag a title bar to move a window. The move is divided by the zoom, so the window tracks the pointer. A pointer-down anywhere on a window brings it to the front.

## Layout

```
src/canvas/useViewport.ts   pan / wheel / zoomAt / fitTo (port of the prototype App.tsx)
src/canvas/World.tsx        the transformed world layer
src/canvas/Frame.tsx        window frame: drag, focus (useFocusOrder), win--born (4 s), onSize,
                            chromes glass | solid, attention wrapper slot
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
src/steer/SteerPanel.tsx    steering panel: quick pills, PromptBar (/stop /wrap-up /pause /status,
                            Mailbox | Urgent), delivery steps, read-only copy fallback; ClaimButton
src/steer/transport.ts      T0 mailbox envelopes as the Desk (seq + supersedes per target), the urgent
                            Escape request and volleyd control requests (claim)
src/steer/ackState.ts       pure delivery state: sending → sent → delivered → acked (| superseded | failed)
src/steer/useSteering.tsx   App glue: steering log, transport over the store's writer, panel()
src/steer/demoClient.ts     demo-mode writer: simulated hook ack + steering_acked through the reducer
src/styles/steer.css        steering panel rules
src/rb/                     React Bits components (installed from the shadcn registry, see below)
scripts/check-react-bits.ts allow-list check, run in CI
```

### Subscriptions

`volley/_system/registry/+`, `volley/+/+/{status,progress,result,mailbox,screen}`, `volley/_waves/+/state`, `volley/_waves/+/decisions/+`, `volley/_waves/_config`, `volley/_system/leases/+`, `volley/_system/admission`.

### Store semantics

- **Agents** are keyed by the topic's `<agent_id>` segment. A mailbox envelope names its sender, and a screen envelope names the supervisor that captured it.
- **Feed:** each agent keeps a ring of its last 200 envelopes. Screen tails are stored separately and stay out of the feed.
- **Narration and progress:** the latest `payload.msg` on `progress` or `status` sets the narration, and `payload.progress` sets the progress.
- **Heartbeat:** taken from `progress/heartbeat`.
- **Wave assignment:** agents get their wave, task and role from `tasks[].agents` in the wave state. An agent keeps its wave after its role slot moves on to a new agent. An agent that no wave references belongs to the `unassigned` pseudo-wave (see `agentsByWave`).
- **Coordinators:** there is one entry per wave owner. The owner's own topics win when they report something: a terminal status means `gone`, an outstanding `awaiting_input` means awaiting input, and `resumed` clears it. If the owner's topics are silent, the store falls back to the supervisor's `coordinator` in the wave state.
- **Cleared topics:** a cleared retained topic removes what it held. That covers registry → agent, wave state → wave (its agents return to `unassigned`), decision, lease pool and screen.

### Attention

Each wave and agent window gets a tier. **Needs you** (pulsing border): the wave's coordinator is waiting for an answer or is gone (reaped, or silent for longer than `claim_after_s`), an open decision on a wave this browser owns (`?me=`), or a stuck agent with no live coordinator. **Coordinator handling** (amber ring): an open decision, a merge-ready gate or a stuck agent while the coordinator is live; after `escalate_after_min` (default 15, from the wave's `effective_config` or the retained config) it becomes Needs you. **Info**: an open PR or a lease wait. The top-bar pill counts everything at Needs you. A browser notification and the chime fire when something moves into Needs you; the bell and speaker toggles share volley-dash's `volley-dash:notify` setting.

### Steering

The chat glyph on a wave window messages its coordinator; on an agent window it steers that agent. Each message is a SPEC §4.4 mailbox envelope published by the browser as the Desk's broker identity (`desk`), with a fresh UUID `correlation_id`, a `seq` per target and `supersedes` = the previous message to the same target. `/stop` sends a `cancel`, and `/stop` or Urgent mode also asks volleyd to interrupt the session with Escape (a mailbox `query` to `volleyd` with `op: "steer"`, `urgent: true`, `escape_only: true`, `message_id`, `agent_id`, `wave`, `task`). `/wrap-up` and `/pause` are steering, `/status` is a `nudge`.

The panel tracks the last message: **Sent** (PUBACK) → **Delivered by hook** (the recipient's hook acked it to the Desk's own mailbox, `volley/<ns>/desk/mailbox`) → **Agent acknowledged** (the model published `progress/steering_acked` with the message id). For a coordinator the steps read **Shown in your Claude session** and **Coordinator replied** (its next `resumed` / `working`, or a mailbox reply correlated to the message). Only answers from the addressed agent count. The store keeps these receipts in `state.steering`, and nothing on the Desk's own mailbox becomes an agent window.

The no-coordinator banner's **Claim this wave** sends `volleyd claim <wave>` as a daemon control request (`op: "claim"`) and shows volleyd's answer.

**Read-only without credentials.** On an anonymous connection the panel publishes nothing: its pills fill a text field and it offers `Copy "volleyd steer <wave> <task> \"…\""` instead, and the claim banner keeps only its copyable command. Demo mode writes to a simulated client whose acks run through the same reducer.

## React Bits

Components come from the [React Bits](https://reactbits.dev) shadcn registry (`@react-bits`, `https://reactbits.dev/r/{name}.json`). Install the TypeScript + CSS variant into its own folder under `src/rb/`, from this package directory:

```sh
bunx --bun shadcn@latest add @react-bits/<Name>-TS-CSS --path src/rb/<Name> --yes
```

The command was verified with Dock: `@react-bits/Dock-TS-CSS --path src/rb/Dock` writes `src/rb/Dock/Dock.tsx` and `src/rb/Dock/Dock.css`. It also adds the component's npm dependencies through bun. Record every component you install here:

| Component | Install command | Used by |
|---|---|---|
| StatusMark | `bunx --bun shadcn@latest add @react-bits/StatusMark-TS-CSS --path src/rb/StatusMark --yes` | agent window title (`src/windows/agent/AgentWindow.tsx`) |
| PromptBar | `bunx --bun shadcn@latest add @react-bits/PromptBar-TS-CSS --path src/rb/PromptBar --yes` | steering panel (`src/steer/SteerPanel.tsx`) |

**Allow-list.** Only the free components that the approved prototype uses are allowed. The list is in `scripts/check-react-bits.ts` (`REACT_BITS_ALLOW_LIST`). `bun run check:react-bits` fails when any entry under `src/rb/` is not on it, and CI runs it as the *React Bits allow-list* job. Pro components are never allowed.

## Tests

```sh
bun run test         # vitest + jsdom; mqtt-client runs against an in-process Aedes broker
bun run typecheck
```
