import { afterEach, describe, expect, it } from "vitest";
import {
  OWNED_PROPERTIES,
  applyLookToDocument,
  applyTheme,
  applyThemeTokens,
} from "../src/look/applyLook";
import { contrast, oklabMix, parseColor, toHex } from "../src/look/color";
import {
  REQUIRED_TOKENS,
  THEMES,
  THEME_IDS,
  THEME_LABEL,
  TOKEN_PROPERTY,
  type ThemeDef,
  deriveTokens,
  themeById,
} from "../src/look/themes";
import { LOOK0 } from "../src/look/useLook";

describe("color", () => {
  it("computes WCAG contrast", () => {
    expect(contrast("#ffffff", "#000000")).toBe(21);
    // --dim on the solid chrome's light end (the tightest Volley surface)
    expect(contrast("#7c859d", "#1a1d2c")).toBeCloseTo(4.54, 2);
    expect(contrast("#7c859d", "#07080d")).toBeCloseTo(5.43, 2);
  });

  it("mixes in oklab as the browser's color-mix does", () => {
    expect(oklabMix("#6ee7f9", "#0b0f1c", 0.62)).toBe("#468c9d");
    expect(oklabMix("#009688", "#222e34", 0.62)).toBe("#226c67");
  });

  it("parses hex and rgb()/rgba()", () => {
    expect(parseColor("rgba(214, 224, 255, 0.1)")).toEqual([214, 224, 255, 0.1]);
    expect(parseColor("rgb(110, 190, 249)")).toEqual([110, 190, 249, 1]);
    expect(parseColor("#abc")).toEqual([170, 187, 204, 1]);
    expect(parseColor("#6ee7f9")).toEqual([110, 231, 249, 1]);
    expect(parseColor("#00000080")[3]).toBeCloseTo(0.502, 3);
    expect(() => parseColor("teal")).toThrow();
    expect(toHex([110, 231, 249, 1])).toBe("#6ee7f9");
  });
});

const SURFACES = ["bg", "win1", "win2", "panel", "well", "pit"] as const;

describe("theme registry", () => {
  it("lists the twelve themes in the approved order, with unique names", () => {
    expect(THEME_IDS).toEqual([
      "volley",
      "oceanic",
      "darker",
      "palenight",
      "deepocean",
      "lighter",
      "dracula",
      "nightowl",
      "onedark",
      "github",
      "monokai",
      "solarized",
    ]);
    expect(new Set(THEME_LABEL.map(([, name]) => name)).size).toBe(12);
  });

  it("gives Volley every required token as a colour, dark", () => {
    const v = themeById("volley");
    expect(v.tone).toBe("dark");
    for (const k of REQUIRED_TOKENS) expect(() => parseColor(v.v[k] ?? ""), k).not.toThrow();
  });

  it("falls back to Volley for an id without an entry", () => {
    // Material Lighter is listed in the picker but has no entry until #368.
    expect(themeById("lighter").id).toBe(
      THEMES.some((t) => t.id === "lighter") ? "lighter" : "volley",
    );
    expect(themeById("neon").id).toBe("volley");
  });

  it("pins Volley's derived tokens (the explicit current step wins over the mix)", () => {
    const d = deriveTokens(themeById("volley"));
    expect(d.accHi).toBe("#b7f3fc");
    expect(d.cur1).toBe("#3a7182");
    expect(d.cur2).toBe("#1f3746");
    expect(d.accText).toBe(d.accHi);
  });

  // The ten dark palettes (#369), pinned to the approved values so a typo cannot pass silently.
  const DARK_PINS: [string, Record<string, string>][] = [
    ["oceanic", { acc: "#009688", bg: "#1e272c", ink: "#eeffff", dim: "#98afb6" }],
    [
      "darker",
      {
        acc: "#ff9800",
        bg: "#1a1a1a",
        ink: "#eeffff",
        dim: "#8d9191",
        onHi: "#2b1600",
        cur1: "#ad6200",
        cur2: "#7a4400",
      },
    ],
    ["palenight", { acc: "#ab47bc", bg: "#202331", ink: "#eeffff", dim: "#929db9" }],
    [
      "deepocean",
      {
        acc: "#84ffff",
        bg: "#090b10",
        ink: "#eeffff",
        dim: "#7a8498",
        onAcc: "#041a1a",
        onHi: "#041a1a",
        cur1: "#84ffff",
        cur2: "#45cfcf",
      },
    ],
    ["dracula", { acc: "#bd93f9", bg: "#21222c", ink: "#f8f8f2", dim: "#94a0c0", onHi: "#1c0f33" }],
    ["nightowl", { acc: "#7e57c2", bg: "#011627", ink: "#d6deeb", dim: "#718da4" }],
    ["onedark", { acc: "#61afef", bg: "#21252b", ink: "#e6e9ef", dim: "#979da7", onHi: "#08223a" }],
    ["github", { acc: "#2f81f7", bg: "#010409", ink: "#f0f6fc", dim: "#7d8590" }],
    [
      "monokai",
      {
        acc: "#ffd866",
        bg: "#221f22",
        ink: "#fcfcfa",
        dim: "#9c9b9b",
        onAcc: "#2d2a2e",
        onHi: "#2d2a2e",
        cur1: "#ffd866",
        cur2: "#d9b34a",
      },
    ],
    ["solarized", { acc: "#268bd2", bg: "#00212b", ink: "#eee8d5", dim: "#949f9c" }],
  ];
  const DERIVED_CUR1: Record<string, string> = {
    oceanic: "#226c67",
    github: "#235298",
    nightowl: "#4c3c7f",
  };

  describe.each(DARK_PINS)("the %s palette", (id, pins) => {
    it("has its own entry, dark, with every required token as a colour", () => {
      const t = themeById(id);
      expect(t.id).toBe(id);
      expect(t.tone).toBe("dark");
      expect(t.name).toBe(THEME_LABEL.find(([i]) => i === id)?.[1]);
      for (const k of REQUIRED_TOKENS) expect(() => parseColor(t.v[k] ?? ""), k).not.toThrow();
    });
    it("pins the approved values", () => {
      const { v } = themeById(id);
      for (const [k, want] of Object.entries(pins)) {
        expect(v[k as keyof typeof v], k).toBe(want);
      }
      const derived = DERIVED_CUR1[id];
      if (derived) {
        expect(v.cur1).toBeUndefined();
        expect(deriveTokens(themeById(id)).cur1).toBe(derived);
      }
    });
  });

  it("has an entry for every id the picker lists but Lighter (#368)", () => {
    for (const id of THEME_IDS) {
      if (id !== "lighter")
        expect(
          THEMES.some((t) => t.id === id),
          id,
        ).toBe(true);
    }
  });

  for (const t of THEMES) {
    describe(`${t.id} reaches WCAG AA`, () => {
      const { v } = t;
      const d = deriveTokens(t);
      it("text on every surface", () => {
        for (const s of SURFACES) {
          for (const ink of ["ink", "dim", "mute", "link"] as const) {
            expect(contrast(v[ink], v[s]), `${ink} on ${s}`).toBeGreaterThanOrEqual(4.5);
          }
          expect(contrast(d.accText, v[s]), `accText on ${s}`).toBeGreaterThanOrEqual(4.5);
        }
      });
      it("the current step and the pill", () => {
        expect(contrast(v.onAcc, d.cur1)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v.onAcc, d.cur2)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v.onHi, oklabMix(d.accHi, v.acc, 0.5))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v.onHi, d.accHi)).toBeGreaterThanOrEqual(3);
        expect(contrast(v.onHi, v.acc)).toBeGreaterThanOrEqual(3);
      });
      it("the done-step text", () => {
        const done = oklabMix(v.ok, v.ink, 0.55);
        expect(contrast(done, v.win1)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(done, v.win2)).toBeGreaterThanOrEqual(4.5);
      });
    });
  }
});

