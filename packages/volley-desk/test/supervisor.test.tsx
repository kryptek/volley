import { readFileSync } from "node:fs";
import path from "node:path";
import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { DeskStoreProvider } from "../src/store/context";
import type { DeskMqttClient } from "../src/store/mqtt-client";
import {
  agentsByWave,
  initialState,
  isSupervisorId,
  pruneUnconfirmed,
  reduceAll,
  resync,
  supervisorHealth,
  supervisorNamespace,
} from "../src/store/reducer";
import type { DeskMessage, DeskState, Envelope, WaveView } from "../src/store/types";
import { TopBar, type TopBarProps } from "../src/topbar/TopBar";
import {
  CoordinatorsWindow,
  type CoordinatorsWindowProps,
} from "../src/windows/coordinators/CoordinatorsWindow";

const T0 = Date.parse("2026-10-18T12:00:00.000Z");

function env(agent: string, channel: string, type: string, payload: unknown, at = T0): Envelope {
  return {
    schema_version: "0.1",
    agent_id: agent,
    channel,
    type,
    wall_time: new Date(at).toISOString(),
    namespace: "default",
    payload,
  };
}

const registry = (id: string, capabilities: string[], at = T0): DeskMessage => ({
  topic: `volley/_system/registry/${id}`,
  envelope: env(id, "_system/registry", "registered", {
    capabilities,
    cwd: "/srv/volleyd",
    started_at: new Date(at).toISOString(),
  }),
  receivedAt: at,
});

const status = (id: string, type: string, at = T0, payload: unknown = {}): DeskMessage => ({
  topic: `volley/default/${id}/status`,
  envelope: env(id, "status", type, payload, at),
  receivedAt: at,
});

const controlQuery = (to: string, op: string, at = T0): DeskMessage => ({
  topic: `volley/default/${to}/mailbox`,
  envelope: {
    ...env("volleyd-cli-ab12cd", "mailbox", "query", { op, text: `volleyd ${op}` }, at),
    correlation_id: `c-${op}-${at}`,
  },
  receivedAt: at,
});

/** The same delivery from volleyd running in namespace `ops`. */
const ops = (m: DeskMessage): DeskMessage => ({
  ...m,
  topic: m.topic.replace("volley/default/", "volley/ops/"),
  envelope: m.envelope && { ...m.envelope, namespace: "ops" },
});

describe("supervisors slice", () => {
  it("a registry entry with capability `supervisor` is a supervisor, not an agent", () => {
    const s = reduceAll(initialState(), [
      registry("sup-main", ["supervisor"]),
      status("sup-main", "working", T0 + 1000, { waves: 2 }),
    ]);
    expect(s.agents["sup-main"]).toBeUndefined();
    expect(s.supervisors["sup-main"]).toMatchObject({
      id: "sup-main",
      status: "working",
      lastHeartbeat: T0 + 1000,
      wavesOwned: 2,
    });
    expect(Object.values(agentsByWave(s)).flat()).toEqual([]);
  });

  it("an id matching ^volleyd(-|$) is a supervisor whatever its capabilities", () => {
    for (const id of ["volleyd", "volleyd-abcd"]) {
      expect(isSupervisorId(id)).toBe(true);
      const s = reduceAll(initialState(), [registry(id, []), status(id, "working")]);
      expect(s.agents[id]).toBeUndefined();
      expect(s.supervisors[id]?.status).toBe("working");
    }
    expect(isSupervisorId("volleydx")).toBe(false);
    expect(isSupervisorId("my-volleyd")).toBe(false);
  });

  it("a supervisor whose status came before its registry entry leaves the agents", () => {
    const s = reduceAll(initialState(), [
      status("sup-main", "working", T0),
      registry("sup-main", ["supervisor"], T0 + 500),
    ]);
    expect(s.agents["sup-main"]).toBeUndefined();
    expect(s.supervisors["sup-main"]).toMatchObject({
      status: "working",
      lastHeartbeat: T0 + 500,
    });
  });

  it("control queries to the supervisor create no window and no feed", () => {
    const s = reduceAll(initialState(), [
      registry("volleyd", ["supervisor"]),
      status("volleyd", "working"),
      controlQuery("volleyd", "status"),
      controlQuery("volleyd", "run"),
    ]);
    expect(Object.keys(s.agents)).toEqual([]);
    // A control client's mailbox (the reply) is not an agent either.
    const reply: DeskMessage = {
      topic: "volley/default/volleyd-cli-ab12cd/mailbox",
      envelope: {
        ...env("volleyd", "mailbox", "ack", { acked_type: "query", op: "status", ok: true }),
        correlation_id: "c-status",
      },
      receivedAt: T0,
    };
    expect(Object.keys(reduceAll(s, [reply]).agents)).toEqual([]);
  });

  it("a cleared registry entry removes the supervisor; resync forgets it until the replay", () => {
    const s = reduceAll(initialState(), [
      registry("volleyd", ["supervisor"]),
      status("volleyd", "working"),
    ]);
    const cleared = reduceAll(s, [
      { topic: "volley/_system/registry/volleyd", envelope: null, receivedAt: T0 },
    ]);
    expect(cleared.supervisors.volleyd).toBeUndefined();
  });

  it("volleyd's namespace comes from its registry: config_set and steering go there", () => {
    const s = reduceAll(initialState(), [ops(registry("volleyd", ["supervisor"]))]);
    expect(supervisorNamespace(s)).toBe("ops");
    expect(supervisorNamespace(initialState())).toBe("default");
  });

  it("resync keeps a supervisor's namespace until the replay; one not replayed is pruned", () => {
    const s = reduceAll(initialState(), [
      ops(registry("volleyd", ["supervisor"])),
      ops(registry("sup-old", ["supervisor"])),
      ops(status("volleyd", "working")),
    ]);
    const r = resync(s);
    expect(r.supervisors.volleyd).toMatchObject({
      namespace: "ops",
      status: null,
      registry: null,
      lastHeartbeat: T0,
    });
    expect(supervisorNamespace(r)).toBe("ops");
    expect(r.unconfirmed).toEqual(expect.arrayContaining(["volleyd", "sup-old"]));
    const replayed = reduceAll(r, [
      { ...ops(registry("volleyd", ["supervisor"])), retained: true },
      { ...ops(status("volleyd", "working")), retained: true },
    ]);
    const settled = pruneUnconfirmed(replayed);
    expect(settled.supervisors.volleyd?.status).toBe("working");
    expect(settled.supervisors["sup-old"]).toBeUndefined();
    expect(settled.unconfirmed).toBeUndefined();
  });

  it("health: live statuses are up; reaped, done and no status are down", () => {
    const at = (type: string | null) => ({
      id: "volleyd",
      namespace: "default",
      registry: null,
      status: type,
      lastHeartbeat: T0,
      wavesOwned: null,
    });
    expect(supervisorHealth(at("working"))).toEqual({ down: false, label: "working", since: T0 });
    expect(supervisorHealth(at("registered")).down).toBe(false);
    expect(supervisorHealth(at("reaped")).down).toBe(true);
    expect(supervisorHealth(at("done")).down).toBe(true);
    expect(supervisorHealth(at(null))).toMatchObject({ down: true, label: "no status" });
    expect(supervisorHealth(undefined)).toEqual({ down: true, label: "absent", since: null });
  });
});

