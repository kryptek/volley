/** Only the player touches Web Audio and vibration; only it fetches clips. */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../src");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : [],
  );
}

describe("the sound boundary", () => {
  it("only src/sounds/player.ts uses AudioContext, decodeAudioData or navigator.vibrate", () => {
    const hits = files(SRC)
      .filter((f) =>
        /AudioContext|decodeAudioData|navigator\.vibrate/.test(readFileSync(f, "utf8")),
      )
      .map((f) => relative(SRC, f));
    expect(hits).toEqual(["sounds/player.ts"]);
  });

  it("in src/sounds/, only player.ts mentions fetch or navigator", () => {
    const hits = files(join(SRC, "sounds"))
      .filter((f) => /\bfetch\(|\bnavigator\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(hits).toEqual(["sounds/player.ts"]);
  });

  it("nothing refers to the old chime", () => {
    const hits = files(SRC).filter((f) => readFileSync(f, "utf8").includes("notify.mp3"));
    expect(hits).toEqual([]);
  });
});
