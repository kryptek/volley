/**
 * The background registry, ported from the prototype `backgrounds.tsx`: every
 * free React Bits background (the "Backgrounds" section of
 * https://reactbits.dev/llms.txt), unmodified and rendered with its default
 * props, plus "None". Each one is lazy-loaded into its own chunk, so the
 * WebGL dependencies (`ogl`, `three`, `vgpu`) cost nothing until picked.
 * `scripts/sync-react-bits-backgrounds.ts` warns when React Bits adds one.
 */
import { type ComponentType, type LazyExoticComponent, lazy } from "react";

export type BackgroundComponent = ComponentType<Record<string, unknown>>;
type LazyBackground = LazyExoticComponent<BackgroundComponent>;

export interface BackgroundDef {
  key: string;
  name: string;
  /** `null` for "None (plain)". */
  C: LazyBackground | null;
  /** Inputs for required props. */
  p?: Record<string, unknown>;
}

type Module = { default: unknown };
type Failure = { err: unknown };

/** Each registry entry's loader, the lazy component that last loaded it, and failed loads. */
const loaders = new WeakMap<LazyBackground, (after?: Failure) => LazyBackground>();
const latest = new WeakMap<LazyBackground, LazyBackground>();
const failures = new WeakMap<LazyBackground, Failure>();

/** How a retry fetches a chunk again (tests swap in their own). */
export interface ChunkFetch {
  importUrl: (url: string) => Promise<Module>;
  addStylesheet: (url: string) => Promise<void>;
}

/** Adds a stylesheet and resolves once it loads (rejects, and removes it, if it doesn't). */
export function addStylesheet(href: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => {
      link.remove();
      reject(new Error(`Unable to preload CSS for ${href}`));
    };
    document.head.appendChild(link);
  });
}

const BROWSER: ChunkFetch = {
  importUrl: (url) => import(/* @vite-ignore */ url),
  addStylesheet,
};

/** The chunk a load error names: Chrome and Firefox name the module, Vite the stylesheet. */
export function failedChunk(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  return err.message.match(/(\S+?\.(?:js|css))(?:\?\S*)?\s*$/)?.[1] ?? null;
}

/**
 * Loads a background again after a failed load. Browsers keep a failed module
 * import for the life of the page, and Vite never re-adds a stylesheet it has
 * tried, so the chunk the error names is fetched again under a fresh URL.
 * Safari names no chunk: its retry runs the loader as is.
 */
export function reloadChunk(load: () => Promise<Module>, err: unknown, fetch = BROWSER) {
  const chunk = failedChunk(err);
  const fresh = `${chunk}?retry=${Date.now()}`;
  if (chunk?.endsWith(".css")) return fetch.addStylesheet(fresh).then(load);
  return chunk ? fetch.importUrl(fresh) : load();
}

/**
 * A lazy background whose failed chunk load can be retried. `React.lazy`
 * keeps a rejected import for the life of the page, so a load that failed
 * (offline, or a redeploy removed the old chunk) is remembered here and
 * `loadable` swaps in a fresh lazy, which fetches the chunk again, on the
 * next pick or Retry. It never retries on its own.
 */
export function lazyBackground(load: () => Promise<Module>, fetch = BROWSER): LazyBackground {
  const make = (after?: Failure): LazyBackground => {
    const C: LazyBackground = lazy(() =>
      // The vendored components are `@ts-nocheck`; each default export renders with no props.
      (
        (after ? reloadChunk(load, after.err, fetch) : load()) as Promise<{
          default: BackgroundComponent;
        }>
      ).catch((err: unknown) => {
        failures.set(C, { err });
        throw err;
      }),
    );
    return C;
  };
  const C = make();
  loaders.set(C, make);
  return C;
}
const L = lazyBackground;

/** The component to render for a registry entry: a fresh lazy if its last load failed. */
export function loadable(C: LazyBackground): LazyBackground {
  const now = latest.get(C) ?? C;
  const failure = failures.get(now);
  const make = loaders.get(C);
  if (!failure || !make) return now;
  const next = make(failure);
  latest.set(C, next);
  return next;
}

/** `true` for a background `lazyBackground` made (never a static import). */
export const isLazyBackground = (C: unknown): boolean =>
  typeof C === "object" && C !== null && loaders.has(C as LazyBackground);

/**
 * A failed chunk load (Chrome, Firefox, Safari, Vite's CSS preload, webpack's
 * ChunkLoadError) as opposed to a background that failed to render.
 */
