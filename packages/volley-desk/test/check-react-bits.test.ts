// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REACT_BITS_ALLOW_LIST, checkReactBits, main } from "../scripts/check-react-bits";

const dirs: string[] = [];

function rbDir(components: string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), "desk-rb-"));
  dirs.push(root);
  for (const name of components) {
    mkdirSync(path.join(root, name));
    writeFileSync(path.join(root, name, `${name}.tsx`), "export default function X() {}\n");
  }
  return root;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("check-react-bits", () => {
  it("allow-lists the prototype's free components", () => {
    expect(REACT_BITS_ALLOW_LIST).toContain("Dock");
    expect(REACT_BITS_ALLOW_LIST).toContain("GradientWaves");
    expect(REACT_BITS_ALLOW_LIST).toContain("StatusMark");
  });

  it("passes when every installed component is allow-listed", () => {
    const dir = rbDir(["Dock", "ShinyText"]);
    expect(checkReactBits(dir)).toEqual({ ok: true, unknown: [] });
    expect(main([dir], () => {})).toBe(0);
  });

  it("fails on a component outside the allow-list", () => {
    const dir = rbDir(["Dock", "FancyProCarousel"]);
    expect(checkReactBits(dir)).toEqual({ ok: false, unknown: ["FancyProCarousel"] });
    const lines: string[] = [];
    expect(main([dir], (l) => lines.push(l))).toBe(1);
    expect(lines.join("\n")).toContain("FancyProCarousel");
  });

  it("treats a stray file at the top of src/rb as a component", () => {
    const dir = rbDir([]);
    writeFileSync(path.join(dir, "Marquee.tsx"), "export {}\n");
    writeFileSync(path.join(dir, ".gitkeep"), "");
    expect(checkReactBits(dir).unknown).toEqual(["Marquee"]);
  });

  it("passes when src/rb does not exist yet", () => {
    expect(checkReactBits(path.join(tmpdir(), "desk-rb-missing-xyz")).ok).toBe(true);
  });
});
