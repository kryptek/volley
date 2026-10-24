import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Grep-guard (SPEC §4.6.11): the one place the Desk takes what finishes a Claude sign-in is the
 * sign-in box (`SigninLink`): a single password-type input with autocomplete off, whose text goes
 * to volleyd once (`claude_signin_entry`) and is cleared. The sheet has no other input, and no
 * textarea, select or contenteditable at all.
 */
const SHEET = path.join(__dirname, "../src/settings/PeerSigninSheet.tsx");
const FIELD = /<input\b|<textarea\b|contentEditable|contenteditable|<select\b/;

describe("credential fields in the Desk's Claude sign-in", () => {
  it("the detector catches what it guards against", () => {
    expect(FIELD.test('<input aria-label="code" />')).toBe(true);
    expect(FIELD.test("<textarea />")).toBe(true);
    expect(FIELD.test("<div contentEditable />")).toBe(true);
    expect(FIELD.test("<a href={url}>Open sign-in</a>")).toBe(false);
  });

  it("PeerSigninSheet.tsx has one field: the sign-in box, password-type, autocomplete off", () => {
    const src = readFileSync(SHEET, "utf-8");
    const lines = src
      .split("\n")
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => !/^\s*(\/\/|\*|\/\*)/.test(l) && FIELD.test(l));
    expect(lines.map(([, l]) => l.trim())).toEqual(["<input"]);
    const start = lines[0]?.[0] as number;
    const tag = src
      .split("\n")
      .slice(start - 1)
      .join("\n");
    const input = tag.slice(0, tag.indexOf("/>"));
    expect(input).toContain('type="password"');
    expect(input).toContain('autoComplete="off"');
  });
});
