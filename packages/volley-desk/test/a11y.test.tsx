import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { REDUCED_MOTION_QUERY, useReducedMotion } from "../src/a11y/motion";
import { CHROMES } from "../src/look/options";
import { LOOK_STORAGE_KEY } from "../src/look/useLook";
import { BrokerAccounts } from "../src/settings/BrokerAccounts";
import { Machines } from "../src/settings/Machines";
import { Setup } from "../src/settings/Setup";
import { SetupWizard } from "../src/settings/SetupWizard";
import { DeskStoreProvider } from "../src/store/context";
import { PLAN, fakeOps } from "./helpers/auth-ops";
import { machineRecord, readiness } from "./helpers/desk-msgs";
import { fakePeerOps } from "./helpers/peer-ops";

const renderApp = () =>
  render(
    <DeskStoreProvider demo>
      <App />
    </DeskStoreProvider>,
  );

const realMatchMedia = window.matchMedia;
function prefersReducedMotion(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on && query === REDUCED_MOTION_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ bg: "none", autoArrange: false }));
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.restoreAllMocks();
});

async function violations(): Promise<string[]> {
  const results = await axe.run(document.body, {
    // jsdom does no layout, so axe cannot measure colours: contrast is checked below.
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.map(
    (v) => `${v.id}: ${v.help}\n  ${v.nodes.map((n) => n.target.join(" ")).join("\n  ")}`,
  );
}

describe("Machines v2: rows and sheets", () => {
  const renderMachines = () => {
    const ops = fakePeerOps({
      known: vi.fn(() => "admin" as const),
      doctor: vi.fn(async () => ({
        ok: true as const,
        checks: [],
        plan: [
          { id: "hooks", ok: false, severity: "warn" as const, detail: "no hooks", fix: "x" },
          {
            id: "gh.auth",
            ok: false,
            severity: "block" as const,
            detail: "no gh",
            fix: "gh auth login",
          },
        ],
      })),
    });
    const failing = machineRecord({
      checks: [
        { id: "tool.git", ok: true, severity: "block", detail: "git 2.47.0" },
        { id: "gh.auth", ok: false, severity: "block", detail: "gh is not signed in" },
      ],
    });
    // In a landmark, as the Settings window has it.
    render(
      <main>
        <Machines
          machines={{ "box-a": failing }}
          readiness={{ "box-a": readiness() }}
          hosts={["box-a"]}
          hubUp
          ops={ops}
          configTransport={{ identity: "owner-desk", send: vi.fn() }}
        />
      </main>,
    );
  };

  it("every check row has a name, and the card has no violations", async () => {
    renderMachines();
    await act(async () => {});
    for (const li of screen.getAllByRole("listitem")) expect(li).toHaveAccessibleName();
    expect(await violations()).toEqual([]);
  }, 30_000);

  it("the Repair sheet traps focus and has no violations", async () => {
    renderMachines();
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Repair…" }));
    });
    const dialog = screen.getByRole("dialog", { name: "Repair box-a" });
    expect(dialog).toHaveFocus();
    const inside = within(dialog).getAllByRole("button");
    const last = inside[inside.length - 1] as HTMLElement;
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(last);
    expect(await violations()).toEqual([]);
  }, 30_000);
});

describe("axe (jsdom)", () => {
  it("reports no violations on the demo canvas", async () => {
    renderApp();
    expect(await violations()).toEqual([]);
  }, 30_000);

  it("reports no violations with the Machines window open", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Machines" }));
    expect(screen.getByRole("region", { name: "Machines" })).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  }, 30_000);

  it("reports no violations with a terminal popout open", async () => {
    renderApp();
    fireEvent.click(screen.getAllByRole("tab", { name: "Terminal" })[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Open terminal in a window" }));
    expect(screen.getByRole("dialog", { name: /^Terminal: / })).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  }, 30_000);

  it("reports no violations with a steering panel and the wave settings open", async () => {
    renderApp();
    fireEvent.click(screen.getAllByRole("button", { name: /^Message / })[0] as HTMLElement);
    expect(await violations()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Settings for ci-speed" }));
    expect(await violations()).toEqual([]);
  }, 30_000);

  it.each([
    "General",
    "Appearance",
    "Supervisor",
    "Broker accounts",
    "Setup & Security",
    "Machines",
    "Repositories",
    "About Volley",
  ])(
    "reports no violations in the Settings window's %s section",
    async (section) => {
      renderApp();
      fireEvent.click(
        within(screen.getByRole("toolbar", { name: "Dock" })).getByRole("button", {
          name: "Settings",
        }),
      );
      fireEvent.click(
        within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", {
          name: section,
        }),
      );
      expect(await violations()).toEqual([]);
    },
    30_000,
  );
});

