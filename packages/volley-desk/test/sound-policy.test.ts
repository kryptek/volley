/** The sound policy: gating, quiet hours, the hidden-tab rule, coalescing and the minimum gap. */
import { describe, expect, it } from "vitest";
import type { SoundEventId } from "../src/sounds/events";
import {
  COALESCE_MS,
  POLICY0,
  type PolicyEnv,
  decide,
  flush,
  inQuietHours,
} from "../src/sounds/policy";
import { SOUND0, type SoundSettings, mergeSound } from "../src/sounds/settings";

const env = (over: Partial<PolicyEnv> = {}): PolicyEnv => ({
  now: 10_000,
  hidden: false,
  reducedMotion: false,
  localMinutes: 12 * 60,
  ...over,
});

const ids = (r: { play: { id: SoundEventId }[] }) => r.play.map((p) => p.id);
const with_ = (change: Parameters<typeof mergeSound>[1]): SoundSettings =>
  mergeSound(SOUND0, change);
const ALL: SoundEventId[] = ["ui_click", "agent_complete", "attention_needed"];

describe("decide: gating", () => {
  it("plays nothing when muted", () => {
    expect(decide(ALL, with_({ muted: true }), env(), POLICY0).play).toEqual([]);
  });

  it("drops an event switched off, and only that one", () => {
    expect(ids(decide(ALL, with_({ events: { ui_click: false } }), env(), POLICY0))).toEqual([
      "agent_complete",
      "attention_needed",
    ]);
  });

  it("drops agent_working by default", () => {
    expect(decide(["agent_working"], SOUND0, env(), POLICY0).play).toEqual([]);
  });

  it("quiet hours drop ui and signal, keep attention unless attentionToo", () => {
    const quiet = with_({ quietHours: { on: true, from: "22:00", to: "07:00" } });
    expect(ids(decide(ALL, quiet, env({ localMinutes: 23 * 60 + 30 }), POLICY0))).toEqual([
      "attention_needed",
    ]);
    const all = mergeSound(quiet, { quietHours: { attentionToo: true } });
    expect(decide(ALL, all, env({ localMinutes: 23 * 60 + 30 }), POLICY0).play).toEqual([]);
    // Off: no quiet hours at all.
    expect(ids(decide(ALL, SOUND0, env({ localMinutes: 23 * 60 + 30 }), POLICY0))).toHaveLength(3);
  });

  it("quiet hours wrap midnight", () => {
    expect(inQuietHours("22:00", "07:00", 6 * 60 + 59)).toBe(true);
    expect(inQuietHours("22:00", "07:00", 7 * 60)).toBe(false);
    expect(inQuietHours("22:00", "07:00", 22 * 60)).toBe(true);
    expect(inQuietHours("09:00", "17:00", 12 * 60)).toBe(true);
    expect(inQuietHours("09:00", "17:00", 17 * 60)).toBe(false);
    expect(inQuietHours("09:00", "09:00", 9 * 60)).toBe(false);
  });

  it("the hidden-tab rule: signals only when hidden, ui never when hidden, attention always", () => {
    const s = with_({ signalsOnlyWhenHidden: true });
    expect(ids(decide(ALL, s, env({ hidden: true }), POLICY0))).toEqual([
      "agent_complete",
      "attention_needed",
    ]);
    expect(ids(decide(ALL, s, env({ hidden: false }), POLICY0))).toEqual([
      "ui_click",
      "attention_needed",
    ]);
    expect(ids(decide(ALL, SOUND0, env({ hidden: true }), POLICY0))).toEqual([
      "agent_complete",
      "attention_needed",
    ]);
  });

  it("reduced motion silences everything unless the setting says not to follow it", () => {
    expect(decide(ALL, SOUND0, env({ reducedMotion: true }), POLICY0).play).toEqual([]);
    expect(
      ids(
        decide(ALL, with_({ followReducedMotion: false }), env({ reducedMotion: true }), POLICY0),
      ),
    ).toHaveLength(3);
  });
});

describe("decide: rate limiting", () => {
  it("coalesces a burst in one call into one play with its count", () => {
    const burst = Array.from({ length: 20 }, (): SoundEventId => "agent_complete");
    expect(decide(burst, SOUND0, env(), POLICY0).play).toEqual([
      { id: "agent_complete", count: 20 },
    ]);
  });

  it("folds a repeat inside the window and reports the total when it closes", () => {
    const a = decide(["agent_complete"], SOUND0, env({ now: 1000 }), POLICY0);
    expect(a.play).toEqual([{ id: "agent_complete", count: 1 }]);
    const b = decide(["agent_complete"], SOUND0, env({ now: 1100 }), a.state);
    expect(b.play).toEqual([]);
    expect(flush(b.state, 1100).done).toEqual([]);
    expect(flush(b.state, 1000 + COALESCE_MS).done).toEqual([{ id: "agent_complete", count: 2 }]);
    // A window with nothing folded reports nothing.
    expect(flush(a.state, 5000).done).toEqual([]);
  });

  it("drops a repeat after the window but inside the minimum gap", () => {
    const a = decide(["agent_complete"], SOUND0, env({ now: 1000 }), POLICY0);
    expect(decide(["agent_complete"], SOUND0, env({ now: 1300 }), a.state).play).toEqual([]);
    expect(decide(["agent_complete"], SOUND0, env({ now: 1400 }), a.state).play).toHaveLength(1);
  });

  it("holds the per-event minimum gap: ui_click 60 ms, attention 0", () => {
    const a = decide(["ui_click"], SOUND0, env({ now: 1000 }), POLICY0);
    expect(decide(["ui_click"], SOUND0, env({ now: 1030 }), a.state).play).toEqual([]);
    expect(decide(["ui_click"], SOUND0, env({ now: 1070 }), a.state).play).toHaveLength(1);
    const b = decide(["attention_needed"], SOUND0, env({ now: 1000 }), POLICY0);
    expect(decide(["attention_needed"], SOUND0, env({ now: 1010 }), b.state).play).toHaveLength(1);
  });

  it("coalesces by id, never across ids", () => {
    expect(ids(decide(["agent_complete", "review_written"], SOUND0, env(), POLICY0))).toEqual([
      "agent_complete",
      "review_written",
    ]);
  });

  it("returns a new state and never mutates the input", () => {
    const frozen = Object.freeze({
      lastPlayedAt: Object.freeze({}),
      pending: Object.freeze({}),
    });
    const r = decide(["agent_complete"], SOUND0, env(), frozen);
    expect(r.state).not.toBe(frozen);
    expect(frozen).toEqual({ lastPlayedAt: {}, pending: {} });
  });
});
