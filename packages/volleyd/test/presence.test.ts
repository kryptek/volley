import { describe, expect, it } from "vitest";
import { type WaitsInput, ownerState, presenceOf, waitsOnOwner } from "../src/presence";

describe("presenceOf", () => {
  it("is online for a live status, offline for a terminal one or none", () => {
    for (const type of ["spawning", "registered", "working", "blocked"])
      expect(presenceOf({ type })).toBe("online");
    for (const type of ["reaped", "done", "failed"]) expect(presenceOf({ type })).toBe("offline");
    expect(presenceOf({ type: "blocked", reason: "shutdown" })).toBe("offline");
    expect(presenceOf({ type: "blocked", reason: "needs a key" })).toBe("online");
    expect(presenceOf(undefined)).toBe("offline");
    expect(presenceOf(null)).toBe("offline");
  });
});

describe("waitsOnOwner", () => {
  const base: WaitsInput = {
    decisions: [],
    inbox: [],
    autopilotEnabled: true,
    mergeMode: "auto",
    gates: [],
  };
  const escalated = { escalated: { why: "owner_only" } };

  it("is null when nothing waits", () => {
    expect(waitsOnOwner(base)).toBeNull();
  });

  it("counts an escalated decision, never a held one", () => {
    expect(waitsOnOwner({ ...base, decisions: [escalated] })).toEqual({
      decisions: 1,
      items: 0,
      gates: 0,
    });
    expect(
      waitsOnOwner({ ...base, decisions: [{ ...escalated, held: { on: { task: "A" } } }] }),
    ).toBeNull();
    expect(waitsOnOwner({ ...base, decisions: [{ ...escalated, resolved: {} }] })).toBeNull();
  });

  it("counts an unescalated decision only while autopilot is off", () => {
    expect(waitsOnOwner({ ...base, decisions: [{}] })).toBeNull();
    expect(waitsOnOwner({ ...base, autopilotEnabled: false, decisions: [{}] })?.decisions).toBe(1);
  });

  it("counts an open owner-only inbox item, not an answered one nor a decision's own", () => {
    const item = { kind: "release_go", owner_only: true };
    expect(waitsOnOwner({ ...base, inbox: [item] })?.items).toBe(1);
    expect(waitsOnOwner({ ...base, inbox: [{ ...item, answered: { answer: "go" } }] })).toBeNull();
    expect(waitsOnOwner({ ...base, inbox: [{ ...item, owner_only: false }] })).toBeNull();
    expect(waitsOnOwner({ ...base, inbox: [{ ...item, kind: "decision" }] })).toBeNull();
  });

  it("counts merge-ready gates only under merge: manual", () => {
    expect(waitsOnOwner({ ...base, gates: ["A"] })).toBeNull();
    expect(waitsOnOwner({ ...base, mergeMode: "manual", gates: ["A", "B"] })?.gates).toBe(2);
  });
});

describe("ownerState", () => {
  const now = 10_000_000;
  const waits = { decisions: 1, items: 0, gates: 0 };
  const base = { attention: undefined, awayAt: undefined, graceMs: 900_000, now, waits: null };

  it("an online owner is its attention, working by default", () => {
    expect(ownerState({ ...base, presence: "online" })).toBe("working");
    expect(
      ownerState({ ...base, presence: "online", attention: { state: "awaiting_input" } }),
    ).toBe("awaiting_input");
    // Waits do not matter while it is online.
    expect(ownerState({ ...base, presence: "online", waits })).toBe("working");
  });

  it("an offline name is reconnecting within the grace", () => {
    expect(ownerState({ ...base, presence: "offline", awayAt: now - 60_000, waits })).toBe(
      "reconnecting",
    );
  });

  it("an offline owner past the grace is gone while something waits, else away", () => {
    const awayAt = now - 900_000;
    expect(ownerState({ ...base, presence: "offline", awayAt })).toBe("away");
    expect(ownerState({ ...base, presence: "offline", awayAt, waits })).toBe("gone");
  });

  it("a plain agent id (no awayAt) is never reconnecting", () => {
    expect(ownerState({ ...base, presence: "offline" })).toBe("away");
    expect(ownerState({ ...base, presence: "offline", waits })).toBe("gone");
  });
});
