/**
 * A QR decoder for clean module matrices (no image processing), written apart from the encoder
 * so a test can check what a scanner reads: the format bits (with their BCH check), the
 * function-pattern layout, the zigzag order, the mask, the block interleaving, the Reed-Solomon
 * syndromes and the byte-mode segment. Byte mode and level M only, like the encoder.
 */

const BLOCKS_M: Record<number, { ec: number; blocks: number[] }> = {
  1: { ec: 10, blocks: [16] },
  2: { ec: 16, blocks: [28] },
  3: { ec: 26, blocks: [44] },
  4: { ec: 18, blocks: [32, 32] },
  5: { ec: 24, blocks: [43, 43] },
  6: { ec: 16, blocks: [27, 27, 27, 27] },
  7: { ec: 18, blocks: [31, 31, 31, 31] },
  8: { ec: 22, blocks: [38, 38, 39, 39] },
  9: { ec: 22, blocks: [36, 36, 36, 37, 37] },
  10: { ec: 26, blocks: [43, 43, 43, 43, 44] },
  11: { ec: 30, blocks: [50, 51, 51, 51, 51] },
  12: { ec: 22, blocks: [36, 36, 36, 36, 36, 36, 37, 37] },
  13: { ec: 22, blocks: [37, 37, 37, 37, 37, 37, 37, 37, 38] },
  14: { ec: 24, blocks: [40, 40, 40, 40, 41, 41, 41, 41, 41] },
  15: { ec: 24, blocks: [41, 41, 41, 41, 41, 42, 42, 42, 42, 42] },
  16: { ec: 28, blocks: [45, 45, 45, 45, 45, 45, 45, 46, 46, 46] },
  17: { ec: 28, blocks: [46, 46, 46, 46, 46, 46, 46, 46, 46, 46, 47] },
  18: { ec: 26, blocks: [43, 43, 43, 43, 43, 43, 43, 43, 43, 44, 44, 44, 44] },
  19: { ec: 26, blocks: [44, 44, 44, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45] },
  20: { ec: 26, blocks: [41, 41, 41, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42] },
};

/** ISO/IEC 18004 Table E.1, the alignment pattern centres. */
const ALIGN: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
  11: [6, 30, 54],
  12: [6, 32, 58],
  13: [6, 34, 62],
  14: [6, 26, 46, 66],
  15: [6, 26, 48, 70],
  16: [6, 26, 50, 74],
  17: [6, 30, 54, 78],
  18: [6, 30, 56, 82],
  19: [6, 30, 58, 86],
  20: [6, 34, 62, 90],
};

/** Parse the `#`/`.` text form. */
export function parseMatrix(text: string): boolean[][] {
  return text
    .trim()
    .split("\n")
    .map((l) => [...l.trim()].map((c) => c === "#"));
}

/** Every valid 15-bit format word with its (level bits, mask): data × BCH(15,5), masked. */
function formatTable(): { word: number; ecl: number; mask: number }[] {
  const out: { word: number; ecl: number; mask: number }[] = [];
  for (let d = 0; d < 32; d++) {
    let r = d << 10;
    for (let i = 14; i >= 10; i--) if ((r >> i) & 1) r ^= 0x537 << (i - 10);
    out.push({ word: ((d << 10) | r) ^ 0x5412, ecl: d >> 3, mask: d & 7 });
  }
  return out;
}

const popcount = (n: number) => n.toString(2).replace(/0/g, "").length;

function gfTables() {
  const exp: number[] = [];
  const log: number[] = new Array(256).fill(0);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp.push(x);
    log[x] = i;
    x = x & 0x80 ? ((x << 1) ^ 0x11d) & 0xff : x << 1;
  }
  return { exp, log };
}

/** Whether `codeword` (data then EC, highest power first) has all-zero syndromes. */
function syndromesZero(codeword: number[], ec: number): boolean {
  const { exp, log } = gfTables();
  for (let i = 0; i < ec; i++) {
    // Evaluate at α^i by Horner's rule.
    let s = 0;
    for (const c of codeword) {
      s = s === 0 ? c : (exp[((log[s] as number) + i) % 255] as number) ^ c;
    }
    if (s !== 0) return false;
  }
  return true;
}

