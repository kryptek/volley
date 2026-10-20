/**
 * Promotes a generated variant to a Desk sound: trims the silence at both
 * ends, normalises its loudness to −16 LUFS (two passes: measure, then a
 * fixed gain under a −1 dBTP limiter), encodes mono Ogg/Opus (48 kHz,
 * 48 kbps VBR) into `packages/volley-desk/public/sounds/<theme>/<event>.ogg`
 * and rewrites the theme's `manifest.json`.
 *
 *   bun scripts/sounds/pick.ts <theme> <event> <variant> [--mp3]
 *   bun scripts/sounds/pick.ts --auto [--theme t]… [--force] [--mp3]
 *   bun scripts/sounds/pick.ts --interactive [--theme t]… [--event e]…
 *
 * `--auto` picks, for every clip not yet in a manifest (all with `--force`),
 * the variant whose trimmed length is closest to the prompt's duration (a
 * stand-in for an ear: re-pick by hand after listening). `--interactive`
 * plays each clip's variants in turn and reads 1/2/3 to pick, r to re-roll
 * (the review files are deleted for `generate.ts` to fill again), s to skip.
 * `--mp3` also writes an MP3 beside the clip, listed as its `fallback`.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SOUND_EVENT_IDS } from "volley-desk/sounds-events";
import { PUBLIC_SOUNDS, type Prompts, REVIEW_DIR, loadPrompts, reviewBase } from "./prompts";

export const TARGET_LUFS = -16;
export const TRUE_PEAK_DB = -1;
const SILENCE_DB = -50;
/** A short fade at the cut, so a trimmed clip never ends on a click. */
const FADE_S = 0.012;

export interface ClipEntry {
  file: string;
  ms: number;
  variant: number;
  fallback?: string;
}

export interface Manifest {
  theme: string;
  label: string;
  version: number;
  generated_at: string;
  clips: Record<string, ClipEntry>;
  missing: string[];
}

