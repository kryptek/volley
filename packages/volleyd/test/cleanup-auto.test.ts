import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlClient } from "../src/control";
import type { Daemon } from "../src/daemon";
import type { JournalEvent } from "../src/types";
import { eventually } from "./helpers/broker-wait";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";

/** Cleanup runs itself when a task and the wave end (#612 D8, `cleanup_on_end`). */

const WAVE = "w-clean";
const OWNER = "coord-a";
const yaml = (extra = "") => `wave: ${WAVE}
repo: /path/to/example-repo
release_branch: release/${WAVE}
model: claude-opus-5-5
pipeline: [implement, merge_ready]
${extra}tasks:
  A: { issue: 1 }
  B: { issue: 2 }
  C: { issue: 3 }
`;

let t: DaemonEnv;
let clock: FakeClock;
let daemon: Daemon;
let client: ControlClient;

async function boot(extra = "") {
  clock = fakeClock(Date.parse("2026-10-25T10:00:00.000Z"));
  t = await makeDaemonEnv();
  daemon = await t.start({ clock });
  client = await ControlClient.connect(t.broker.url, NS);
  const res = await client.request("run", { wave_yaml: yaml(extra), owner: OWNER });
  expect(res.error).toBeUndefined();
}
afterEach(async () => {
  await client.close();
  await t.cleanup();
});

const cleaned = (): JournalEvent[] =>
  daemon.journalEvents(WAVE).filter((e) => e.type === "wave_cleaned");

/** An agent of `task` that ran and was retired (its worktree gone from disk already). */
async function ranAndRetired(task: string): Promise<void> {
  const agent_id = `${WAVE}-${task.toLowerCase()}-implementer-1`;
  await daemon.recordEvent(WAVE, {
    type: "agent_spawned",
    task,
    data: {
      agent_id,
      role: "implementer",
      host: "local",
      worktree: `/path/to/worktrees/${WAVE}/${task}-implementer`,
      branch: `${WAVE}/${task}-implementer-1`,
      credentials: "none",
    },
  });
  await daemon.recordEvent(WAVE, {
    type: "agent_retired",
    task,
    data: { agent_id, workspace_closed: true },
  });
}

const stage = (task: string, s: string) =>
  daemon.recordEvent(WAVE, { type: "stage_entered", task, data: { stage: s } });

describe("cleanup_on_end: true (the default)", () => {
  beforeEach(() => boot());

  it("a task that is done is cleaned on the next tick; a merge_ready one only once it merges", async () => {
    await ranAndRetired("A");
    await ranAndRetired("B");
    await stage("A", "done");
    await stage("B", "merge_ready");
    await daemon.tick();
    await eventually(() => {
      expect(cleaned().map((e) => e.task)).toEqual(["A"]);
      return true;
    });
    expect(cleaned()[0]?.data).toMatchObject({ by: "volleyd", task: "A", dry_run: false });
    await daemon.tick();
    expect(cleaned().map((e) => e.task)).toEqual(["A"]);
    await stage("B", "done");
    await daemon.tick();
    await eventually(() => {
      expect(cleaned().map((e) => e.task)).toEqual(["A", "B"]);
      return true;
    });
  });

  it("wave_complete with no live agent: the whole-wave run, with its summary in the state", async () => {
    await ranAndRetired("A");
    await stage("A", "done");
    await stage("B", "done");
    await stage("C", "done");
    await daemon.tick();
    await daemon.tick();
    await eventually(() => cleaned().some((e) => e.task === undefined && e.data.dry_run === false));
    const whole = cleaned().find((e) => e.task === undefined);
    expect(whole?.data.summary).toEqual(expect.stringMatching(/; kept 1$/));
    expect(whole?.data.kept).toContainEqual(
      expect.objectContaining({ kind: "release_branch", what: `release/${WAVE}` }),
    );
    expect(daemon.record(WAVE)?.state?.cleanup?.summary).toBe(whole?.data.summary);
    // Nothing runs twice.
    const n = cleaned().length;
    await daemon.tick();
    await daemon.tick();
    expect(cleaned()).toHaveLength(n);
  });

  it("the whole-wave run covers the tasks: no task pass after it, status shows it (#630)", async () => {
    await ranAndRetired("A");
    await ranAndRetired("B");
    await stage("A", "done");
    await stage("B", "done");
    await stage("C", "cancelled");
    await daemon.tick();
    await daemon.tick();
    const real = () => cleaned().filter((e) => e.data.dry_run === false);
    await eventually(() => real().some((e) => e.task === undefined));
    const whole = real().find((e) => e.task === undefined);
    // It names the tasks it covered (every done or cancelled one).
    expect([...((whole?.data.tasks as string[]) ?? [])].sort()).toEqual(["A", "B", "C"]);
    for (let i = 0; i < 3; i++) {
      await daemon.tick();
      await daemon.settled();
    }
    expect(real().filter((e) => e.task !== undefined)).toEqual([]);
    expect(daemon.record(WAVE)?.state?.cleanup?.task).toBeUndefined();
    expect(daemon.record(WAVE)?.state?.cleanup?.summary).toBe(whole?.data.summary);
  });

  it("a wave that ended before the daemon started is cleaned on its first ticks (#630 D6)", async () => {
    // Journaled with no tick in between: nothing has cleaned it when the daemon stops.
    await ranAndRetired("A");
    await stage("A", "done");
    await stage("B", "done");
    await stage("C", "done");
    await daemon.recordEvent(WAVE, { type: "wave_complete", data: {} });
    expect(daemon.record(WAVE)?.state?.status).toBe("complete");
    expect(cleaned()).toEqual([]);
    await client.close();
    await daemon.stop();
    daemon = await t.start({ clock });
    client = await ControlClient.connect(t.broker.url, NS);
    await daemon.tick();
    await daemon.tick();
    await eventually(() =>
      cleaned().some(
        (e) => e.task === undefined && e.data.dry_run === false && e.data.by === "volleyd",
      ),
    );
  });

  it("a wave resumed after its whole-wave run is cleaned again when it ends again", async () => {
    await ranAndRetired("A");
    await stage("A", "done");
    await stage("B", "done");
    await stage("C", "done");
    await daemon.tick();
    await daemon.tick();
    const whole = () => cleaned().filter((e) => e.task === undefined);
    await eventually(() => whole().length === 1);
    await daemon.recordEvent(WAVE, { type: "wave_resumed", data: { by: OWNER } });
    await stage("A", "implement");
    await ranAndRetired("A");
    await stage("A", "done");
    await eventually(async () => {
      await daemon.tick();
      return whole().length === 2;
    });
  });

  it("volleyd archive runs one last pass and its answer lists the kept items", async () => {
    await stage("A", "cancelled");
    await stage("B", "done");
    await stage("C", "done");
    await daemon.tick();
    await daemon.tick();
    expect(daemon.record(WAVE)?.state?.status).toBe("complete");
    const r = await client.request("archive", { wave: WAVE, by: OWNER });
    expect(r.ok).toBe(true);
    expect((r.result as { kept: unknown[] }).kept).toContainEqual(
      expect.objectContaining({ kind: "release_branch" }),
    );
    const types = daemon.journalEvents(WAVE).map((e) => e.type);
    expect(types.lastIndexOf("wave_cleaned")).toBeLessThan(types.indexOf("wave_archived"));
    expect(types.at(-1)).toBe("wave_archived");
  });
});

