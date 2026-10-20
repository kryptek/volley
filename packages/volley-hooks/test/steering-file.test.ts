import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendBlock,
  hasBlock,
  liveDirectives,
  markDelivered,
  markSuperseded,
  readBlocks,
} from "../src/lib/steering-file";

const path = () => join(mkdtempSync(join(tmpdir(), "volley-hooks-steer-")), "STEERING.md");
const base = { type: "steering", from: "coord-a", at: "2026-10-18T10:00:00.000Z" };

describe("STEERING.md", () => {
  it("round-trips blocks, including multi-line text and markdown headings in it", () => {
    const p = path();
    appendBlock(p, { ...base, seq: 1, id: "id-1", text: "line one\n## not a header\nline three" });
    appendBlock(p, { ...base, seq: null, id: "id-2", type: "cancel", text: "stop" });
    expect(readFileSync(p, "utf-8")).toContain("## 1 steering id-1\n");
    expect(readFileSync(p, "utf-8")).toContain("## - cancel id-2\n");
    const blocks = readBlocks(p);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ seq: 1, id: "id-1", from: "coord-a", state: "live" });
    expect(blocks[0]?.text).toBe("line one\n## not a header\nline three");
    expect(blocks[1]).toMatchObject({ seq: null, type: "cancel", text: "stop" });
    expect(hasBlock(p, "id-2")).toBe(true);
    expect(hasBlock(p, "id-3")).toBe(false);
  });

  it("supersedes only a live block from the same sender", () => {
    const p = path();
    appendBlock(p, { ...base, seq: 1, id: "id-1", text: "a" });
    expect(markSuperseded(p, "id-1", "id-9", "coord-b")).toBe(false);
    expect(markSuperseded(p, "id-1", "id-2", "coord-a")).toBe(true);
    expect(readBlocks(p)[0]).toMatchObject({ state: "superseded", supersededBy: "id-2" });
    expect(liveDirectives(p)).toEqual([]);
  });

  it("round-trips text byte for byte, including escapes and blank edges", () => {
    const p = path();
    const texts = [
      "\n\nleading blank\n ## indented heading\n## heading\n\\## escaped-looking\ntrailing\n\n",
      "",
      "\\",
      "## \n\\## \n \\## ",
    ];
    texts.forEach((text, i) => appendBlock(p, { ...base, seq: i, id: `id-${i}`, text }));
    markDelivered(p, ["id-1"]);
    expect(readBlocks(p).map((b) => b.text)).toEqual(texts);
    expect(readBlocks(p).map((b) => b.id)).toEqual(["id-0", "id-1", "id-2", "id-3"]);
  });

  it("marks blocks delivered without touching their state", () => {
    const p = path();
    appendBlock(p, { ...base, seq: 1, id: "id-1", text: "a" });
    appendBlock(p, { ...base, seq: 2, id: "id-2", text: "b" });
    expect(readBlocks(p).map((b) => b.delivered)).toEqual([false, false]);
    markDelivered(p, ["id-2"]);
    expect(readBlocks(p).map((b) => [b.id, b.state, b.delivered])).toEqual([
      ["id-1", "live", false],
      ["id-2", "live", true],
    ]);
  });

  it("a missing file has no blocks", () => {
    expect(readBlocks(path())).toEqual([]);
  });
});
