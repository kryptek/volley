import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DeskServer, desk, startDeskServer } from "../../src/commands/desk-serve";
import { makeBufferIO } from "../../src/io";
import { DESK_STAMP, deskStamp } from "../../src/setup/desk-build";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { type FakeMachine, NOW, fakeMachine } from "../helpers/setup-machine";
import { tempDir } from "../helpers/tmp";

/** Commands that only read state. */
const READ_ONLY = (a: string[]) =>
  (a[0] === "launchctl" && a[1] === "print") ||
  (a[0] === "systemctl" && (a[2] === "is-active" || a[2] === "show")) ||
  a[0] === "lsof" ||
  a[0] === "ss";

describe("volley desk install | uninstall", () => {
  let fake: FakeDynsec;
  let m: FakeMachine;
  beforeEach(async () => {
    fake = await startFakeDynsec();
  });
  afterEach(async () => {
    await fake.close();
  });

  const env = () => ({
    HOME: m.ctx.home,
    VOLLEYD_HOME: m.ctx.volleydHome,
    // The installing shell's own: never built into the page.
    VITE_VOLLEY_BROKER_URL: "ws://leak.test:9001",
    VITE_VOLLEY_BROKER_PASSWORD: "hunter2",
  });
  const run = async (argv: string[]) => {
    const io = makeBufferIO({ now: () => new Date(NOW) });
    const code = await desk({ argv, env: env(), io, setupDeps: m.deps });
    return { code, stdout: io.readStdout(), stderr: io.readStderr() };
  };
  const repo = () => m.deps.repoRoot as string;
  const deskDir = () => join(repo(), "packages", "volley-desk");
  const unit = () => join(m.ctx.home, ".config", "systemd", "user", "volley-desk.service");
  const record = () =>
    JSON.parse(readFileSync(join(m.ctx.volleydHome, "setup.json"), "utf-8")) as Record<
      string,
      unknown
    >;

  describe("Linux (systemd --user)", () => {
    beforeEach(() => {
      m = fakeMachine(fake, tempDir("volley-desk-install-"), { platform: "linux" });
    });

    it("builds without the VITE_ vars, stamps the build, installs the unit and records the broker host", async () => {
      const r = await run(["install", "--port", "5300", "--broker-host", "box-a"]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      const build = m.execCalls.findIndex((a) => a.join(" ") === "bun run build");
      expect(build).toBeGreaterThanOrEqual(0);
      const buildEnv = m.execEnvs[build] ?? {};
      expect(Object.keys(buildEnv).filter((k) => k.startsWith("VITE_VOLLEY_BROKER"))).toEqual([]);
      expect(readFileSync(join(m.deskDist, DESK_STAMP), "utf-8")).toBe(`${deskStamp(repo())}\n`);
      expect(readFileSync(unit(), "utf-8")).toMatch(
        /^ExecStart=.* desk serve --host 0\.0\.0\.0 --port 5300 --broker-host box-a$/m,
      );
      expect(m.execCalls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
      expect(m.execCalls).toContainEqual(["systemctl", "--user", "enable", "volley-desk.service"]);
      expect(m.execCalls).toContainEqual(["systemctl", "--user", "restart", "volley-desk.service"]);
      expect(record()).toMatchObject({ broker_host: "box-a", desk_port: 5300 });
      expect(r.stdout).toContain("Built the Desk");
    });

    it("is a no-op the second time", async () => {
      expect((await run(["install", "--port", "5300", "--broker-host", "box-a"])).code).toBe(0);
      const calls = m.execCalls.length;
      const again = await run(["install", "--port", "5300", "--broker-host", "box-a"]);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain("already installed");
      expect(m.execCalls.slice(calls).every(READ_ONLY)).toBe(true);
    });

    it("an install that does not take records nothing", async () => {
      const inner = m.deps.exec;
      m.deps.exec = async (argv, o) =>
        argv.join(" ") === "systemctl --user is-active volley-desk.service"
          ? { code: 3, stdout: "inactive\n", stderr: "" }
          : inner(argv, o);
      const r = await run(["install", "--port", "5300", "--broker-host", "box-a"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("still not in place");
      expect(existsSync(join(m.ctx.volleydHome, "setup.json"))).toBe(false);
    });

    it("without --broker-host the unit has no flag and the record drops it", async () => {
      expect((await run(["install", "--port", "5300", "--broker-host", "box-a"])).code).toBe(0);
      expect((await run(["install", "--port", "5300"])).code).toBe(0);
      expect(readFileSync(unit(), "utf-8")).not.toContain("--broker-host");
      expect(record().broker_host).toBeUndefined();
    });

    it("--root names the checkout; one that is not a Volley checkout exits 2", async () => {
      const r = await run(["install", "--root", repo()]);
      expect(r.code).toBe(0);
      expect(readFileSync(unit(), "utf-8")).toContain(
        `${join(repo(), "packages", "volley-cli", "src", "cli.ts")} desk serve`,
      );
      const bad = await run(["install", "--root", join(repo(), "nope")]);
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain("--root");
    });

    it("refuses a Desk whose .env files set VITE_VOLLEY_BROKER_*, building nothing", async () => {
      writeFileSync(join(deskDir(), ".env.local"), "VITE_VOLLEY_BROKER_URL=ws://x:9001\n");
      const r = await run(["install"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(join(deskDir(), ".env.local"));
      expect(m.execCalls.some((a) => a.join(" ") === "bun run build")).toBe(false);
    });

    it("validates its flags", async () => {
      expect((await run(["install", "--port", "web"])).code).toBe(2);
      expect((await run(["install", "--broker-host", "ws://box-a"])).code).toBe(2);
      expect((await run(["install", "--frob"])).code).toBe(2);
    });

    it("uninstall disables and removes the unit and keeps dist/", async () => {
      expect((await run(["install"])).code).toBe(0);
      const r = await run(["uninstall"]);
      expect(r.code).toBe(0);
      expect(m.execCalls).toContainEqual([
        "systemctl",
        "--user",
        "disable",
        "--now",
        "volley-desk.service",
      ]);
      expect(existsSync(unit())).toBe(false);
      expect(m.execCalls.at(-1)).toEqual(["systemctl", "--user", "daemon-reload"]);
      expect(existsSync(join(m.deskDist, "index.html"))).toBe(true);
      const again = await run(["uninstall"]);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain("not installed");
    });
  });

  describe("--tailscale: the Desk on the private network", () => {
    const NAME = "studio.example.ts.net";
    const SERVES = [
      ["serve", "--bg", "--https=443", "http://127.0.0.1:5199"],
      ["serve", "--bg", "--https=8443", "http://127.0.0.1:9001"],
    ];
    const roles = () => join(m.ctx.volleydHome, "roles.json");
    const rolesRecord = (url: string) => ({
      broker: {
        machine: "studio",
        address: { ssh: null, mqtt_port: 1883, ws_port: 9001 },
        lan: true,
      },
      supervisor: { machine: "studio" },
      desk: { machine: "studio", url },
      version: 3,
      updated_at: NOW,
      updated_by: "volleyd-defaults",
    });
    /** A machine whose Network step recorded Tailscale (and volleyd's roles record). */
    const onTailnet = (platform: NodeJS.Platform) => {
      m = fakeMachine(fake, tempDir("volley-desk-install-ts-"), { platform });
      m.tailscale.installed = true;
      m.tailscale.state = "Running";
      mkdirSync(m.ctx.volleydHome, { recursive: true });
      writeFileSync(
        join(m.ctx.volleydHome, "setup.json"),
        JSON.stringify({ network: { kind: "tailscale", name: NAME, address: "100.64.0.2" } }),
      );
      writeFileSync(roles(), JSON.stringify(rolesRecord("http://desk.example:5199")));
    };

    it("configures the two serves under sudo (Linux), writes --ws-url, records the private address", async () => {
      onTailnet("linux");
      const r = await run(["install", "--tailscale"]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      for (const s of SERVES) expect(m.execCalls).toContainEqual(["sudo", "tailscale", ...s]);
      expect(m.execCalls.some((a) => a.includes("funnel") || a.includes("reset"))).toBe(false);
      expect(readFileSync(unit(), "utf-8")).toMatch(
        new RegExp(
          `^ExecStart=.* desk serve --host 0\\.0\\.0\\.0 --port 5199 --ws-url wss://${NAME}:8443$`,
          "m",
        ),
      );
      expect(record()).toMatchObject({
        desk_port: 5199,
        desk_private_url: `https://${NAME}`,
        network: { kind: "tailscale", name: NAME },
      });
      const rr = JSON.parse(readFileSync(roles(), "utf-8"));
      expect(rr.desk).toEqual({
        machine: "studio",
        url: `https://${NAME}`,
        lan_url: "http://desk.example:5199",
      });
      expect(rr.version).toBe(4);
      expect(r.stdout).toContain(`on your private network at https://${NAME}`);
      // A second run (with or without the flag) changes nothing and keeps the serve.
      const calls = m.execCalls.length;
      const again = await run(["install"]);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain("already installed");
      expect(
        m.execCalls
          .slice(calls)
          .every(
            (a) => READ_ONLY(a) || a.join(" ").match(/^tailscale (version|serve status --json)$/),
          ),
      ).toBe(true);
      expect(record().desk_private_url).toBe(`https://${NAME}`);
    });

    it("runs serve without sudo on macOS", async () => {
      onTailnet("darwin");
      expect((await run(["install", "--tailscale"])).code).toBe(0);
      for (const s of SERVES) expect(m.execCalls).toContainEqual(["tailscale", ...s]);
      expect(m.execCalls.some((a) => a[0] === "sudo")).toBe(false);
    });

    it("without a Tailscale record it refuses with the volley setup --network tailscale line", async () => {
      m = fakeMachine(fake, tempDir("volley-desk-install-ts-"), { platform: "linux" });
      const r = await run(["install", "--tailscale"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("run `volley setup --network tailscale` first");
      expect(m.execCalls.some((a) => a.includes("serve"))).toBe(false);
      expect(existsSync(unit())).toBe(false);
    });

    it("refuses --tailscale together with a broker on another machine (no broker behind 8443 here)", async () => {
      onTailnet("linux");
      const r = await run(["install", "--tailscale", "--broker-host", "box-a"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("broker on box-a");
      expect(m.execCalls.some((a) => a.includes("serve") && a.includes("--bg"))).toBe(false);
      expect(existsSync(unit())).toBe(false);
    });

    it("never replaces the owner's own serve on 443", async () => {
      onTailnet("linux");
      m.tailscale.serves.set(443, "http://127.0.0.1:3000");
      const r = await run(["install", "--tailscale"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("already serves http://127.0.0.1:3000");
      expect(m.tailscale.serves.get(443)).toBe("http://127.0.0.1:3000");
    });

    it("uninstall takes off the two serves it added and nothing else", async () => {
      onTailnet("linux");
      m.tailscale.serves.set(10000, "http://127.0.0.1:8080");
      expect((await run(["install", "--tailscale"])).code).toBe(0);
      const calls = m.execCalls.length;
      const r = await run(["uninstall"]);
      expect(r.code).toBe(0);
      const offs = m.execCalls.slice(calls).filter((a) => a.includes("serve") && a.includes("off"));
      expect(offs).toEqual([
        ["sudo", "tailscale", "serve", "--https=443", "off"],
        ["sudo", "tailscale", "serve", "--https=8443", "off"],
      ]);
      expect(m.tailscale.serves).toEqual(new Map([[10000, "http://127.0.0.1:8080"]]));
      expect(record().desk_private_url).toBeUndefined();
      expect(JSON.parse(readFileSync(roles(), "utf-8")).desk).toEqual({
        machine: "studio",
        url: "http://desk.example:5199",
      });
    });
  });

  describe("macOS (launchd)", () => {
    beforeEach(() => {
      m = fakeMachine(fake, tempDir("volley-desk-install-mac-"), { platform: "darwin" });
    });

    it("installs and loads the plist; uninstall boots it out and keeps dist/", async () => {
      const plist = join(m.ctx.home, "Library", "LaunchAgents", "systems.volley.desk.plist");
      expect((await run(["install", "--broker-host", "box-a"])).code).toBe(0);
      expect(readFileSync(plist, "utf-8")).toContain("<string>--broker-host</string>");
      expect(m.loaded.has("systems.volley.desk")).toBe(true);
      expect(m.execCalls.some((a) => a[0] === "launchctl" && a[1] === "bootstrap")).toBe(true);
      const r = await run(["uninstall"]);
      expect(r.code).toBe(0);
      expect(m.execCalls).toContainEqual(["launchctl", "bootout", "gui/501/systems.volley.desk"]);
      expect(m.loaded.has("systems.volley.desk")).toBe(false);
      expect(existsSync(plist)).toBe(false);
      expect(existsSync(join(m.deskDist, "index.html"))).toBe(true);
    });
  });
});

describe("volley desk check", () => {
  let root: string;
  let server: DeskServer | null = null;
  beforeEach(() => {
    root = tempDir("volley-desk-check-");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.html"), "<!doctype html><title>Desk</title>");
    writeFileSync(join(root, "version.json"), JSON.stringify({ version: "0.11.0" }));
  });
  afterEach(async () => {
    await server?.close();
    server = null;
  });
  const check = async (argv: string[]) => {
    const io = makeBufferIO();
    const code = await desk({ argv: ["check", ...argv], env: {}, io });
    return { code, stdout: io.readStdout(), stderr: io.readStderr() };
  };

  it("exits 0 when / is 200 and /version.json is the version", async () => {
    server = await startDeskServer({ root, host: "127.0.0.1", port: 0 });
    const r = await check(["--url", server.url, "--version", "0.11.0"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("0.11.0");
  });

  it("exits 1 on another version, a missing version.json, or nothing listening", async () => {
    server = await startDeskServer({ root, host: "127.0.0.1", port: 0 });
    const other = await check(["--url", server.url, "--version", "0.12.0"]);
    expect(other.code).toBe(1);
    expect(other.stderr).toContain("0.11.0");
    writeFileSync(join(root, "version.json"), "not json");
    expect((await check(["--url", server.url, "--version", "0.11.0"])).code).toBe(1);
    const url = server.url;
    await server.close();
    server = null;
    const down = await check(["--url", url, "--version", "0.11.0"]);
    expect(down.code).toBe(1);
    expect(down.stderr).toContain(url);
  });

  it("needs --url and --version", async () => {
    expect((await check(["--version", "0.11.0"])).code).toBe(2);
    expect((await check(["--url", "http://127.0.0.1:1"])).code).toBe(2);
    expect((await check(["--url", "ftp://x", "--version", "1"])).code).toBe(2);
  });
});
