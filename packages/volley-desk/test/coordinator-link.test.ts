import { describe, expect, it } from "vitest";
import { coordinatorLink } from "../src/store/coordinatorLink";
import { initialState, reduceAll } from "../src/store/reducer";
import type { CoordinatorRolePayload, DeskMessage } from "../src/store/types";
import { NOW, S, env, status } from "./helpers/desk-msgs";

const LINK = "https://claude.ai/code/session_fake01";
const OLD_LINK = "https://claude.ai/code/session_fake00";

const role = (over: Partial<CoordinatorRolePayload> = {}): CoordinatorRolePayload => ({
  machine: "box-a",
  name: "coord-test",
  state: "running",
  since: new Date(NOW).toISOString(),
  restarts: 0,
  session_url: LINK,
  ...over,
});

const federation = (p: CoordinatorRolePayload | null, from = "volleyd"): DeskMessage => ({
  topic: "volley/_system/federation/coordinator",
  envelope: p === null ? null : env(from, "_system/federation", "coordinator", p, NOW),
  receivedAt: NOW,
  retained: true,
});

const coordEntry = (id: string, at: number, url: string): DeskMessage => ({
  topic: `volley/_system/registry/${id}`,
  envelope: env(
    id,
    "_system/registry",
    "registered",
    {
      capabilities: ["coordinator"],
      started_at: new Date(at).toISOString(),
      coordinator: "coord-test",
      session_url: url,
    },
    at,
  ),
  receivedAt: at,
});

describe("the coordinator role in the store", () => {
  it("keeps volleyd's payload, forgets it on an empty retained message, ignores anyone else", () => {
    let s = reduceAll(initialState(), [federation(role())]);
    expect(s.coordinatorRole?.session_url).toBe(LINK);
    s = reduceAll(s, [federation(role({ session_url: OLD_LINK }), "mallory")]);
    expect(s.coordinatorRole?.session_url).toBe(LINK);
    s = reduceAll(s, [federation(null)]);
    expect(s.coordinatorRole).toBeNull();
  });
});

describe("coordinatorLink", () => {
  it("running with a link: opens it", () => {
    const s = reduceAll(initialState(), [federation(role())]);
    expect(coordinatorLink(s)).toEqual({ href: LINK });
  });

  it("starting: disabled with the machine", () => {
    const { session_url: _, ...starting } = role({ state: "starting" });
    const s = reduceAll(initialState(), [federation(starting)]);
    expect(coordinatorLink(s)).toEqual({ disabled: "Coordinator starting on box-a…" });
  });

  it("running with no link yet: names the session to pick in the Claude app", () => {
    const { session_url: _, ...noLink } = role();
    const s = reduceAll(initialState(), [federation(noLink)]);
    expect(coordinatorLink(s)).toEqual({
      disabled: 'No link yet: open the Claude app and pick "coord-test"',
    });
  });

  it("an empty payload falls back to the newest live coordinator registry entry's link", () => {
    const s = reduceAll(initialState(), [
      federation(null),
      coordEntry("coordinator-aa11", NOW - 60 * S, OLD_LINK),
      status("coordinator-aa11", "working", NOW - 60 * S),
      coordEntry("coordinator-ab12", NOW - 10 * S, LINK),
      status("coordinator-ab12", "working", NOW - 10 * S),
    ]);
    expect(coordinatorLink(s)).toEqual({ href: LINK });
    // The newest one ended: the older live one's link.
    const ended = reduceAll(s, [status("coordinator-ab12", "done", NOW)]);
    expect(coordinatorLink(ended)).toEqual({ href: OLD_LINK });
  });

  it("nothing at all: No coordinator running", () => {
    expect(coordinatorLink(initialState())).toEqual({ disabled: "No coordinator running" });
    const s = reduceAll(initialState(), [federation(null)]);
    expect(coordinatorLink(s)).toEqual({ disabled: "No coordinator running" });
  });
});
