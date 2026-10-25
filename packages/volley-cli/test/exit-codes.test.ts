import { describe, expect, it } from "vitest";
import { EXIT as VOLLEYD_EXIT } from "volleyd/io";
import { EXIT } from "../src/exit-codes";

describe("EXIT constants", () => {
  it("matches the conventional shell exit codes", () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.ERROR).toBe(1);
    expect(EXIT.USAGE).toBe(2);
    expect(EXIT.DIRTY).toBe(3);
    expect(EXIT.SUPERVISOR_UNREACHABLE).toBe(69);
    expect(EXIT.TIMEOUT).toBe(124);
  });

  it("agrees with volleyd's table on every code both name", () => {
    const shared = Object.keys(EXIT).filter((k) => Object.hasOwn(VOLLEYD_EXIT, k));
    expect(shared.sort()).toEqual(["ERROR", "OK", "SUPERVISOR_UNREACHABLE", "TIMEOUT", "USAGE"]);
    for (const k of shared) {
      expect(EXIT[k as keyof typeof EXIT]).toBe(VOLLEYD_EXIT[k as keyof typeof VOLLEYD_EXIT]);
    }
  });

  it("no two names share a number, in either table, except 3 (each table's own)", () => {
    const numbers = new Map<number, string>();
    for (const [k, v] of [...Object.entries(EXIT), ...Object.entries(VOLLEYD_EXIT)]) {
      const seen = numbers.get(v);
      if (seen !== undefined && seen !== k) expect(v).toBe(3);
      numbers.set(v, k);
    }
  });
});
