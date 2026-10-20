/**
 * Checks the Desk's committed sound themes in `packages/volley-desk/public/sounds/`:
 * every theme folder is a known theme with a manifest; the manifest names a
 * clip or a `missing` entry for every catalogue event and nothing else; every
 * clip exists, is Ogg/Opus and mono (read from its `OpusHead`, so no ffmpeg
 * is needed); a theme weighs under 200 KB; and no file sits unreferenced.
 * A theme with no folder counts as all-missing; `--complete` requires every
 * theme to have every clip.
 *
 *   bun scripts/sounds/check.ts [--complete] [dir]
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SOUND_EVENT_IDS } from "volley-desk/sounds-events";
import { THEMES } from "volley-desk/sounds-themes";
import { listFiles } from "./pick";
import { PUBLIC_SOUNDS } from "./prompts";

export const THEME_BUDGET_BYTES = 200 * 1024;

/** The channel count of an Ogg/Opus file, or null when it is not one. */
export function opusChannels(bytes: Uint8Array): number | null {
  const ascii = (at: number, n: number) => String.fromCharCode(...bytes.subarray(at, at + n));
  if (bytes.length < 47 || ascii(0, 4) !== "OggS") return null;
  // The first page's single segment holds the OpusHead packet.
  const segments = bytes[26] ?? 0;
  const head = 27 + segments;
  if (ascii(head, 8) !== "OpusHead") return null;
  return bytes[head + 9] ?? null;
}

const ALLOWED_FALLBACK = /\.mp3$/;

export function checkSounds(dir: string, { complete = false } = {}): string[] {
  const errors: string[] = [];
  const known = new Set<string>(THEMES.map((t) => t.id));
  const referenced = new Set<string>();
  for (const f of listFiles(dir)) {
    const theme = f.split(/[\\/]/)[0] ?? "";
    if (!known.has(theme)) errors.push(`${f}: not in a known theme folder`);
  }
  for (const t of THEMES) {
    const folder = join(dir, t.id);
    if (!existsSync(folder)) {
      if (complete) errors.push(`${t.id}: no theme folder`);
      continue;
    }
    const mf = join(folder, "manifest.json");
    referenced.add(join(t.id, "manifest.json"));
    let m: {
      theme?: string;
      clips?: Record<string, { file?: string; fallback?: string }>;
      missing?: string[];
    };
    try {
      m = JSON.parse(readFileSync(mf, "utf8"));
    } catch {
      errors.push(`${t.id}: manifest.json missing or not JSON`);
      continue;
    }
    if (m.theme !== t.id) errors.push(`${t.id}: manifest names theme ${String(m.theme)}`);
    const clips = m.clips ?? {};
    const missing = new Set(m.missing ?? []);
    let bytes = 0;
    for (const id of Object.keys(clips))
      if (!(SOUND_EVENT_IDS as string[]).includes(id)) errors.push(`${t.id}: unknown event ${id}`);
    for (const id of SOUND_EVENT_IDS) {
      const clip = clips[id];
      if (!clip) {
        if (!missing.has(id)) errors.push(`${t.id}/${id}: neither a clip nor listed as missing`);
        else if (complete) errors.push(`${t.id}/${id}: missing`);
        continue;
      }
      for (const file of [clip.file, clip.fallback]) {
        if (file === undefined) continue;
        const path = join(folder, file);
        referenced.add(join(t.id, file));
        if (!existsSync(path)) {
          errors.push(`${t.id}/${file}: listed but not on disk`);
          continue;
        }
        bytes += statSync(path).size;
        if (file === clip.fallback) {
          if (!ALLOWED_FALLBACK.test(file)) errors.push(`${t.id}/${file}: a fallback must be .mp3`);
          continue;
        }
        const ch = opusChannels(new Uint8Array(readFileSync(path)));
        if (ch === null) errors.push(`${t.id}/${file}: not Ogg/Opus`);
        else if (ch !== 1) errors.push(`${t.id}/${file}: ${ch} channels, not mono`);
      }
    }
    if (bytes > THEME_BUDGET_BYTES)
      errors.push(
        `${t.id}: ${Math.round(bytes / 1024)} KB, over the ${THEME_BUDGET_BYTES / 1024} KB budget`,
      );
  }
  for (const f of listFiles(dir))
    if (!referenced.has(f)) errors.push(`${f}: not referenced by a manifest`);
  return errors;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--")) ?? PUBLIC_SOUNDS;
  const errors = checkSounds(dir, { complete: args.includes("--complete") });
  for (const e of errors) console.error(e);
  if (errors.length === 0) console.log("sounds: ok");
  process.exit(errors.length ? 1 : 0);
}
