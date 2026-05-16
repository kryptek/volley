import { describe, expect, it } from "vitest";
import { relTime } from "../src/lib/rel-time";

describe("relTime", () => {
  const now = 1_700_000_000_000;

  it('returns "now" for deltas under 5 seconds', () => {
    expect(relTime(now, now)).toBe("now");
    expect(relTime(now - 1_000, now)).toBe("now");
    expect(relTime(now - 4_999, now)).toBe("now");
  });

  it("returns Ns ago for deltas under one minute", () => {
    expect(relTime(now - 5_000, now)).toBe("5s ago");
    expect(relTime(now - 12_000, now)).toBe("12s ago");
    expect(relTime(now - 59_000, now)).toBe("59s ago");
  });

  it("returns Nm ago for deltas under one hour", () => {
    expect(relTime(now - 60_000, now)).toBe("1m ago");
    expect(relTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relTime(now - 59 * 60_000, now)).toBe("59m ago");
  });

  it("returns Nh ago for deltas under one day", () => {
    expect(relTime(now - 60 * 60_000, now)).toBe("1h ago");
    expect(relTime(now - 23 * 60 * 60_000, now)).toBe("23h ago");
  });

  it("returns Nd ago for deltas over one day", () => {
    expect(relTime(now - 24 * 60 * 60_000, now)).toBe("1d ago");
    expect(relTime(now - 3 * 24 * 60 * 60_000, now)).toBe("3d ago");
    expect(relTime(now - 30 * 24 * 60 * 60_000, now)).toBe("30d ago");
  });

  it("clamps negative deltas (future timestamps) to now", () => {
    expect(relTime(now + 10_000, now)).toBe("now");
  });

  it("defaults to Date.now() when no second argument provided", () => {
    const recent = Date.now() - 1_000;
    expect(relTime(recent)).toBe("now");
  });
});
