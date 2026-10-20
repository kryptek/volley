import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ActivityEvidence,
  NO_EVIDENCE,
  newestWrite,
  ownWorkReason,
} from "../src/activity-evidence";
import { tempDir } from "./helpers/tmp";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const T = { idle_grace_s: 180, background_wait_max_s: 7200 };
const ev = (e: Partial<ActivityEvidence>): ActivityEvidence => ({ ...NO_EVIDENCE, ...e });

describe("ownWorkReason", () => {
  it("is null without evidence", () => {
    expect(ownWorkReason(NO_EVIDENCE, NOW, T)).toBeNull();
    expect(ownWorkReason(ev({ shells_running: 0 }), NOW, T)).toBeNull();
  });

  it("names each source, the hooks' own claim first", () => {
    const all = ev({
      background_wait: { since: NOW - 60_000 },
      lease_held: true,
      lease_pool: "it",
      shells_running: 2,
      worktree_write_at: NOW - 40_000,
    });
    expect(ownWorkReason(all, NOW, T)).toBe("waiting on its own background task");
    expect(ownWorkReason({ ...all, background_wait: null }, NOW, T)).toBe("holds lease it");
    expect(ownWorkReason(ev({ lease_held: true }), NOW, T)).toBe("holds a lease");
    expect(ownWorkReason(ev({ shells_running: 2, worktree_write_at: NOW - 40_000 }), NOW, T)).toBe(
      "2 shells still running",
    );
    expect(ownWorkReason(ev({ shells_running: 1 }), NOW, T)).toBe("1 shell still running");
    expect(ownWorkReason(ev({ worktree_write_at: NOW - 40_000 }), NOW, T)).toBe(
      "worktree written 40 s ago",
    );
  });

  it("a write older than idle_grace_s or a background wait older than its cap is no evidence", () => {
    expect(ownWorkReason(ev({ worktree_write_at: NOW - 10 * 60_000 }), NOW, T)).toBeNull();
    expect(ownWorkReason(ev({ background_wait: { since: NOW - 7201_000 } }), NOW, T)).toBeNull();
  });

  it("no evidence holds off the nudge once the idle is older than background_wait_max_s", () => {
    const idleSince = NOW - 7201_000;
    for (const e of [
      ev({ lease_held: true, lease_pool: "it" }),
      ev({ shells_running: 1 }),
      ev({ worktree_write_at: NOW - 40_000 }),
      ev({ background_wait: { since: NOW - 60_000 } }),
    ])
      expect(ownWorkReason(e, NOW, T, idleSince)).toBeNull();
    expect(ownWorkReason(ev({ shells_running: 1 }), NOW, T, NOW - 7199_000)).toBe(
      "1 shell still running",
    );
  });
});

describe("newestWrite", () => {
  const opts = (max = 100) => ({ now: NOW, freshMs: 180_000, maxEntries: max });
  const file = (root: string, rel: string, at: number) => {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "x");
    utimesSync(p, at / 1000, at / 1000);
  };

  it("returns the newest mtime, ignoring .git, .volley, node_modules, target and build", async () => {
    const root = tempDir("volleyd-evidence-");
    file(root, "src/a.ts", NOW - 20 * 60_000);
    file(root, "src/deep/b.ts", NOW - 15 * 60_000);
    for (const skip of [".git", ".volley", "node_modules", "target", "build"])
      file(root, `${skip}/x`, NOW - 1000);
    expect(await newestWrite(root, opts())).toBe(NOW - 15 * 60_000);
  });

  it("stops at the first fresh file", async () => {
    const root = tempDir("volleyd-evidence-");
    file(root, "fresh.log", NOW - 5000);
    for (let i = 0; i < 20; i++) file(root, `old/${i}.ts`, NOW - 60 * 60_000);
    expect(await newestWrite(root, opts(3))).toBe(NOW - 5000);
  });

  it("is null past maxEntries and for a vanished directory", async () => {
    const root = tempDir("volleyd-evidence-");
    for (let i = 0; i < 10; i++) file(root, `old/${i}.ts`, NOW - 60 * 60_000);
    expect(await newestWrite(root, opts(5))).toBeNull();
    rmSync(root, { recursive: true, force: true });
    expect(await newestWrite(root, opts())).toBeNull();
    expect(await newestWrite(join(root, "never"), opts())).toBeNull();
  });
});
