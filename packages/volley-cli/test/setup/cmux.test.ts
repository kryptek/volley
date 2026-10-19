import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CMUX_CHECK_SCRIPT,
  CMUX_PASSWORD_STEPS,
  classifyCmux,
  cmuxAdvice,
  cmuxCheckArgv,
  cmuxEnv,
  readCmuxPassword,
  writeCmuxPassword,
} from "../../src/setup/cmux";
import { planServices } from "../../src/setup/services";
import type { ExecResult, StepPlan } from "../../src/setup/step";
import { setupFence } from "../../src/setup/step";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { type FakeMachine, fakeMachine } from "../helpers/setup-machine";

const DENIED = "Access denied - only processes started inside cmux can connect";
const CMUX_SUMMARY = "Give volleyd the cmux socket password";

describe("setup: cmux", () => {
  it("classifies what cmux says to a program it did not start", () => {
    const r = (code: number, stderr: string) => ({ code, stdout: "", stderr });
    expect(classifyCmux({ code: 0, stdout: "PONG", stderr: "" })).toBe("ok");
    expect(classifyCmux(r(1, DENIED))).toBe("refused");
    expect(classifyCmux(r(1, "Error: invalid socket password"))).toBe("refused");
    expect(classifyCmux(r(1, "Failed to connect to /tmp/cmux.sock: Connection refused"))).toBe(
      "not_running",
    );
    expect(classifyCmux(r(127, "sh: cmux: command not found"))).toBe("missing");
    expect(classifyCmux(r(2, "something new"))).toBe("unknown");
  });

  it("says what to do in plain words, never the raw error alone", () => {
    expect(cmuxAdvice("refused", false)).toContain(CMUX_PASSWORD_STEPS);
    expect(cmuxAdvice("refused", false)).toContain("volley setup --repair");
    expect(CMUX_PASSWORD_STEPS).toContain("Settings… (⌘,) → Automation → Socket control mode");
    expect(CMUX_PASSWORD_STEPS).toContain("Password mode");
    expect(cmuxAdvice("refused", true)).toContain("refused the socket password volleyd has");
    expect(cmuxAdvice("not_running", false)).toContain("open cmux");
  });

  it("stores the password mode 0600 and gives cmux it in its environment, not on argv", () => {
    const home = mkdtempSync(join(tmpdir(), "volley-cmux-home-"));
    try {
      expect(readCmuxPassword(home)).toBeNull();
      expect(cmuxEnv(home, { PATH: "/usr/bin" })).toBeUndefined();
      const file = writeCmuxPassword(home, "s3cret");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readCmuxPassword(home)).toBe("s3cret");
      expect(cmuxEnv(home, { PATH: "/usr/bin" })).toEqual({
        PATH: "/usr/bin",
        CMUX_SOCKET_PASSWORD: "s3cret",
      });
      // An explicit one in volleyd's own environment wins.
      expect(cmuxEnv(home, { CMUX_SOCKET_PASSWORD: "mine" })).toBeUndefined();
      writeFileSync(file, "not json");
      expect(readCmuxPassword(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("the fence lets setup run exactly the service-like check", () => {
    const fence = setupFence({
      restart: "brew services restart mosquitto",
      repoRoot: "/r",
      bun: "bun",
    });
    expect(() => fence(cmuxCheckArgv("/Users/x/.volley/volleyd/cmux-check.out"))).not.toThrow();
    expect(() => fence(["sh", "-c", "cmux ping", "sh", "/x/cmux-check.out"])).toThrow();
    expect(() => fence(["sh", "-c", CMUX_CHECK_SCRIPT, "sh", "/x/other"])).toThrow();
    expect(() => fence(["sh", "-c", CMUX_CHECK_SCRIPT, "sh", "rel/cmux-check.out"])).toThrow();
    expect(() => fence(["sh", "-c", CMUX_CHECK_SCRIPT, "sh", "/x/cmux-check.out", "x"])).toThrow();
  });

  describe("the Services step on macOS", () => {
    let dir: string;
    let fake: FakeDynsec;
    let m: FakeMachine;
    /** cmux's socket: null = the default (cmux's own processes only), else Password mode. */
    let cmuxPassword: string | null;
    let cmuxRunning: boolean;
    /** The env each service-like check ran with. */
    let checks: Record<string, string | undefined>[];
    const applyAll = async (plan: StepPlan) => {
      const out: string[] = [];
      for (const c of plan.changes) out.push(...(await c.apply()));
      return out;
    };
    const cmuxChange = (p: StepPlan) => p.changes.find((c) => c.summary.startsWith(CMUX_SUMMARY));

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), "volley-setup-cmux-"));
      fake = await startFakeDynsec();
      m = fakeMachine(fake, dir, { platform: "darwin" });
      cmuxPassword = null;
      cmuxRunning = true;
      checks = [];
      // cmux installed in ~/Applications.
      const bin = join(m.ctx.home, "Applications", "cmux.app", "Contents", "Resources", "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "cmux"), "");
      const inner = m.ctx.deps.exec;
      m.ctx.deps.exec = async (argv, o) => {
        if (argv[0] === "sh" && argv[1] === "-c" && argv[2] === CMUX_CHECK_SCRIPT) {
          m.execCalls.push([...argv]);
          m.execEnvs.push(o?.env);
          checks.push({ ...o?.env });
          const sent = o?.env?.CMUX_SOCKET_PASSWORD;
          const [code, said] = !cmuxRunning
            ? [1, "Failed to connect to /tmp/cmux.sock: Connection refused"]
            : cmuxPassword === null
              ? [1, DENIED]
              : sent === cmuxPassword
                ? [0, "PONG"]
                : [1, "Access denied - invalid socket password"];
          writeFileSync(argv[4] as string, `${said}\nvolley-cmux-exit=${code}\n`);
          return { code: 0, stdout: "", stderr: "" } satisfies ExecResult;
        }
        if (argv[0] === "security" && argv.includes("volley-cmux")) {
          // The cmux item: one more keychain entry in the fake, keyed by its account.
          m.execCalls.push([...argv]);
          const pw = m.keychain.get("volleyd");
          return pw === undefined
            ? { code: 44, stdout: "", stderr: "not found" }
            : { code: 0, stdout: `${pw}\n`, stderr: "" };
        }
        return inner(argv, o);
      };
    });
    afterEach(async () => {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("explains how to set a socket password in cmux and offers to store it", async () => {
      const p = await planServices(m.ctx);
      const found = p.found.join("\n");
      expect(found).toContain("cmux lets only programs started inside cmux use its socket");
      expect(found).toContain(CMUX_PASSWORD_STEPS);
      const c = cmuxChange(p);
      expect(c?.summary).toContain("asked for now, hidden");
      expect(c?.summary).toContain("service volley-cmux");
      expect(c?.summary).toContain(join(m.ctx.volleydHome, "cmux.json"));
      // Planning asks nothing and stores nothing; the check ran with the service's environment.
      expect(m.secretPrompts).toEqual([]);
      expect(existsSync(join(m.ctx.volleydHome, "cmux.json"))).toBe(false);
      expect(checks[0]?.VOLLEYD_HOME).toBe(m.ctx.volleydHome);
      expect(checks[0]?.PATH).toContain(join(m.ctx.home, ".volley", "bin"));
      expect(checks[0]?.CMUX_SOCKET_PASSWORD).toBeUndefined();
    });

    it("asks for the password (hidden), checks it as the service would, then stores it", async () => {
      cmuxPassword = "hunter2";
      m.secrets = ["hunter2"];
      const p = await planServices(m.ctx);
      const out = await applyAll(p);
      expect(m.secretPrompts).toEqual(["cmux socket password (hidden): "]);
      const file = join(m.ctx.volleydHome, "cmux.json");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readCmuxPassword(m.ctx.volleydHome)).toBe("hunter2");
      expect(m.keychain.get("volleyd")).toBe("hunter2");
      expect(out.join("\n")).toContain("volleyd's service reaches cmux now");
      // The password reached cmux and the keychain only through env and stdin, never argv,
      // and no unit file has it.
      expect(m.execCalls.flat().join(" ")).not.toContain("hunter2");
      for (const f of readdirSync(join(m.ctx.home, "Library", "LaunchAgents"))) {
        expect(readFileSync(join(m.ctx.home, "Library", "LaunchAgents", f), "utf-8")).not.toContain(
          "hunter2",
        );
      }
      expect(checks.at(-1)?.CMUX_SOCKET_PASSWORD).toBe("hunter2");
      // A rerun (`--repair`) finds it in place.
      const again = await planServices(m.ctx);
      expect(again.changes).toEqual([]);
      expect(again.found.join("\n")).toContain(
        "cmux: volleyd's service reaches it (`cmux ping`, run the way the service runs it, with the stored socket password)",
      );
      expect(await again.verify?.()).toEqual([]);
    });

    it("refuses a password cmux does not take, storing nothing", async () => {
      cmuxPassword = "right";
      m.secrets = ["wrong"];
      const c = cmuxChange(await planServices(m.ctx));
      await expect(c?.apply()).rejects.toThrow(/cmux refused that password; nothing was stored/);
      expect(readCmuxPassword(m.ctx.volleydHome)).toBeNull();
      expect(m.keychain.has("volleyd")).toBe(false);
      m.secrets = [""];
      await expect(c?.apply()).rejects.toThrow(/no password entered/);
    });

    it("a stored password cmux no longer takes is offered again, saying why", async () => {
      writeCmuxPassword(m.ctx.volleydHome, "old");
      cmuxPassword = "new";
      const p = await planServices(m.ctx);
      expect(p.found.join("\n")).toContain("cmux refused the socket password volleyd has");
      expect(cmuxChange(p)).toBeDefined();
    });

    it("re-stores a working password the keychain lacks", async () => {
      writeCmuxPassword(m.ctx.volleydHome, "pw");
      cmuxPassword = "pw";
      const p = await planServices(m.ctx);
      const c = p.changes.find((x) => x.summary.startsWith("Store the cmux socket password"));
      expect(c?.summary).toContain("the macOS keychain, service volley-cmux");
      await c?.apply();
      expect(m.keychain.get("volleyd")).toBe("pw");
      chmodSync(join(m.ctx.volleydHome, "cmux.json"), 0o644);
      const loose = (await planServices(m.ctx)).changes.find((x) =>
        x.summary.startsWith("Store the cmux socket password"),
      );
      expect(loose?.summary).toContain("mode 0600");
      await loose?.apply();
      expect(statSync(join(m.ctx.volleydHome, "cmux.json")).mode & 0o777).toBe(0o600);
    });

    it("without a terminal it asks nothing and says where to enter the password", async () => {
      m.deps.interactive = false;
      const p = await planServices(m.ctx);
      expect(cmuxChange(p)).toBeUndefined();
      expect(p.found.join("\n")).toContain(
        "run `volley setup --step services` in a terminal to enter the socket password",
      );
    });

    it("says to open cmux when it is not running, and offers nothing", async () => {
      cmuxRunning = false;
      const p = await planServices(m.ctx);
      expect(cmuxChange(p)).toBeUndefined();
      expect(p.found.join("\n")).toContain("cmux is not running");
    });

    it("on a Mac without cmux, says so and changes nothing for it", async () => {
      rmSync(join(m.ctx.home, "Applications"), { recursive: true });
      const p = await planServices(m.ctx);
      expect(cmuxChange(p)).toBeUndefined();
      expect(p.found.join("\n")).toContain("cmux: not installed");
      expect(checks).toEqual([]);
    });
  });
});
