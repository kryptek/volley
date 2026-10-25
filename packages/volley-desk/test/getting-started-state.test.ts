import { describe, expect, it } from "vitest";
import {
  PROGRESS_KEY,
  type Progress,
  freshProgress,
  markDone,
  readProgress,
  writeProgress,
} from "../src/getting-started/state";
import { decide } from "../src/getting-started/useGettingStarted";

/** A `Storage` stand-in over a plain map. */
function memory(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    raw: (k: string) => m.get(k),
  };
}

const FRESH = { v: 1, step: "welcome", summary: { machines: [], repos: [], people: [] } };

describe("Getting started progress", () => {
  it("is fresh for an empty storage, malformed JSON, another version or no storage", () => {
    expect(readProgress(memory())).toEqual(FRESH);
    expect(readProgress(memory({ [PROGRESS_KEY]: "{not json" }))).toEqual(FRESH);
    expect(readProgress(memory({ [PROGRESS_KEY]: '{"v":2,"step":"repos"}' }))).toEqual(FRESH);
    expect(readProgress(null)).toEqual(FRESH);
    expect(freshProgress()).toEqual(FRESH);
  });

  it("round-trips through writeProgress", () => {
    const s = memory();
    const p: Progress = {
      v: 1,
      step: "repos",
      summary: {
        machine: "studio",
        machines: ["studio", "laptop"],
        connectedBy: "code",
        repos: ["acme/web"],
        people: [{ name: "sam", role: "steer" }],
        network: "tailscale",
        coordinatorMachine: null,
      },
    };
    writeProgress(s, p);
    expect(JSON.parse(s.raw(PROGRESS_KEY) ?? "null")).toEqual(p);
    expect(readProgress(s)).toEqual(p);
  });

  it("drops an unknown step and a malformed summary field", () => {
    const s = memory({
      [PROGRESS_KEY]: JSON.stringify({
        v: 1,
        step: "nope",
        summary: { repos: "x", machines: [1] },
      }),
    });
    expect(readProgress(s)).toEqual(FRESH);
  });

  it("markDone records skipped or finished with when, keeping the step reached", () => {
    const s = memory();
    writeProgress(s, { ...freshProgress(), step: "people" });
    const now = new Date("2026-10-24T12:00:00Z");
    const p = markDone(s, "skipped", now);
    expect(p.done).toEqual({ kind: "skipped", at: "2026-10-24T12:00:00.000Z" });
    expect(readProgress(s)).toEqual({ ...FRESH, step: "people", done: p.done });
    expect(markDone(s, "finished", now).done?.kind).toBe("finished");
  });

  it("a blocked storage never throws", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readProgress(blocked)).toEqual(FRESH);
    expect(() => writeProgress(blocked, freshProgress())).not.toThrow();
    expect(markDone(blocked, "skipped", new Date(0)).done?.kind).toBe("skipped");
  });
});

describe("decide: what the Desk opens on load", () => {
  const fresh = freshProgress();
  const skipped: Progress = { ...fresh, done: { kind: "skipped", at: "2026-10-24T00:00:00Z" } };
  const finished: Progress = { ...fresh, done: { kind: "finished", at: "2026-10-24T00:00:00Z" } };

  it("an admin after the first-run sign-in gets Getting started unless it was skipped or finished", () => {
    expect(decide({ admin: true, firstRun: true, progress: fresh })).toBe("getting-started");
    expect(decide({ admin: true, firstRun: true, progress: skipped })).toBe("settings-setup");
    expect(decide({ admin: true, firstRun: true, progress: finished })).toBeNull();
  });

  it("an admin Desk with no marker opens it on any load; a done one opens nothing", () => {
    expect(decide({ admin: true, firstRun: false, progress: fresh })).toBe("getting-started");
    expect(decide({ admin: true, firstRun: false, progress: skipped })).toBeNull();
    expect(decide({ admin: true, firstRun: false, progress: finished })).toBeNull();
  });

  it("a non-admin never gets it", () => {
    for (const progress of [fresh, skipped, finished]) {
      for (const firstRun of [true, false]) {
        expect(decide({ admin: false, firstRun, progress })).toBeNull();
      }
    }
  });
});
