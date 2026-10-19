// @vitest-environment node
//
// Node environment so mqtt.js loads its TCP entry point against the Aedes
// listener (see mqtt-client.test.ts): redeemToken's real round trip over the
// token's own login, with a volleyd stand-in that seals the answer as volleyd does.
import { constants, createPublicKey, publicEncrypt } from "node:crypto";
import mqtt from "mqtt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redeemToken } from "../src/store/control";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";

const ID = "0123abcd";
const SIGNIN = `vly_signin_${ID}_0123456789abcdef0123456789abcdef`;

describe("redeemToken over the token's own login (SPEC §4.6.10)", () => {
  let broker: TestBroker;
  let daemon: mqtt.MqttClient | null = null;

  beforeEach(async () => {
    // The broker accepts only the token's login: username = token id, password = the token.
    broker = await startTestBroker({ credentials: { username: ID, password: SIGNIN } });
  });
  afterEach(async () => {
    await daemon?.endAsync();
    daemon = null;
    await broker.close();
  });

  /** A volleyd stand-in that answers one token_redeem, sealing the login to its reply_key. */
  async function fakeDaemon(answer: (p: Record<string, unknown>) => Record<string, unknown>) {
    const seen: { topic: string; env: Record<string, unknown> }[] = [];
    daemon = await mqtt.connectAsync(broker.url, {
      username: ID,
      password: SIGNIN,
      clientId: "fake-volleyd",
    });
    await daemon.subscribeAsync(`volley-auth/redeem/${ID}`, { qos: 1 });
    daemon.on("message", (topic, raw) => {
      if (raw.length === 0) return;
      const env = JSON.parse(raw.toString()) as Record<string, unknown>;
      seen.push({ topic, env });
      const payload = answer(env.payload as Record<string, unknown>);
      void daemon?.publishAsync(
        `volley-auth/redeem/${ID}/reply`,
        JSON.stringify({
          schema_version: "0.1",
          agent_id: "volleyd",
          parent_id: null,
          channel: "_system/auth",
          type: "ack",
          wall_time: new Date().toISOString(),
          correlation_id: env.correlation_id,
          payload,
        }),
        { qos: 1 },
      );
    });
    return seen;
  }

  const seal = (jwk: unknown, secret: unknown) =>
    publicEncrypt(
      {
        key: createPublicKey({ key: jwk as never, format: "jwk" }),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(JSON.stringify(secret)),
    ).toString("base64url");

  it("publishes token_redeem with a reply_key and opens the sealed login", async () => {
    const seen = await fakeDaemon((p) => ({
      text: "ACKED",
      acked_type: "query",
      op: "token_redeem",
      ok: true,
      result: { username: `steer-${ID}`, role: "steer", label: p.label },
      sealed: seal(p.reply_key, { username: `steer-${ID}`, password: "s3cret" }),
    }));
    const r = await redeemToken({ url: broker.url, token: SIGNIN, label: "Desk on iPhone" });
    expect(r).toEqual({
      ok: true,
      username: `steer-${ID}`,
      password: "s3cret",
      role: "steer",
      label: "Desk on iPhone",
    });
    expect(seen).toHaveLength(1);
    const env = seen[0]?.env as Record<string, unknown>;
    expect(env.channel).toBe("_system/auth");
    expect(env.type).toBe("query");
    expect(env.agent_id).toBe(ID);
    expect(String(env.correlation_id)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    const p = env.payload as Record<string, unknown>;
    expect(p.op).toBe("token_redeem");
    expect(p.token).toBe(SIGNIN);
    expect(p.label).toBe("Desk on iPhone");
    expect((p.reply_key as { kty?: string }).kty).toBe("RSA");
    // Only the public half travels.
    expect((p.reply_key as { d?: string }).d).toBeUndefined();
  });

  it("passes a refusal through, and says so when nobody answers", async () => {
    await fakeDaemon(() => ({
      text: "ACKED",
      acked_type: "query",
      op: "token_redeem",
      ok: false,
      error: "token already used",
    }));
    expect(await redeemToken({ url: broker.url, token: SIGNIN, label: "x" })).toEqual({
      ok: false,
      error: "token already used",
    });
    await daemon?.endAsync();
    daemon = null;
    const r = await redeemToken({ url: broker.url, token: SIGNIN, label: "x", timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/volleyd did not answer/);
  });

  it("explains a broker that refuses the token's login (used or expired)", async () => {
    const r = await redeemToken({
      url: broker.url,
      token: `vly_signin_${ID}_ffffffffffffffffffffffffffffffff`,
      label: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/refused this link/);
  });
});
