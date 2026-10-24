import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OWNED_PROPERTIES } from "../src/look/applyLook";
import { TOKEN_PROPERTY, type ThemeTokens, themeById } from "../src/look/themes";

const STYLES = join(__dirname, "../src/styles");
const read = (f: string) => readFileSync(join(STYLES, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const norm = (v: string) => v.replace(/\s+/g, " ").trim();

/** The custom properties a `<selector> { … }` block of desk.css declares. */
function block(selector: string): Map<string, string> {
  const css = read("desk.css");
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("\n}", at));
  return new Map(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1] ?? "", norm(m[2] ?? "")]),
  );
}

describe("desk.css :root is the Volley theme", () => {
  const root = block(":root");
  const volley = themeById("volley").v;

  it("declares every token Volley sets with Volley's value", () => {
    for (const [key, prop] of Object.entries(TOKEN_PROPERTY) as [keyof ThemeTokens, string][]) {
      const want = volley[key];
      if (want === undefined) continue;
      expect(root.get(prop), `${key} (${prop})`).toBe(norm(want));
    }
  });

  it("declares every property a theme may write, so Volley needs none of them inline", () => {
    for (const p of OWNED_PROPERTIES) expect(root.has(p), p).toBe(true);
  });

  it("re-derives every tinted surface for the other themes (the themed block)", () => {
    const themed = block('html[data-theme]:not([data-theme="volley"])');
    const tinted = [...root.keys()].filter((p) =>
      /^--(glass|spot|liquid|well-|sheet|dock|card|lite)/.test(p),
    );
    expect(tinted.length).toBeGreaterThan(20);
    for (const p of tinted) {
      expect(themed.get(p), p).toBeDefined();
      expect(themed.get(p), p).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });
});

describe("the light tone (#368)", () => {
  it("accent-coloured text reads --acc-ink: the accent itself, darkened on a light theme", () => {
    expect(block(":root").get("--acc-ink")).toMatch(/^var\(--acc[,)]/);
    expect(block('html[data-tone="light"]').get("--acc-ink")).toMatch(
      /^color-mix\(in oklab, var\(--acc[,)].* 55%, black\)$/,
    );
  });

  it("dark ink on amber is a token on both tones", () => {
    expect(block(":root").get("--on-amber")).toBe("#1a1204");
  });

  it("the near-duplicate text tints are gone (unified onto the *-ink tokens)", () => {
    for (const f of readdirSync(STYLES).filter((f) => f.endsWith(".css"))) {
      const css = read(f);
      for (const tint of [
        "#7ee2a0",
        "#ff9d85",
        "#ff8f7a",
        "#8be9fd",
        "#ffd27a",
        "#ffd60a",
        "#1a1204",
      ]) {
        if (f === "desk.css" && tint === "#1a1204") continue;
        expect(css.toLowerCase().includes(tint), `${tint} in ${f}`).toBe(false);
      }
      expect(css, `${f}: #ff6961 as text`).not.toMatch(/(^|[\s;{])color:\s*#ff6961/i);
    }
  });

  it("the graph's task ids are filled with --acc-ink from CSS, not a presentation attribute", () => {
    expect(read("wave.css")).toMatch(/\.dag-id\s*\{[^}]*fill:\s*var\(--acc-ink\)/);
  });

  it("on a light theme the graph's node outlines and edges are drawn from --mute", () => {
    const css = read("wave.css");
    expect(css).toMatch(/html\[data-tone="light"\] \.dag-edge\s*\{[^}]*stroke:[^;]*var\(--mute\)/);
    expect(css).toMatch(
      /:where\(html\[data-tone="light"\]\) \.dag-node rect\s*\{[^}]*stroke:[^;]*var\(--mute\)/,
    );
  });

  it("the stale-terminal pill and the sign-in backdrop sit on themed surfaces", () => {
    expect(read("agent.css")).toMatch(/\.term-stale\s*\{[^}]*background:[^;]*var\(--panel-solid\)/);
    expect(read("signin.css")).toMatch(
      /\.signin-backdrop\s*\{[^}]*background:\s*var\(--signin-ground\)/,
    );
  });

  it("no accent is text without going through --acc-ink", () => {
    for (const f of readdirSync(STYLES).filter((f) => f.endsWith(".css"))) {
      expect(read(f), f).not.toMatch(/(^|[\s;{])(color|fill):\s*var\(--acc[,)]/);
    }
  });
});

describe("colour literals in the Desk's stylesheets", () => {
  it("only go down (the ratchet)", () => {
    const count = readdirSync(STYLES)
      .filter((f) => f.endsWith(".css"))
      .reduce(
        (n, f) =>
          n +
          (readFileSync(join(STYLES, f), "utf8").match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? []).length,
        0,
      );
    // 409 before the token layer (#365), 297 after it, 271 after the light tone (#368). This
    // ceiling only ever goes down: re-point a literal to a token (or the themed block) rather
    // than raising it.
    expect(count).toBeLessThanOrEqual(271);
  });
});