describe("cleanup_on_end: false", () => {
  beforeEach(() => boot("config: { cleanup_on_end: false }\n"));

  it("journals nothing on its own; the cleanup op then cleans everything", async () => {
    await ranAndRetired("A");
    await stage("A", "done");
    await stage("B", "done");
    await stage("C", "done");
    await daemon.tick();
    await daemon.tick();
    expect(cleaned()).toEqual([]);
    const dry = await client.request("cleanup", { wave: WAVE, by: OWNER, dry_run: true });
    expect(dry.ok).toBe(true);
    expect((dry.result as { lines: string[] }).lines.at(-1)).toBe("dry run: pass --yes to remove");
    const r = await client.request("cleanup", { wave: WAVE, by: OWNER, dry_run: false });
    expect(r.ok).toBe(true);
    const lines = (r.result as { lines: string[] }).lines;
    expect(lines).toContain(
      `kept release branch release/${WAVE}: the wave's release branch (volleyd never deletes it)`,
    );
    expect(lines.at(-1)).toMatch(/^nothing to clean; kept 1$|^cleaned /);
    expect(cleaned().filter((e) => e.data.dry_run === false)).toHaveLength(1);
    // the owner only
    const other = await client.request("cleanup", {
      wave: WAVE,
      by: "someone-else",
      dry_run: false,
    });
    expect(other.error).toContain("owned by");
  });

  it("a manual whole run does not cover a done task whose agent is not retired (#630 Q1)", async () => {
    await ranAndRetired("B");
    await stage("B", "done");
    await daemon.recordEvent(WAVE, {
      type: "agent_spawned",
      task: "A",
      data: {
        agent_id: `${WAVE}-a-implementer-1`,
        role: "implementer",
        host: "local",
        worktree: `/path/to/worktrees/${WAVE}/A-implementer`,
        branch: `${WAVE}/A-implementer-1`,
        credentials: "none",
      },
    });
    await stage("A", "done");
    const r = await client.request("cleanup", { wave: WAVE, by: OWNER, dry_run: false });
    expect(r.ok).toBe(true);
    const whole = cleaned().find((e) => e.task === undefined && e.data.dry_run === false);
    expect(whole?.data.kept).toContainEqual(
      expect.objectContaining({ kind: "worktree", task: "A" }),
    );
    // A's worktree was kept, so A's own pass is still owed; B was cleaned.
    expect(whole?.data.tasks).toEqual(["B"]);
  });
});