const html = () => document.documentElement;
const stub: ThemeDef = {
  id: "dracula",
  name: "Stub",
  tone: "light",
  v: { ...themeById("volley").v, bg: "#111111", acc: "#bd93f9", cur1: "#222222" },
};

describe("applyTheme", () => {
  afterEach(() => applyTheme("volley"));

  it("writes nothing for Volley: :root is the Volley theme", () => {
    applyTheme("volley");
    expect(html().style.length).toBe(0);
    expect(html().dataset.theme).toBeUndefined();
    expect(html().style.colorScheme).toBe("");
  });

  it("writes another theme's tokens, then data-theme, data-tone and color-scheme", () => {
    applyThemeTokens(stub);
    expect(html().style.getPropertyValue("--ground")).toBe("#111111");
    expect(html().style.getPropertyValue("--t-acc")).toBe("#bd93f9");
    expect(html().style.getPropertyValue("--cur1")).toBe("#222222");
    expect(html().style.getPropertyValue("--ink")).toBe(stub.v.ink);
    expect(html().dataset.theme).toBe("dracula");
    expect(html().dataset.tone).toBe("light");
    expect(html().style.colorScheme).toBe("light");
  });

  it("Volley again removes everything another theme wrote", () => {
    applyThemeTokens(stub);
    applyTheme("volley");
    expect(html().style.length).toBe(0);
    expect(html().dataset.theme).toBeUndefined();
    expect(html().dataset.tone).toBeUndefined();
    expect(html().style.colorScheme).toBe("");
  });

  it("owns every token property and the derived ones", () => {
    for (const p of Object.values(TOKEN_PROPERTY)) expect(OWNED_PROPERTIES).toContain(p);
    for (const p of ["--t-acc-hi", "--t-acc-lo", "--cur1", "--cur2", "--acc-text", "--hot-ink"]) {
      expect(OWNED_PROPERTIES).toContain(p);
    }
  });

  it("applyLookToDocument with the default look is a no-op", () => {
    applyLookToDocument({ ...LOOK0, theme: "volley" });
    expect(html().style.length).toBe(0);
    expect(html().getAttribute("data-theme")).toBeNull();
  });
});
