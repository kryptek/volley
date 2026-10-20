/** The sound manager: store changes and Desk emits through the policy to the player. */
import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../src/canvas/Frame";
import { Toggle } from "../src/settings/primitives";
import { emitSound } from "../src/sounds/emit";
import type { SoundEventId } from "../src/sounds/events";
import type { Player } from "../src/sounds/player";
import { SOUND0, type SoundSettings, mergeSound } from "../src/sounds/settings";
import { usePanelSound } from "../src/sounds/usePanelSound";
import {
  type SoundManagerInput,
  VIBRATE_PATTERN,
  useFlipSound,
  useSoundManager,
} from "../src/sounds/useSoundManager";
import { initialState } from "../src/store/reducer";
import type { AgentView, DeskState } from "../src/store/types";

function fakePlayer() {
  const played: SoundEventId[] = [];
  const p: Player & { played: SoundEventId[] } = {
    played,
    loadTheme: vi.fn(async () => {}),
    has: () => true,
    theme: () => "synthwave",
    play: vi.fn(async (id: SoundEventId) => {
      played.push(id);
    }),
    audition: vi.fn(async () => {}),
    disposeAudition: vi.fn(),
    setVolume: vi.fn(),
    unlock: vi.fn(async () => {}),
    canVibrate: () => true,
    vibrate: vi.fn(),
    dispose: vi.fn(),
  };
  return p;
}

const agent = (id: string, status: string | null): AgentView => ({
  id,
  namespace: "default",
  parentId: null,
  wave: "w1",
  task: "t1",
  role: "implementer",
  registered: true,
  registry: null,
  model: null,
  status: status ? { type: status, payload: {}, at: 0 } : null,
  progress: null,
  narration: null,
  heartbeat: null,
  lastSeen: 0,
  attention: null,
  attentionObserved: false,
  feed: [],
  screen: null,
  bornAt: 0,
});

const withAgents = (agents: AgentView[]): DeskState => {
  const s = initialState();
  for (const a of agents) s.agents[a.id] = a;
  return s;
};

let player: ReturnType<typeof fakePlayer>;

function mount(over: Partial<SoundManagerInput> = {}) {
  const props: SoundManagerInput = {
    state: initialState(),
    settling: false,
    connection: "connected",
    settings: SOUND0,
    player,
    ...over,
  };
  return renderHook((p: SoundManagerInput) => useSoundManager(p), { initialProps: props });
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
}

beforeEach(() => {
  player = fakePlayer();
  setHidden(false);
});

afterEach(() => {
  vi.useRealTimers();
  // biome-ignore lint/performance/noDelete: drop the per-test override
  delete (document as { visibilityState?: unknown }).visibilityState;
});

