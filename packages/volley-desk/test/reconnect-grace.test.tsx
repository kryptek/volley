import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { SYNCING_LABEL } from "../src/attention";
import {
  DeskStoreProvider,
  NARRATION_STORAGE_PREFIX,
  graceMsFor,
  storeReducer,
} from "../src/store/context";
import { initialState } from "../src/store/reducer";
import type { ConfigPayload, DeskMessage, DeskState } from "../src/store/types";
import { NOW, S, fakeClient, progress, registry, status } from "./helpers/desk-msgs";

const ID = "impl-1";
const NAME = ID; // an unassigned agent's window is named by its id

const apply = (s: DeskState, ...msgs: DeskMessage[]) => storeReducer(s, { type: "apply", msgs });

function setVisibility(v: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  setVisibility("visible");
});

function mount() {
  const f = fakeClient();
  const view = render(
    <DeskStoreProvider demo={false} brokerUrl="ws://test.invalid" clientFactory={() => f.client}>
      <App />
    </DeskStoreProvider>,
  );
  return { f, ...view };
}

describe("grace window", () => {
  it("is 2 × the heartbeat interval: 30 s by default, from the retained config when it has one", () => {
    expect(graceMsFor(null)).toBe(30 * S);
    expect(graceMsFor({ heartbeat_interval_s: 20 } as unknown as ConfigPayload)).toBe(40 * S);
  });

  it("after a connect the agent shows 'syncing…' and no quiet / no-signal judgement until the grace ends", () => {
    const { f, container } = mount();
    act(() => {
      f.up();
      // A cold load's retained replay: the status is ten minutes old.
      f.emit(registry(ID, NOW - 900 * S, true));
      f.emit(status(ID, "working", NOW - 600 * S, {}, true));
      vi.advanceTimersByTime(100);
    });
    const win = () => screen.getByRole("region", { name: NAME });
    expect(within(win()).getByText(SYNCING_LABEL)).toBeInTheDocument();
    expect(win()).not.toHaveTextContent(/quiet for|no signal/);
    expect(container.querySelector(".topbar .proto")).toHaveTextContent(SYNCING_LABEL);
    act(() => {
      vi.advanceTimersByTime(25 * S);
    });
    expect(win()).not.toHaveTextContent(/quiet for|no signal/);
    // Grace over (30 s) plus one attention tick: nothing came, so now it is judged.
    act(() => {
      vi.advanceTimersByTime(20 * S);
    });
    expect(within(win()).queryByText(SYNCING_LABEL)).toBeNull();
    expect(win()).toHaveTextContent(/quiet for \d+m/);
    expect(container.querySelector(".topbar .proto")).not.toHaveTextContent(SYNCING_LABEL);
  });

  it("visibilitychange → visible probes the broker and starts a new grace window", () => {
    const { f } = mount();
    act(() => {
      f.up();
      f.emit(registry(ID, NOW - 900 * S, true));
      f.emit(status(ID, "working", NOW - 600 * S, {}, true));
      vi.advanceTimersByTime(60 * S);
    });
    expect(screen.getByRole("region", { name: NAME })).toHaveTextContent(/quiet for/);
    act(() => {
      setVisibility("hidden");
      vi.advanceTimersByTime(10 * S);
    });
    expect(f.probes).toBe(0);
    act(() => {
      setVisibility("visible");
      vi.advanceTimersByTime(100);
    });
    expect(f.probes).toBe(1);
    expect(
      within(screen.getByRole("region", { name: NAME })).getByText(SYNCING_LABEL),
    ).toBeInTheDocument();
  });
});

describe("reconnect keeps what the Desk already had", () => {
  it("feed rows and narration survive a resync and the retained replay, with no duplicates", () => {
    const reg = registry(ID, NOW - 900 * S, true);
    const st = status(ID, "working", NOW - 600 * S, { seq: 4 }, true);
    let s = apply(
      initialState(),
      reg,
      st,
      progress(ID, "narration", NOW - 30 * S, { msg: "writing the RED test", seq: 5 }),
    );
    const before = s.agents[ID]?.feed.length;
    s = storeReducer(s, { type: "resync" });
    s = apply(s, reg, st);
    s = storeReducer(s, { type: "prune" });
    const a = s.agents[ID];
    expect(a?.feed).toHaveLength(before ?? -1);
    expect(a?.narration).toBe("writing the RED test");
    expect(a?.status?.type).toBe("working");
  });

  it("dedupes a replay by (topic, wall_time, seq): a different seq at the same time is news", () => {
    const st = status(ID, "working", NOW - 600 * S, { seq: 4 }, true);
    let s = apply(initialState(), registry(ID, NOW - 900 * S, true), st);
    s = apply(s, st);
    expect(s.agents[ID]?.feed.filter((e) => e.envelope.channel === "status")).toHaveLength(1);
    s = apply(s, status(ID, "working", NOW - 600 * S, { seq: 5 }, true));
    expect(s.agents[ID]?.feed.filter((e) => e.envelope.channel === "status")).toHaveLength(2);
  });
});

describe("narration persistence", () => {
  it("saves each agent's last narration and restores it on a cold load, marked 'as of HH:MM'", () => {
    const first = mount();
    act(() => {
      first.f.up();
      first.f.emit(registry(ID, NOW - 900 * S, true));
      first.f.emit(progress(ID, "narration", NOW - 60 * S, { msg: "running the gates" }));
      vi.advanceTimersByTime(100);
    });
    const saved = JSON.parse(sessionStorage.getItem(`${NARRATION_STORAGE_PREFIX}${ID}`) ?? "null");
    expect(saved).toMatchObject({ text: "running the gates" });
    first.unmount();

    // Cold load: only retained topics come back.
    const second = mount();
    act(() => {
      second.f.up();
      second.f.emit(registry(ID, NOW - 900 * S, true));
      second.f.emit(status(ID, "working", NOW - 600 * S, {}, true));
      vi.advanceTimersByTime(100);
    });
    const win = screen.getByRole("region", { name: NAME });
    expect(win.querySelector(".narr")).toHaveTextContent("running the gates");
    const hhmm = new Date(NOW - 60 * S).toTimeString().slice(0, 5);
    expect(within(win).getByText(`as of ${hhmm}`)).toHaveClass("narr-asof");

    // A live narration replaces it, unmarked.
    act(() => {
      second.f.emit(progress(ID, "narration", Date.now(), { msg: "gates green" }));
      vi.advanceTimersByTime(100);
    });
    expect(win.querySelector(".narr")).toHaveTextContent("gates green");
    expect(win.querySelector(".narr-asof")).toBeNull();
  });
});
