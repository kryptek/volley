import { readFileSync } from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { ARRANGE_ANIM_MS } from "../src/layout/useAutoArrange";
import { DeskStoreProvider } from "../src/store/context";
import type { DeskMqttClient } from "../src/store/mqtt-client";
import type { DeskMessage, Envelope, WaveStatePayload } from "../src/store/types";

describe("App (demo mode)", () => {
  it("renders a wave window per demo wave, an agent window per agent, and the top-bar counts", () => {
    const { container } = render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
    // 3 waves + 5 agents + the coordinators window.
    expect(container.querySelectorAll(".world .win")).toHaveLength(3 + 5 + 1);
    // Agent windows use .t-name too; wave windows are the ones with a dependency graph.
    const waveNames = [...container.querySelectorAll(".world .win")]
      .filter((w) => w.querySelector(".dag"))
      .map((w) => w.querySelector(".t-name")?.textContent);
    expect(waveNames).toEqual(["status-chip", "ci-speed", "leaderboard"]);
    expect(screen.getByRole("region", { name: "status-chip" })).toBeInTheDocument();
    expect(container.querySelectorAll(".world .narr")).toHaveLength(5);
    expect(container.querySelectorAll(".world .dag")).toHaveLength(3);
    expect(screen.getByText("Demo · sample data")).toBeInTheDocument();
    expect(container.querySelector(".topbar-mid")?.textContent).toContain("3 waves");
  });
});

describe("App attention (demo mode)", () => {
  it("pulses the waves that need you, shows their banners, the pill and the coordinators window", () => {
    const { container } = render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
    const win = (name: string) => screen.getByRole("region", { name });
    expect(win("status-chip")).toHaveClass("win--attn-you");
    expect(win("status-chip").querySelector(".win-attn-pulse")).not.toBeNull();
    expect(win("status-chip")).toHaveTextContent(
      "Needs you: the coordinator is waiting for your answer",
    );
    expect(win("leaderboard")).toHaveClass("win--attn-you");
    expect(win("leaderboard")).toHaveTextContent("Needs you: no coordinator for 34 min");
    expect(win("ci-speed")).toHaveClass("win--attn-coordinator");
    expect(win("Wave coordinators")).toBeInTheDocument();
    expect(container.querySelector(".topbar .ny-pill")?.textContent).toMatch(/\d+ needs? you/);
  });

  it("frames the coordinators window in the initial view", () => {
    const { container } = render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
    const world = container.querySelector(".world") as HTMLElement;
    const [, tx = "0", ty = "0", ts = "1"] =
      /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(world.style.transform) ?? [];
    const coords = screen.getByRole("region", { name: "Wave coordinators" });
    const left = Number(tx) + Number.parseFloat(coords.style.left) * Number(ts);
    const top = Number(ty) + Number.parseFloat(coords.style.top) * Number(ts);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThan(window.innerWidth);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(window.innerHeight);
  });
});