describe("useSoundManager", () => {
  it("derives events from each store change and plays them", () => {
    const working = withAgents([agent("a", "working")]);
    const { rerender } = mount({ state: working });
    rerender({
      state: withAgents([agent("a", "done")]),
      settling: false,
      connection: "connected",
      settings: SOUND0,
      player,
    });
    expect(player.played).toEqual(["agent_complete"]);
  });

  it("plays nothing while settling", () => {
    const { rerender } = mount({ state: withAgents([agent("a", "working")]), settling: true });
    rerender({
      state: withAgents([agent("a", "done")]),
      settling: true,
      connection: "connected",
      settings: SOUND0,
      player,
    });
    expect(player.played).toEqual([]);
  });

  it("loads the theme and sets the volume from the settings", () => {
    const { rerender } = mount();
    expect(player.loadTheme).toHaveBeenCalledWith("synthwave");
    const s = mergeSound(SOUND0, { theme: "arcade", volume: 0.3 });
    rerender({
      state: initialState(),
      settling: false,
      connection: "connected",
      settings: s,
      player,
    });
    expect(player.loadTheme).toHaveBeenLastCalledWith("arcade");
    expect(player.setVolume).toHaveBeenLastCalledWith(0.3);
  });

  it("plays what the Desk emits, through the same policy", () => {
    const { rerender } = mount();
    act(() => emitSound("ui_drag_start"));
    expect(player.played).toEqual(["ui_drag_start"]);
    const muted: SoundSettings = { ...SOUND0, muted: true };
    rerender({
      state: initialState(),
      settling: false,
      connection: "connected",
      settings: muted,
      player,
    });
    act(() => emitSound("ui_drop"));
    expect(player.played).toEqual(["ui_drag_start"]);
  });

  it("clicks for a marked control, and asks the context to start on every gesture", () => {
    mount();
    const { getByRole } = render(<Toggle on={false} onChange={() => {}} label="Thing" />);
    fireEvent.pointerDown(getByRole("switch", { name: "Thing" }));
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document.body, { key: "a" });
    expect(player.played).toEqual(["ui_click"]);
    // A refused or later-suspended context gets another try; unlock() is a no-op once running.
    expect(player.unlock).toHaveBeenCalledTimes(3);
  });

  it("a Frame drag plays drag start and drop", () => {
    mount();
    const { container } = render(
      <Frame
        id="w"
        title="wave-1"
        accent="#6ee7f9"
        pos={{ x: 0, y: 0 }}
        width={300}
        z={1}
        scale={1}
        chrome="glass"
        onMove={() => {}}
        onFocus={() => {}}
      >
        body
      </Frame>,
    );
    const bar = container.querySelector(".win-bar") as HTMLElement;
    fireEvent.pointerDown(bar, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(bar, { clientX: 12, clientY: 10 });
    expect(player.played).toEqual([]);
    fireEvent.pointerMove(bar, { clientX: 50, clientY: 10 });
    fireEvent.pointerMove(bar, { clientX: 60, clientY: 10 });
    fireEvent.pointerUp(bar, { clientX: 60, clientY: 10 });
    expect(player.played).toEqual(["ui_drag_start", "ui_drop"]);
  });

  it("a Frame tap (no drag) plays neither drag start nor drop", () => {
    mount();
    const onCollapse = vi.fn();
    const { container } = render(
      <Frame
        id="w"
        title="wave-1"
        accent="#6ee7f9"
        pos={{ x: 0, y: 0 }}
        width={300}
        z={1}
        scale={1}
        chrome="glass"
        onMove={() => {}}
        onFocus={() => {}}
        onCollapse={onCollapse}
      >
        body
      </Frame>,
    );
    const bar = container.querySelector(".win-bar") as HTMLElement;
    fireEvent.pointerDown(bar, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(bar, { clientX: 11, clientY: 10 });
    expect(onCollapse).toHaveBeenCalled();
    fireEvent.pointerDown(bar, { clientX: 10, clientY: 10 });
    fireEvent.pointerCancel(bar, { clientX: 10, clientY: 10 });
    expect(player.played).toEqual([]);
  });

  it("a panel plays open on mount and close on unmount; tethers flip on and off", () => {
    mount();
    const panel = renderHook(() => usePanelSound());
    panel.unmount();
    const flip = renderHook(({ v }) => useFlipSound(v, "tethers_on", "tethers_off", emitSound), {
      initialProps: { v: true },
    });
    flip.rerender({ v: false });
    flip.rerender({ v: true });
    expect(player.played).toEqual(["panel_open", "panel_close", "tethers_off", "tethers_on"]);
  });

  it("plays attention and vibrates when hidden (with vibrate on), not when visible on a desktop", () => {
    mount();
    act(() => emitSound("attention_needed"));
    expect(player.played).toEqual(["attention_needed"]);
    expect(player.vibrate).not.toHaveBeenCalled();
    setHidden(true);
    act(() => emitSound("attention_needed"));
    expect(player.vibrate).toHaveBeenCalledWith(VIBRATE_PATTERN);
  });

  it("does not vibrate when the setting is off", () => {
    setHidden(true);
    mount({ settings: { ...SOUND0, vibrate: false } });
    act(() => emitSound("attention_needed"));
    expect(player.played).toEqual(["attention_needed"]);
    expect(player.vibrate).not.toHaveBeenCalled();
  });

  it("announces a coalesced burst: one play, '12 agents completed'", () => {
    const before = withAgents(Array.from({ length: 12 }, (_, i) => agent(`a${i}`, "working")));
    const after = withAgents(Array.from({ length: 12 }, (_, i) => agent(`a${i}`, "done")));
    const { result, rerender } = mount({ state: before });
    rerender({ state: after, settling: false, connection: "connected", settings: SOUND0, player });
    expect(player.played).toEqual(["agent_complete"]);
    expect(result.current.announcement).toBe("12 agents completed");
  });

  it("announces repeats folded into the window when it closes", () => {
    vi.useFakeTimers();
    const { result } = mount();
    act(() => emitSound("agent_complete"));
    act(() => emitSound("agent_complete"));
    expect(player.played).toEqual(["agent_complete"]);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current.announcement).toBe("2 agents completed");
  });

  it("disposes the player on unmount", () => {
    const { unmount } = mount();
    unmount();
    expect(player.dispose).toHaveBeenCalled();
  });
});
