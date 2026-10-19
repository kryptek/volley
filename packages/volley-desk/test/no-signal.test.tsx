import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import {
  type AttentionCtx,
  DEFAULT_NO_SIGNAL_AFTER_S,
  NO_SIGNAL_LABEL,
  agentAttention,
  noSignalFor,
} from "../src/attention";
import { DeskStoreProvider } from "../src/store/context";
import type { DeskMqttClient } from "../src/store/mqtt-client";
import { UNASSIGNED, initialState, reduceAll } from "../src/store/reducer";
import type {
  AgentView,
  ConfigPayload,
  DeskMessage,
  Envelope,
  WaveStatePayload,
  WaveView,
} from "../src/store/types";
import { AgentWindow, NO_SIGNAL_GREY } from "../src/windows/agent/AgentWindow";
import { Terminal } from "../src/windows/agent/Terminal";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const S = 1000;

function env(agent: string, channel: string, type: string, payload: unknown, at: number): Envelope {
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

const registry = (id: string, at: number): DeskMessage => ({
  topic: `volley/_system/registry/${id}`,
  envelope: env(
    id,
    "_system/registry",
    "registered",
    {
      capabilities: ["implements-issue"],
      cwd: "/work/repo",
      started_at: new Date(at).toISOString(),
    },
    at,
  ),
  receivedAt: at,
});
const status = (id: string, type: string, at: number): DeskMessage => ({
  topic: `volley/default/${id}/status`,
  envelope: env(id, "status", type, {}, at),
  receivedAt: at,
});
const progress = (id: string, type: string, at: number, payload: unknown = {}): DeskMessage => ({
  topic: `volley/default/${id}/progress`,
  envelope: env(id, "progress", type, payload, at),
  receivedAt: at,
});

function wave(over: Partial<WaveStatePayload> = {}): WaveView {
  const state: WaveStatePayload = {
    wave: "w1",
    version: 1,
    owner: "coord-1",
    repo: "example-org/example-repo",
    release_branch: "release/w1",
    status: "running",
    tasks: [
      { id: "T1", issue: 1, stage: "implement", agents: { implementer: "impl-1" } },
      { id: "T2", issue: 2, stage: "spec_review", agents: { spec_reviewer: "rev-1" } },
    ],
    open_decisions: [],
    gates: [],
    updated_at: new Date(NOW).toISOString(),
    ...over,
  };
  return { id: "w1", state, decisions: {}, receivedAt: NOW };
}

function agentFrom(id: string, msgs: DeskMessage[], w?: WaveView): AgentView {
  const waveMsg: DeskMessage[] = w
    ? [
        {
          topic: "volley/_waves/w1/state",
          envelope: env("volleyd", "_waves/state", "wave_state", w.state, NOW),
          receivedAt: NOW,
        },
      ]
    : [];
  const a = reduceAll(initialState(), [...waveMsg, ...msgs]).agents[id];
  if (!a) throw new Error(`no agent ${id}`);
  return a;
}

const ctx = (over: Partial<AttentionCtx> = {}): AttentionCtx => ({ now: NOW, ...over });

describe("no-signal state", () => {
  it("registry present, no status: no signal, tier info", () => {
    const a = agentFrom("loner", [registry("loner", NOW - 5 * S)]);
    expect(a.wave).toBe(UNASSIGNED);
    expect(noSignalFor(a, undefined, ctx())).toMatchObject({ label: NO_SIGNAL_LABEL });
    expect(agentAttention(a, undefined, ctx())).toEqual({ tier: "info", reason: NO_SIGNAL_LABEL });
  });

  it(`working but silent for more than ${DEFAULT_NO_SIGNAL_AFTER_S} s: no signal; a heartbeat clears it`, () => {
    const msgs = [registry("loner", NOW - 200 * S), status("loner", "working", NOW - 121 * S)];
    expect(DEFAULT_NO_SIGNAL_AFTER_S).toBe(120);
    expect(noSignalFor(agentFrom("loner", msgs), undefined, ctx())).not.toBeNull();
    const fresh = agentFrom("loner", [
      ...msgs.slice(0, 1),
      status("loner", "working", NOW - 119 * S),
    ]);
    expect(noSignalFor(fresh, undefined, ctx())).toBeNull();
    const beat = agentFrom("loner", [...msgs, progress("loner", "heartbeat", NOW - 3 * S)]);
    expect(noSignalFor(beat, undefined, ctx())).toBeNull();
    const narr = agentFrom("loner", [
      ...msgs,
      progress("loner", "narration", NOW - 3 * S, { msg: "x" }),
    ]);
    expect(noSignalFor(narr, undefined, ctx())).toBeNull();
  });

  it("counts only connected time, and reads no_signal_after_s from the config", () => {
    const a = agentFrom("loner", [
      registry("loner", NOW - 300 * S),
      status("loner", "working", NOW - 150 * S),
    ]);
    expect(
      noSignalFor(a, undefined, ctx({ offline: [{ from: NOW - 60 * S, to: null }] })),
    ).toBeNull();
    const config = {
      version: 1,
      updated_at: "",
      updated_by: "",
      no_signal_after_s: 600,
    } as ConfigPayload;
    expect(noSignalFor(a, undefined, ctx({ config }))).toBeNull();
    const w = wave({ effective_config: { no_signal_after_s: 30 } });
    const b = agentFrom("loner", [
      registry("loner", NOW - 300 * S),
      status("loner", "working", NOW - 60 * S),
    ]);
    expect(noSignalFor(b, w, ctx())).not.toBeNull();
  });

  it("is never shown for a finished, blocked, waiting or idle agent", () => {
    const base = [registry("loner", NOW - 900 * S)];
    for (const type of ["done", "failed", "reaped"]) {
      expect(
        noSignalFor(
          agentFrom("loner", [...base, status("loner", type, NOW - 900 * S)]),
          undefined,
          ctx(),
        ),
      ).toBeNull();
    }
    const blocked = agentFrom("loner", [...base, status("loner", "blocked", NOW - 900 * S)]);
    expect(noSignalFor(blocked, undefined, ctx())).toBeNull();
    expect(agentAttention(blocked, undefined, ctx()).tier).toBe("you");
    const waiting = agentFrom("loner", [
      ...base,
      status("loner", "working", NOW - 900 * S),
      progress("loner", "awaiting_input", NOW - 800 * S, { text: "Allow?" }),
    ]);
    expect(noSignalFor(waiting, undefined, ctx())).toBeNull();
    const idle = agentFrom("loner", [
      ...base,
      status("loner", "working", NOW - 900 * S),
      progress("loner", "idle", NOW - 800 * S, { text: "Done for now" }),
    ]);
    expect(noSignalFor(idle, undefined, ctx())).toBeNull();
  });

  it("coordinator tier for an implementer in `implement` under a live coordinator; info otherwise", () => {
    const w = wave();
    const coordinators = { "coord-1": { id: "coord-1", waves: ["w1"], state: "working" as const } };
    const c = ctx({ coordinators });
    const impl = agentFrom("impl-1", [registry("impl-1", NOW - 5 * S)], w);
    expect(impl.role).toBe("implementer");
    expect(agentAttention(impl, w, c)).toEqual({ tier: "coordinator", reason: NO_SIGNAL_LABEL });
    const rev = agentFrom("rev-1", [registry("rev-1", NOW - 5 * S)], w);
    expect(agentAttention(rev, w, c).tier).toBe("info");
    // No live coordinator: nobody's job yet.
    expect(agentAttention(impl, w, ctx()).tier).toBe("info");
  });

  it("a coordinator-tier no-signal item escalates to you after escalate_after_min", () => {
    const w = wave();
    const coordinators = { "coord-1": { id: "coord-1", waves: ["w1"], state: "working" as const } };
    // Silent since NOW - 121 s: the silence began at NOW - 1 s (120 s after the last status).
    const impl = agentFrom(
      "impl-1",
      [registry("impl-1", NOW - 200 * S), status("impl-1", "working", NOW - 121 * S)],
      w,
    );
    const at = (now: number) => agentAttention(impl, w, ctx({ now, coordinators }));
    expect(at(NOW).tier).toBe("coordinator");
    expect(at(NOW + 14 * 60 * S).tier).toBe("coordinator");
    expect(at(NOW + 15 * 60 * S)).toEqual({
      tier: "you",
      reason: `${NO_SIGNAL_LABEL} · unresolved for 15 min`,
    });
    // Never any signal: the silence began at its registration.
    const mute = agentFrom("impl-1", [registry("impl-1", NOW - 5 * S)], w);
    expect(
      agentAttention(mute, w, ctx({ now: NOW + 15 * 60 * S - 5 * S, coordinators })).tier,
    ).toBe("you");
  });

  it("times a live status by its receipt, not the sender's (skewed) clock", () => {
    // The sender's clock runs 5 min behind: wall_time says NOW - 300 s, it arrived at NOW - 5 s.
    const skewed: DeskMessage = {
      topic: "volley/default/loner/status",
      envelope: env("loner", "status", "working", {}, NOW - 300 * S),
      receivedAt: NOW - 5 * S,
    };
    const a = agentFrom("loner", [registry("loner", NOW - 400 * S), skewed]);
    expect(noSignalFor(a, undefined, ctx())).toBeNull();
    // A retained replay still uses its wall_time.
    const replay = agentFrom("loner", [
      registry("loner", NOW - 400 * S),
      { ...skewed, retained: true },
    ]);
    expect(noSignalFor(replay, undefined, ctx())).not.toBeNull();
  });

  it("passes the wave state's why_waiting through as the reason", () => {
    const why = "MCP server connected to another broker";
    const w = wave({
      tasks: [
        {
          id: "T1",
          issue: 1,
          stage: "implement",
          agents: { implementer: "impl-1" },
          why_waiting: why,
        },
      ],
    });
    const impl = agentFrom("impl-1", [registry("impl-1", NOW - 5 * S)], w);
    expect(noSignalFor(impl, w, ctx())).toMatchObject({ label: NO_SIGNAL_LABEL, reason: why });
    expect(agentAttention(impl, w, ctx()).reason).toBe(why);
  });
});

describe("AgentWindow no-signal glyph and label", () => {
  const frame = {
    pos: { x: 0, y: 0 },
    z: 1,
    scale: 1,
    chrome: "glass" as const,
    onMove: () => {},
    onFocus: () => {},
  };

  it("greys the status glyph and shows the label with a tooltip naming the agent's cwd", () => {
    const a = agentFrom("loner", [registry("loner", NOW - 5 * S)]);
    const ns = noSignalFor(a, undefined, ctx());
    if (!ns) throw new Error("expected no signal");
    const { container } = render(
      <AgentWindow
        agent={a}
        wave={undefined}
        accent="#fff"
        frame={frame}
        now={NOW}
        noSignal={ns}
      />,
    );
    const label = screen.getByText(NO_SIGNAL_LABEL);
    expect(label.closest(".a-nosignal")).toHaveAttribute(
      "title",
      expect.stringContaining("/work/repo"),
    );
    const mark = container.querySelector<HTMLElement>(".sm-nosignal");
    expect(mark?.style.getPropertyValue("--sm-color")).toBe(NO_SIGNAL_GREY);
  });

  it("the Terminal's empty state says there is no signal", () => {
    const { rerender } = render(<Terminal screen={null} stale={false} noSignal />);
    expect(screen.getByText(/no screen yet/)).toHaveTextContent(/no signal/);
    rerender(<Terminal screen={null} stale={false} />);
    expect(screen.getByText(/no screen yet/)).not.toHaveTextContent(/no signal/);
  });

  it("no label without the state", () => {
    const a = agentFrom("loner", [registry("loner", NOW - 5 * S), status("loner", "working", NOW)]);
    const { container } = render(
      <AgentWindow agent={a} wave={undefined} accent="#fff" frame={frame} now={NOW} />,
    );
    expect(screen.queryByText(NO_SIGNAL_LABEL)).toBeNull();
    expect(container.querySelector(".sm-nosignal")).toBeNull();
  });
});

describe("App no-signal (fake timers)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an agent silent for 121 s shows no signal; a heartbeat clears it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const handlers = new Set<(m: DeskMessage) => void>();
    const emit = (m: DeskMessage) => {
      for (const h of handlers) h(m);
    };
    const factory = (): DeskMqttClient => {
      const none = () => () => {};
      return {
        connect: async () => {
          setTimeout(() => {
            emit(registry("loner", NOW));
            emit(status("loner", "working", NOW));
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
    render(
      <DeskStoreProvider demo={false} brokerUrl="ws://test.invalid" clientFactory={factory}>
        <App />
      </DeskStoreProvider>,
    );
    act(() => {
      vi.advanceTimersByTime(10 * S);
    });
    expect(screen.getByRole("region", { name: "loner" })).toBeInTheDocument();
    expect(screen.queryByText(NO_SIGNAL_LABEL)).toBeNull();
    // 121 s of silence, plus one attention tick (App re-evaluates time-based attention every 15 s).
    act(() => {
      vi.advanceTimersByTime(121 * S + 15 * S);
    });
    expect(screen.getByText(NO_SIGNAL_LABEL)).toBeInTheDocument();
    act(() => {
      emit(progress("loner", "heartbeat", Date.now()));
      vi.advanceTimersByTime(100); // the store coalesces deliveries
    });
    expect(screen.queryByText(NO_SIGNAL_LABEL)).toBeNull();
  });
});