function topBar(state: DeskState, over: Partial<TopBarProps> = {}) {
  const props: TopBarProps = {
    state,
    connection: "connected",
    demo: false,
    needsYou: 0,
    onNeedsYou: () => {},
    coordsOpen: true,
    onToggleCoords: () => {},
    notify: { enabled: false, sound: false, on: [] },
    setNotify: () => {},
    now: T0 + 4000,
    ...over,
  };
  return render(<TopBar {...props} />);
}

describe("top-bar supervisor pill", () => {
  it("shows the supervisor with its status and heartbeat age", () => {
    const s = reduceAll(initialState(), [
      registry("volleyd", ["supervisor"]),
      status("volleyd", "working"),
    ]);
    topBar(s);
    const pill = screen.getByRole("status", { name: /supervisor/i });
    expect(pill).toHaveTextContent("volleyd · working · 4s");
    expect(pill).not.toHaveClass("sup-pill--down");
  });

  it("at phone width the pill is its dot alone; the text stays in its label", () => {
    const s = reduceAll(initialState(), [
      registry("volleyd", ["supervisor"]),
      status("volleyd", "working"),
    ]);
    topBar(s, { compact: true });
    const pill = screen.getByRole("status", { name: "Supervisor volleyd · working · 4s" });
    expect(pill.textContent?.trim()).toBe("");
    expect(pill).toHaveAttribute("title", expect.stringContaining("volleyd · working · 4s"));
  });

  it("a reaped supervisor renders red", () => {
    const s = reduceAll(initialState(), [
      registry("volleyd-abcd", []),
      status("volleyd-abcd", "reaped", T0, { reason: "disconnect" }),
    ]);
    topBar(s);
    const pill = screen.getByRole("status", { name: /supervisor/i });
    expect(pill).toHaveTextContent("volleyd-abcd · reaped");
    expect(pill).toHaveClass("sup-pill--down");
  });

  it("with waves but no supervisor it says volleyd is absent (never in demo mode)", () => {
    const wave = JSON.parse(
      readFileSync(
        path.resolve(__dirname, "../../../spec/examples/valid/wave-state-running.json"),
        "utf8",
      ),
    ) as Envelope;
    const s = reduceAll(initialState(), [
      { topic: "volley/_waves/w1/state", envelope: wave, receivedAt: T0 },
    ]);
    const { unmount } = topBar(s);
    const pill = screen.getByRole("status", { name: /supervisor/i });
    expect(pill).toHaveTextContent("volleyd · absent");
    expect(pill).toHaveClass("sup-pill--down");
    unmount();
    topBar(s, { demo: true });
    expect(screen.queryByRole("status", { name: /supervisor/i })).toBeNull();
  });
});