describe("axe (jsdom): the admin's onboarding views", () => {
  const accounts = () =>
    fakeOps({
      setup_plan: () => ({ ok: true, result: PLAN }),
      account_list: () => ({
        ok: true,
        result: {
          accounts: [
            {
              name: "admin-0123abcd",
              role: "admin",
              kind: "human",
              created: "2026-10-18T10:00:00Z",
            },
            { name: "desk-ipad", role: "steer", kind: "device", created: "2026-10-18T10:00:00Z" },
          ],
        },
      }),
    }).ops;

  it("reports no violations in Broker accounts", async () => {
    // In the Desk these live inside the Settings dialog: a <main> stands in for its landmark.
    render(
      <main>
        <BrokerAccounts ops={accounts()} admin identity="admin-0123abcd" liveAgents={3} />
      </main>,
    );
    await screen.findByText("desk-ipad");
    expect(await violations()).toEqual([]);
  }, 30_000);

  it("reports no violations in Setup & Security", async () => {
    render(
      <main>
        <Setup
          ops={accounts()}
          admin
          identity="admin-0123abcd"
          brokerUrl="ws://desk.example:9001"
          deskUrl="http://desk.example:5199/"
          onOpenSetup={() => {}}
        />
      </main>,
    );
    await screen.findByText("On");
    expect(await violations()).toEqual([]);
  }, 30_000);

  it("reports no violations in the setup wizard", async () => {
    render(<SetupWizard ops={accounts()} deskUrl="http://desk.example:5199/" onClose={() => {}} />);
    await screen.findByText("Found your broker");
    expect(await violations()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await violations()).toEqual([]);
  }, 30_000);
});

describe("landmarks and roles", () => {
  it("every window is a labelled section", () => {
    const { container } = renderApp();
    const wins = [...container.querySelectorAll(".world .win")];
    expect(wins.length).toBeGreaterThan(3);
    for (const w of wins) {
      expect(w.tagName).toBe("SECTION");
      expect(
        w.getAttribute("aria-label")?.trim() || w.getAttribute("aria-labelledby"),
      ).toBeTruthy();
    }
    const names = wins.map((w) => w.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
  });

  it("tabs are tabs, progress bars carry their value, narration and Needs-you are live", () => {
    const { container } = renderApp();
    for (const list of container.querySelectorAll(".tabs")) {
      expect(list).toHaveAttribute("role", "tablist");
      const tabs = within(list as HTMLElement).getAllByRole("tab");
      expect(tabs.filter((t) => t.getAttribute("aria-selected") === "true")).toHaveLength(1);
    }
    const bars = [...container.querySelectorAll(".agent-foot .bar")];
    expect(bars.length).toBeGreaterThan(0);
    for (const b of bars) {
      expect(b).toHaveAttribute("role", "progressbar");
      expect(b).toHaveAttribute("aria-valuemin", "0");
      expect(b).toHaveAttribute("aria-valuemax", "100");
      expect(b).toHaveAccessibleName();
    }
    // An agent with progress exposes it.
    expect(bars.some((b) => b.hasAttribute("aria-valuenow"))).toBe(true);
    for (const n of container.querySelectorAll(".narr")) expect(n).toHaveAttribute("aria-live");
    const banners = [...container.querySelectorAll(".needs-you")];
    expect(banners.length).toBeGreaterThan(0);
    for (const b of banners) expect(b).toHaveAttribute("role", "status");
  });
});

describe("reduced motion", () => {
  it("useReducedMotion follows prefers-reduced-motion", () => {
    prefersReducedMotion(true);
    expect(renderHook(() => useReducedMotion()).result.current).toBe(true);
    prefersReducedMotion(false);
    expect(renderHook(() => useReducedMotion()).result.current).toBe(false);
  });

  it("narration drops DecryptedText / ShinyText for plain text", () => {
    prefersReducedMotion(true);
    const { container } = renderApp();
    const narr = [...container.querySelectorAll(".world .narr")];
    expect(narr.length).toBeGreaterThan(0);
    for (const n of narr) expect(n).toHaveAttribute("data-fx", "plain");
  });

  it("the stylesheets stop born / hop / pulse / caret / tether / arrange animation", () => {
    const css = readFileSync(join(__dirname, "../src/styles/responsive.css"), "utf8");
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const sel of [
      ".win--born",
      ".clawd--wait",
      ".win-attn-pulse",
      ".caret",
      ".tether",
      ".world--anim",
    ]) {
      expect(block, sel).toContain(sel);
    }
  });
});

