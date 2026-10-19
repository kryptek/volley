/**
 * A QR code encoder for the Desk (sign-in links, one-time passwords): byte mode, error
 * correction level M, versions 1..10 (up to 213 bytes, ample for a Desk sign-in link), mask
 * chosen by the standard penalty score (ISO/IEC 18004). A port of `volley setup`'s terminal
 * encoder (volley-cli `src/setup/qr.ts`, checked there by an independent decoder; the shared
 * fixture in `test/fixtures/qr-signin-link.txt` keeps the two identical). Pure: `encodeQr`
 * returns the module matrix, `qrPath` an SVG path of its dark modules.
 */

/** `true` = a dark module. `matrix[y][x]`, square, `size = 17 + 4 * version`. */
export interface QrCode {
  version: number;
  mask: number;
  size: number;
  matrix: boolean[][];
}

interface VersionInfo {
  /** Error correction codewords per block. */
  ec: number;
  /** Data codewords of each block, in order. */
  blocks: number[];
  /** Alignment pattern centre coordinates. */
  align: number[];
}

/** Level M. */
const VERSIONS: VersionInfo[] = [
  { ec: 10, blocks: [16], align: [] },
  { ec: 16, blocks: [28], align: [6, 18] },
  { ec: 26, blocks: [44], align: [6, 22] },
  { ec: 18, blocks: [32, 32], align: [6, 26] },
  { ec: 24, blocks: [43, 43], align: [6, 30] },
  { ec: 16, blocks: [27, 27, 27, 27], align: [6, 34] },
  { ec: 18, blocks: [31, 31, 31, 31], align: [6, 22, 38] },
  { ec: 22, blocks: [38, 38, 39, 39], align: [6, 24, 42] },
  { ec: 22, blocks: [36, 36, 36, 37, 37], align: [6, 26, 46] },
  { ec: 26, blocks: [43, 43, 43, 43, 44], align: [6, 28, 50] },
];

/** The format bits' error-correction level field for M. */
const ECL_M = 0b00;

// GF(256) over x^8 + x^4 + x^3 + x^2 + 1, the field QR's Reed-Solomon codes use.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] as number;
}
const mul = (a: number, b: number) =>
  a === 0 || b === 0 ? 0 : (EXP[(LOG[a] as number) + (LOG[b] as number)] as number);

/** The `degree` error correction codewords of `data` (generator roots α^0..α^(degree-1)). */
export function reedSolomon(data: readonly number[], degree: number): number[] {
  // Generator polynomial, highest coefficient (always 1) dropped.
  const gen = new Array<number>(degree).fill(0);
  gen[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      gen[j] = mul(gen[j] as number, root) ^ (j + 1 < degree ? (gen[j + 1] as number) : 0);
    }
    root = mul(root, 2);
  }
  const rem = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ (rem.shift() as number);
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] = (rem[i] as number) ^ mul(gen[i] as number, factor);
  }
  return rem;
}

/** The capacity in bytes of byte mode at `version` (level M). */
const capacity = (v: number) => {
  const data = VERSIONS[v - 1]?.blocks.reduce((a, b) => a + b, 0) ?? 0;
  const countBits = v < 10 ? 8 : 16;
  return Math.floor((data * 8 - 4 - countBits) / 8);
};

/** The data + error correction codewords of `bytes`, interleaved, for `version`. */
function codewords(bytes: Uint8Array, version: number): number[] {
  const info = VERSIONS[version - 1] as VersionInfo;
  const dataLen = info.blocks.reduce((a, b) => a + b, 0);
  const bits: number[] = [];
  const put = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, dataLen * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  }
  for (let pad = 0xec; data.length < dataLen; pad ^= 0xec ^ 0x11) data.push(pad);

  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let at = 0;
  for (const n of info.blocks) {
    const block = data.slice(at, at + n);
    at += n;
    blocks.push(block);
    ecBlocks.push(reedSolomon(block, info.ec));
  }
  const out: number[] = [];
  const longest = Math.max(...info.blocks);
  for (let i = 0; i < longest; i++) {
    for (const b of blocks) if (i < b.length) out.push(b[i] as number);
  }
  for (let i = 0; i < info.ec; i++) for (const b of ecBlocks) out.push(b[i] as number);
  return out;
}

/** BCH remainder of `value` (already shifted) by `poly` of degree `deg`. */
function bch(value: number, poly: number, deg: number): number {
  let v = value;
  for (let i = 31 - Math.clz32(v); i >= deg; i = 31 - Math.clz32(v)) v ^= poly << (i - deg);
  return v;
}

/** The 15 format bits for level M and `mask`. */
export const formatBits = (mask: number) => {
  const d = (ECL_M << 3) | mask;
  return ((d << 10) | bch(d << 10, 0x537, 10)) ^ 0x5412;
};