describe("coordinators window supervisor row", () => {
  const wave: WaveView = {
    id: "w1",
    state: {
      wave: "w1",
      version: 1,
      owner: "coord-1",
      repo: "example-org/example-repo",
      release_branch: "release/w1",
      status: "running",
      tasks: [],
      open_decisions: [],
      gates: [],
      updated_at: new Date(T0).toISOString(),
    },
    decisions: {},
    receivedAt: T0,
  };
  const props = (over: Partial<CoordinatorsWindowProps>): CoordinatorsWindowProps => ({
    waves: [wave],
    coordinators: { w1: { id: "coord-1", state: "working" } },
    needsYou: 0,
    me: null,
    hidden: new Set(),
    frame: {
      pos: { x: 0, y: 0 },
      z: 1,
      scale: 1,
      chrome: "glass",
      onMove: () => {},
      onFocus: () => {},
    },
    onToggle: vi.fn(),
    onGoTo: vi.fn(),
    onClose: vi.fn(),
    now: T0 + 4000,
    ...over,
  });

  it("the first row is the supervisor with the same health", () => {
    const s = reduceAll(initialState(), [
      registry("volleyd", ["supervisor"]),
      status("volleyd", "working", T0, { waves: 1 }),
    ]);
    render(<CoordinatorsWindow {...props({ supervisors: Object.values(s.supervisors) })} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveAccessibleName("Supervisor volleyd");
    expect(rows[0]).toHaveTextContent("Supervisor");
    expect(rows[0]).toHaveTextContent(/volleyd · working · 4s/);
    expect(rows[0]).not.toHaveClass("st-gone");
    expect(rows[1]).toHaveAccessibleName("w1");
  });

  it("a reaped supervisor's row is red; with none it says absent", () => {
    const s = reduceAll(initialState(), [registry("volleyd", []), status("volleyd", "reaped")]);
    const { unmount } = render(
      <CoordinatorsWindow {...props({ supervisors: Object.values(s.supervisors) })} />,
    );
    const row = screen.getByRole("listitem", { name: "Supervisor volleyd" });
    expect(row).toHaveClass("st-gone");
    unmount();
    render(<CoordinatorsWindow {...props({ supervisors: [] })} />);
    const absent = screen.getByRole("listitem", { name: "Supervisor volleyd" });
    expect(within(absent).getByText(/absent/)).toBeInTheDocument();
    expect(absent).toHaveClass("st-gone");
  });
});

describe("App with a live supervisor", () => {
  const waveEnv = JSON.parse(
    readFileSync(
      path.resolve(__dirname, "../../../spec/examples/valid/wave-state-running.json"),
      "utf8",
    ),
  ) as Envelope;

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

  it("renders no agent window for volleyd; the pill and the coordinators row show it", async () => {
    const now = Date.now();
    const factory = fakeClient([
      { topic: "volley/_waves/w1/state", envelope: waveEnv, receivedAt: now },
      registry("volleyd", ["supervisor"], now),
      status("volleyd", "working", now),
      controlQuery("volleyd", "status", now),
    ]);
    render(
      <DeskStoreProvider demo={false} brokerUrl="ws://test.invalid" clientFactory={factory}>
        <App />
      </DeskStoreProvider>,
    );
    expect(await screen.findByRole("listitem", { name: "Supervisor volleyd" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /supervisor/i })).toHaveTextContent(
      /volleyd · working/,
    );
    expect(screen.queryByRole("region", { name: "volleyd" })).toBeNull();
    expect(screen.queryByText("model unknown")).toBeNull();
  });

  it("the pill and the coordinators row tick on one clock: the same age", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const now = Date.now();
      const factory = fakeClient([
        { topic: "volley/_waves/w1/state", envelope: waveEnv, receivedAt: now },
        registry("volleyd", ["supervisor"], now),
        status("volleyd", "working", now),
      ]);
      render(
        <DeskStoreProvider demo={false} brokerUrl="ws://test.invalid" clientFactory={factory}>
          <App />
        </DeskStoreProvider>,
      );
      const row = await screen.findByRole("listitem", { name: "Supervisor volleyd" });
      await act(async () => {
        vi.advanceTimersByTime(6000);
      });
      const ageOf = (el: HTMLElement) => /working · (\d+[smh])/.exec(el.textContent ?? "")?.[1];
      const pill = screen.getByRole("status", { name: /supervisor/i });
      expect(ageOf(pill)).toMatch(/^\d+s$/);
      expect(ageOf(pill)).not.toBe("0s");
      expect(ageOf(row)).toBe(ageOf(pill));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("top-bar clock", () => {
  it("runs no timer when there is no supervisor to age", () => {
    vi.useFakeTimers();
    try {
      render(
        <TopBar
          state={initialState()}
          connection="connected"
          demo={false}
          needsYou={0}
          onNeedsYou={() => {}}
          coordsOpen
          onToggleCoords={() => {}}
          notify={{ enabled: false, sound: false, on: [] }}
          setNotify={() => {}}
        />,
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
