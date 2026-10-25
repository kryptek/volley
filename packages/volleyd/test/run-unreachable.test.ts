import { mkdirSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli";
import { tempDir } from "./helpers/tmp";

const EXAMPLE = fileURLToPath(new URL("./fixtures/example.yaml", import.meta.url));
const BAD = fileURLToPath(new URL("./fixtures/bad-cycle.yaml", import.meta.url));

/** A loopback port nothing listens on (bound once, then closed). */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

let servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  servers = [];
});
/** A loopback port that accepts connections (the stand-in for github.com:443). */
async function openPort(): Promise<number> {
  const s = createServer((c) => c.destroy());
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return (s.address() as { port: number }).port;
}

/** A home with no setup and nothing on `port`: `volleyd` there reaches no broker. */
async function deadHome() {
  const root = tempDir("volleyd-unreachable-");
  return {
    root,
    env: {
      HOME: join(root, "home"),
      VOLLEYD_HOME: join(root, "volleyd"),
      VOLLEY_BROKER_URL: `mqtt://127.0.0.1:${await closedPort()}`,
      VOLLEY_INTERNET_PROBE: `127.0.0.1:${await openPort()}`,
    },
  };
}

describe("volleyd run against a supervisor that does not answer", () => {
  it("validates the file first: a bad file is still a validation error (exit 1)", async () => {
    const { env } = await deadHome();
    const r = await runCli(["run", BAD], env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("dependency cycle");
    expect(r.stderr).not.toContain("supervisor unreachable");
  });

  it("a valid file against a dead broker: exit 69 with the diagnosis, nothing submitted", async () => {
    const { env } = await deadHome();
    const r = await runCli(["run", EXAMPLE], env);
    expect(r.exitCode).toBe(69);
    expect(r.stderr).toMatch(/^volleyd run: supervisor unreachable \(no_broker_here\): /);
    expect(r.stdout).not.toContain("submitted");
  });

  it("--json: the SUPERVISOR_UNREACHABLE object on stdout", async () => {
    const { env } = await deadHome();
    const r = await runCli(["run", "--json", EXAMPLE], env);
    expect(r.exitCode).toBe(69);
    expect(JSON.parse(r.stdout)).toMatchObject({
      error: "SUPERVISOR_UNREACHABLE",
      reason: "no_broker_here",
      where: { kind: "other" },
    });
  });

  it("on a paired machine whose tunnel is down: tunnel_down with the port", async () => {
    const { env } = await deadHome();
    const port = Number(new URL(env.VOLLEY_BROKER_URL).port);
    mkdirSync(join(env.HOME, ".volley"), { recursive: true });
    writeFileSync(
      join(env.HOME, ".volley", "peer.json"),
      JSON.stringify({ name: "box", remote_port: port }),
    );
    const r = await runCli(["run", EXAMPLE], env);
    expect(r.exitCode).toBe(69);
    expect(r.stderr).toContain(
      `volleyd run: supervisor unreachable (tunnel_down): This machine's tunnel to the broker is down (\`127.0.0.1:${port}\` refuses).`,
    );
  });

  it("on a paired machine that is offline: offline, before the tunnel is tried", async () => {
    const { env } = await deadHome();
    mkdirSync(join(env.HOME, ".volley"), { recursive: true });
    writeFileSync(
      join(env.HOME, ".volley", "peer.json"),
      JSON.stringify({ name: "box", remote_port: 21883 }),
    );
    const r = await runCli(["run", EXAMPLE], {
      ...env,
      VOLLEY_INTERNET_PROBE: `127.0.0.1:${await closedPort()}`,
    });
    expect(r.exitCode).toBe(69);
    expect(r.stderr).toContain("supervisor unreachable (offline): You are offline.");
  });
});
