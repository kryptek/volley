import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Grep-guard (SPEC §4.6.11): the Desk never offers a field a Claude sign-in code could be typed
 * into. The paired machine's sign-in sheet has no input, textarea or contenteditable at all.
 */
const SHEET = path.join(__dirname, "../src/settings/PeerSigninSheet.tsx");
const FIELD = /<input\b|<textarea\b|contentEditable|contenteditable|<select\b/;

describe("no credential fields in the Desk's Claude sign-in", () => {
  it("the detector catches what it guards against", () => {
    expect(FIELD.test('<input aria-label="code" />')).toBe(true);
    expect(FIELD.test("<textarea />")).toBe(true);
    expect(FIELD.test("<div contentEditable />")).toBe(true);
    expect(FIELD.test("<a href={url}>Open sign-in</a>")).toBe(false);
  });

  it("PeerSigninSheet.tsx has no input, textarea or contenteditable", () => {
    const lines = readFileSync(SHEET, "utf-8")
      .split("\n")
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => !/^\s*(\/\/|\*|\/\*)/.test(l) && FIELD.test(l));
    expect(lines).toEqual([]);
  });
});
