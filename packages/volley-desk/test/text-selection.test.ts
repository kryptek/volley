// Owner report: a drag on the empty canvas selected text across every panel. The Desk is
// user-select: none; only panel content opts back in. jsdom applies no stylesheet, so this
// guards the rules themselves (the browser behaviour is checked with Playwright).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(__dirname, "../src/styles/desk.css"), "utf8");
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
};

describe("text selection on the Desk", () => {
  it("the whole Desk (canvas, chrome, dock) does not select", () => {
    expect(rule(".app")).toMatch(/[^-]user-select: none/);
    expect(rule(".app")).toMatch(/-webkit-user-select: none/);
  });

  it("panel content selects again: narration, feed rows, the wave file, the terminal", () => {
    const content = css.match(/\.app :is\(([^)]*)\) \{[^}]*user-select: text/);
    expect(content).not.toBeNull();
    const selectors = (content?.[1] ?? "").split(",").map((x) => x.trim());
    for (const s of [".narr-txt", ".feed .env-row", ".env-json", ".yaml", ".term"]) {
      expect(selectors).toContain(s);
    }
  });
});