describe("App (live store)", () => {
  const wave = JSON.parse(
    readFileSync(
      path.resolve(__dirname, "../../../spec/examples/valid/wave-state-running.json"),
      "utf8",
    ),
  ) as Envelope;
  const decision = (id: string, wave: string, resolved: boolean): DeskMessage => ({
    topic: `volley/_waves/${wave}/decisions/${id}`,
    envelope: {
      schema_version: "0.1",
      agent_id: "volleyd",
      channel: "_waves/decisions",
      type: resolved ? "decision_resolved" : "decision_opened",
      payload: {
        decision_id: id,
        wave,
        task: null,
        kind: "plan_change",
        question: "?",
        pointers: {},
        opened_at: "2026-10-18T14:00:00.000Z",
        ...(resolved
          ? { resolved: { answer: "yes", by: "owner", at: "2026-10-18T14:01:00.000Z" } }
          : {}),
      },
    },
    receivedAt: 1_000,
  });

  function fakeClient(msgs: DeskMessage[]): () => DeskMqttClient {
    return () => {
      const handlers = new Set<(m: DeskMessage) => void>();
      const none = () => () => {};
      return {
        connect: async () => {
          setTimeout(() => {
            for (const m of msgs) for (const h of handlers) h(m);
          }, 0);
        },
        disconnect: async () => {},
        publish: async () => {},
        onMessage: (h) => {
          handlers.add(h);
          return () => handlers.delete(h);
        },
        onConnect: none,
        onDisconnect: none,
        onError: none,
      };
    };
  }

  it("counts only unresolved decisions and labels a decision-only wave as waiting", async () => {
    const factory = fakeClient([
      { topic: "volley/_waves/w1/state", envelope: wave, receivedAt: 1_000 },
      decision("d1", "w1", false),
      decision("d2", "w1", true),
      decision("d3", "w2", false),
    ]);
    const { container } = render(
      <DeskStoreProvider demo={false} brokerUrl="ws://test.invalid" clientFactory={factory}>
        <App />
      </DeskStoreProvider>,
    );
    expect(await screen.findByText(/1 decision ·/)).toBeInTheDocument();
    expect(screen.getByText("waiting for wave state")).toBeInTheDocument();
    expect(container.querySelector(".topbar-mid")?.textContent).toContain("1 wave");
    expect(container.querySelector(".topbar-mid")?.textContent).not.toContain("1 waves");
  });
});

// ---------------------------------------------------------------- live attention

const T0 = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

function env(agent: string, channel: string, type: string, payload: object = {}): Envelope {
  return {
    schema_version: "0.1",
    agent_id: agent,
    namespace: "default",
    wall_time: iso(T0),
    channel,
    type,
    payload,
  } as Envelope;
}

const msg = (topic: string, envelope: Envelope, retained: boolean): DeskMessage => ({
  topic,
  envelope,
  receivedAt: Date.now(),
  retained,
});

function waveState(status: WaveStatePayload["status"] = "running"): Envelope {
  const payload: WaveStatePayload = {
    wave: "w1",
    version: 1,
    owner: "coord-1",
    repo: "example-org/example-repo",
    release_branch: "release/w1",
    status,
    tasks: [{ id: "T1", issue: 1, stage: "implement", agents: { implementer: "impl-1" } }],
    open_decisions: [],
    gates: [],
    updated_at: iso(T0),
  };
  return env("volleyd", "_waves/state", "wave_state", payload);
}

/** What the broker holds for a wave with a working coordinator and one implementer. */
const retained = (coordStatus = "working", status: WaveStatePayload["status"] = "running") => [
  msg("volley/_system/registry/coord-1", env("coord-1", "registry", "registered"), true),
  msg("volley/default/coord-1/status", env("coord-1", "status", coordStatus), true),
  msg("volley/_system/registry/impl-1", env("impl-1", "registry", "registered"), true),
  msg("volley/default/impl-1/status", env("impl-1", "status", "working"), true),
  msg("volley/_waves/w1/state", waveState(status), true),
];

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A fake broker connection the test drives: deliveries, drops and reconnects.
 * `sleep` paces them; under fake timers pass one that advances the clock.
 */
function scriptedClient(sleep: (ms: number) => Promise<unknown> = realSleep) {
  const message = new Set<(m: DeskMessage) => void>();
  const connect = new Set<() => void>();
  const disconnect = new Set<() => void>();
  const on =
    <H,>(set: Set<H>) =>
    (h: H) => {
      set.add(h);
      return () => {
        set.delete(h);
      };
    };
  const client: DeskMqttClient = {
    connect: async () => {
      for (const h of connect) h();
    },
    disconnect: async () => {},
    publish: async () => {},
    onMessage: on(message),
    onConnect: on(connect),
    onDisconnect: on(disconnect),
    onError: () => () => {},
  };
  const tick = () => sleep(40);
  return {
    factory: () => client,
    /** Deliver each message in its own flush, as a slow replay would. */
    async deliver(msgs: DeskMessage[]) {
      for (const m of msgs) {
        await act(async () => {
          for (const h of message) h(m);
          await tick();
        });
      }
    },
    async reconnect() {
      await act(async () => {
        for (const h of disconnect) h();
        await tick();
        for (const h of connect) h();
      });
    },
  };
}

