import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOUND_EVENT_IDS } from "volley-desk/sounds-events";
import { THEMES } from "volley-desk/sounds-themes";
import { THEME_BUDGET_BYTES, checkSounds, opusChannels } from "./check";
import { PUBLIC_SOUNDS } from "./prompts";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "volley-sounds-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A minimal Ogg page carrying an OpusHead with `channels`. */
function opus(channels: number, pad = 0): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  head[8] = 1;
  head[9] = channels;
  const page = new Uint8Array(27 + 1 + head.length + pad);
  page.set(new TextEncoder().encode("OggS"), 0);
  page[26] = 1;
  page[27] = head.length;
  page.set(head, 28);
  return page;
}

function theme(dir: string, id: string, clips: string[], extra: Record<string, unknown> = {}) {
  mkdirSync(join(dir, id), { recursive: true });
  for (const c of clips) writeFileSync(join(dir, id, `${c}.ogg`), opus(1));
  writeFileSync(
    join(dir, id, "manifest.json"),
    JSON.stringify({
      theme: id,
      label: id,
      version: 1,
      generated_at: "2026-10-19T00:00:00Z",
      clips: Object.fromEntries(clips.map((c) => [c, { file: `${c}.ogg`, ms: 500, variant: 1 }])),
      missing: SOUND_EVENT_IDS.filter((e) => !clips.includes(e)),
      ...extra,
    }),
  );
}

describe("opusChannels", () => {
  test("reads the channel count from OpusHead; null for anything else", () => {
    expect(opusChannels(opus(1))).toBe(1);
    expect(opusChannels(opus(2))).toBe(2);
    expect(opusChannels(new TextEncoder().encode("ID3 not ogg at all, an mp3 ............."))).toBe(
      null,
    );
  });
});

describe("checkSounds", () => {
  test("passes on an empty folder (every event missing) but not with --complete", () => {
    const dir = temp();
    expect(checkSounds(dir)).toEqual([]);
    expect(checkSounds(dir, { complete: true })).toHaveLength(THEMES.length);
  });

  test("passes on a consistent theme", () => {
    const dir = temp();
    theme(dir, "arcade", ["ui_click", "ui_drop"]);
    expect(checkSounds(dir)).toEqual([]);
  });

  test("fails an event with neither a clip nor a missing entry", () => {
    const dir = temp();
    theme(dir, "arcade", ["ui_click"], { missing: [] });
    expect(checkSounds(dir).join("\n")).toContain("arcade/ui_drop: neither a clip nor listed");
  });

  test("fails a stray file and an unknown theme folder", () => {
    const dir = temp();
    theme(dir, "arcade", ["ui_click"]);
    writeFileSync(join(dir, "arcade", "old.ogg"), opus(1));
    mkdirSync(join(dir, "kazoo"));
    writeFileSync(join(dir, "kazoo", "x.ogg"), opus(1));
    const errors = checkSounds(dir).join("\n");
    expect(errors).toContain("arcade/old.ogg: not referenced");
    expect(errors).toContain("kazoo/x.ogg: not in a known theme folder");
  });

  test("fails a clip that is not Opus, or not mono", () => {
    const dir = temp();
    theme(dir, "arcade", ["ui_click", "ui_drop"]);
    writeFileSync(join(dir, "arcade", "ui_click.ogg"), "not ogg");
    writeFileSync(join(dir, "arcade", "ui_drop.ogg"), opus(2));
    const errors = checkSounds(dir).join("\n");
    expect(errors).toContain("arcade/ui_click.ogg: not Ogg/Opus");
    expect(errors).toContain("arcade/ui_drop.ogg: 2 channels");
  });

  test("fails a theme over the 200 KB budget", () => {
    const dir = temp();
    theme(dir, "arcade", ["ui_click"]);
    writeFileSync(join(dir, "arcade", "ui_click.ogg"), opus(1, THEME_BUDGET_BYTES));
    expect(checkSounds(dir).join("\n")).toContain("over the 200 KB budget");
  });

  test("the committed themes pass, complete", () => {
    expect(checkSounds(PUBLIC_SOUNDS, { complete: true })).toEqual([]);
  });
});
