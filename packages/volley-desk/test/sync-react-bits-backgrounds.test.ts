import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffBackgrounds, main, parseBackgrounds } from "../scripts/sync-react-bits-backgrounds";
import { REACT_BITS_BACKGROUNDS } from "../src/look/backgrounds";

const entry = (name: string) =>
  `- [${name}](https://www.reactbits.dev/backgrounds/x): Something. CLI: \`${name}\`.`;
const llms = (names: string[]) =>
  [
    "# React Bits",
    "",
    "## Text Animations",
    "",
    entry("ShinyText"),
    "",
    "## Backgrounds",
    "",
    ...names.map(entry),
    "",
    "## Variants",
    "",
    "- `TS-CSS`",
  ].join("\n");

const dirs: string[] = [];
const write = (text: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), "rb-llms-"));
  dirs.push(dir);
  const file = path.join(dir, "llms.txt");
  writeFileSync(file, text);
  return file;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sync-react-bits-backgrounds", () => {
  it("reads only the Backgrounds section", () => {
    expect(parseBackgrounds(llms(["Aurora", "CRTWarp"]))).toEqual(["Aurora", "CRTWarp"]);
    expect(() => parseBackgrounds("# nothing")).toThrow(/Backgrounds/);
  });

  it("diffs both ways", () => {
    expect(diffBackgrounds(["A", "B", "C"], ["B", "D"])).toEqual({
      missing: ["A", "C"],
      extra: ["D"],
    });
  });

  it("passes when the registry matches and warns (exit 1) when React Bits adds one", async () => {
    const ours = REACT_BITS_BACKGROUNDS.map((b) => b.key);
    const lines: string[] = [];
    expect(await main([write(llms(ours))], (l) => lines.push(l))).toBe(0);
    expect(lines.join("\n")).toContain("ok (63 backgrounds");
    lines.length = 0;
    expect(await main([write(llms([...ours, "NewShiny"]))], (l) => lines.push(l))).toBe(1);
    expect(lines.join("\n")).toContain('React Bits added "NewShiny"');
  });
});
