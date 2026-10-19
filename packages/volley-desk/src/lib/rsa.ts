/**
 * RSA-OAEP (SHA-256, MGF1-SHA-256, empty label) decryption with a 2048-bit key
 * made here, for pages where WebCrypto's `crypto.subtle` is missing. Browsers
 * expose `crypto.subtle` only in a secure context (https, or localhost), and a
 * phone opens the Desk over plain http on the LAN (`volley setup`'s link,
 * `http://<lan address>:5199/#signin=<token>`), so the sealed answers of SPEC
 * §4.6.10 must open without it. `crypto.getRandomValues` is available on every
 * page and is the only randomness used. RFC 8017 §7.1.2 (decryption), FIPS
 * 180-4 (SHA-256); key generation by random odd candidates, a small-prime
 * sieve and Miller–Rabin. Pure: no I/O, checked against Node's
 * `publicEncrypt` in the tests.
 */

// ------------------------------------------------------------------ SHA-256

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bits = data.length * 8;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(padded.length - 4, bits >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const e0 = e as number;
      const a0 = a as number;
      const s1 = rotr(e0, 6) ^ rotr(e0, 11) ^ rotr(e0, 25);
      const ch = (e0 & (f as number)) ^ (~e0 & (g as number));
      const t1 = ((hh as number) + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const s0 = rotr(a0, 2) ^ rotr(a0, 13) ^ rotr(a0, 22);
      const maj = (a0 & (b as number)) ^ (a0 & (c as number)) ^ ((b as number) & (c as number));
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = ((d as number) + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const add = [a, b, c, d, e, f, g, hh] as number[];
    for (let i = 0; i < 8; i++) h[i] = ((h[i] as number) + (add[i] as number)) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i] as number);
  return out;
}

// ------------------------------------------------------------------ bigints

export function bytesToBig(b: Uint8Array): bigint {
  let x = 0n;
  for (const byte of b) x = (x << 8n) | BigInt(byte);
  return x;
}

/** Big-endian, exactly `len` bytes (I2OSP). Throws when `x` does not fit. */
export function bigToBytes(x: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let v = x;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("integer too large");
  return out;
}

export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [a % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error("not invertible");
  return ((oldS % m) + m) % m;
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

type Random = (bytes: Uint8Array<ArrayBuffer>) => void;

const systemRandom: Random = (bytes) => {
  crypto.getRandomValues(bytes);
};

/** A uniformly random integer in [2, n - 2]. */
function randomBelow(n: bigint, random: Random): bigint {
  const len = Math.ceil(n.toString(16).length / 2);
  for (;;) {
    const b = new Uint8Array(len);
    random(b);
    const x = bytesToBig(b) % n;
    if (x >= 2n && x <= n - 2n) return x;
  }
}

const SMALL_PRIMES = (() => {
  const out: number[] = [];
  for (let n = 3; out.length < 300; n += 2) if (out.every((p) => n % p !== 0)) out.push(n);
  return out.map(BigInt);
})();

/** Miller–Rabin with `rounds` random bases. */
export function probablyPrime(n: bigint, rounds: number, random: Random = systemRandom): boolean {
  if (n < 2n) return false;
  for (const p of SMALL_PRIMES) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }
  let d = n - 1n;
  let s = 0;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s++;
  }
  outer: for (let i = 0; i < rounds; i++) {
    let x = modPow(randomBelow(n, random), d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let j = 1; j < s; j++) {
      x = (x * x) % n;
      if (x === n - 1n) continue outer;
    }
    return false;
  }
  return true;
}

const E = 65537n;
/** Miller–Rabin rounds for a 1024-bit prime factor (FIPS 186-5 Table B.1 asks for 5; more is cheap). */
const MR_ROUNDS = 12;

/** A random `bits`-bit prime with its top two bits set (so p·q has exactly 2·bits bits), p ≢ 1 mod e. */
function randomPrime(bits: number, random: Random): bigint {
  const len = bits / 8;
  for (;;) {
    const b = new Uint8Array(len);
    random(b);
    b[0] = (b[0] as number) | 0xc0;
    b[len - 1] = (b[len - 1] as number) | 1;
    const p = bytesToBig(b);
    if ((p - 1n) % E === 0n) continue;
    if (probablyPrime(p, MR_ROUNDS, random)) return p;
  }
}

export interface RsaPrivateKey {
  n: bigint;
  e: bigint;
  d: bigint;
  p: bigint;
  q: bigint;
  dp: bigint;
  dq: bigint;
  qinv: bigint;
}

/** A fresh RSA key of `bits` bits (2048 for a reply key). */
export function generateRsaKey(bits = 2048, random: Random = systemRandom): RsaPrivateKey {
  for (;;) {
    const p = randomPrime(bits / 2, random);
    const q = randomPrime(bits / 2, random);
    if (p === q) continue;
    const n = p * q;
    const phi = (p - 1n) * (q - 1n);
    if (gcd(E, phi) !== 1n) continue;
    const lambda = phi / gcd(p - 1n, q - 1n);
    const d = modInverse(E, lambda);
    return { n, e: E, d, p, q, dp: d % (p - 1n), dq: d % (q - 1n), qinv: modInverse(q, p) };
  }
}

const b64url = (b: Uint8Array) => {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** The public half as a JWK (what a request carries as `reply_key`). */
export function publicJwk(key: RsaPrivateKey): JsonWebKey {
  const len = Math.ceil(key.n.toString(16).length / 2);
  return {
    kty: "RSA",
    n: b64url(bigToBytes(key.n, len)),
    e: b64url(bigToBytes(key.e, 3)),
    alg: "RSA-OAEP-256",
    ext: true,
  };
}

function mgf1(seed: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(len);
  const block = new Uint8Array(seed.length + 4);
  block.set(seed);
  for (let counter = 0, off = 0; off < len; counter++, off += 32) {
    new DataView(block.buffer).setUint32(seed.length, counter);
    out.set(sha256(block).subarray(0, Math.min(32, len - off)), off);
  }
  return out;
}

const EMPTY_LABEL_HASH = sha256(new Uint8Array(0));

/** RSAES-OAEP-DECRYPT with SHA-256 and an empty label (RFC 8017 §7.1.2). Throws on any error. */
export function oaepDecrypt(key: RsaPrivateKey, ciphertext: Uint8Array): Uint8Array {
  const k = Math.ceil(key.n.toString(16).length / 2);
  const hLen = 32;
  if (ciphertext.length !== k || k < 2 * hLen + 2) throw new Error("decryption error");
  const c = bytesToBig(ciphertext);
  if (c >= key.n) throw new Error("decryption error");
  // CRT: m = m2 + q·((m1 − m2)·qinv mod p).
  const m1 = modPow(c, key.dp, key.p);
  const m2 = modPow(c, key.dq, key.q);
  const h = (((((m1 - m2) % key.p) + key.p) % key.p) * key.qinv) % key.p;
  const em = bigToBytes(m2 + h * key.q, k);
  const maskedSeed = em.subarray(1, 1 + hLen);
  const maskedDb = em.subarray(1 + hLen);
  const seed = mgf1(maskedDb, hLen).map((x, i) => x ^ (maskedSeed[i] as number));
  const db = mgf1(seed, k - hLen - 1).map((x, i) => x ^ (maskedDb[i] as number));
  let bad = em[0] !== 0;
  for (let i = 0; i < hLen; i++) bad ||= db[i] !== EMPTY_LABEL_HASH[i];
  let i = hLen;
  while (i < db.length && db[i] === 0) i++;
  if (bad || db[i] !== 1) throw new Error("decryption error");
  return db.slice(i + 1);
}
