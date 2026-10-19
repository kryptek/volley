// @vitest-environment node
//
// The pure-TS RSA-OAEP the Desk falls back to when `crypto.subtle` is missing (a phone on plain
// http), checked against Node's own crypto: what volleyd seals with `publicEncrypt` must open.
import { constants, createHash, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bigToBytes,
  bytesToBig,
  generateRsaKey,
  oaepDecrypt,
  probablyPrime,
  publicJwk,
  sha256,
} from "../src/lib/rsa";
import { newReplyKey } from "../src/store/control";

const seal = (jwk: JsonWebKey, plain: Buffer) =>
  publicEncrypt(
    {
      key: createPublicKey({ key: jwk as never, format: "jwk" }),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    plain,
  );

describe("sha256", () => {
  it("matches Node for every length across the block boundaries", () => {
    for (let n = 0; n <= 200; n++) {
      const data = randomBytes(n);
      expect(Buffer.from(sha256(data)).toString("hex")).toBe(
        createHash("sha256").update(data).digest("hex"),
      );
    }
  });
});

describe("RSA-OAEP fallback", () => {
  // One key for the file: generating it is the slow part.
  const key = generateRsaKey(2048);

  it("makes a 2048-bit key whose public JWK Node accepts", () => {
    expect(key.n.toString(2)).toHaveLength(2048);
    expect(key.p * key.q).toBe(key.n);
    const jwk = publicJwk(key);
    expect(jwk.kty).toBe("RSA");
    expect(jwk).not.toHaveProperty("d");
    const pub = createPublicKey({ key: jwk as never, format: "jwk" });
    expect(pub.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(pub.asymmetricKeyDetails?.publicExponent).toBe(65537n);
  });

  it("opens what Node seals, from empty up to the largest message OAEP fits", () => {
    const jwk = publicJwk(key);
    // Many messages, so both CRT branches (m1 < m2 and m1 ≥ m2) are taken.
    for (const n of [0, 1, 32, 100, 190, ...Array.from({ length: 24 }, (_, i) => 40 + i)]) {
      const plain = randomBytes(n);
      expect(Buffer.from(oaepDecrypt(key, seal(jwk, plain)))).toEqual(plain);
    }
  });

  it("refuses a tampered or truncated ciphertext", () => {
    const sealed = seal(publicJwk(key), Buffer.from("secret"));
    const bad = Buffer.from(sealed);
    bad[100] = (bad[100] as number) ^ 1;
    expect(() => oaepDecrypt(key, bad)).toThrow("decryption error");
    expect(() => oaepDecrypt(key, sealed.subarray(1))).toThrow("decryption error");
  });

  it("is what newReplyKey uses without WebCrypto, end to end", async () => {
    const reply = await newReplyKey(undefined);
    const secret = { username: "steer-0123abcd", password: "s3cret" };
    const sealed = seal(reply.jwk, Buffer.from(JSON.stringify(secret))).toString("base64url");
    expect(await reply.open(sealed)).toEqual(secret);
  });
});

describe("bigint helpers", () => {
  it("round-trips big-endian bytes and finds primes", () => {
    const b = randomBytes(64);
    expect(Buffer.from(bigToBytes(bytesToBig(b), 64))).toEqual(b);
    expect(() => bigToBytes(256n, 1)).toThrow();
    expect(probablyPrime(2n ** 127n - 1n, 8)).toBe(true);
    expect(probablyPrime((2n ** 61n - 1n) * (2n ** 31n - 1n), 8)).toBe(false);
    expect(probablyPrime(561n, 8)).toBe(false);
  });
});
