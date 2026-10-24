import { describe, expect, it } from "vitest";
import { InFlightLedger } from "../../src/claude/in-flight";

describe("InFlightLedger", () => {
  it("a pick reserves its account until the agent's first sample", () => {
    const l = new InFlightLedger();
    l.reserve("w1", "T1", "implementer", "work");
    expect(l.on("work")).toEqual(["w1/T1/implementer"]);
    l.launched("w1", "T1", "implementer", "w1-t1-implementer-1");
    expect(l.on("work")).toEqual(["w1-t1-implementer-1"]);
    expect(l.on("primary")).toEqual([]);
    l.release("w1-t1-implementer-1");
    expect(l.on("work")).toEqual([]);
  });

  it("two picks in one pass both count", () => {
    const l = new InFlightLedger();
    l.reserve("w1", "T1", "implementer", "work");
    l.reserve("w1", "T2", "implementer", "work");
    expect(l.on("work")).toHaveLength(2);
  });

  it("a failed spawn leaves no reservation; a launched agent of the role keeps its own", () => {
    const l = new InFlightLedger();
    l.reserve("w1", "T1", "implementer", "work");
    l.failed("w1", "T1", "implementer");
    expect(l.on("work")).toEqual([]);
    l.reserve("w1", "T2", "implementer", "work");
    l.launched("w1", "T2", "implementer", "w1-t2-implementer-1");
    // an extra spawn of the role, refused (SPAWN_LOCKED)
    l.reserve("w1", "T2", "implementer", "work");
    l.failed("w1", "T2", "implementer");
    expect(l.on("work")).toEqual(["w1-t2-implementer-1"]);
  });

  it("a role's new pick replaces its old one", () => {
    const l = new InFlightLedger();
    l.reserve("w1", "T1", "implementer", "work");
    l.reserve("w1", "T1", "implementer", "spare");
    expect(l.on("work")).toEqual([]);
    expect(l.on("spare")).toEqual(["w1/T1/implementer"]);
  });
});