// ------------------------------------------------------------------ contrast

type RGB = [number, number, number];
const STYLES = join(__dirname, "../src/styles");
const css = (f: string) => readFileSync(join(STYLES, f), "utf8");

function parseColor(c: string): { rgb: RGB; a: number } {
  const hex = c.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = Number.parseInt(hex[1] as string, 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], a: 1 };
  }
  const m = c.match(/^rgba?\(([^)]+)\)$/);
  if (!m) throw new Error(`colour ${c}`);
  const [r, g, b, a = "1"] = (m[1] as string).split(",").map((s) => s.trim());
  return { rgb: [Number(r), Number(g), Number(b)], a: Number(a) };
}
const over = (top: { rgb: RGB; a: number }, under: RGB): RGB =>
  top.rgb.map((v, i) => v * top.a + (under[i] as number) * (1 - top.a)) as RGB;
function luminance([r, g, b]: RGB): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
const token = (name: string): string => {
  const m = css("desk.css").match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`--${name}`);
  return (m[1] as string).trim();
};
const resolveVar = (v: string) => v.replace(/^var\(--([a-z-]+)\)$/, (_, n: string) => token(n));
function chromeRule(chrome: string): string {
  for (const f of ["desk.css", "look.css"]) {
    const m = css(f).match(new RegExp(`\\.win-inner\\.chrome-${chrome}\\s*\\{([^}]*)\\}`));
    if (m) return m[1] as string;
  }
  throw new Error(`no rule for chrome-${chrome}`);
}
function chromeBackground(chrome: string): string {
  const m = chromeRule(chrome).match(/background-color:\s*([^;]+);/);
  if (!m) throw new Error(`no background for chrome-${chrome}`);
  return resolveVar((m[1] as string).trim());
}
/** The colour stops of a chrome's depth gradient (`--win-body`, D10). */
function bodyStops(chrome: string): string[] {
  const m = chromeRule(chrome).match(/--win-body:\s*([^;]+);/);
  // The stops are tokens (desk.css :root, the Volley theme): resolve them first.
  const body = (m?.[1] ?? "").replace(/var\(--([a-z0-9-]+)\)/g, (_, n: string) => token(n));
  return [...body.matchAll(/rgba?\([^)]+\)|#[0-9a-f]{6}/gi)].map((x) => x[0]);
}

describe("contrast (WCAG AA, 4.5:1 for text)", () => {
  // Over the plain background the Desk falls back to (and with the default dim
  // over the darker React Bits backgrounds), every chrome must keep body,
  // muted and dim text at AA. Glow draws its own BorderGlow fill (Frame.tsx).
  const ground = parseColor(token("ground")).rgb;
  // The depth gradient (D10) lies over the body colour: every one of its stops must keep AA.
  const surfaces: Record<string, RGB[]> = {};
  for (const chrome of CHROMES) {
    const bg = chrome === "glow" ? "rgba(14,16,26,.78)" : chromeBackground(chrome);
    const body = over(parseColor(bg), ground);
    surfaces[chrome] = [body, ...bodyStops(chrome).map((c) => over(parseColor(c), body))];
  }

  it.each(CHROMES)("text tokens on the %s chrome", (chrome) => {
    expect(bodyStops(chrome).length, `${chrome} depth gradient`).toBeGreaterThan(0);
    for (const surface of surfaces[chrome] as RGB[]) {
      // --amber and --bad: the Machines window's numbers at 70 / 90 %.
      for (const t of ["ink", "mute", "dim", "amber", "bad"]) {
        const ratio = contrast(parseColor(token(t)).rgb, surface);
        expect(ratio, `--${t} on ${chrome}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("the top bar and needs-you pill text on the Desk ground", () => {
    for (const t of ["ink", "mute", "dim"]) {
      expect(contrast(parseColor(token(t)).rgb, ground)).toBeGreaterThanOrEqual(4.5);
    }
    const pill = over(parseColor("rgba(255, 122, 89, 0.16)"), ground);
    expect(contrast(parseColor("#ffd0c4").rgb, pill)).toBeGreaterThanOrEqual(4.5);
  });
});
