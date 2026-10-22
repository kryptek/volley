import { describe, expect, it } from "vitest";
import { eventually, until } from "./helpers/broker-wait";

describe("broker-wait helpers carry a deadline", () => {
  it("eventually resolves once the predicate holds", async () => {
    let n = 0;
    await eventually(() => ++n >= 3);
    expect(n).toBe(3);
  });

  it("eventually rejects past its deadline with what it waited for and the last error", async () => {
    let n = 0;
    const p = eventually(
      () => {
        n++;
        throw new Error(`attempt ${n} not yet`);
      },
      { deadlineMs: 50, what: "the retained state" },
    );
    await expect(p).rejects.toThrow(/waited 50 ms for the retained state; last error: attempt \d+/);
  });

  it("eventually says a predicate that only returned false was still false", async () => {
    await expect(eventually(() => false, { deadlineMs: 20, what: "x" })).rejects.toThrow(
      "waited 20 ms for x: still false",
    );
  });

  it("until fails with the last assertion error", async () => {
    const err = await until(() => expect("working").toBe("gone"), {
      deadlineMs: 50,
      what: "gone",
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    // vitest and bun word an assertion failure differently: check the cause is carried, not its wording.
    expect(err).toBeInstanceOf(Error);
    const { message, cause } = err as Error;
    expect(cause).toBeInstanceOf(Error);
    expect(message).toBe(`waited 50 ms for gone; last error: ${(cause as Error).message}`);
    expect((cause as Error).message).toMatch(/working/);
  });
});
