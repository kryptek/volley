import { describe, expect, it } from "vitest";
import {
  ROLE_MOVE_TIMEOUT_MS,
  ROLE_PLAN_TIMEOUT_MS,
  createRoleOps,
  isQuietWait,
} from "../src/store/roleOps";
import { fakeOps } from "./helpers/auth-ops";

const PLAN = {
  role: "broker",
  from: "studio",
  to: "box-a",
  plan_id: "role-broker-5f2c9a1e",
  steps: [{ id: "install", title: "Install the broker", where: "box-a" }],
  blocked: [{ why: "wave w1 is running", fix: "stop it, or move when idle (drain: true)" }],
  warnings: ["box-a is busy"],
  terminal: [{ where: "box-a", reason: "needs sudo", command: "sudo volley setup --lan" }],
  after: ["Every tunnel reaches box-a."],
};

describe("createRoleOps (SPEC §4.6.24)", () => {
  it("plan sends role_plan with only the fields given and reads the plan", async () => {
    const { ops, calls } = fakeOps({ role_plan: () => ({ ok: true, result: PLAN }) });
    const a = await createRoleOps(ops).plan({ role: "broker", to: "box-a", lan: true });
    expect(calls[0]).toMatchObject({
      op: "role_plan",
      fields: { role: "broker", to: "box-a", lan: true },
      opts: { timeoutMs: ROLE_PLAN_TIMEOUT_MS },
    });
    expect(a).toEqual({
      ok: true,
      plan: {
        role: "broker",
        from: "studio",
        to: "box-a",
        planId: "role-broker-5f2c9a1e",
        steps: PLAN.steps,
        blocked: PLAN.blocked,
        warnings: PLAN.warnings,
        terminal: PLAN.terminal,
        after: PLAN.after,
      },
    });
  });

  it("a refused plan carries volleyd's reason", async () => {
    const { ops } = fakeOps({
      role_plan: () => ({ ok: false, error: "broker already runs on box-a" }),
    });
    expect(await createRoleOps(ops).plan({ role: "broker", to: "box-a" })).toEqual({
      ok: false,
      error: "broker already runs on box-a",
    });
  });

  it("move sends plan_id and drain, waits per role, and passes onLate", async () => {
    const { ops, calls } = fakeOps({
      role_move: () => ({ ok: true, result: { move_id: "mv-1", status: "planning" } }),
    });
    const a = await createRoleOps(ops).move(
      { role: "broker", to: "box-a", planId: "p-1", drain: true },
      { onLate: () => {} },
    );
    expect(calls[0]?.fields).toEqual({ role: "broker", to: "box-a", plan_id: "p-1", drain: true });
    expect(calls[0]?.opts?.timeoutMs).toBe(ROLE_MOVE_TIMEOUT_MS.broker);
    expect(typeof calls[0]?.opts?.onLate).toBe("function");
    expect(a).toEqual({ ok: true, moveId: "mv-1", status: "planning" });
  });

  it("a Desk move opens the sealed link, or joins link_base with a sealed token", async () => {
    const link = "http://box-a:5199/#signin=vly_signin_a_b";
    const sealedLink = fakeOps({
      role_move: () => ({
        ok: true,
        result: { move_id: "mv-2", status: "done" },
        secret: { link },
      }),
    });
    expect(
      await createRoleOps(sealedLink.ops).move({ role: "desk", to: "box-a", planId: "p" }),
    ).toEqual({ ok: true, moveId: "mv-2", status: "done", link });
    const sealedToken = fakeOps({
      role_move: () => ({
        ok: true,
        result: { move_id: "mv-3", status: "done", link_base: "http://box-a:5199/" },
        secret: { token: "vly_signin_a_b" },
      }),
    });
    expect(
      await createRoleOps(sealedToken.ops).move({ role: "desk", to: "box-a", planId: "p" }),
    ).toMatchObject({ link });
  });

  it("a supervisor move answers handing over; a failure names its step and rollback", async () => {
    const sup = fakeOps({
      role_move: () => ({
        ok: true,
        result: { move_id: "mv-4", status: "running", handing_over: true },
      }),
    });
    expect(
      await createRoleOps(sup.ops).move({ role: "supervisor", to: "box-a", planId: "p" }),
    ).toEqual({ ok: true, moveId: "mv-4", status: "running", handingOver: true });
    const failed = fakeOps({
      role_move: () => ({
        ok: false,
        error: "check failed",
        result: { move_id: "mv-5", status: "failed", step: "check", rolled_back: true },
      }),
    });
    expect(
      await createRoleOps(failed.ops).move({ role: "desk", to: "box-a", planId: "p" }),
    ).toEqual({
      ok: false,
      error: "check failed",
      moveId: "mv-5",
      step: "check",
      rolledBack: true,
    });
  });

  it("plan changed and no answer in time are said apart", async () => {
    const changed = fakeOps({
      role_move: () => ({ ok: false, error: "plan changed: moving the broker …; plan again" }),
    });
    expect(
      await createRoleOps(changed.ops).move({ role: "broker", to: "box-a", planId: "p" }),
    ).toMatchObject({ ok: false, planChanged: true });
    const late = fakeOps({
      role_move: () => ({ ok: false, error: "volleyd did not answer", unanswered: true }),
    });
    expect(
      await createRoleOps(late.ops).move({ role: "broker", to: "box-a", planId: "p" }),
    ).toMatchObject({ ok: false, unanswered: true });
  });

  it("rollback sends role_rollback and names the new move", async () => {
    const { ops, calls } = fakeOps({
      role_rollback: () => ({ ok: true, result: { move_id: "mv-6", rolls_back: "mv-2" } }),
    });
    expect(await createRoleOps(ops).rollback("mv-2")).toEqual({
      ok: true,
      moveId: "mv-6",
      rollsBack: "mv-2",
    });
    expect(calls[0]?.fields).toEqual({ move_id: "mv-2" });
  });

  it("an older volleyd's unknown op is a plain refusal", async () => {
    const { ops } = fakeOps({});
    expect(await createRoleOps(ops).plan({ role: "desk", to: "box-a" })).toEqual({
      ok: false,
      error: "unknown op 'role_plan'",
    });
  });
});

describe("isQuietWait", () => {
  it("is the not-quiet blocker whose fix names drain: true", () => {
    expect(isQuietWait({ why: "wave w1 is running", fix: "… (drain: true)" })).toBe(true);
    expect(isQuietWait({ why: "box-a is down", fix: "bring it back" })).toBe(false);
    expect(isQuietWait({ why: "box-a is down" })).toBe(false);
  });
});
