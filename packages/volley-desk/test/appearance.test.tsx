import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { Appearance } from "../src/look/Appearance";
import { Background } from "../src/look/Background";
import {
  BACKGROUNDS,
  type BackgroundDef,
  NO_BACKGROUND,
  REACT_BITS_BACKGROUNDS,
  isLazyBackground,
} from "../src/look/backgrounds";
import { LOOK_STORAGE_KEY, type Look, useLook } from "../src/look/useLook";
import { DeskStoreProvider } from "../src/store/context";

/** The "Backgrounds" section of https://reactbits.dev/llms.txt (the owner's amendment). */
const REACT_BITS_63 =
  "AcidSquares AeroShards Antigravity Aurora Balatro Ballpit Beams ColorBends CRTWarp DarkVeil Dither DotField DotGrid FaultyTerminal Ferrofluid FloatingLines FluxLines Galaxy GhostFibers GradientASCII GradientBlinds GradientWaves Grainient GridDistortion GridMotion GridScan Hyperspeed Iridescence LetterGlitch Lightfall Lightning LightPillar LightRays LightTunnel LineWaves LiquidChrome LiquidEther MagicRings MagnetLines MicroSlats MoltenMetal Orb Particles PatternWaves PixelBlast PixelSnow Plasma PlasmaWave Prism PrismaticBurst Radar RippleGrid Scanner ShapeGrid ShapeWaves SideRays Silk SlicedWaves SoftAurora Threads Topography Waves WebThreads".split(
    " ",
  );

const stub: readonly BackgroundDef[] = BACKGROUNDS.map((b) => ({
  ...b,
  C: b.C ? ((() => <div data-testid={`bg-${b.key}`} />) as unknown as BackgroundDef["C"]) : null,
}));

let latest: Look;
function Harness({ onArrange = () => {} }: { onArrange?: () => void }) {
  const [look, setLook] = useLook();
  latest = look;
  return (
    <>
      <Background which={look.bg} dim={look.dim} backgrounds={stub} />
      <Appearance look={look} setLook={setLook} onClose={() => {}} onArrange={onArrange} />
    </>
  );
}
const stored = () => JSON.parse(localStorage.getItem(LOOK_STORAGE_KEY) ?? "{}");
const grid = () => within(screen.getByRole("group", { name: "Backgrounds" }));

beforeEach(() => {
  localStorage.clear();
});

