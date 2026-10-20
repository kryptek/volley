/** The sound catalogue (`sounds/events.ts`) and the themes (`sounds/themes.ts`). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVENT_GROUPS, SOUND_EVENTS, SOUND_EVENT_IDS } from "../src/sounds/events";
import { DEFAULT_THEME, THEMES } from "../src/sounds/themes";

const IDS = [
  "ui_click",
  "ui_drag_start",
  "ui_drop",
  "tethers_on",
  "tethers_off",
  "panel_open",
  "panel_close",
  "agent_spawned",
  "agent_working",
  "agent_complete",
  "agent_failed",
  "agent_reaped",
  "attention_needed",
  "decision_answered",
  "review_written",
  "ci_passed",
  "ci_failed",
  "merge_ready",
  "pr_merged",
  "wave_start",
  "wave_complete",
  "wave_stopped",
  "steering_sent",
  "steering_delivered",
  "account_limit",
  "machine_down",
  "broker_disconnected",
  "broker_reconnected",
];

describe("SOUND_EVENTS", () => {
  it("has exactly the 28 events, each with class, severity, label, group and defaultOn", () => {
    expect([...SOUND_EVENT_IDS].sort()).toEqual([...IDS].sort());
    for (const id of SOUND_EVENT_IDS) {
      const e = SOUND_EVENTS[id];
      expect(["ui", "signal", "attention"]).toContain(e.class);
      expect(["failure", "neutral", "success", "attention"]).toContain(e.severity);
      expect(e.label).not.toBe("");
      expect(e.many).not.toBe("");
      expect(typeof e.defaultOn).toBe("boolean");
    }
  });

  it("maps classes and defaults as the design table says", () => {
    const by = (cls: string) => SOUND_EVENT_IDS.filter((id) => SOUND_EVENTS[id].class === cls);
    expect(by("ui")).toHaveLength(7);
    expect(by("signal")).toHaveLength(20);
    expect(by("attention")).toEqual(["attention_needed"]);
    expect(SOUND_EVENT_IDS.filter((id) => !SOUND_EVENTS[id].defaultOn)).toEqual(["agent_working"]);
    expect(SOUND_EVENTS.agent_failed.severity).toBe("failure");
    expect(SOUND_EVENTS.wave_complete.severity).toBe("success");
    expect(SOUND_EVENTS.agent_complete.many).toBe("agents completed");
  });

  it("puts every event in exactly one Settings group, in order", () => {
    expect(EVENT_GROUPS.map((g) => g.group)).toEqual([
      "UI",
      "Agents",
      "Pipeline",
      "Wave",
      "Steering",
      "System",
      "Attention",
    ]);
    expect(EVENT_GROUPS.flatMap((g) => g.ids).sort()).toEqual([...IDS].sort());
  });

  it("is pure data: no DOM or audio in the catalogue or the settings model", () => {
    for (const f of ["events.ts", "themes.ts", "settings.ts", "derive.ts", "policy.ts"]) {
      const src = readFileSync(join(__dirname, "../src/sounds", f), "utf8");
      expect(src).not.toMatch(/\b(window|document|navigator)\.|AudioContext|\bfetch\(/);
    }
    // The derivation and the policy never read the clock: `now` comes in.
    for (const f of ["derive.ts", "policy.ts"]) {
      const src = readFileSync(join(__dirname, "../src/sounds", f), "utf8");
      expect(src).not.toMatch(/\bDate\b|performance\./);
    }
  });
});

describe("THEMES", () => {
  it("has twelve themes, synthwave first and the default", () => {
    expect(THEMES).toHaveLength(12);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(12);
    expect(DEFAULT_THEME).toBe("synthwave");
    expect(THEMES[0]?.id).toBe("synthwave");
  });
});
