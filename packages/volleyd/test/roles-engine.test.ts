import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import type { RoleDeps } from "../src/roles/deps";
import { type MovePayload, type MoveStep, RoleMoves, moveDir, planId } from "../src/roles/engine";
import { RoleOps } from "../src/roles/ops";
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

  it("a move that rolls another back marks it rolled_back once done, journaling role_rolled_back", async () => {
    await start([step("a")]);
    events = [];
    const r = await moves.run({
      move_id: "m-2",
      role: "desk",
      from: "box-a",
      to: "mac",
      by: "admin-2",
      steps: [step("b")],
      rolls_back: "m-1",
    });
    expect(r).toMatchObject({ ok: true, status: "done" });
    expect(moves.read("m-1")?.status).toBe("rolled_back");
    expect(published.at(-1)).toMatchObject({ move_id: "m-1", status: "rolled_back" });
    const ev = events.find((e) => e.type === "role_rolled_back");
    expect(ev?.data).toEqual({ by: "admin-2", move_id: "m-1", role: "desk", to: "mac" });
  });

  it("a rollback that fails leaves the move it undoes done", async () => {
    await start([step("a")]);
    await moves.run({
      move_id: "m-2",
      role: "desk",
      from: "box-a",
      to: "mac",
      by: "admin-1",
      steps: [step("b", { run: async () => Promise.reject(new Error("no")) })],
      rolls_back: "m-1",
    });
    expect(moves.read("m-1")?.status).toBe("done");
    expect(events.some((e) => e.type === "role_rolled_back")).toBe(false);
  });

  it("markRolledBack survives a publish that throws", async () => {
    await start([step("a")]);
    const quiet = new RoleMoves({
      home,
      now: () => new Date(now),
      publish: async () => Promise.reject(new Error("broker gone")),
      clear: async () => {},
      journal: () => {},
      log: () => {},
    });
    await expect(quiet.markRolledBack("m-1", "admin-1", "mac")).resolves.toBeUndefined();
    expect(quiet.read("m-1")?.status).toBe("rolled_back");
  });

  it("releases the lock after a failing step and after a publish that throws", async () => {
    await start([step("a", { run: async () => Promise.reject(new Error("no")) })]);
    expect(moves.refusal()).toBeNull();
    const broken = new RoleMoves({
      home,
      now: () => new Date(now),
      publish: async () => {},
      clear: async () => {},
      journal: () => {
        throw new Error("journal full");
      },
      log: () => {},
    });
    await expect(
      broken.run({ move_id: "m-3", role: "desk", from: "a", to: "b", by: "x", steps: [step("a")] }),
    ).rejects.toThrow("journal full");
    expect(broken.refusal()).toBeNull();
  });

  it("an undo that fails answers rolled_back: false", async () => {
    const r = await start([
      step("a", { undo: async () => Promise.reject(new Error("stuck")) }),
      step("b", { run: async () => Promise.reject(new Error("no")) }),
    ]);
    expect(r).toMatchObject({ ok: false, step: "b", rolled_back: false });
  });

  it("a resumed move that fails answers rolled_back: false (the old machine's steps were not undone)", async () => {
    const first = await moves.run({
      move_id: "m-1",
      role: "supervisor",
      from: "mac",
      to: "box-a",
      by: "admin-1",
      steps: [step("bundle", { handover: true })],
    });
    expect(first).toMatchObject({ ok: true, handing_over: true });
    const resume = moves.read("m-1");
    if (resume === null) throw new Error("no record");
    const r = await moves.run({
      move_id: "m-1",
      role: "supervisor",
      from: "mac",
      to: "box-a",
      by: "admin-1",
      steps: [step("bundle"), step("record", { run: async () => Promise.reject(new Error("no")) })],
      resume,
    });
    expect(r).toMatchObject({ ok: false, step: "record", rolled_back: false });
  });

  it("a handed-over record is never republished and ages out like a finished one", async () => {
    await moves.run({
      move_id: "m-1",
      role: "supervisor",
      from: "mac",
      to: "box-a",
      by: "admin-1",
      steps: [step("bundle", { handover: true }), step("record")],
    });
    expect(moves.read("m-1")).toMatchObject({ status: "running", handed_over: true });
    published = [];
    await moves.republish();
    expect(published).toEqual([]);
    now = T0 + DAEMON_DEFAULTS.role_move_retention_ms + 1000;
    expect(await moves.sweep()).toEqual(["m-1"]);
  });

  it("at start, a move left running by a crash is ended failed, not republished as running", async () => {
    let hang: () => void = () => {};
    let entered: () => void = () => {};
    const inStep = new Promise<void>((r) => {
      entered = r;
    });
    const run = moves.run({
      move_id: "m-1",
      role: "desk",
      from: "mac",
      to: "box-a",
      by: "admin-1",
      steps: [
        step("a"),
        step("b", {
          run: () =>
            new Promise<string>((done) => {
              hang = () => done("late");
              entered();
            }),
        }),
      ],
    });
    await inStep;
    // A new process: the same home, no move in progress.
    const fresh = new RoleMoves({
      home,
      now: () => new Date(now),
      publish: async (p) => {
        published.push(structuredClone(p));
      },
      clear: async () => {},
      journal: (ev) => {
        events.push(ev);
      },
      log: () => {},
    });
    published = [];
    events = [];
    await fresh.republish();
    expect(fresh.read("m-1")).toMatchObject({ status: "failed" });
    expect(published.map((p) => p.status)).toEqual(["failed"]);
    expect(events.find((e) => e.type === "role_move_failed")?.data).toMatchObject({
      move_id: "m-1",
      rolled_back: false,
    });
    hang();
    await run;
  });
});

describe("role_rollback of a supervisor move (RoleOps)", () => {
  it("is refused while another move runs, and the move stays done", async () => {
    const home = tempDir("volleyd-roles-ops-");
    const now = T0;
    const moves = new RoleMoves({
      home,
      now: () => new Date(now),
      publish: async () => {},
      clear: async () => {},
      journal: () => {},
      log: () => {},
    });
    const ok = (id: string): MoveStep => ({
      id,
      title: id,
      where: "mac",
      detail: id,
      run: async () => "ok",
    });
    await moves.run({
      move_id: "supervisor-1",
      role: "supervisor",
      from: "mac",
      to: "box-a",
      by: "admin-1",
      steps: [ok("record")],
    });
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const inStep = new Promise<void>((r) => {
      entered = r;
    });
    const busy = moves.run({
      move_id: "desk-1",
      role: "desk",
      from: "box-a",
      to: "mac",
      by: "admin-1",
      steps: [
        {
          ...ok("hold"),
          run: () =>
            new Promise((done) => {
              release = () => done("ok");
              entered();
            }),
        },
      ],
    });
    await inStep;
    const ops = new RoleOps({
      deps: () =>
        ({
          now: () => new Date(now),
          localName: "box-a",
          roles: { supervisor: { machine: "box-a" } },
        }) as unknown as RoleDeps,
      supervisor: () => {
        throw new Error("never planned");
      },
      moves,
      finished: async () => {},
      log: () => {},
    });
    const r = await ops.handle("role_rollback", { move_id: "supervisor-1" }, "admin-1");
    expect(r).toMatchObject({ ok: false, error: "a role move is in progress: desk-1" });
    expect(moves.read("supervisor-1")?.status).toBe("done");
    release();
    await busy;
  });
});
