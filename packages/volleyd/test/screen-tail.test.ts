import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { screenHash, screenTail } from "../src/screen-tail";

const SCREENS = new URL("./fixtures/screens/", import.meta.url).pathname;
const screen = (name: string) => readFileSync(join(SCREENS, name), "utf-8");

describe("screenTail", () => {
  it("keeps the transcript above the ❯ prompt: no input box, status bar or (ctrl+…) hints", () => {
    expect(screenTail(screen("claude-session.txt"), 40)).toEqual([
      "> fix the flaky retry test in packages/api",
      "● Bash(bun run test)",
      "  ⎿  ✓ 42 passed",
      "     ✗ 1 failed: retry.test.ts > backs off",
      "     … +18 lines",
      "● Read(src/retry.ts)",
      "  ⎿  Read 120 lines",
      "● Update(src/retry.ts)",
      "  ⎿  Updated src/retry.ts with 2 additions and 1 removal",
      "✳ Sautéing… (34s · ↓ 2.1k tokens · esc to interrupt)",
    ]);
  });

  it("drops a draft typed into the input box", () => {
    const text = [
      "● Done.",
      "───────────",
      "❯ also update the README",
      "  and the changelog",
      "───────────",
      "  ? for shortcuts",
    ].join("\n");
    expect(screenTail(text, 40)).toEqual(["● Done."]);
  });

  it("cuts at the older boxed `│ >` prompt too", () => {
    const tail = screenTail(screen("working.txt"), 40);
    expect(tail.at(-1)).toBe("✶ Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)");
    expect(tail.join("\n")).not.toContain("bypass permissions");
  });

  it("a menu's ❯ (not between rules) is not the prompt", () => {
    const tail = screenTail(screen("login.txt"), 40);
    expect(tail.at(-1)).toBe("   2. Anthropic Console account · API usage billing");
    expect(tail).toContain(
      " ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise",
    );
  });

  it("a screen without a prompt → its last N non-blank lines", () => {
    expect(screenTail(screen("shell-prompt.txt"), 40)).toEqual([
      "user@machine ~/.volley/worktrees/w1/T1-implementer %",
    ]);
    const long = Array.from({ length: 70 }, (_, i) => (i % 2 === 0 ? `line ${i}` : "")).join("\n");
    const tail = screenTail(long, 5);
    expect(tail).toEqual(["line 60", "line 62", "line 64", "line 66", "line 68"]);
    expect(screenTail(screen("blank.txt"), 40)).toEqual([]);
  });

  it("keeps only the last N lines above the prompt", () => {
    const body = Array.from({ length: 50 }, (_, i) => `out ${i}`);
    const text = [...body, "─────", "❯ ", "─────"].join("\n");
    const tail = screenTail(text, 40);
    expect(tail).toHaveLength(40);
    expect(tail[0]).toBe("out 10");
    expect(tail.at(-1)).toBe("out 49");
  });

  it("normalises CRLF and trailing spaces", () => {
    expect(screenTail("a  \r\nb\t\r\n", 40)).toEqual(["a", "b"]);
  });
});

describe("screenHash", () => {
  it("is stable for equal lines and differs otherwise", () => {
    expect(screenHash(["a", "b"])).toBe(screenHash(["a", "b"]));
    expect(screenHash(["a", "b"])).not.toBe(screenHash(["a", "b", ""]));
    expect(screenHash(["ab"])).not.toBe(screenHash(["a", "b"]));
    expect(screenHash([])).toMatch(/^[0-9a-f]{16,}$/);
  });
});
