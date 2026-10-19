import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { type AuthDeps, auth, realAuthDeps } from "../../src/commands/auth";
import { makeBufferIO } from "../../src/io";

/**
 * A token redemption against a real mosquitto: the real `volley auth` (real mosquitto_passwd, the
 * shipped ACL) and a reload that signals only this test's own broker. mosquitto disconnects a
 * client whose user leaves the password file when it reloads, so the client that redeemed (still
 * connected as the token's login) must keep that login until it has its answer.
 *
 * Needs VOLLEY_INTEGRATION=1, `mosquitto_passwd` on PATH and docker with the image CI uses
 * (eclipse-mosquitto:2). It runs a PRIVATE broker container on a free port (distro mosquitto
 * builds are often confined to /etc/mosquitto) and never touches any other broker. Locally it
 * skips without them; CI sets VOLLEY_REDEEM_IT_REQUIRED=1, which turns a skip into a failure.
 */
const IMAGE = "eclipse-mosquitto:2";
const RUN =
  process.env.VOLLEY_INTEGRATION === "1" &&
  spawnSync("mosquitto_passwd", ["-h"]).error === undefined &&
  spawnSync("docker", ["image", "inspect", IMAGE]).status === 0;
const REQUIRED = process.env.VOLLEY_REDEEM_IT_REQUIRED === "1";
const docker = (args: string[]) => spawnSync("docker", args, { encoding: "utf-8" });

describe.runIf(REQUIRED && !RUN)("volley auth redeem integration prerequisites", () => {
  it("are present (VOLLEY_INTEGRATION=1, mosquitto_passwd, docker image)", () => {
    expect.fail(
      `VOLLEY_REDEEM_IT_REQUIRED=1 but VOLLEY_INTEGRATION=1, mosquitto_passwd or ${IMAGE} is missing`,
    );
  });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

describe.skipIf(!RUN)("volley auth redeem against a private mosquitto", () => {
  let dir: string;
  let url: string;
  const container = `volley-redeem-it-${randomBytes(4).toString("hex")}`;
  const clients: VolleyBroker[] = [];

  const deps: AuthDeps = {
    ...realAuthDeps,
    reload: async () => {
      docker(["kill", "-s", "HUP", container]);
      // mosquitto re-reads its files asynchronously after the signal.
      await new Promise((r) => setTimeout(r, 300));
      return { ok: true, detail: "sent SIGHUP to the test broker" };
    },
  };
  const run = async (argv: string[], stdin = "") => {
    const io = makeBufferIO();
    const code = await auth(
      { argv: [...argv, "--dir", dir], env: { VOLLEYD_HOME: join(dir, "home") }, io },
      { ...deps, readStdin: async () => stdin },
    );
    return { code, stdout: io.readStdout(), stderr: io.readStderr() };
  };
  const connect = async (agentId: string, username: string, password: string) => {
    const c = new VolleyBroker();
    await c.connect({ url, agentId, username, password });
    clients.push(c);
    return c;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "volley-redeem-it-"));
    const port = await freePort();
    url = `mqtt://127.0.0.1:${port}`;
    // `init` writes passwd + acl.conf; the broker starts on them afterwards.
    await run(["init", "--volleyd-file", "--no-reload"]);
    writeFileSync(
      join(dir, "mosquitto.conf"),
      [
        `listener ${port} 127.0.0.1`,
        "allow_anonymous false",
        `password_file ${join(dir, "passwd")}`,
        `acl_file ${join(dir, "acl.conf")}`,
        "",
      ].join("\n"),
    );
    // As this user (no privilege drop), with the files at the same paths as on the host.
    const started = docker([
      "run",
      "-d",
      "--rm",
      "--name",
      container,
      "--network",
      "host",
      "--user",
      `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      "-v",
      `${dir}:${dir}`,
      IMAGE,
      "mosquitto",
      "-c",
      join(dir, "mosquitto.conf"),
    ]);
    if (started.status !== 0) throw new Error(`docker run: ${started.stderr}`);
    for (let i = 0; i < 50; i++) {
      const probe = new VolleyBroker();
      try {
        await probe.connect({ url, agentId: "probe", username: "x", password: "x" });
      } catch (e) {
        // Refused credentials mean the broker is up.
        if (!String(e).includes("ECONNREFUSED")) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  afterAll(async () => {
    for (const c of clients) await c.disconnect().catch(() => {});
    docker(["rm", "-f", container]);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("the redeeming client, connected as the token login, still receives the answer", async () => {
    const issued = JSON.parse((await run(["token", "--json"])).stdout) as {
      token: string;
      username: string;
    };
    const client = await connect("desk-redeem", issued.username, issued.token);
    const got: string[] = [];
    await client.subscribeStream("volley/_system/auth/replies/it-0001", (m) => got.push(m.payload));

    const redeemed = await run(["redeem", "--label", "Desk on laptop", "--json"], issued.token);
    expect(redeemed.code, redeemed.stderr).toBe(0);
    const creds = JSON.parse(redeemed.stdout) as { username: string; password: string };

    // What volleyd does next: publish the (sealed) answer on the reply topic.
    const daemonCreds = JSON.parse(readFileSync(join(dir, "home", "broker.json"), "utf-8")) as {
      username: string;
      password: string;
    };
    const daemon = await connect("volleyd-it", daemonCreds.username, daemonCreds.password);
    await daemon.publish("volley/_system/auth/replies/it-0001", "answer", {
      qos: 1,
      retain: false,
    });
    for (let i = 0; i < 40 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(got).toEqual(["answer"]);
    expect(client.connected).toBe(true);

    // ...and the minted admin account works.
    const admin = await connect("desk-admin", creds.username, creds.password);
    expect(admin.connected).toBe(true);
  });
});
