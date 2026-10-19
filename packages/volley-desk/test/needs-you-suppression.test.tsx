import { act, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { IDLE_WAIT_REASON, ctxFrom, needsYouTargets, waveAttention } from "../src/attention";
import { DeskStoreProvider } from "../src/store/context";
import { initialState, reduceAll } from "../src/store/reducer";
import type { DeskMessage, DeskState } from "../src/store/types";
import {
  NOW,
  S,
  fakeClient,
  progress,
  registry,
  status,
  waveMsg,
  waveState,
} from "./helpers/desk-msgs";

const COORD = "coord-1";

/** The idle_prompt the hooks publish after a Stop with a background wait armed. */
const idleWait = (at = NOW - 30 * S, extra: Record<string, unknown> = {}) =>
  progress(COORD, "awaiting_input", at, {
    notification_type: "idle_prompt",
    text: "Claude is waiting for your input",
    question: "Claude is waiting for your input",
    background_wait: true,
    ...extra,
  });

const base = (): DeskMessage[] => [
  waveMsg(waveState({ owner: COORD })),
  registry(COORD, NOW - 600 * S),
  status(COORD, "working", NOW - 600 * S),
];

const opts = { now: NOW };
const attn = (state: DeskState) => {
  const w = state.waves.w1;
  if (!w) throw new Error("no wave");
  return waveAttention(w, ctxFrom(state, opts));
};

describe("Needs-you suppression for an idle coordinator with a live background wait", () => {
  it("downgrades awaiting_input + background_wait to info 'idle — waiting on wave events'", () => {
    const state = reduceAll(initialState(), [...base(), idleWait()]);
    expect(state.coordinators[COORD]).toMatchObject({ state: "working", waitingOnEvents: true });
    expect(attn(state)).toEqual({ tier: "info", reason: IDLE_WAIT_REASON });
    expect(IDLE_WAIT_REASON).toBe("idle — waiting on wave events");
    expect(needsYouTargets(state, opts)).toEqual([]);
  });

  it("without background_wait the same idle prompt still needs you", () => {
    const plain = progress(COORD, "awaiting_input", NOW - 30 * S, {
      notification_type: "idle_prompt",
      question: "Should I merge PR 12 now?",
    });
    const state = reduceAll(initialState(), [...base(), plain]);
    expect(attn(state).tier).toBe("you");
  });

  it("a permission_prompt is always Needs-you", () => {
    const state = reduceAll(initialState(), [
      ...base(),
      idleWait(NOW - 30 * S, { notification_type: "permission_prompt" }),
    ]);
    expect(attn(state).tier).toBe("you");
  });

  it("an open decision still escalates to Needs-you", () => {
    const decision: DeskMessage = {
      topic: "volley/_waves/w1/decisions/d-1",
      envelope: {
        schema_version: "0.1",
        agent_id: "volleyd",
        channel: "_waves/decisions",
        type: "decision",
        payload: {
          decision_id: "d-1",
          wave: "w1",
          task: "T1",
          kind: "reviewers_disagree",
          question: "Spec and quality disagree on T1",
          opened_at: new Date(NOW - 20 * 60 * S).toISOString(),
        },
      },
      receivedAt: NOW,
    };
    const state = reduceAll(initialState(), [...base(), idleWait(), decision]);
    expect(attn(state)).toMatchObject({ tier: "you" });
    expect(attn(state).reason).toMatch(/Spec and quality disagree/);
  });

  it("a later resumed clears the wait", () => {
    const state = reduceAll(initialState(), [
      ...base(),
      idleWait(),
      progress(COORD, "resumed", NOW - 5 * S, { previous: "awaiting_input" }),
    ]);
    expect(state.coordinators[COORD]?.waitingOnEvents).toBeUndefined();
    expect(attn(state).tier).toBe("none");
  });
});

describe("Needs-you suppression — App", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows no pill or banner, and the coordinators window says 'Working · waiting on events'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = fakeClient();
    const { container } = render(
      <DeskStoreProvider demo={false} brokerUrl="ws://test.invalid" clientFactory={() => f.client}>
        <App />
      </DeskStoreProvider>,
    );
    act(() => {
      f.up();
      for (const m of [...base(), idleWait()]) f.emit(m);
      vi.advanceTimersByTime(100);
    });
    expect(container.querySelector(".topbar .ny-pill")).toBeNull();
    const win = screen.getByRole("region", { name: "w1" });
    expect(win).not.toHaveClass("win--attn-you");
    expect(win).not.toHaveTextContent(/Needs you/);
    const coords = screen.getByRole("region", { name: "Wave coordinators" });
    expect(within(coords).getByText("Working · waiting on events")).toBeInTheDocument();
  });
});
