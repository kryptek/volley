import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ROLES,
  type Account,
  DESK_OPS,
  SIGNIN_ROLES,
  accountOp,
  authOpsTopic,
  deskBase,
  deskRefusal,
  isValidLabel,
  replyKey,
  seal,
  tokenRedeemTopic,
  tokenReplyTopic,
} from "../src/accounts";
import { fakeExec } from "./helpers/fake-exec";

/** The pure helpers behind the account ops (SPEC §4.6.10); the daemon wiring is control-accounts. */

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = keys.publicKey.export({ format: "jwk" });
const unseal = (sealed: unknown) =>
  JSON.parse(
    privateDecrypt(
      { key: keys.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(sealed as string, "base64url"),
    ).toString("utf-8"),
  );

/** A `volley auth` that knows `admin-1` (admin) and `steer-1`, and answers the account verbs. */
function auth() {
  return fakeExec().on(["volley", "auth"], (argv) => {
    if (argv[2] === "list") {
      return {
        stdout: JSON.stringify({
          accounts: [
            { name: "admin-1", role: "admin", kind: "human", created: "2026-10-18T12:00:00Z" },
            { name: "steer-1", role: "steer", kind: "device", created: "2026-10-18T12:00:00Z" },
          ],
        }),
      };
    }
    if (argv[2] === "signin-link") {
      return {
        stdout: JSON.stringify({
          token: `vly_signin_0000abcd_${"f".repeat(32)}`,
          username: "0000abcd",
          expires_at: "2026-10-18T12:10:00.000Z",
        }),
      };
    }
    if (argv[2] === "rotate")
      return { stdout: JSON.stringify({ username: argv[3], password: "p" }) };
    return { stdout: "not json" };
  });
}

describe("replyKey", () => {
  it("accepts a 2048-bit RSA public JWK", () => {
    expect(typeof replyKey(jwk)).not.toBe("string");
  });

  it("refuses a key too small to trust a secret to", () => {
    const small = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({
      format: "jwk",
    });
    expect(replyKey(small)).toBe("reply_key must be at least 2048 bits");
  });

  it("refuses a non-RSA, malformed or missing key", () => {
    for (const k of [undefined, null, "not-a-key", { kty: "oct", k: "abc" }, { kty: "RSA" }]) {
      expect(replyKey(k), JSON.stringify(k)).toMatch(/^reply_key /);
    }
  });
});

describe("seal", () => {
  it("is RSA-OAEP/SHA-256 ciphertext only the key's private half opens", () => {
    const key = replyKey(jwk);
    if (typeof key === "string") throw new Error(key);
    const sealed = seal(key, { username: "u", password: "secret" });
    expect(sealed).not.toContain("secret");
    expect(unseal(sealed)).toEqual({ username: "u", password: "secret" });
  });
});

describe("isValidLabel", () => {
  it("takes 1..64 printable characters, apostrophes included", () => {
    expect(isValidLabel("Owner's phone")).toBe(true);
    expect(isValidLabel("x".repeat(64))).toBe(true);
  });

  it("refuses empty, long, control characters, a leading dash and non-strings", () => {
    for (const l of ["", "x".repeat(65), "a\nb", "a\u0007b", "a\u007fb", "-x", "--json", 7, null]) {
      expect(isValidLabel(l), JSON.stringify(l)).toBe(false);
    }
  });
});

describe("deskBase", () => {
  it("keeps origin, path and query of an http(s) URL", () => {
    expect(deskBase("https://desk.example/")).toBe("https://desk.example/");
    expect(deskBase("http://127.0.0.1:5173/desk/?v=1")).toBe("http://127.0.0.1:5173/desk/?v=1");
  });

  it("refuses a fragment, another scheme, a malformed URL and a non-string", () => {
    for (const u of [
      "https://desk.example/#x",
      "https://desk.example/#",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "not a url",
      42,
    ]) {
      expect(deskBase(u), String(u)).toBeNull();
    }
  });
});

describe("accountOp", () => {
  it("signin_link seals only the token, so a long desk_url still fits the key", async () => {
    const desk = `https://volley-desk.${"a".repeat(120)}.example:5173/desk/`;
    const r = await accountOp(auth().exec, "admin-1", {
      op: "signin_link",
      role: "steer",
      label: "Owner's phone",
      desk_url: desk,
      reply_key: jwk,
    });
    expect(r.reply).toMatchObject({ ok: true, result: { link_base: desk } });
    const secret = unseal(r.reply.sealed) as { token: string };
    expect(secret).toEqual({ token: `vly_signin_0000abcd_${"f".repeat(32)}` });
  });

  it("signin_link refuses a bad desk_url or ttl_s before issuing anything", async () => {
    const exec = auth();
    for (const p of [
      { desk_url: "https://desk.example/#signin=x" },
      { desk_url: "ftp://desk.example/" },
      { ttl_s: 0 },
      { ttl_s: 86_401 },
      { ttl_s: 1.5 },
      { ttl_s: "600" },
    ]) {
      const r = await accountOp(exec.exec, "admin-1", {
        op: "signin_link",
        role: "steer",
        label: "x",
        reply_key: jwk,
        ...p,
      });
      expect(r.reply, JSON.stringify(p)).toMatchObject({ ok: false });
    }
    expect(exec.argvs(["volley", "auth", "signin-link"])).toEqual([]);
  });

  it("refuses to rotate the sender's own account: the reload would drop it before the answer", async () => {
    const exec = auth();
    const r = await accountOp(exec.exec, "admin-1", {
      op: "account_rotate",
      name: "admin-1",
      reply_key: jwk,
    });
    expect(r.reply).toMatchObject({ ok: false });
    expect(r.reply.error).toContain("own account");
    expect(exec.argvs(["volley", "auth", "rotate"])).toEqual([]);
    const other = await accountOp(exec.exec, "admin-1", {
      op: "account_rotate",
      name: "steer-1",
      reply_key: jwk,
    });
    expect(other.reply).toMatchObject({ ok: true });
  });

  it("reports a `volley auth` that printed no JSON", async () => {
    const r = await accountOp(auth().exec, "admin-1", {
      op: "account_create",
      name: "phone",
      role: "steer",
      reply_key: jwk,
    });
    expect(r.reply).toMatchObject({ ok: false, error: "volley auth add printed no JSON" });
  });
});

describe("shared with volley-cli's auth-roles.ts", () => {
  it("the role lists and topics are the same in both packages", async () => {
    // A test-only cross-check: volleyd does not depend on volley-cli at run time.
    const cli = await import(
      new URL("../../volley-cli/src/commands/auth-roles.ts", import.meta.url).href
    );
    expect([...cli.ROLES]).toEqual([...ACCOUNT_ROLES]);
    expect([...cli.SIGNIN_ROLES]).toEqual([...SIGNIN_ROLES]);
    expect(cli.tokenRedeemTopic("0000abcd")).toBe(tokenRedeemTopic("0000abcd"));
    expect(cli.tokenReplyTopic("0000abcd")).toBe(tokenReplyTopic("0000abcd"));
    expect(tokenRedeemTopic("0000abcd")).toBe("volley-auth/redeem/0000abcd");
    expect(tokenReplyTopic("0000abcd")).toBe("volley-auth/redeem/0000abcd/reply");
    expect(cli.authOpsTopic("admin-1")).toBe(authOpsTopic("admin-1"));
  });
});

describe("deskRefusal (a Desk login's Needs-you answers, SPEC §4.6.18)", () => {
  const at = "2026-10-19T09:00:00.000Z";
  const accounts: Account[] = ["admin", "steer", "watch", "supervisor", "peer"].map((role) => ({
    name: `${role}-1`,
    role,
    kind: "device",
    created: at,
  }));

  it("passes the fixed desk identity, a steer and an admin account", () => {
    expect(deskRefusal(accounts, "desk")).toBeUndefined();
    expect(deskRefusal(accounts, "steer-1")).toBeUndefined();
    expect(deskRefusal(accounts, "admin-1")).toBeUndefined();
  });

  it("refuses watch, supervisor, peer and an unknown name, with a reason", () => {
    for (const role of ["watch", "supervisor", "peer"])
      expect(deskRefusal(accounts, `${role}-1`)).toBe(
        `"${role}-1" has role ${role}; Desk ops need the steer or admin role`,
      );
    expect(deskRefusal(accounts, "agent-a1")).toBe(
      '"agent-a1" has no account; Desk ops need the steer or admin role',
    );
  });

  it("covers inbox_answer and resolve only", () => {
    expect([...DESK_OPS].sort()).toEqual(["inbox_answer", "resolve"]);
  });
});
