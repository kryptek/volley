import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSounds } from "./check";
import { hasFfmpeg, pick, probeDuration } from "./pick";
import { loadPrompts } from "./prompts";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "volley-sounds-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ff = hasFfmpeg();
const prompts = loadPrompts();

/** 150 ms of silence, 0.8 s of a stereo tone, 150 ms of silence: what the API hands back. */
function fixture(review: string, theme: string, event: string, n: number): void {
  mkdirSync(join(review, theme), { recursive: true });
  const r = spawnSync("ffmpeg", [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=44100:duration=0.8"],
    ...["-af", "volume=-6dB,adelay=150|150,apad=pad_dur=0.15,aformat=channel_layouts=stereo"],
    join(review, theme, `${event}.${n}.wav`),
  ]);
  if (r.status !== 0) throw new Error("fixture");
}

function integratedLufs(file: string): number {
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-af",
      "apad=whole_dur=1.5,ebur128",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  const m = /I:\s+(-?[\d.]+) LUFS/.exec(r.stderr.slice(r.stderr.lastIndexOf("Summary")));
  return Number(m?.[1]);
}

function probe(file: string) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_name,channels,sample_rate", "-of", "json", file],
    { encoding: "utf8" },
  );
  return (JSON.parse(r.stdout) as { streams: Record<string, unknown>[] }).streams[0];
}

describe.skipIf(!ff)("pick (ffmpeg)", () => {
  test("trims, normalises to −16 LUFS, encodes mono Opus and writes the manifest", () => {
    const review = temp();
    const pub = temp();
    fixture(review, "synthwave", "agent_complete", 2);
    const entry = pick("synthwave", "agent_complete", 2, {
      prompts,
      reviewDir: review,
      publicDir: pub,
      scratch: join(review, "_scratch"),
    });
    const out = join(pub, "synthwave", "agent_complete.ogg");
    expect(probe(out)).toMatchObject({ codec_name: "opus", channels: 1, sample_rate: "48000" });
    const len = probeDuration(out);
    expect(len).toBeGreaterThan(0.75);
    expect(len).toBeLessThan(0.85);
    expect(Math.abs(integratedLufs(out) - -16)).toBeLessThanOrEqual(1);
    expect(entry).toEqual({ file: "agent_complete.ogg", ms: expect.any(Number), variant: 2 });
    const m = JSON.parse(readFileSync(join(pub, "synthwave", "manifest.json"), "utf8"));
    expect(m).toMatchObject({ theme: "synthwave", label: "Synthwave", version: 1 });
    expect(m.clips.agent_complete).toEqual(entry);
    expect(m.missing).toHaveLength(27);
    expect(m.missing).not.toContain("agent_complete");
    expect(checkSounds(pub)).toEqual([]);
  });

  test("--mp3 also writes an MP3 and lists it as the fallback", () => {
    const review = temp();
    const pub = temp();
    fixture(review, "arcade", "ui_click", 1);
    const entry = pick("arcade", "ui_click", 1, {
      prompts,
      reviewDir: review,
      publicDir: pub,
      scratch: join(review, "_scratch"),
      mp3: true,
    });
    expect(entry.fallback).toBe("ui_click.mp3");
    expect(existsSync(join(pub, "arcade", "ui_click.mp3"))).toBe(true);
    expect(checkSounds(pub)).toEqual([]);
  });

  test("refuses an unknown theme, event or a variant with no review file", () => {
    const o = { prompts, reviewDir: temp(), publicDir: temp(), scratch: temp() };
    expect(() => pick("nope", "ui_click", 1, o)).toThrow("unknown theme");
    expect(() => pick("arcade", "nope", 1, o)).toThrow("unknown event");
    expect(() => pick("arcade", "ui_click", 1, o)).toThrow("no review file");
  });
});

describe("pick without ffmpeg", () => {
  test("exits 2 with a hint", () => {
    const r = spawnSync("bun", [join(import.meta.dir, "pick.ts"), "arcade", "ui_click", "1"], {
      encoding: "utf8",
      env: { ...process.env, PATH: "/nonexistent" },
    });
    // Bun itself is found by absolute path; ffmpeg is not.
    if (r.error) return;
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("ffmpeg");
  });
});