export function hasFfmpeg(): boolean {
  return ["ffmpeg", "ffprobe"].every(
    (bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0,
  );
}

function ffmpeg(args: string[]): string {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.split("\n").slice(-4).join(" ")}`);
  return r.stderr;
}

export function probeDuration(file: string): number {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
  return Number(r.stdout.trim());
}

const TRIM_END = `silenceremove=start_periods=1:start_threshold=${SILENCE_DB}dB:start_silence=0.005,areverse`;
/** Downmix to mono and cut the silence at both ends (trim, reverse, trim, reverse back). */
const TRIM = `aformat=channel_layouts=mono,${TRIM_END},${TRIM_END}`;

/** Integrated loudness of `file` after the trim (padded so a short clip still has gating blocks). */
export function measureLufs(file: string): number {
  const err = ffmpeg([
    "-i",
    file,
    "-af",
    `${TRIM},apad=whole_dur=1.5,loudnorm=print_format=json`,
    "-f",
    "null",
    "-",
  ]);
  const json = err.slice(err.lastIndexOf("{"), err.lastIndexOf("}") + 1);
  const i = Number((JSON.parse(json) as { input_i: string }).input_i);
  return Number.isFinite(i) ? i : Number.NEGATIVE_INFINITY;
}

/** The trimmed length of `file`, in seconds (0 for a clip that is all silence). */
export function trimmedLength(file: string, scratch: string): number {
  mkdirSync(scratch, { recursive: true });
  const out = join(scratch, "trim.wav");
  ffmpeg(["-i", file, "-af", TRIM, out]);
  return existsSync(out) ? probeDuration(out) || 0 : 0;
}

/** Trim, normalise and encode one variant; returns the clip's length in ms. */
export function encode(src: string, dest: string, scratch: string, mp3?: string): number {
  mkdirSync(scratch, { recursive: true });
  const trimmed = join(scratch, "trimmed.wav");
  ffmpeg(["-i", src, "-af", TRIM, "-ar", "48000", trimmed]);
  const len = probeDuration(trimmed);
  if (!(len > 0)) throw new Error(`${src}: nothing left after trimming the silence`);
  const lufs = measureLufs(trimmed);
  const gain = Number.isFinite(lufs) ? TARGET_LUFS - lufs : 0;
  const fadeAt = Math.max(0, len - FADE_S);
  const limit = 10 ** (TRUE_PEAK_DB / 20);
  const chain = `volume=${gain.toFixed(2)}dB,alimiter=limit=${limit.toFixed(3)}:attack=1:release=20:level=false,afade=t=out:st=${fadeAt.toFixed(3)}:d=${FADE_S}`;
  ffmpeg([
    "-i",
    trimmed,
    "-af",
    chain,
    "-ac",
    "1",
    "-ar",
    "48000",
    "-c:a",
    "libopus",
    "-b:a",
    "48k",
    "-vbr",
    "on",
    dest,
  ]);
  if (mp3)
    ffmpeg(["-i", trimmed, "-af", chain, "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", mp3]);
  return Math.round(probeDuration(dest) * 1000);
}

export function readManifest(dir: string, theme: string, label: string): Manifest {
  try {
    const m = JSON.parse(readFileSync(join(dir, theme, "manifest.json"), "utf8")) as Manifest;
    return { ...m, clips: m.clips ?? {}, missing: m.missing ?? [] };
  } catch {
    return { theme, label, version: 0, generated_at: "", clips: {}, missing: [] };
  }
}

export function writeManifest(dir: string, m: Manifest): void {
  const clips = Object.fromEntries(
    SOUND_EVENT_IDS.filter((id) => m.clips[id]).map((id) => [id, m.clips[id]]),
  );
  const out: Manifest = {
    theme: m.theme,
    label: m.label,
    version: m.version + 1,
    generated_at: new Date().toISOString(),
    clips,
    missing: SOUND_EVENT_IDS.filter((id) => !clips[id]),
  };
  mkdirSync(join(dir, m.theme), { recursive: true });
  writeFileSync(join(dir, m.theme, "manifest.json"), `${JSON.stringify(out, null, 2)}\n`);
}

/** The review file for a variant, whatever its extension. */
export function variantFile(
  reviewDir: string,
  theme: string,
  event: string,
  n: number,
): string | null {
  const base = reviewBase(reviewDir, theme, event, n);
  for (const ext of ["wav", "mp3"]) if (existsSync(`${base}.${ext}`)) return `${base}.${ext}`;
  return null;
}

export interface PickOptions {
  prompts: Prompts;
  reviewDir: string;
  publicDir: string;
  scratch: string;
  mp3?: boolean;
}

export function pick(theme: string, event: string, variant: number, o: PickOptions): ClipEntry {
  const t = o.prompts.themes.find((x) => x.id === theme);
  if (!t) throw new Error(`unknown theme: ${theme}`);
  if (!o.prompts.events.some((e) => e.id === event)) throw new Error(`unknown event: ${event}`);
  const src = variantFile(o.reviewDir, theme, event, variant);
  if (!src) throw new Error(`no review file for ${theme}/${event}.${variant}`);
  const dir = join(o.publicDir, theme);
  mkdirSync(dir, { recursive: true });
  const file = `${event}.ogg`;
  const mp3 = o.mp3 ? `${event}.mp3` : undefined;
  if (!o.mp3) rmSync(join(dir, `${event}.mp3`), { force: true });
  const ms = encode(
    src,
    join(dir, file),
    join(o.scratch, `${theme}-${event}`),
    mp3 && join(dir, mp3),
  );
  const entry: ClipEntry = { file, ms, variant, ...(mp3 ? { fallback: mp3 } : {}) };
  const m = readManifest(o.publicDir, theme, t.label);
  m.clips[event] = entry;
  m.label = t.label;
  writeManifest(o.publicDir, m);
  return entry;
}

/** The variant whose trimmed length is closest to the prompt's duration; null if none exist. */
export function autoVariant(theme: string, event: string, o: PickOptions): number | null {
  const want = o.prompts.events.find((e) => e.id === event)?.duration_s ?? 1;
  let best: { n: number; score: number } | null = null;
  for (let n = 1; n <= 9; n++) {
    const f = variantFile(o.reviewDir, theme, event, n);
    if (!f) continue;
    const len = trimmedLength(f, join(o.scratch, `probe-${theme}-${event}-${n}`));
    if (len < 0.02) continue;
    const score = Math.abs(len - want);
    if (!best || score < best.score) best = { n, score };
  }
  return best?.n ?? null;
}

function play(file: string): void {
  for (const bin of ["afplay", "ffplay"]) {
    const args = bin === "ffplay" ? ["-nodisp", "-autoexit", "-loglevel", "quiet", file] : [file];
    if (spawnSync(bin, args, { stdio: "ignore" }).status === 0) return;
  }
}

async function interactive(themes: string[], events: string[], o: PickOptions): Promise<void> {
  const ask = async (q: string) => {
    process.stdout.write(q);
    for await (const line of console) return line.trim();
    return "s";
  };
  for (const theme of themes)
    for (const event of events) {
      const variants = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((n) =>
        variantFile(o.reviewDir, theme, event, n),
      );
      if (!variants.length) continue;
      for (;;) {
        for (const n of variants) {
          console.log(`${theme}/${event} variant ${n}`);
          play(variantFile(o.reviewDir, theme, event, n) as string);
        }
        const a = await ask(
          `${theme}/${event}: ${variants.join("/")} pick, p replay, r re-roll, s skip > `,
        );
        if (a === "p") continue;
        if (a === "s") break;
        if (a === "r") {
          for (const n of variants) rmSync(variantFile(o.reviewDir, theme, event, n) as string);
          console.log(`  deleted: run sounds:generate --theme ${theme} --event ${event}`);
          break;
        }
        const n = Number(a);
        if (variants.includes(n)) {
          pick(theme, event, n, o);
          break;
        }
      }
    }
}

export async function main(argv: readonly string[], o: Partial<PickOptions> = {}): Promise<number> {
  if (!hasFfmpeg()) {
    console.error("pick needs ffmpeg and ffprobe on the PATH (e.g. brew install ffmpeg)");
    return 2;
  }
  const opts: PickOptions = {
    prompts: o.prompts ?? loadPrompts(),
    reviewDir: o.reviewDir ?? REVIEW_DIR,
    publicDir: o.publicDir ?? PUBLIC_SOUNDS,
    scratch: o.scratch ?? join(o.reviewDir ?? REVIEW_DIR, "_scratch"),
    mp3: argv.includes("--mp3"),
  };
  const flags = (name: string) =>
    argv.flatMap((a, i) => (a === name && argv[i + 1] ? (argv[i + 1]?.split(",") ?? []) : []));
  const themes = flags("--theme").length ? flags("--theme") : opts.prompts.themes.map((t) => t.id);
  const events = flags("--event").length ? flags("--event") : opts.prompts.events.map((e) => e.id);
  try {
    if (argv.includes("--interactive")) {
      await interactive(themes, events, opts);
      return 0;
    }
    if (argv.includes("--auto")) {
      const force = argv.includes("--force");
      for (const theme of themes) {
        const label = opts.prompts.themes.find((t) => t.id === theme)?.label ?? theme;
        const have = readManifest(opts.publicDir, theme, label).clips;
        for (const event of events) {
          if (have[event] && !force) continue;
          const n = autoVariant(theme, event, opts);
          if (n === null) {
            console.error(`${theme}/${event}: no usable variant`);
            continue;
          }
          const e = pick(theme, event, n, opts);
          console.log(`${theme}/${event} ← variant ${n} (${e.ms} ms)`);
        }
      }
      return 0;
    }
    const [theme, event, variant] = argv.filter((a) => !a.startsWith("--"));
    if (!theme || !event || !variant) {
      console.error("usage: pick <theme> <event> <variant> [--mp3] | --auto | --interactive");
      return 2;
    }
    const e = pick(theme, event, Number(variant), opts);
    console.log(`${theme}/${event} ← variant ${variant} (${e.ms} ms)`);
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  } finally {
    rmSync(opts.scratch, { recursive: true, force: true });
  }
}

/** Every file under `dir`, relative, for the stray-file check. */
export function listFiles(dir: string, rel = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p, join(rel, name)) : [join(rel, name)];
  });
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