/** The 18 version bits (version >= 7). */
export const versionBits = (version: number) => (version << 12) | bch(version << 12, 0x1f25, 12);

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Modules of a version's function patterns and their reserved areas, before data or masks. */
function baseMatrix(version: number): { m: boolean[][]; fn: boolean[][] } {
  const size = 17 + 4 * version;
  const m = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    (m[y] as boolean[])[x] = dark;
    (fn[y] as boolean[])[x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const align = (VERSIONS[version - 1] as VersionInfo).align;
  for (const cy of align) {
    for (const cx of align) {
      // Not over the finder patterns.
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6))
        continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  // Reserve the format areas (drawn per mask) and the dark module.
  for (let i = 0; i < 9; i++) {
    set(8, i, false);
    set(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    set(size - 1 - i, 8, false);
    set(8, size - 1 - i, false);
  }
  set(8, size - 8, true);
  if (version >= 7) {
    const v = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((v >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  // Restore the timing patterns the format reservation overwrote.
  set(6, 8, true);
  set(8, 6, true);
  return { m, fn };
}

function drawFormat(m: boolean[][], mask: number): void {
  const size = m.length;
  const f = formatBits(mask);
  const bit = (i: number) => ((f >>> i) & 1) === 1;
  const set = (x: number, y: number, dark: boolean) => {
    (m[y] as boolean[])[x] = dark;
  };
  // Copy 1, around the top-left finder.
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  // Copy 2, split between the other two finders.
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

/** Place `cw` in the zigzag order over every non-function module. */
function placeData(m: boolean[][], fn: boolean[][], cw: readonly number[]): void {
  const size = m.length;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if ((fn[y] as boolean[])[x]) continue;
        const byte = cw[i >>> 3];
        (m[y] as boolean[])[x] = byte !== undefined && ((byte >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

function applyMask(m: boolean[][], fn: boolean[][], mask: number): boolean[][] {
  const f = MASKS[mask] as (x: number, y: number) => boolean;
  return m.map((row, y) => row.map((v, x) => ((fn[y] as boolean[])[x] ? v : v !== f(x, y))));
}

/** The standard's penalty score (rules N1..N4); the mask with the lowest wins. */
export function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  const at = (x: number, y: number) => (m[y] as boolean[])[x] as boolean;
  const lines = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < size; i++) {
      // N1: runs of five or more.
      let run = 1;
      for (let j = 1; j <= size; j++) {
        if (j < size && get(i, j) === get(i, j - 1)) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      // N3: 1:1:3:1:1 finder-like patterns with four light modules on one side, in bounds.
      for (let j = 0; j + 10 < size; j++) {
        const w = [...Array(11).keys()].map((k) => get(i, j + k));
        const is = (p: string) => [...p].every((c, k) => (c === "1") === w[k]);
        if (is("10111010000") || is("00001011101")) score += 40;
      }
    }
  };
  lines((i, j) => at(j, i));
  lines((i, j) => at(i, j));
  // N2: 2x2 blocks of one colour.
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = at(x, y);
      if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += 3;
    }
  }
  // N4: dark proportion away from 50%.
  const dark = m.reduce((a, row) => a + row.filter(Boolean).length, 0);
  score += Math.abs(Math.ceil((dark * 100) / (size * size) / 5) - 10) * 10;
  return score;
}

/** Encode `text` (UTF-8) at the smallest version that holds it. Throws when it is too long. */
export function encodeQr(text: string, opts: { mask?: number } = {}): QrCode {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= VERSIONS.length && capacity(version) < bytes.length) version++;
  if (version > VERSIONS.length) {
    throw new Error(
      `text too long for a QR code here (${bytes.length} bytes; at most ${capacity(VERSIONS.length)})`,
    );
  }
  const { m, fn } = baseMatrix(version);
  placeData(m, fn, codewords(bytes, version));
  let best: { mask: number; matrix: boolean[][]; score: number } | null = null;
  const masks = opts.mask !== undefined ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7];
  for (const mask of masks) {
    const matrix = applyMask(m, fn, mask);
    drawFormat(matrix, mask);
    const score = penalty(matrix);
    if (best === null || score < best.score) best = { mask, matrix, score };
  }
  const b = best as { mask: number; matrix: boolean[][] };
  return { version, mask: b.mask, size: m.length, matrix: b.matrix };
}

/**
 * The dark modules as one SVG path in module units, offset by a quiet zone of `quiet` modules:
 * draw it in a `viewBox` of `0 0 (size + 2·quiet) (size + 2·quiet)`.
 */
export function qrPath(qr: QrCode, quiet = 2): string {
  const parts: string[] = [];
  qr.matrix.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    });
  });
  return parts.join("");
}

/** `#` dark, `.` light: one row per line (the test fixture's form). */
export const matrixText = (qr: QrCode) =>
  `${qr.matrix.map((r) => r.map((d) => (d ? "#" : ".")).join("")).join("\n")}\n`;
