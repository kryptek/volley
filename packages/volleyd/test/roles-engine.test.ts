import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { type MovePayload, type MoveStep, RoleMoves, moveDir, planId } from "../src/roles/engine";
import type { NewEvent } from "../src/types";
import { envelope, schemaErrors } from "./helpers/schema";
import { tempDir } from "./helpers/tmp";

const T0 = Date.parse("2026-10-24T09:00:00.000Z");

describe("the role-move engine (SPEC §4.6.24)", () => {
  let home: string;
  let now: number;
  let published: MovePayload[];
  let cleared: string[];
  let events: NewEvent[];
  let ran: string[];
  let moves: RoleMoves;

  beforeEach(() => {
    home = tempDir("volleyd-roles-engine-");
    now = T0;
    published = [];
    cleared = [];
    events = [];
    ran = [];
    moves = new RoleMoves({
      home,
      now: () => new Date(now),
      publish: async (p) => {
        published.push(structuredClone(p));
      },
      clear: async (id) => {
        cleared.push(id);
      },
      journal: (ev) => {
        events.push(ev);
      },
      log: () => {},
    });
  });

  const step = (id: string, over: Partial<MoveStep> = {}): MoveStep => ({
    id,
    title: `Step ${id}`,
    where: "box-a",
    detail: `do ${id}`,
    run: async () => {
      ran.push(`run ${id}`);
      return `${id} ok`;
    },
    undo: async () => {
      ran.push(`undo ${id}`);
    },
    ...over,
  });

  const start = (steps: MoveStep[]) =>
    moves.run({ move_id: "m-1", role: "desk", from: "mac", to: "box-a", by: "admin-1", steps });

  it("runs the steps in order, publishing running → ok per step, then done", async () => {
    const r = await start([step("a"), step("b"), step("c")]);
    expect(r).toMatchObject({ ok: true, status: "done" });
    expect(ran).toEqual(["run a", "run b", "run c"]);
    const statuses = published.map((p) => `${p.status}:${p.steps.map((s) => s.status).join(",")}`);
    expect(statuses[0]).toBe("running:pending,pending,pending");
    expect(statuses).toContain("running:running,pending,pending");
    expect(statuses).toContain("running:ok,running,pending");
    expect(statuses.at(-1)).toBe("done:ok,ok,ok");
    expect(published.at(-1)?.steps.map((s) => s.line)).toEqual(["a ok", "b ok", "c ok"]);
    expect(events.map((e) => e.type)).toEqual([
      "role_move_started",
      ...Array(6).fill("role_move_step"),
      "role_move_completed",
    ]);
    expect(events[0]?.data).toEqual({
      by: "admin-1",
      move_id: "m-1",
      role: "desk",
      from: "mac",
      to: "box-a",
    });
    // The log on disk, one line per change.
    const log = readFileSync(join(moveDir(home, "m-1"), "log.jsonl"), "utf-8")
      .trim()
      .split("\n");
    expect(log.length).toBeGreaterThanOrEqual(8);
    expect(published.at(-1)?.log_path).toBe(join(moveDir(home, "m-1"), "log.jsonl"));
  });

  it("a failing step undoes the done ones in reverse and ends failed with that step", async () => {
    const r = await start([
      step("a"),
      step("b"),
      step("c", {
        run: async () => {
          throw new Error("the check failed");
        },
      }),
    ]);
    expect(r).toMatchObject({ ok: false, status: "failed", step: "c", rolled_back: true });
    expect(ran).toEqual(["run a", "run b", "undo b", "undo a"]);
    const last = published.at(-1);
    expect(last?.status).toBe("failed");
    expect(last?.error).toBe("c: the check failed");
    expect(last?.steps.map((s) => s.status)).toEqual(["skipped", "skipped", "failed"]);
    expect(events.at(-1)).toEqual({
      type: "role_move_failed",
      data: {
        by: "admin-1",
        move_id: "m-1",
        role: "desk",
        step: "c",
        error: "c: the check failed",
        rolled_back: true,
      },
    });
  });

  it("a second move while one runs is refused, naming the one in progress", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const first = start([
      step("a", {
        run: async () => {
          await held;
          return "a";
        },
      }),
    ]);
    expect(moves.running()).toBe("m-1");
    expect(moves.refusal()).toBe("a role move is in progress: m-1");
    await expect(
      moves.run({ move_id: "m-2", role: "desk", from: "mac", to: "box-b", by: "x", steps: [] }),
    ).rejects.toThrow("a role move is in progress: m-1");
    release();
    await first;
    expect(moves.running()).toBeNull();
  });

  it("plan_id differs when any step detail differs, and not otherwise", () => {
    const steps = [
      { id: "a", where: "box-a", detail: "volley desk install --port 5199" },
      { id: "b", where: "mac", detail: "unload" },
    ];
    const id = planId("desk", "box-a", steps, []);
    expect(id).toMatch(/^desk-[0-9a-f]{16}$/);
    expect(planId("desk", "box-a", structuredClone(steps), [])).toBe(id);
    const other = structuredClone(steps);
    (other[0] as { detail: string }).detail = "volley desk install --port 8080";
    expect(planId("desk", "box-a", other, [])).not.toBe(id);
    expect(planId("desk", "box-a", steps, ["box-a is down"])).not.toBe(id);
    expect(planId("desk", "box-b", steps, [])).not.toBe(id);
  });

  it("the sweep removes a move kept longer than 7 days, with its retained topic, and keeps a newer one", async () => {
    await start([step("a")]);
    now = T0 + 6 * 86_400_000;
    await moves.run({
      move_id: "m-2",
      role: "desk",
      from: "box-a",
      to: "mac",
      by: "admin-1",
      steps: [step("b")],
    });
    // A directory with no record at all is aged by its own time.
    const stray = moveDir(home, "stray");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, "log.jsonl"), "");
    const old = new Date(T0 - 86_400_000);
    utimesSync(stray, old, old);
    now = T0 + DAEMON_DEFAULTS.role_move_retention_ms + 1000;
    const removed = await moves.sweep();
    expect(removed.sort()).toEqual(["m-1", "stray"]);
    expect(existsSync(moveDir(home, "m-1"))).toBe(false);
    expect(existsSync(moveDir(home, "m-2"))).toBe(true);
    expect(cleared.sort()).toEqual(["m-1", "stray"]);
  });

  it("keeps each move's record for a rollback, and every published record validates", async () => {
    await start([step("a"), step("b")]);
    expect(moves.read("m-1")).toMatchObject({ move_id: "m-1", status: "done", by: "admin-1" });
    await moves.run({
      move_id: "m-2",
      role: "desk",
      from: "mac",
      to: "box-a",
      by: "admin-1",
      steps: [step("x", { run: async () => Promise.reject(new Error("no")) })],
    });
    for (const p of published) {
      expect(
        schemaErrors("role-move.schema.json", envelope("_system/roles/moves", "role_move", p)),
      ).toEqual([]);
    }
  });

  it("a step that is the health check publishes health_check while it runs", async () => {
    await start([step("a"), step("check", { health: true }), step("c")]);
    expect(published.some((p) => p.status === "health_check")).toBe(true);
  });
});