describe("background registry", () => {
  it("has every free React Bits background, plus None", () => {
    expect(REACT_BITS_63).toHaveLength(63);
    expect(REACT_BITS_BACKGROUNDS.map((b) => b.key).sort()).toEqual([...REACT_BITS_63].sort());
    expect(BACKGROUNDS.map((b) => b.key)).toEqual([...REACT_BITS_63, NO_BACKGROUND]);
    expect(new Set(BACKGROUNDS.map((b) => b.name)).size).toBe(BACKGROUNDS.length);
  });

  it("lazy-loads every background into its own chunk", () => {
    for (const b of REACT_BITS_BACKGROUNDS) {
      expect(isLazyBackground(b.C), b.key).toBe(true);
      expect((b.C as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.lazy"));
    }
  });

  it("imports no background statically (it would pull its WebGL stack into the entry chunk)", () => {
    const src = join(__dirname, "../src");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter(
      (f) => /\.tsx?$/.test(f) && !f.startsWith("rb"),
    );
    expect(files.length).toBeGreaterThan(10);
    const dirs = REACT_BITS_63.join("|");
    const staticImport = new RegExp(`^\\s*import[^(]*from\\s*["'][^"']*/rb/(${dirs})/`, "m");
    for (const f of files) {
      expect(staticImport.test(readFileSync(join(src, f), "utf8")), f).toBe(false);
    }
    // The guard itself works: a static import is caught.
    expect(staticImport.test('import Aurora from "../rb/Aurora/Aurora";')).toBe(true);
  });

  it("feeds GridDistortion a generated image", () => {
    const gd = BACKGROUNDS.find((b) => b.key === "GridDistortion");
    expect(String(gd?.p?.imageSrc)).toMatch(/^data:image\/svg\+xml/);
  });
});

describe("Appearance", () => {
  it("counts the React Bits backgrounds", () => {
    render(<Harness />);
    expect(screen.getByText("· 63 from React Bits")).toBeInTheDocument();
  });

  // One test per background: each role query scans the whole grid, so 64 picks in one test
  // outran the test timeout on a loaded machine.
  it.each(BACKGROUNDS.map((b) => [b.name, b] as const))(
    "makes %s selectable and persists the pick",
    (_, b) => {
      render(<Harness />);
      fireEvent.click(grid().getByRole("button", { name: b.name }));
      expect(latest.bg).toBe(b.key);
      expect(stored().bg).toBe(b.key);
      expect(grid().getByRole("button", { name: b.name })).toHaveAttribute("aria-pressed", "true");
      expect(document.querySelector(".bg-layer")).toHaveAttribute("data-bg", b.key);
      expect(screen.getByText(b.name, { selector: ".bg-current b" })).toBeInTheDocument();
    },
  );

  it("searches the list and keeps the current choice listed", () => {
    render(<Harness />);
    const search = screen.getByRole("searchbox", { name: "Search backgrounds" });
    fireEvent.change(search, { target: { value: "light" } });
    const names = grid()
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(names).toEqual([
      "Gradient Waves", // current
      "Lightfall",
      "Lightning",
      "Light Pillar",
      "Light Rays",
      "Light Tunnel",
    ]);
    fireEvent.change(search, { target: { value: "ghost" } });
    fireEvent.click(grid().getByRole("button", { name: "Ghost Fibers" }));
    expect(latest.bg).toBe("GhostFibers");
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(grid().getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText(/No other background matches/)).toBeInTheDocument();
  });

  it("dim slider sets the overlay opacity", () => {
    const { container } = render(<Harness />);
    const dim = () => (container.querySelector(".bg-dim") as HTMLElement).style.opacity;
    expect(dim()).toBe("0.2");
    fireEvent.change(screen.getByLabelText(/Dim background/), { target: { value: "0.6" } });
    expect(dim()).toBe("0.6");
    expect(latest.dim).toBe(0.6);
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(stored().dim).toBe(0.6);
  });

  it("window style, Needs-you and narration segments set the look", () => {
    render(<Harness />);
    const seg = (group: string, name: string) =>
      within(screen.getByRole("group", { name: group })).getByRole("button", { name });
    const picks: [string, string, keyof Look, string][] = [
      ["Window style", "Frosted glass", "chrome", "glass"],
      ["Window style", "Liquid glass", "chrome", "liquid"],
      ["Window style", "Spotlight", "chrome", "spotlight"],
      ["Window style", "Border glow", "chrome", "glow"],
      ["Window style", "Solid", "chrome", "solid"],
      ["Needs you effect", "Electric border", "attn", "electric"],
      ["Needs you effect", "Star border", "attn", "star"],
      ["Needs you effect", "Pulse", "attn", "pulse"],
      ["Narration effect", "Decrypt", "narr", "decrypt"],
      ["Narration effect", "Shiny", "narr", "shiny"],
      ["Narration effect", "Plain", "narr", "plain"],
    ];
    for (const [group, name, key, value] of picks) {
      fireEvent.click(seg(group, name));
      expect(latest[key]).toBe(value);
      expect(stored()[key]).toBe(value);
      expect(seg(group, name)).toHaveAttribute("aria-pressed", "true");
    }
    expect(seg("Needs you effect", "Electric border")).toHaveAttribute("aria-pressed", "false");
  });

  it("toggles auto-arrange and arranges on demand", () => {
    const onArrange = vi.fn();
    render(<Harness onArrange={onArrange} />);
    const box = screen.getByRole("checkbox", { name: /Auto-arrange and fit/ });
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(latest.autoArrange).toBe(false);
    expect(stored().autoArrange).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Arrange & fit now" }));
    expect(onArrange).toHaveBeenCalledTimes(1);
  });
});

describe("App look (demo mode)", () => {
  const renderApp = () =>
    render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
  const dock = () => within(screen.getByRole("toolbar", { name: "Dock" }));

  it("renders the saved background, tethers per agent and the dock with the needs-you badge", () => {
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ bg: "none", dim: 0.4 }));
    const { container } = renderApp();
    expect(container.querySelector(".bg-layer")).toHaveAttribute("data-bg", "none");
    expect((container.querySelector(".bg-dim") as HTMLElement).style.opacity).toBe("0.4");
    const agents = container.querySelectorAll(".world .win .narr").length;
    expect(agents).toBeGreaterThan(0);
    expect(container.querySelectorAll(".world svg.tethers path")).toHaveLength(agents);
    const pill = container.querySelector(".topbar .ny-pill")?.textContent ?? "";
    const n = pill.match(/(\d+) needs? you/)?.[1];
    expect(n).toBeDefined();
    expect(dock().getByRole("button", { name: "Wave coordinators" })).toHaveTextContent(n ?? "");
    // Narration uses the default effect (decrypt).
    expect(container.querySelector(".world .narr")).toHaveAttribute("data-fx", "decrypt");
  });

  it("draws tethers only for the agents of visible waves", () => {
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ bg: "none" }));
    const { container } = renderApp();
    const paths = () => container.querySelectorAll(".world svg.tethers path").length;
    const agents = () => container.querySelectorAll(".world .win .narr").length;
    const before = paths();
    const first = container.querySelector(".coord-list > li") as HTMLElement;
    const wave = first.getAttribute("aria-label") ?? "";
    fireEvent.click(within(first).getByRole("button", { name: `Hide ${wave}` }));
    expect(agents()).toBeLessThan(before);
    expect(paths()).toBe(agents());
    fireEvent.click(within(first).getByRole("button", { name: `Show ${wave}` }));
    expect(paths()).toBe(before);
  });

  it("opens Appearance from the dock; picks reach every window; tethers toggle", () => {
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ bg: "none" }));
    const { container } = renderApp();
    expect(screen.queryByRole("complementary", { name: "Appearance" })).toBeNull();
    fireEvent.click(dock().getByRole("button", { name: "Appearance" }));
    const panel = within(screen.getByRole("complementary", { name: "Appearance" }));
    fireEvent.click(panel.getByRole("button", { name: "Solid" }));
    const inners = [...container.querySelectorAll(".world .win-inner")];
    expect(inners.length).toBeGreaterThan(0);
    for (const el of inners) expect(el).toHaveClass("chrome-solid");
    fireEvent.click(panel.getByRole("button", { name: "Star border" }));
    expect(container.querySelector(".world .win--attn-you .star-border")).not.toBeNull();
    expect(container.querySelector(".world .win-attn-pulse")).toBeNull();
    fireEvent.click(panel.getByRole("button", { name: "Plain" }));
    expect(container.querySelector(".world .narr")).toHaveAttribute("data-fx", "plain");
    fireEvent.click(dock().getByRole("button", { name: "Hide tethers" }));
    expect(container.querySelector(".world svg.tethers")).toBeNull();
    expect(stored()).toMatchObject({
      chrome: "solid",
      attn: "star",
      narr: "plain",
      tethers: false,
    });
    fireEvent.click(panel.getByRole("button", { name: "Close appearance" }));
    expect(screen.queryByRole("complementary", { name: "Appearance" })).toBeNull();
  });

  it("toggles auto-arrange from the dock with a toast", () => {
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ bg: "none" }));
    renderApp();
    fireEvent.click(dock().getByRole("button", { name: "Auto-arrange: on" }));
    expect(stored().autoArrange).toBe(false);
    expect(dock().getByRole("button", { name: "Auto-arrange: off" })).toBeInTheDocument();
    expect(screen.getByText("Windows stay where you put them.")).toBeInTheDocument();
  });
});
