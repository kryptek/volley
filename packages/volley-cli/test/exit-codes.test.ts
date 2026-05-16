import { describe, expect, it } from "vitest";
import { EXIT } from "../src/exit-codes";

describe("EXIT constants", () => {
  it("matches the conventional shell exit codes", () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.ERROR).toBe(1);
    expect(EXIT.USAGE).toBe(2);
    expect(EXIT.TIMEOUT).toBe(124);
  });
});