// Longer than a scripted replay (five deliveries, 40 ms apart), as SETTLE_MS is for a real one.
const SETTLE = 400;
const settle = () => act(() => new Promise((r) => setTimeout(r, SETTLE + 60)));

describe("App attention (live store)", () => {
  let notification: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    notification = vi.fn();
    Object.defineProperty(notification, "permission", { value: "granted", configurable: true });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      writable: true,
      value: notification,
    });
    localStorage.setItem(
      "volley-dash:notify",
      JSON.stringify({ enabled: true, sound: false, on: ["blocked", "failed", "reaped"] }),
    );
  });
  afterEach(() => {
    (globalThis as { Notification?: unknown }).Notification = undefined;
    localStorage.clear();
  });

  const mount = (c: ReturnType<typeof scriptedClient>) =>
    render(
      <DeskStoreProvider
        demo={false}
        brokerUrl="ws://test.invalid"
        clientFactory={c.factory}
        settleMs={SETTLE}
      >
        <App />
      </DeskStoreProvider>,
    );

  it("stays quiet through a reconnect resync and replay, then notifies once per wave", async () => {
    const c = scriptedClient();
    mount(c);
    await c.deliver(retained());
    await settle();
    // impl-1 waits for input while its coordinator works (coordinator tier); then
    // the coordinator asks the owner something: the wave moves to you, live.
    await c.deliver([
      msg("volley/default/impl-1/progress", env("impl-1", "progress", "awaiting_input"), false),
      msg(
        "volley/default/coord-1/progress",
        env("coord-1", "progress", "awaiting_input", { question: "Merge T1?" }),
        false,
      ),
    ]);
    expect(screen.getByRole("region", { name: "w1" })).toHaveClass("win--attn-you");
    expect(notification).toHaveBeenCalledTimes(1);
    notification.mockClear();

    // Reconnect: resync drops the waves and coordinators, the replay rebuilds
    // them one topic at a time, wave state last.
    await c.reconnect();
    await c.deliver(retained());
    await settle();
    expect(notification).not.toHaveBeenCalled();

    // A real transition after settling still notifies: the coordinator answers
    // nothing and exits, so the wave and impl-1 both need you, one notification.
    await c.deliver([
      msg("volley/default/coord-1/progress", env("coord-1", "progress", "resumed"), false),
    ]);
    await c.deliver([
      msg("volley/default/coord-1/status", env("coord-1", "status", "done"), false),
    ]);
    await waitFor(() => expect(notification).toHaveBeenCalledTimes(1));
    expect(notification).toHaveBeenCalledWith(
      "Volley: w1 needs you",
      expect.objectContaining({ tag: "wave:w1" }),
    );
  });

  it("shows no banner and no claim for a finished wave whose coordinator is done", async () => {
    const c = scriptedClient();
    const { container } = mount(c);
    await c.deliver(retained("done", "complete"));
    await settle();
    const w1 = screen.getByRole("region", { name: "w1" });
    expect(w1.querySelector(".needs-you")).toBeNull();
    expect(w1).not.toHaveClass("win--attn-you");
    expect(container.querySelector(".topbar .ny-pill")).toBeNull();
    const coords = screen.getByRole("region", { name: "Wave coordinators" });
    expect(within(coords).getByText("Complete")).toBeInTheDocument();
    expect(within(coords).queryByText(/claim it/)).toBeNull();
  });
});

// ------------------------------------------------------------ live auto-arrange

