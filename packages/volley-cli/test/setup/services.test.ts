import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DESK_STAMP,
  commandScript,
  deskStamp,
  planServices,
  renderLaunchd,
  renderSystemd,
} from "../../src/setup/services";
import type { StepPlan } from "../../src/setup/step";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { type FakeMachine, HOOKED_SETTINGS, fakeMachine } from "../helpers/setup-machine";
import { tempDir } from "../helpers/tmp";

/** The change that puts `volley` and `volleyd` on a PATH (volleyd runs `volley auth`). */
const LINK_SUMMARY = (m: FakeMachine) =>
  `Install the volley and volleyd commands in ${join(m.ctx.home, ".volley", "bin")} (volleyd runs \`volley auth\` to redeem the Desk's sign-in links)`;

/** What setup writes as ~/.volley/bin/<name> for this fake checkout (its bun is "bun"). */
const SCRIPT = (m: FakeMachine, pkg: "volley-cli" | "volleyd") =>
  commandScript("bun", join(m.deps.repoRoot as string, "packages", pkg, "src", "cli.ts"));

/** Commands that only read state. */
const READ_ONLY = (a: string[]) =>
  a.includes("--dry-run") ||
  (a[0] === "launchctl" && a[1] === "print") ||
  (a[0] === "systemctl" && (a[2] === "is-active" || a[2] === "show")) ||
  a[0] === "lsof" ||
  a[0] === "ss";

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
    dir = tempDir("volley-setup-services-");
    fake = await startFakeDynsec();
  });
  afterEach(async () => {
    await fake.close();
  });

  describe("macOS (launchd)", () => {
    beforeEach(() => {
      m = fakeMachine(fake, dir, { platform: "darwin" });
    });

    it("plans volleyd, the hooks, the Desk build and its service, running only read-only commands", async () => {
      const p = await planServices(m.ctx);
      expect(p.blocked).toBeUndefined();
      expect(p.changes.map((c) => c.summary)).toEqual([
        LINK_SUMMARY(m),
        "Install volleyd as a launchd service (volleyd install)",
        `Install the Volley hooks for coordinator sessions into ${m.settingsFile}`,
        "Build the Desk (vite build in packages/volley-desk)",
        "Install `volley desk serve` as a launchd service on 0.0.0.0:5199",
      ]);
      expect(p.changes[2]?.detail).toContain('+  "hooks": {');
      expect(p.changes[2]?.detail).toContain(
        "Your Claude Code status line keeps working: Volley runs it after its own (same input, 2 s timeout).",
      );
      expect(p.changes[4]?.detail).toContain("<string>serve</string>");
      expect(m.execCalls.every(READ_ONLY)).toBe(true);
      expect(existsSync(m.settingsFile)).toBe(false);
      expect(existsSync(m.deskDist)).toBe(false);
    });

    it("says release evidence stays off, and how to serve it (a LAN-trust choice)", async () => {
      const p = await planServices(m.ctx);
      const line = p.found.find((l) => l.includes("--evidence"));
      expect(line).toBeDefined();
      expect(line).toContain(`volley desk serve --evidence ${m.ctx.volleydHome}`);
      expect(line).toMatch(/off/);
      expect(line).toMatch(/LAN/);
      // Planner text only: the service is installed without the flag.
      expect(p.changes[4]?.detail).not.toContain("--evidence");
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

    describe("a rerun with the Desk loaded (launchd's bootout is asynchronous)", () => {
      const DESK = "systems.volley.desk";
      let plist: string;
      /** prints left before a booted-out Desk is gone; while it is, bootstrap fails with EIO. */
      let teardown: number;
      /** A bootstrap of a plist with this text is refused (not EIO). */
      let refuse: string | null;
      beforeEach(async () => {
        await applyAll(await planServices(m.ctx));
        plist = join(m.ctx.home, "Library", "LaunchAgents", `${DESK}.plist`);
        teardown = 0;
        refuse = null;
        const inner = m.ctx.deps.exec;
        m.ctx.deps.exec = async (argv, o) => {
          if (argv[0] === "launchctl" && (argv[2] ?? "").endsWith(DESK)) {
            m.execCalls.push([...argv]);
            if (argv[1] === "print" && teardown > 0 && --teardown === 0) m.loaded.delete(DESK);
            if (argv[1] === "print") {
              return { code: m.loaded.has(DESK) ? 0 : 113, stdout: "", stderr: "" };
            }
            if (argv[1] === "bootout" && m.loaded.has(DESK)) {
              if (teardown === 0) teardown = 6;
              return { code: 0, stdout: "", stderr: "" };
            }
          }
          if (argv[0] === "launchctl" && argv[1] === "bootstrap" && argv[3] === plist) {
            m.execCalls.push([...argv]);
            if (m.loaded.has(DESK)) {
              return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
            }
            if (refuse !== null && readFileSync(plist, "utf-8").includes(refuse)) {
              return {
                code: 1,
                stdout: "",
                stderr: "Bootstrap failed: 1: Operation not permitted",
              };
            }
            m.loaded.add(DESK);
            return { code: 0, stdout: "", stderr: "" };
          }
          return inner(argv, o);
        };
      });

      it("waits for the old Desk to go, then loads the new one", async () => {
        writeFileSync(plist, "<plist>older</plist>\n");
        const p = await planServices(m.ctx);
        expect(p.changes.map((c) => c.summary)).toEqual([
          "Install `volley desk serve` as a launchd service on 0.0.0.0:5199",
        ]);
        await applyAll(p);
        expect(m.loaded.has(DESK)).toBe(true);
        expect(readFileSync(plist, "utf-8")).toContain("<string>0.0.0.0</string>");
        expect((await planServices(m.ctx)).changes).toEqual([]);
      });

      it("a new plist launchd refuses: the previous one is restored and loaded, and the change fails", async () => {
        writeFileSync(plist, "<plist>older</plist>\n");
        refuse = "<string>0.0.0.0</string>";
        const c = (await planServices(m.ctx)).changes[0];
        await expect(c?.apply()).rejects.toThrow(
          /Operation not permitted.*Restored the previous .*systems\.volley\.desk\.plist and loaded it again/s,
        );
        expect(readFileSync(plist, "utf-8")).toBe("<plist>older</plist>\n");
        // Never left down.
        expect(m.loaded.has(DESK)).toBe(true);
      });
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

    it("installs volley and volleyd scripts from this checkout and puts them on volleyd's PATH", async () => {
      const bin = join(m.ctx.home, ".volley", "bin");
      const out = await applyAll(await planServices(m.ctx));
      expect(readFileSync(join(bin, "volley"), "utf-8")).toBe(SCRIPT(m, "volley-cli"));
      expect(readFileSync(join(bin, "volleyd"), "utf-8")).toBe(SCRIPT(m, "volleyd"));
      expect(statSync(join(bin, "volley")).mode & 0o777).toBe(0o755);
      expect(out.join("\n")).toContain(`export PATH="${bin}:$PATH"`);
      // `volleyd install` writes the PATH and auth dir it runs with into the plist: the dry run
      // (what the plan compares) and the install get the same ones, the commands first on PATH.
      for (const dry of [true, false]) {
        const i = m.execCalls.findIndex(
          (a) => a[2] === "install" && a.includes("--dry-run") === dry,
        );
        expect(m.execEnvs[i]?.PATH).toBe(`${bin}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`);
        expect(m.execEnvs[i]?.VOLLEY_AUTH_DIR).toBe(m.ctx.auth.dir);
      }
      // volleyd's own service change is in this plan: the commands change says sign-in waits for it.
      expect(out.join("\n")).toContain(
        "Sign-in links work once volleyd runs with it on its PATH: the change “Install volleyd as a launchd service (volleyd install)” in this step does that",
      );
      const again = await planServices(m.ctx);
      expect(again.changes).toEqual([]);
      expect(again.found.join("\n")).toContain(`volley, volleyd: installed in ${bin}`);
    });

    it("replaces a symlink (an earlier setup's, another checkout's) and setup's own older script", async () => {
      const bin = join(m.ctx.home, ".volley", "bin");
      mkdirSync(bin, { recursive: true });
      symlinkSync("/elsewhere/volley-cli/src/cli.ts", join(bin, "volley"));
      writeFileSync(
        join(bin, "volleyd"),
        commandScript("/old/bun", "/elsewhere/volleyd/src/cli.ts"),
      );
      const p = await planServices(m.ctx);
      expect(p.changes[0]?.summary).toBe(LINK_SUMMARY(m));
      expect(p.changes[0]?.detail).toContain("(now: a link to /elsewhere/volley-cli/src/cli.ts)");
      expect(p.changes[0]?.detail).toContain(
        "(now: volley setup's script for another checkout or bun)",
      );
      const out = await applyAll(p);
      expect(readFileSync(join(bin, "volley"), "utf-8")).toBe(SCRIPT(m, "volley-cli"));
      expect(readFileSync(join(bin, "volleyd"), "utf-8")).toBe(SCRIPT(m, "volleyd"));
      // Setup's own script and a symlink are replaced, never backed up.
      expect(out.join("\n")).not.toContain("Moved");
      expect(readdirSync(bin).sort()).toEqual(["volley", "volleyd"]);
    });

    it("backs up a file or directory at a command's path instead of deleting it", async () => {
      const bin = join(m.ctx.home, ".volley", "bin");
      mkdirSync(join(bin, "volleyd"), { recursive: true });
      writeFileSync(join(bin, "volleyd", "inside"), "kept\n");
      writeFileSync(join(bin, "volley"), "#!/bin/sh\necho my own wrapper\n");
      // A backup from this same second already exists: the new one gets its own name.
      const backup = (name: string) => `${join(bin, name)}.volley-backup-20261018T120000Z`;
      writeFileSync(backup("volley"), "an earlier backup\n");
      const p = await planServices(m.ctx);
      expect(p.changes[0]?.detail).toContain(`${join(bin, "volley")}: runs this checkout's volley`);
      expect(p.changes[0]?.detail).toContain("(now: a file; backed up first)");
      expect(p.changes[0]?.detail).toContain("(now: a directory; backed up first)");
      const out = (await p.changes[0]?.apply()) ?? [];
      expect(readFileSync(backup("volley"), "utf-8")).toBe("an earlier backup\n");
      expect(readFileSync(`${backup("volley")}-1`, "utf-8")).toBe(
        "#!/bin/sh\necho my own wrapper\n",
      );
      expect(statSync(backup("volleyd")).isDirectory()).toBe(true);
      expect(readFileSync(join(backup("volleyd"), "inside"), "utf-8")).toBe("kept\n");
      expect(out.join("\n")).toContain(
        `Moved ${join(bin, "volley")} aside to ${backup("volley")}-1`,
      );
      expect(readFileSync(join(bin, "volley"), "utf-8")).toBe(SCRIPT(m, "volley-cli"));
      expect(readFileSync(join(bin, "volleyd"), "utf-8")).toBe(SCRIPT(m, "volleyd"));
    });

    it("puts the links first, and no other `volley` on the shell's PATH, on the services' PATH", async () => {
      const bin = join(m.ctx.home, ".volley", "bin");
      m.ctx.auth.env.PATH = `/opt/old-volley/bin:${bin}:/usr/bin`;
      await applyAll(await planServices(m.ctx));
      const i = m.execCalls.findIndex((a) => a[2] === "install" && !a.includes("--dry-run"));
      expect(m.execEnvs[i]?.PATH).toBe(`${bin}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`);
    });

    it("a rerun from another terminal (another PATH, a per-session shim dir) changes nothing", async () => {
      // Stable install dirs on this (fake) Mac: Homebrew, cmux's app, claude's installer.
      const local = join(m.ctx.home, ".local", "bin");
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "claude"), "");
      for (const d of ["/opt/homebrew/bin", "/Applications/cmux.app/Contents/Resources/bin"]) {
        m.present.add(d);
      }
      const shim = "/var/folders/xy/abc/T/cmux-cli-shims/1234-5678";
      // A cmux terminal: a shim dir, a project's node_modules, ~/.local/bin and Homebrew on PATH.
      m.ctx.auth.env.PATH = `${shim}:${local}:/opt/homebrew/bin:/some/project/node_modules/.bin:/usr/bin:/bin`;
      await applyAll(await planServices(m.ctx));
      const plist = join(m.ctx.home, "Library", "LaunchAgents", "systems.volley.desk.plist");
      const written = readFileSync(plist, "utf-8");
      expect(written).not.toContain("cmux-cli-shims");
      expect(written).not.toContain("node_modules");
      const want = [
        join(m.ctx.home, ".volley", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/Applications/cmux.app/Contents/Resources/bin",
        local,
        "/usr/bin:/bin:/usr/sbin:/sbin",
      ].join(":");
      expect(written).toContain(`<string>${want}</string>`);
      // Terminal.app without ~/.local/bin or Homebrew on its PATH: the same PATH, nothing to do.
      m.ctx.auth.env.PATH = "/usr/bin:/bin:/usr/sbin:/var/folders/xy/abc/T/cmux-cli-shims/9999";
      const again = await planServices(m.ctx);
      expect(again.changes).toEqual([]);
      // And a shell with no PATH at all.
      m.ctx.auth.env.PATH = undefined as unknown as string;
      expect((await planServices(m.ctx)).changes).toEqual([]);
      const installs = m.execCalls
        .map((a, i) => (a[2] === "install" ? m.execEnvs[i]?.PATH : null))
        .filter((p) => p !== null);
      expect(new Set(installs)).toEqual(new Set([want]));
    });

    it("with volleyd's service already in place, the commands alone fix sign-in", async () => {
      await applyAll(await planServices(m.ctx));
      rmSync(join(m.ctx.home, ".volley", "bin"), { recursive: true });
      const p = await planServices(m.ctx);
      expect(p.changes.map((c) => c.summary)).toEqual([LINK_SUMMARY(m)]);
      const out = await applyAll(p);
      expect(out.join("\n")).toContain("volleyd already runs with it on its PATH");
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
        LINK_SUMMARY(m),
        "Install volleyd as a systemd user service (volleyd.service)",
        `Install the Volley hooks for coordinator sessions into ${m.settingsFile}`,
        "Build the Desk (vite build in packages/volley-desk)",
        "Install `volley desk serve` as a systemd user service (volley-desk.service) on 0.0.0.0:5199",
      ]);
      const out = await applyAll(p);
      expect(out.join("\n")).toContain(
        "the change “Install volleyd as a systemd user service (volleyd.service)” in this step does that",
      );
      const unit = readFileSync(
        join(m.ctx.home, ".config", "systemd", "user", "volleyd.service"),
        "utf-8",
      );
      expect(unit).toContain("/packages/volleyd/src/cli.ts daemon");
      expect(unit).toContain(`Environment="VOLLEYD_HOME=${m.ctx.volleydHome}"`);
      expect(unit).toContain(`Environment="VOLLEY_BROKER_URL=${m.ctx.auth.url}"`);
      expect(unit).toContain(`Environment="VOLLEY_AUTH_DIR=${m.ctx.auth.dir}"`);
      expect(unit).toContain(
        `Environment="PATH=${join(m.ctx.home, ".volley", "bin")}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"`,
      );
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
      LINK_SUMMARY(m),
      `Install the Volley hooks for coordinator sessions into ${m.settingsFile}`,
      "Build the Desk (vite build in packages/volley-desk)",
    ]);
    expect(p.found.join("\n")).toContain("no launchd or systemd here");
    const out = (await p.changes[0]?.apply()) ?? [];
    expect(out.join("\n")).toContain(
      `Run volleyd with ${join(m.ctx.home, ".volley", "bin")} first on its PATH, or the Desk's sign-in links fail.`,
    );
  });

  it("a command script runs its cli with setup's bun, whatever the PATH, quoting both paths", () => {
    const d = join(dir, "it's here");
    mkdirSync(d, { recursive: true });
    const bun = join(d, "fake bun");
    writeFileSync(bun, '#!/bin/sh\nfor a in "$@"; do echo "[$a]"; done\n', { mode: 0o755 });
    const script = join(d, "volley");
    writeFileSync(script, commandScript(bun, "/x/it's cli.ts"), { mode: 0o755 });
    const r = spawnSync(script, ["peer", "a b"], {
      env: { PATH: "/nonexistent" },
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("[/x/it's cli.ts]\n[peer]\n[a b]\n");
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
