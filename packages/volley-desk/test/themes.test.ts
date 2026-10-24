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
import { ACCENT_PALETTE, NEUTRAL_ACCENT } from "../src/windows/wave/accent";

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
    expect(themeById("dracula").id).toBe(
      THEMES.some((t) => t.id === "dracula") ? "dracula" : "volley",
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

describe("Material Lighter (#368)", () => {
  const t = themeById("lighter");
  const { v } = t;

  it("is the light entry", () => {
    expect(t.id).toBe("lighter");
    expect(t.tone).toBe("light");
    expect(v).toMatchObject({ dim: "#5e6c73", link: "#4f6b98", cur1: "#00798a", cur2: "#005662" });
    expect(v.accText).toBe("#006974");
  });

  it("gives every semantic colour a text tint that reaches AA on every surface", () => {
    for (const ink of ["hotInk", "amberInk", "okInk", "badInk", "infoInk", "mineInk"] as const) {
      const c = v[ink];
      expect(c, ink).toBeDefined();
      for (const s of SURFACES) {
        expect(contrast(c ?? "", v[s]), `${ink} on ${s}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("darkens every wave accent to AA text (the --acc-ink recipe)", () => {
    for (const acc of [...ACCENT_PALETTE, NEUTRAL_ACCENT]) {
      const ink = oklabMix(acc, "#000000", 0.55);
      for (const s of SURFACES) {
        expect(contrast(ink, v[s]), `${acc} on ${s}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
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

  it("Material Lighter sets the light tone and colour scheme", () => {
    applyTheme("lighter");
    expect(html().dataset.theme).toBe("lighter");
    expect(html().dataset.tone).toBe("light");
    expect(html().style.colorScheme).toBe("light");
    expect(html().style.getPropertyValue("--ok-ink")).toBe("#1b5e20");
  });

  it("applyLookToDocument with the default look is a no-op", () => {
    applyLookToDocument({ ...LOOK0, theme: "volley" });
    expect(html().style.length).toBe(0);
    expect(html().getAttribute("data-theme")).toBeNull();
  });
});
