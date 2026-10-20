// The Terminal's font stack: the Desk's mono families, then the bundled Symbols Nerd Font Mono
// for Nerd Font and powerline glyphs (Private Use Areas only, served by the Desk, no CDN).
// jsdom applies no stylesheet, so this guards the CSS itself.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(path.resolve(__dirname, "..", p), "utf8");
const desk = read("src/styles/desk.css");
const agent = read("src/styles/agent.css");
const notices = read("THIRD_PARTY_NOTICES.md");

const token = (css: string, name: string) => {
  const m = css.match(new RegExp(`${name}:\\s*([^;]+);`));
  expect(m, `${name} is declared`).not.toBeNull();
  return (m as RegExpMatchArray)[1]?.replace(/\s+/g, " ").trim() ?? "";
};

describe("terminal font stack", () => {
  it("--f-term is the --f-mono families followed by Symbols Nerd Font Mono", () => {
    const mono = token(desk, "--f-mono");
    const term = token(desk, "--f-term");
    expect(term.startsWith(mono)).toBe(true);
    expect(term.endsWith('"Symbols Nerd Font Mono"')).toBe(true);
  });

  it("declares a local @font-face limited to the Private Use Areas", () => {
    const at = desk.indexOf("@font-face");
    expect(at).toBeGreaterThanOrEqual(0);
    const face = desk.slice(at, desk.indexOf("}", at));
    expect(face).toMatch(/font-family: "Symbols Nerd Font Mono";/);
    const src = face.match(/src: url\("([^"]+)"\)/);
    expect(src).not.toBeNull();
    const url = (src as RegExpMatchArray)[1] as string;
    expect(url.startsWith("/fonts/")).toBe(true);
    expect(url).not.toMatch(/http/);
    expect(existsSync(path.resolve(__dirname, "../public", url.slice(1)))).toBe(true);
    expect(face).toMatch(/unicode-range:[^;]*U\+E000-F8FF/);
    expect(face).toMatch(/unicode-range:[^;]*U\+F0000-FFFFD/);
    expect(face).toMatch(/font-display: swap;/);
  });

  it("the card's .term uses the terminal stack", () => {
    const at = agent.indexOf(".term {\n  padding");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(agent.slice(at, agent.indexOf("}", at))).toMatch(/var\(--f-term\)/);
  });

  it("records the font's licence and release in the third-party notices", () => {
    expect(notices).toMatch(/^## Symbols Nerd Font Mono/m);
    expect(notices).toMatch(/v3\.\d+\.\d+/);
    expect(notices).toMatch(/Copyright \(c\) 2014 Ryan L McIntyre/);
  });
});