export interface Decoded {
  version: number;
  ecl: number;
  mask: number;
  text: string;
}

export function decodeMatrix(m: boolean[][]): Decoded {
  const size = m.length;
  if ((size - 17) % 4 !== 0 || m.some((r) => r.length !== size)) throw new Error("not square QR");
  const version = (size - 17) / 4;
  const info = BLOCKS_M[version];
  if (info === undefined) throw new Error(`unsupported version ${version}`);
  const at = (x: number, y: number) => (m[y] as boolean[])[x] === true;

  // Format copy 1: bits 14..0 read along row 8 then column 8 around the top-left finder.
  const coords1: [number, number][] = [
    [0, 8],
    [1, 8],
    [2, 8],
    [3, 8],
    [4, 8],
    [5, 8],
    [7, 8],
    [8, 8],
    [8, 7],
    [8, 5],
    [8, 4],
    [8, 3],
    [8, 2],
    [8, 1],
    [8, 0],
  ];
  let word = 0;
  for (const [x, y] of coords1) word = (word << 1) | (at(x, y) ? 1 : 0);
  const best = formatTable()
    .map((f) => ({ ...f, dist: popcount(f.word ^ word) }))
    .sort((a, b) => a.dist - b.dist)[0];
  if (best === undefined || best.dist !== 0) throw new Error("format bits do not check");
  if (best.ecl !== 0) throw new Error(`level ${best.ecl} is not M`);

  // Which modules are function patterns.
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++)
        if (x >= 0 && y >= 0 && x < size && y < size) (fn[y] as boolean[])[x] = true;
  };
  mark(0, 0, 9, 9); // finder + separator + format
  mark(size - 8, 0, 8, 9);
  mark(0, size - 8, 9, 8);
  mark(6, 0, 1, size); // timing
  mark(0, 6, size, 1);
  const al = ALIGN[version] as number[];
  for (const cy of al)
    for (const cx of al) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6))
        continue;
      mark(cx - 2, cy - 2, 5, 5);
    }
  if (version >= 7) {
    mark(size - 11, 0, 3, 6);
    mark(0, size - 11, 6, 3);
  }

  const maskFn: ((r: number, c: number) => boolean)[] = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  const unmask = maskFn[best.mask] as (r: number, c: number) => boolean;

  // Read two-column strips from the right edge, alternating up and down, skipping column 6.
  const bits: number[] = [];
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < size; k++) {
      const row = up ? size - 1 - k : k;
      for (const c of [col, col - 1]) {
        if ((fn[row] as boolean[])[c]) continue;
        bits.push(at(c, row) !== unmask(row, c) ? 1 : 0);
      }
    }
    up = !up;
  }
  const total = info.blocks.reduce((a, b) => a + b, 0) + info.ec * info.blocks.length;
  const cws: number[] = [];
  for (let i = 0; i < total; i++) {
    cws.push(bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));
  }

  // De-interleave.
  const data = info.blocks.map(() => [] as number[]);
  const ecs = info.blocks.map(() => [] as number[]);
  let p = 0;
  for (let i = 0; i < Math.max(...info.blocks); i++)
    info.blocks.forEach((n, b) => {
      if (i < n) (data[b] as number[]).push(cws[p++] as number);
    });
  for (let i = 0; i < info.ec; i++) for (const e of ecs) e.push(cws[p++] as number);
  data.forEach((d, b) => {
    if (!syndromesZero([...d, ...(ecs[b] as number[])], info.ec)) {
      throw new Error(`block ${b} fails its Reed-Solomon check`);
    }
  });

  const stream = data
    .flat()
    .flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (byte >> i) & 1));
  let q = 0;
  const take = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | (stream[q++] as number);
    return v;
  };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`mode ${mode.toString(2)} is not byte mode`);
  const len = take(version < 10 ? 8 : 16);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = take(8);
  return { version, ecl: best.ecl, mask: best.mask, text: new TextDecoder().decode(bytes) };
}
