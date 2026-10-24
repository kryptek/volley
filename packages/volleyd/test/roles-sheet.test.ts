import { describe, expect, it } from "vitest";
import { planWire } from "../src/roles/engine";
import { isPlanSheet, renderSheet } from "../src/roles/sheet";

/** The plan sheet (roles/sheet.ts): `role_plan`'s answer as the CLI and the Desk show it. */
describe("renderSheet", () => {
  const wire = planWire({
    role: "broker",
    from: "mac",
    to: "box-a",
    steps: [
      {
        id: "stop",
        title: "Stop the broker",
        where: "mac",
        detail: "brew services stop mosquitto",
        run: async () => undefined,
      },
    ],
    blocked: [{ why: "box-a has no mosquitto", fix: "brew install mosquitto" }],
    waits: [{ why: "wave w1 is running" }],
    warnings: ["the broker leaves the supervisor's machine"],
    terminal: [
      { where: "box-a", reason: "a snap layout", command: "sudo volley broker receive b" },
    ],
    after: ["re-point the owner's sessions on mac"],
  });

  it("reads planWire's answer", () => {
    expect(isPlanSheet(wire)).toBe(true);
    expect(isPlanSheet({ ...wire, steps: [{ id: "x" }] })).toBe(false);
  });

  it("names every step's machine, each blocker with its fix, terminal commands and what follows", () => {
    expect(renderSheet(wire)).toEqual([
      `Move the broker from mac to box-a (plan ${wire.plan_id})`,
      "",
      "Steps:",
      "  1. on mac: Stop the broker",
      "",
      "Blocked:",
      "  ✗ wave w1 is running",
      "  ✗ box-a has no mosquitto",
      "    fix: brew install mosquitto",
      "",
      "Warnings:",
      "  ! the broker leaves the supervisor's machine",
      "",
      "Commands to run in a terminal:",
      "  on box-a (a snap layout):",
      "    sudo volley broker receive b",
      "",
      "Afterwards:",
      "  · re-point the owner's sessions on mac",
    ]);
  });
});