export function isChunkLoadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "ChunkLoadError" ||
    /dynamically imported module|Importing a module script failed|Unable to preload/i.test(
      err.message,
    )
  );
}

/** GridDistortion needs an image: a generated gradient gives it something to bend. */
export const GRADIENT_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b1140"/><stop offset=".5" stop-color="#5b2bbf"/><stop offset="1" stop-color="#e879f9"/></linearGradient></defs><rect width="800" height="500" fill="url(#g)"/></svg>',
)}`;

export const NO_BACKGROUND = "none";

export const BACKGROUNDS: readonly BackgroundDef[] = [
  { key: "AcidSquares", name: "Acid Squares", C: L(() => import("../rb/AcidSquares/AcidSquares")) },
  { key: "AeroShards", name: "Aero Shards", C: L(() => import("../rb/AeroShards/AeroShards")) },
  { key: "Antigravity", name: "Antigravity", C: L(() => import("../rb/Antigravity/Antigravity")) },
  { key: "Aurora", name: "Aurora", C: L(() => import("../rb/Aurora/Aurora")) },
  { key: "Balatro", name: "Balatro", C: L(() => import("../rb/Balatro/Balatro")) },
  { key: "Ballpit", name: "Ballpit", C: L(() => import("../rb/Ballpit/Ballpit")) },
  { key: "Beams", name: "Beams", C: L(() => import("../rb/Beams/Beams")) },
  { key: "ColorBends", name: "Color Bends", C: L(() => import("../rb/ColorBends/ColorBends")) },
  { key: "CRTWarp", name: "CRT Warp", C: L(() => import("../rb/CRTWarp/CRTWarp")) },
  { key: "DarkVeil", name: "Dark Veil", C: L(() => import("../rb/DarkVeil/DarkVeil")) },
  { key: "Dither", name: "Dither", C: L(() => import("../rb/Dither/Dither")) },
  { key: "DotField", name: "Dot Field", C: L(() => import("../rb/DotField/DotField")) },
  { key: "DotGrid", name: "Dot Grid", C: L(() => import("../rb/DotGrid/DotGrid")) },
  {
    key: "FaultyTerminal",
    name: "Faulty Terminal",
    C: L(() => import("../rb/FaultyTerminal/FaultyTerminal")),
  },
  { key: "Ferrofluid", name: "Ferrofluid", C: L(() => import("../rb/Ferrofluid/Ferrofluid")) },
  {
    key: "FloatingLines",
    name: "Floating Lines",
    C: L(() => import("../rb/FloatingLines/FloatingLines")),
  },
  { key: "FluxLines", name: "Flux Lines", C: L(() => import("../rb/FluxLines/FluxLines")) },
  { key: "Galaxy", name: "Galaxy", C: L(() => import("../rb/Galaxy/Galaxy")) },
  { key: "GhostFibers", name: "Ghost Fibers", C: L(() => import("../rb/GhostFibers/GhostFibers")) },
  {
    key: "GradientASCII",
    name: "Gradient ASCII",
    C: L(() => import("../rb/GradientASCII/GradientASCII")),
  },
  {
    key: "GradientBlinds",
    name: "Gradient Blinds",
    C: L(() => import("../rb/GradientBlinds/GradientBlinds")),
  },
  {
    key: "GradientWaves",
    name: "Gradient Waves",
    C: L(() => import("../rb/GradientWaves/GradientWaves")),
  },
  { key: "Grainient", name: "Grainient", C: L(() => import("../rb/Grainient/Grainient")) },
  {
    key: "GridDistortion",
    name: "Grid Distortion",
    C: L(() => import("../rb/GridDistortion/GridDistortion")),
    p: { imageSrc: GRADIENT_IMAGE },
  },
  { key: "GridMotion", name: "Grid Motion", C: L(() => import("../rb/GridMotion/GridMotion")) },
  { key: "GridScan", name: "Grid Scan", C: L(() => import("../rb/GridScan/GridScan")) },
  { key: "Hyperspeed", name: "Hyperspeed", C: L(() => import("../rb/Hyperspeed/Hyperspeed")) },
  { key: "Iridescence", name: "Iridescence", C: L(() => import("../rb/Iridescence/Iridescence")) },
  {
    key: "LetterGlitch",
    name: "Letter Glitch",
    C: L(() => import("../rb/LetterGlitch/LetterGlitch")),
  },
  { key: "Lightfall", name: "Lightfall", C: L(() => import("../rb/Lightfall/Lightfall")) },
  { key: "Lightning", name: "Lightning", C: L(() => import("../rb/Lightning/Lightning")) },
  { key: "LightPillar", name: "Light Pillar", C: L(() => import("../rb/LightPillar/LightPillar")) },
  { key: "LightRays", name: "Light Rays", C: L(() => import("../rb/LightRays/LightRays")) },
  { key: "LightTunnel", name: "Light Tunnel", C: L(() => import("../rb/LightTunnel/LightTunnel")) },
  { key: "LineWaves", name: "Line Waves", C: L(() => import("../rb/LineWaves/LineWaves")) },
  {
    key: "LiquidChrome",
    name: "Liquid Chrome",
    C: L(() => import("../rb/LiquidChrome/LiquidChrome")),
  },
  { key: "LiquidEther", name: "Liquid Ether", C: L(() => import("../rb/LiquidEther/LiquidEther")) },
  { key: "MagicRings", name: "Magic Rings", C: L(() => import("../rb/MagicRings/MagicRings")) },
  { key: "MagnetLines", name: "Magnet Lines", C: L(() => import("../rb/MagnetLines/MagnetLines")) },
  { key: "MicroSlats", name: "Micro Slats", C: L(() => import("../rb/MicroSlats/MicroSlats")) },
  { key: "MoltenMetal", name: "Molten Metal", C: L(() => import("../rb/MoltenMetal/MoltenMetal")) },
  { key: "Orb", name: "Orb", C: L(() => import("../rb/Orb/Orb")) },
  { key: "Particles", name: "Particles", C: L(() => import("../rb/Particles/Particles")) },
  {
    key: "PatternWaves",
    name: "Pattern Waves",
    C: L(() => import("../rb/PatternWaves/PatternWaves")),
  },
  { key: "PixelBlast", name: "Pixel Blast", C: L(() => import("../rb/PixelBlast/PixelBlast")) },
  { key: "PixelSnow", name: "Pixel Snow", C: L(() => import("../rb/PixelSnow/PixelSnow")) },
  { key: "Plasma", name: "Plasma", C: L(() => import("../rb/Plasma/Plasma")) },
  { key: "PlasmaWave", name: "Plasma Wave", C: L(() => import("../rb/PlasmaWave/PlasmaWave")) },
  { key: "Prism", name: "Prism", C: L(() => import("../rb/Prism/Prism")) },
  {
    key: "PrismaticBurst",
    name: "Prismatic Burst",
    C: L(() => import("../rb/PrismaticBurst/PrismaticBurst")),
  },
  { key: "Radar", name: "Radar", C: L(() => import("../rb/Radar/Radar")) },
  { key: "RippleGrid", name: "Ripple Grid", C: L(() => import("../rb/RippleGrid/RippleGrid")) },
  { key: "Scanner", name: "Scanner", C: L(() => import("../rb/Scanner/Scanner")) },
  { key: "ShapeGrid", name: "Shape Grid", C: L(() => import("../rb/ShapeGrid/ShapeGrid")) },
  { key: "ShapeWaves", name: "Shape Waves", C: L(() => import("../rb/ShapeWaves/ShapeWaves")) },
  { key: "SideRays", name: "Side Rays", C: L(() => import("../rb/SideRays/SideRays")) },
  { key: "Silk", name: "Silk", C: L(() => import("../rb/Silk/Silk")) },
  { key: "SlicedWaves", name: "Sliced Waves", C: L(() => import("../rb/SlicedWaves/SlicedWaves")) },
  { key: "SoftAurora", name: "Soft Aurora", C: L(() => import("../rb/SoftAurora/SoftAurora")) },
  { key: "Threads", name: "Threads", C: L(() => import("../rb/Threads/Threads")) },
  { key: "Topography", name: "Topography", C: L(() => import("../rb/Topography/Topography")) },
  { key: "Waves", name: "Waves", C: L(() => import("../rb/Waves/Waves")) },
  { key: "WebThreads", name: "Web Threads", C: L(() => import("../rb/WebThreads/WebThreads")) },
  { key: NO_BACKGROUND, name: "None (plain)", C: null },
];

/** The React Bits backgrounds (every entry but "None"). */
export const REACT_BITS_BACKGROUNDS = BACKGROUNDS.filter((b) => b.C !== null);

export const isBackground = (key: unknown): key is string =>
  typeof key === "string" && BACKGROUNDS.some((b) => b.key === key);