// The replay's pacing, the settle window and the arrange/animation timeouts all race on the
// clock: under fake timers each step happens at its scripted time however loaded the machine is.
describe("App auto-arrange (live store)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const wait = (ms: number) => act(() => advance(ms));
  const settle = () => wait(SETTLE + 60);
  const mount = (c: ReturnType<typeof scriptedClient>) =>
    render(
      <DeskStoreProvider
        demo={false}
        brokerUrl="ws://test.invalid"
        clientFactory={c.factory}
        settleMs={SETTLE}
      >
        <App />
      </DeskStoreProvider>,
    );
  const at = (name: string) => {
    const el = screen.getByRole("region", { name });
    return { left: el.style.left, top: el.style.top };
  };

  it("a reconnect resync and replay of the same windows keeps drags and the view", async () => {
    const c = scriptedClient(advance);
    const { container } = mount(c);
    const world = () => container.querySelector(".world") as HTMLElement;
    await c.deliver(retained());
    await settle();
    await wait(ARRANGE_ANIM_MS);
    expect(world()).not.toHaveClass("world--anim");
    const bar = screen.getByRole("region", { name: "w1" }).querySelector(".win-bar") as Element;
    fireEvent.pointerDown(bar, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(bar, { clientX: 300, clientY: 260 });
    fireEvent.pointerUp(bar);
    const dragged = at("w1");
    const view = world().style.transform;

    await c.reconnect();
    await c.deliver(retained());
    await settle();
    await wait(300);
    expect(world()).not.toHaveClass("world--anim");
    expect(at("w1")).toEqual(dragged);
    expect(world().style.transform).toBe(view);
  });

  it("a window that does not come back after a reconnect re-arranges once settled", async () => {
    const c = scriptedClient(advance);
    const { container } = mount(c);
    const world = () => container.querySelector(".world") as HTMLElement;
    await c.deliver(retained());
    await settle();
    await wait(ARRANGE_ANIM_MS);
    const bar = screen.getByRole("region", { name: "w1" }).querySelector(".win-bar") as Element;
    fireEvent.pointerDown(bar, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(bar, { clientX: 300, clientY: 260 });
    fireEvent.pointerUp(bar);
    const dragged = at("w1");

    // impl-1's registry entry is gone: the prune after settling removes its window
    await c.reconnect();
    await c.deliver(retained().filter((m) => !m.topic.endsWith("/impl-1")));
    await settle();
    await wait(130);
    expect(world()).toHaveClass("world--anim");
    expect(at("w1")).not.toEqual(dragged);
  });
});

describe("App tethers (live store, D10)", () => {
  it("a live progress envelope for an agent sends one pulse along that agent's tether", async () => {
    localStorage.clear();
    const broker = scriptedClient();
    const { container } = render(
      <DeskStoreProvider
        demo={false}
        brokerUrl="ws://test.invalid"
        clientFactory={broker.factory}
        settleMs={SETTLE}
      >
        <App />
      </DeskStoreProvider>,
    );
    await broker.deliver(retained());
    await settle();
    const tether = () => container.querySelector('.world g.tether[data-agent="impl-1"]');
    const pulses = () => [...container.querySelectorAll(".world path.tether-pulse")];
    expect(tether()).not.toBeNull();
    expect(pulses()).toHaveLength(0);
    await broker.deliver([
      msg(
        "volley/default/impl-1/progress",
        env("impl-1", "progress", "narration", { progress: 40, msg: "writing tests" }),
        false,
      ),
    ]);
    expect(pulses()).toHaveLength(1);
    expect(pulses()[0]?.getAttribute("data-agent")).toBe("impl-1");
  });

  it("dragging an agent window by its title bar sways its tether; arranging sways none", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        <DeskStoreProvider demo>
          <App />
        </DeskStoreProvider>,
      );
      const sways = () => container.querySelectorAll(".world g.tether[data-sway]");
      const win = [...container.querySelectorAll<HTMLElement>(".world .win")].find((w) =>
        w.querySelector(".gooey-tabs"),
      ) as HTMLElement;
      const bar = win.querySelector(".win-bar") as HTMLElement;
      fireEvent.pointerDown(bar, { clientX: 100, clientY: 100, pointerId: 1 });
      fireEvent.pointerMove(bar, { clientX: 260, clientY: 220, pointerId: 1 });
      fireEvent.pointerUp(bar, { pointerId: 1 });
      const dragged = win.style.left;
      expect(sways()).toHaveLength(1);
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(sways()).toHaveLength(0);
      // `f` arranges and fits: the dragged window moves, and no cable sways.
      fireEvent.keyDown(screen.getByRole("region", { name: /Desk canvas/ }), { key: "f" });
      expect(win.style.left).not.toBe(dragged);
      expect(sways()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
