import { describe, expect, it } from "vitest";
import { VolleyError, toToolError } from "../src/errors";

describe("VolleyError", () => {
  it("carries a spec error code and message and is an Error", () => {
    const e = new VolleyError("BROKER_DOWN", "cannot reach broker");
    expect(e.code).toBe("BROKER_DOWN");
    expect(e.message).toBe("cannot reach broker");
    expect(e.name).toBe("VolleyError");
    expect(e instanceof Error).toBe(true);
  });
});

describe("toToolError", () => {
  it("maps a VolleyError to its { error, code }", () => {
    const e = new VolleyError("NOT_REGISTERED", "call vol_register first");
    expect(toToolError(e)).toEqual({ error: "call vol_register first", code: "NOT_REGISTERED" });
  });
  it("maps an unknown Error to IMPL_UNEXPECTED", () => {
    expect(toToolError(new Error("boom"))).toEqual({ error: "boom", code: "IMPL_UNEXPECTED" });
  });
  it("maps a non-Error throw to IMPL_UNEXPECTED", () => {
    expect(toToolError("weird")).toEqual({ error: "weird", code: "IMPL_UNEXPECTED" });
  });
});
