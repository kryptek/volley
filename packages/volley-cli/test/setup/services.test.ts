import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DESK_STAMP,
  deskStamp,
  planServices,
  renderLaunchd,
  renderSystemd,
} from "../../src/setup/services";
import type { StepPlan } from "../../src/setup/step";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { type FakeMachine, HOOKED_SETTINGS, fakeMachine } from "../helpers/setup-machine";

/** Commands that only read state. */
const READ_ONLY = (a: string[]) =>
  a.includes("--dry-run") ||
  (a[0] === "launchctl" && a[1] === "print") ||
  (a[0] === "systemctl" && a[2] === "is-active");

describe("setup: services", () => {
  let dir: string;
  let fake: FakeDynsec;
  let m: FakeMachine;
  const applyAll = async (plan: StepPlan) => {
    const out: string[] = [];
    for (const c of plan.changes) out.push(...(await c.apply()));
    return out;
  };
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "volley-setup-services-"));
    fake = await startFakeDynsec();
  });
  afterEach(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("macOS (launchd)", () => {
    beforeEach(() => {
      m = fakeMachine(fake, dir, { platform: "darwin" });
    });

    it("plans volleyd, the hooks, the Desk build and its service, running only read-only commands", async () => {
      const p = await planServices(m.ctx);
      expect(p.blocked).toBeUndefined();
      expect(p.changes.map((c) => c.summary)).toEqual([
        "Install volleyd as a launchd service (volleyd install)",
        `Install the Volley hooks for coordinator sessions into ${m.settingsFile}`,
        "Build the Desk (vite build in packages/volley-desk)",
        "Install `volley desk serve` as a launchd service on 0.0.0.0:5199",
      ]);
      expect(p.changes[1]?.detail).toContain('+  "hooks": {');
      expect(p.changes[3]?.detail).toContain("<string>serve</string>");
      expect(m.execCalls.every(READ_ONLY)).toBe(true);
      expect(existsSync(m.settingsFile)).toBe(false);
      expect(existsSync(m.deskDist)).toBe(false);
    });

    it("applies, and a second plan finds every service in place", async () => {
      await applyAll(await planServices(m.ctx));
      expect(readFileSync(m.settingsFile, "utf-8")).toBe(HOOKED_SETTINGS);
      expect(existsSync(join(m.deskDist, "index.html"))).toBe(true);
      const plist = join(m.ctx.home, "Library", "LaunchAgents", "systems.volley.desk.plist");
      expect(readFileSync(plist, "utf-8")).toContain("<string>0.0.0.0</string>");
      expect(m.loaded).toEqual(new Set(["systems.volley.volleyd", "systems.volley.desk"]));
      const again = await planServices(m.ctx);
      expect(again.changes).toEqual([]);
      expect(again.found.join("\n")).toContain("volleyd: installed and loaded");
      expect(await again.verify?.()).toEqual([]);
    });

    it("records what the Desk was built from, and rebuilds it once the checkout changed", async () => {
      await applyAll(await planServices(m.ctx));
      const repo = m.deps.repoRoot as string;
      expect(readFileSync(join(m.deskDist, DESK_STAMP), "utf-8")).toBe(`${deskStamp(repo)}\n`);
      // An update (git pull) changes the Desk's sources: the old build is stale.
      const old = deskStamp(repo);
      mkdirSync(join(repo, "packages", "volley-desk", "src"), { recursive: true });
      writeFileSync(join(repo, "packages", "volley-desk", "src", "main.tsx"), "export {};\n");
      const p = await planServices(m.ctx);
      expect(p.changes.map((c) => c.summary)).toEqual([
        `Rebuild the Desk (built from ${old}, the checkout is now ${deskStamp(repo)})`,
      ]);
      await applyAll(p);
      expect((await planServices(m.ctx)).changes).toEqual([]);
    });

    it("rebuilds a Desk build that setup did not make", async () => {
      mkdirSync(m.deskDist, { recursive: true });
      writeFileSync(join(m.deskDist, "index.html"), "<!doctype html><!-- a dev build -->");
      const p = await planServices(m.ctx);
      expect(p.changes.map((c) => c.summary)).toContain(
        "Rebuild the Desk (the build in packages/volley-desk/dist was not made by setup)",
      );
    });

    it("refuses to build a Desk whose .env files set a broker URL or login", async () => {
      const deskDir = join(m.deps.repoRoot as string, "packages", "volley-desk");
      writeFileSync(join(deskDir, ".env.local"), "VITE_VOLLEY_BROKER_PASSWORD=hunter2\n");
      writeFileSync(join(deskDir, ".env"), "VITE_SOMETHING_ELSE=1\n");
      const p = await planServices(m.ctx);
      expect(p.blocked).toContain(join(deskDir, ".env.local"));
      expect(p.blocked).not.toContain(join(deskDir, ".env,"));
      expect(p.blocked).toContain("VITE_VOLLEY_BROKER_");
      expect(p.blocked).not.toContain("hunter2");
      expect(m.execCalls.some((a) => a[1] === "run" && a[2] === "build")).toBe(false);
    });

    it("reloads a unit that is installed but not loaded", async () => {
      await applyAll(await planServices(m.ctx));
      m.loaded.delete("systems.volley.desk");
      const p = await planServices(m.ctx);
      expect(p.changes.map((c) => c.summary)).toEqual([
        "Install `volley desk serve` as a launchd service on 0.0.0.0:5199",
      ]);
      await applyAll(p);
      expect(m.loaded.has("systems.volley.desk")).toBe(true);
    });

    it("backs a changed unit file up before rewriting it", async () => {
      await applyAll(await planServices(m.ctx));
      const plist = join(m.ctx.home, "Library", "LaunchAgents", "systems.volley.desk.plist");
      writeFileSync(plist, "<plist>edited</plist>\n");
      const p = await planServices(m.ctx);
      expect(p.changes[0]?.detail).toContain("-<plist>edited</plist>");
      const out = await applyAll(p);
      expect(out.join("\n")).toContain(".volley-backup-20261018T120000Z");
    });

    it("is skipped as root: the services belong to the user", async () => {
      m.auth.invokingUser = () => ({ uid: 501, gid: 20, home: m.ctx.home });
      const p = await planServices(m.ctx);
      expect(p.blocked).toBeUndefined();
      expect(p.changes).toEqual([]);
      expect(p.skipped).toContain("as root");
      expect(p.skipped).toContain("volley setup --step services");
    });
  });

  describe("Linux (systemd --user)", () => {
    beforeEach(() => {
      m = fakeMachine(fake, dir, { platform: "linux" });
    });

    it("writes user units for volleyd and the Desk and enables them", async () => {
      const p = await planServices(m.ctx);
      expect(p.changes.map((c) => c.summary)).toEqual([
        "Install volleyd as a systemd user service (volleyd.service)",
        `Install the Volley hooks for coordinator sessions into ${m.settingsFile}`,
        "Build the Desk (vite build in packages/volley-desk)",
        "Install `volley desk serve` as a systemd user service (volley-desk.service) on 0.0.0.0:5199",
      ]);
      await applyAll(p);
      const unit = readFileSync(
        join(m.ctx.home, ".config", "systemd", "user", "volleyd.service"),
        "utf-8",
      );
      expect(unit).toContain("/packages/volleyd/src/cli.ts daemon");
      expect(unit).toContain(`Environment="VOLLEYD_HOME=${m.ctx.volleydHome}"`);
      expect(unit).toContain(`Environment="VOLLEY_BROKER_URL=${m.ctx.auth.url}"`);
      expect(m.execCalls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
      expect(m.execCalls).toContainEqual(["systemctl", "--user", "enable", "volleyd.service"]);
      expect(m.execCalls).toContainEqual(["systemctl", "--user", "restart", "volley-desk.service"]);
      expect((await planServices(m.ctx)).changes).toEqual([]);
    });

    it("starts a unit that is in place but inactive", async () => {
      await applyAll(await planServices(m.ctx));
      m.active.delete("volleyd.service");
      const p = await planServices(m.ctx);
      expect(p.changes.map((c) => c.summary)).toEqual([
        "Install volleyd as a systemd user service (volleyd.service)",
      ]);
    });
  });

  it("leaves the services to the user where there is no service manager", async () => {
    m = fakeMachine(fake, dir, { platform: "win32" });
    const p = await planServices(m.ctx);
    expect(p.changes.map((c) => c.summary)).toEqual([
      `Install the Volley hooks for coordinator sessions into ${m.settingsFile}`,
      "Build the Desk (vite build in packages/volley-desk)",
    ]);
    expect(p.found.join("\n")).toContain("no launchd or systemd here");
  });

  it("renders units with their arguments quoted and escaped", () => {
    const spec = {
      name: "volley-desk",
      label: "systems.volley.desk",
      description: "Volley Desk",
      args: ["/opt/bun bin/bun", "a&b", "serve"],
      env: { PATH: "/usr/bin:/bin" },
      log: "/tmp/desk.log",
      workdir: "/tmp",
    };
    expect(renderSystemd(spec)).toContain('ExecStart="/opt/bun bin/bun" a&b serve');
    expect(renderLaunchd(spec)).toContain("<string>a&amp;b</string>");
    expect(renderLaunchd(spec)).toContain("<key>KeepAlive</key>");
  });
});
