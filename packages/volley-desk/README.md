# volley-desk

The Desk: an infinite canvas of live wave and agent windows, driven straight off the Volley MQTT topics. There's no backend: the browser subscribes to the broker over WebSocket. The approved interactive prototype is the visual and interaction spec, and this package ports it piece by piece.

**Status:** foundation only. The package currently ships the canvas (pan and zoom), the window frame, the MQTT store, demo mode and the agent window, plus one plain placeholder window per wave. The real wave and coordinator windows, the backgrounds, the dock, steering, settings and auto-arrange come in later tasks. `volley dash` still opens the classic dashboard (`packages/volley-dash`) until the cutover.

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
src/settings/               settings modal (wave gear): rows built from spec/schemas/config.schema.json
                            (schemaRows), config_set requests + acks (configTransport), SettingsModal
src/styles/settings.css     settings modal rules
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

## Settings

The gear on a wave window opens the settings modal. Its rows come from the config schema, so a new tunable shows up without Desk changes: a bounded number gets a stepped slider, a string gets a text field, and each lease pool gets a capacity row. Hints come from the schema descriptions.

- **Global** shows the retained `volley/_waves/_config`. A change sends one `config_set` request to the daemon's mailbox (`volley/<ns>/volleyd/mailbox`, `payload: { op, text, patch, by }`). A slider sends once the user lets go: presses and drags within 400 ms of each other become one request with the settled value. The row then shows the ack: `applied · v<version>`, the rejected paths with their reasons, `failed ·` for a refused publish or daemon error, or `no answer ·` when volleyd does not reply in time (the change may still have applied).
- **This wave** shows the wave's `effective_config` and is read-only. volleyd applies `config_set` to the global config only. Per-wave values come from the wave file's `config:` block.
- **Without broker credentials** the modal is read-only, and each row offers its exact `volleyd config set <path> <value>` line to copy. Without the async Clipboard API (plain `http://` from another device) the button selects the line and falls back to a legacy copy, or asks you to copy it by hand. The Desk has no sign-in yet, so this is the current state.

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

**Allow-list.** Only the free components that the approved prototype uses are allowed. The list is in `scripts/check-react-bits.ts` (`REACT_BITS_ALLOW_LIST`). `bun run check:react-bits` fails when any entry under `src/rb/` is not on it, and CI runs it as the *React Bits allow-list* job. Pro components are never allowed.

## Tests

```sh
bun run test         # vitest + jsdom; mqtt-client runs against an in-process Aedes broker
bun run typecheck
```
