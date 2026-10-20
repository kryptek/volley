import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeQr, formatBits, matrixText, renderQr, versionBits } from "../../src/setup/qr";
import { decodeMatrix, parseMatrix } from "./qr-decode";

const URL_ =
  "http://desk.example:5199/#signin=vly_signin_0123abcd_0123456789abcdef0123456789abcdef";
const fixture = readFileSync(new URL("./fixtures/qr-signin-link.txt", import.meta.url), "utf-8");

describe("encodeQr", () => {
  it("renders a known sign-in link as the stable fixture matrix, which decodes back to it", () => {
    const qr = encodeQr(URL_);
    expect(matrixText(qr)).toBe(fixture);
    const d = decodeMatrix(parseMatrix(fixture));
    expect(d.text).toBe(URL_);
    expect(d.version).toBe(qr.version);
    expect(d.mask).toBe(qr.mask);
  });

  it("round-trips every mask and size from one byte to the version 10 limit", () => {
    for (const text of ["a", "é ünïcode ✓", "x".repeat(84), "y".repeat(85), "z".repeat(213)]) {
      for (let mask = 0; mask < 8; mask++) {
        const qr = encodeQr(text, { mask });
        expect(qr.size).toBe(17 + 4 * qr.version);
        expect(decodeMatrix(qr.matrix).text).toBe(text);
      }
    }
    expect(encodeQr("y".repeat(85)).version).toBe(6);
    expect(encodeQr("z".repeat(213)).version).toBe(10);
  });

  it("refuses text beyond version 10", () => {
    expect(() => encodeQr("q".repeat(214))).toThrow(/too long/);
  });

  it("matches the standard's format and version words", () => {
    // ISO/IEC 18004 Annex C: level M, mask 0 = 101010000010010; version 7 = 000111110010010100.
    expect(formatBits(0).toString(2).padStart(15, "0")).toBe("101010000010010");
    expect(versionBits(7).toString(2).padStart(18, "0")).toBe("000111110010010100");
  });
});

describe("renderQr", () => {
  it("prints two module rows per line inside the quiet zone, black on white", () => {
    const qr = encodeQr("a");
    const plain = renderQr(qr, { color: false }).replace(/\n$/, "").split("\n");
    expect(plain).toHaveLength(Math.ceil((qr.size + 4) / 2));
    expect(plain.every((l) => [...l].length === qr.size + 4)).toBe(true);
    // The top-left finder's top edge: quiet row above it, so its first line is the finder's top two rows.
    expect(plain[1]?.slice(2, 9)).toBe("█▀▀▀▀▀█");
    // Read back, the half blocks give exactly the module matrix inside the quiet zone.
    const big = encodeQr(URL_);
    const lines = renderQr(big, { color: false }).replace(/\n$/, "").split("\n");
    const rows: boolean[][] = [];
    for (const l of lines) {
      const cells = [...l];
      rows.push(cells.map((c) => c === "█" || c === "▀"));
      rows.push(cells.map((c) => c === "█" || c === "▄"));
    }
    const inner = rows.slice(2, 2 + big.size).map((r) => r.slice(2, 2 + big.size));
    expect(inner).toEqual(big.matrix);
    expect(decodeMatrix(inner).text).toBe(URL_);
    const colored = renderQr(qr);
    expect(colored.startsWith("\x1b[30;47m")).toBe(true);
    expect(colored).toContain("\x1b[0m");
  });
});
