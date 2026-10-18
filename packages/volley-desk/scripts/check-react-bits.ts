/**
 * React Bits allow-list check. The Desk may only use the free React Bits
 * components the approved prototype uses; each is installed from the shadcn
 * registry into `src/rb/<Name>/` (see README "React Bits"). Any top-level
 * entry of `src/rb/` (directory or file) whose name is not on this list fails
 * the check, so a Pro component or an unreviewed addition can't slip in. Files
 * inside an allowed component's folder are its own helpers and aren't checked.
 *
 * Usage: bun run scripts/check-react-bits.ts [rb-dir]   (default: src/rb)
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REACT_BITS_ALLOW_LIST: readonly string[] = [
  "AcidSquares",
  "AeroShards",
  "Antigravity",
  "Aurora",
  "Balatro",
  "Ballpit",
  "Beams",
  "BorderGlow",
  "ColorBends",
  "Counter",
  "CRTWarp",
  "DarkVeil",
  "DecryptedText",
  "Dither",
  "Dock",
  "DotField",
  "DotGrid",
  "ElasticSlider",
  "ElectricBorder",
  "FaultyTerminal",
  "Ferrofluid",
  "FloatingLines",
  "FluxLines",
  "Galaxy",
  "GhostFibers",
  "GlassSurface",
  "GlideSelect",
  "GradientASCII",
  "GradientBlinds",
  "GradientWaves",
  "Grainient",
  "GridDistortion",
  "GridMotion",
  "GridScan",
  "Hyperspeed",
  "Iridescence",
  "LetterGlitch",
  "Lightfall",
  "Lightning",
  "LightPillar",
  "LightRays",
  "LightTunnel",
  "LineWaves",
  "LiquidChrome",
  "LiquidEther",
  "MagicRings",
  "MagnetLines",
  "MicroSlats",
  "MoltenMetal",
  "Orb",
  "Particles",
  "PatternWaves",
  "PixelBlast",
  "PixelSnow",
  "Plasma",
  "PlasmaWave",
  "Prism",
  "PrismaticBurst",
  "PromptBar",
  "Radar",
  "RippleGrid",
  "Scanner",
  "ShapeGrid",
  "ShapeWaves",
  "ShinyText",
  "SideRays",
  "Silk",
  "SlicedWaves",
  "SoftAurora",
  "SpecularButton",
  "SpotlightCard",
  "StarBorder",
  "StatusMark",
  "SwipeToast",
  "ThoughtLine",
  "Threads",
  "Topography",
  "Waves",
  "WebThreads",
];

export interface CheckResult {
  ok: boolean;
  unknown: string[];
}

export function checkReactBits(rbDir: string): CheckResult {
  if (!existsSync(rbDir)) return { ok: true, unknown: [] };
  const allowed = new Set(REACT_BITS_ALLOW_LIST);
  const unknown = readdirSync(rbDir)
    .filter((entry) => !entry.startsWith("."))
    .map((entry) => entry.replace(/\.(tsx?|css)$/, ""))
    .filter((name) => !allowed.has(name))
    .sort();
  return { ok: unknown.length === 0, unknown: [...new Set(unknown)] };
}

export function main(argv: string[], log: (line: string) => void = console.error): number {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const rbDir = path.resolve(argv[0] ?? path.join(here, "..", "src", "rb"));
  const result = checkReactBits(rbDir);
  if (result.ok) {
    log(`check-react-bits: ok (${rbDir})`);
    return 0;
  }
  for (const name of result.unknown) {
    log(`check-react-bits: "${name}" is not on the React Bits allow-list (${rbDir})`);
  }
  log("Only the free components used by the approved prototype are allowed.");
  return 1;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
