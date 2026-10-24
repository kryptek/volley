import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planServices, planServicesForDesk } from "../../src/setup/services";
import type { ExecResult, SetupContext, StepPlan } from "../../src/setup/step";
import { setupFence } from "../../src/setup/step";
import {
  CMUX_AUTOMATION_STEPS,
  CMUX_CHECK_SCRIPT,
  CMUX_MODE_LABEL,
  CMUX_PASSWORD_STEPS,
  classifyCmux,
  cmuxAdvice,
  cmuxCheckArgv,
  cmuxEnv,
  cmuxModeOf,
  cmuxSaid,
  parseCmuxCheck,
  planTerminal,
  readCmuxPassword,
  withLocalTerminal,
  writeCmuxPassword,
} from "../../src/setup/terminal";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { type FakeMachine, fakeMachine } from "../helpers/setup-machine";
import { tempDir } from "../helpers/tmp";

const DENIED = "Access denied - only processes started inside cmux can connect";
const DENIED_PASSWORD = "ERROR: Authentication required — send auth <password> first";
const REFUSED_SOCKET = "Failed to connect to /tmp/cmux.sock: Connection refused";
const AUTOMATION_SUMMARY = "Make volleyd's service reach cmux (choose Automation mode";
const CMUX_SUMMARY = "Give volleyd the cmux socket password";

describe("setup: the terminal (cmux, tmux)", () => {
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
    // Every denial cmux (or a future cmux) words differently is still a refusal.
    for (const said of [
      "ERROR: Invalid password",
      "ERROR: Authentication required — send auth <password> first",
      "Password mode is enabled but no socket password is configured in Settings.",
      '{"error":{"code":"auth_failed"}}',
      "Unable to verify client process",
      "Error: forbidden",
      "permission denied",
      "not authorized",
      "invalid credentials",
    ]) {
      expect(classifyCmux(r(1, said)), said).toBe("refused");
    }
    // A bad path in a cmux command is not "cmux is not running".
    expect(classifyCmux(r(1, "Error: no such file or directory: /bad/worktree"))).toBe("unknown");
    expect(classifyCmux(r(1, "connect ENOENT /path/to/home/.cmux/cmux.sock"))).toBe("not_running");
  });

  it("checks what volleyd needs, not `cmux ping`, and reads the socket's mode", () => {
    expect(CMUX_CHECK_SCRIPT).toContain("cmux capabilities --json");
    expect(CMUX_CHECK_SCRIPT).toContain("cmux list-workspaces");
    expect(CMUX_CHECK_SCRIPT).not.toContain("cmux ping");
    const out = (caps: [number, string], list: [number, string]) =>
      `${caps[1]}\nvolley-cmux-caps=${caps[0]}\n${list[1]}\nvolley-cmux-exit=${list[0]}\n`;
    // ping-style success is not enough: capabilities answer, the workspace call is refused.
    expect(
      parseCmuxCheck(
        out([0, '{"access_mode":"password","methods":[]}'], [1, "ERROR: Authentication required"]),
      ),
    ).toEqual({ access: "refused", output: "ERROR: Authentication required", mode: "password" });
    expect(
      parseCmuxCheck(out([0, '{"access_mode":"automation"}'], [0, "workspace:1 main"])),
    ).toEqual({ access: "ok", output: "workspace:1 main", mode: "automation" });
    expect(parseCmuxCheck(out([1, DENIED], [1, DENIED]))?.mode).toBe("cmuxOnly");
    expect(parseCmuxCheck(out([1, "boom"], [1, "boom"]))?.mode).toBeNull();
    expect(cmuxModeOf(0, '{"access_mode":"allow-all"}')).toBe("allowAll");
    expect(cmuxModeOf(0, '{"access_mode":"something-new"}')).toBeNull();
    // Not finished yet.
    expect(parseCmuxCheck('{"access_mode":"automation"}\nvolley-cmux-caps=0\n')).toBeNull();
    expect(CMUX_MODE_LABEL.automation).toBe("Automation mode");
  });

  it("quotes the first thing cmux said", () => {
    expect(cmuxSaid("\n  ERROR: Invalid password\nmore")).toBe(
      " (cmux said: ERROR: Invalid password)",
    );
    expect(cmuxSaid("")).toBe("");
  });

  it("says what to do in plain words, never the raw error alone", () => {
    expect(cmuxAdvice("refused", false)).toContain(CMUX_PASSWORD_STEPS);
    expect(cmuxAdvice("refused", false)).toContain("volley setup --repair");
    expect(CMUX_PASSWORD_STEPS).toContain("Settings… (⌘,) → Automation → Socket control mode");
    expect(CMUX_PASSWORD_STEPS).toContain("Password mode");
    // Automation mode is the recommendation; Password mode stays an option.
    expect(cmuxAdvice("refused", false)).toContain(CMUX_AUTOMATION_STEPS);
    expect(cmuxAdvice("refused", false).indexOf(CMUX_AUTOMATION_STEPS)).toBeLessThan(
      cmuxAdvice("refused", false).indexOf(CMUX_PASSWORD_STEPS),
    );
    expect(cmuxAdvice("refused", true)).toContain("refused the socket password volleyd has");
    expect(cmuxAdvice("not_running", false)).toContain("open cmux");
    // cmux open with its socket off answers like a stopped cmux: the advice covers both.
    expect(cmuxAdvice("not_running", false)).toContain("Password mode");
    expect(cmuxAdvice("unknown", false)).toContain(CMUX_PASSWORD_STEPS);
  });

  it("stores the password mode 0600 and gives cmux it in its environment, not on argv", () => {
    const home = tempDir("volley-cmux-home-");
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
  });

  it("the fence lets setup run exactly the service-like check", () => {
    const fence = setupFence({
      restart: "brew services restart mosquitto",
      repoRoot: "/r",
      bun: "bun",
    });
    expect(() =>
      fence(cmuxCheckArgv("/path/to/home/.volley/volleyd/cmux-check.out")),
    ).not.toThrow();
    expect(() => fence(["sh", "-c", "cmux ping", "sh", "/x/cmux-check.out"])).toThrow();
    expect(() => fence(["sh", "-c", CMUX_CHECK_SCRIPT, "sh", "/x/other"])).toThrow();
    expect(() => fence(["sh", "-c", CMUX_CHECK_SCRIPT, "sh", "rel/cmux-check.out"])).toThrow();
    expect(() => fence(["sh", "-c", CMUX_CHECK_SCRIPT, "sh", "/x/cmux-check.out", "x"])).toThrow();
  });

  describe("the Terminal step on a Mac with cmux", () => {
    let dir: string;
    let fake: FakeDynsec;
    let m: FakeMachine;
    /** cmux's socket: null = the default (cmux's own processes only), else Password mode. */
    let cmuxPassword: string | null;
    let cmuxRunning: boolean;
    /** cmux in Automation mode: any process of the user gets in. */
    let automation: boolean;
    /** cmux's socket mode when it lets the service in without a password. */
    let openMode: "automation" | "allow-all";
    /** What cmux answers a wrong password with. */
    let wrongPassword: string;
    /** The env each service-like check ran with. */
    let checks: Record<string, string | undefined>[];
    const applyAll = async (plan: StepPlan) => {
      const out: string[] = [];
      for (const c of plan.changes) out.push(...(await c.apply()));
      return out;
    };
    const cmuxChange = (p: StepPlan) => p.changes.find((c) => c.summary.startsWith(CMUX_SUMMARY));

    beforeEach(async () => {
      dir = tempDir("volley-setup-cmux-");
      fake = await startFakeDynsec();
      m = fakeMachine(fake, dir, { platform: "darwin" });
      cmuxPassword = null;
      cmuxRunning = true;
      automation = false;
      openMode = "automation";
      wrongPassword = "Access denied - invalid socket password";
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
          // `cmux capabilities --json`, then `cmux list-workspaces`, as the check script runs them.
          const [capsCode, caps, code, said] = !cmuxRunning
            ? [1, REFUSED_SOCKET, 1, REFUSED_SOCKET]
            : automation
              ? [0, `{"access_mode":"${openMode}","methods":[]}`, 0, "workspace:1"]
              : cmuxPassword === null
                ? [1, DENIED, 1, DENIED]
                : sent === cmuxPassword
                  ? [0, '{"access_mode":"password","methods":[]}', 0, "workspace:1"]
                  : [1, wrongPassword, 1, wrongPassword];
          writeFileSync(
            argv[4] as string,
            `${caps}\nvolley-cmux-caps=${capsCode}\n${said}\nvolley-cmux-exit=${code}\n`,
          );
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
    });

    it("recommends Automation mode, keeps Password mode optional, and records the mode", async () => {
      const p = await planTerminal(m.ctx);
      const found = p.found.join("\n");
      expect(found).toContain("cmux lets only programs started inside cmux use its socket");
      expect(found).toContain(CMUX_AUTOMATION_STEPS);
      expect(found).toContain("cmux's socket control mode: cmux processes only");
      expect(m.ctx.cmuxSocketMode).toBe("cmuxOnly");
      expect(cmuxChange(p)).toBeUndefined();
      const c = p.changes.find((x) => x.summary.startsWith(AUTOMATION_SUMMARY));
      expect(c?.detail).toContain(CMUX_AUTOMATION_STEPS);
      expect(c?.detail).toContain(`Password mode works too: ${CMUX_PASSWORD_STEPS}`);
      // Planning asks nothing and stores nothing; the check ran with the service's environment.
      expect(m.secretPrompts).toEqual([]);
      expect(existsSync(join(m.ctx.volleydHome, "cmux.json"))).toBe(false);
      expect(checks[0]?.VOLLEYD_HOME).toBe(m.ctx.volleydHome);
      expect(checks[0]?.PATH).toContain(join(m.ctx.home, ".volley", "bin"));
      expect(checks[0]?.CMUX_SOCKET_PASSWORD).toBeUndefined();
      // Not switched yet: the change fails saying so.
      await expect(c?.apply()).rejects.toThrow(/still does not let volleyd's service in/);
      // Switched to Automation mode in cmux: the change passes, no password asked or stored.
      automation = true;
      expect(await c?.apply()).toEqual([
        "volleyd's service reaches cmux now (cmux's socket control mode: Automation mode).",
      ]);
      expect(m.secretPrompts).toEqual([]);
      expect(existsSync(join(m.ctx.volleydHome, "cmux.json"))).toBe(false);
      const again = await planTerminal(m.ctx);
      expect(
        again.changes
          .map((x) => x.summary)
          .filter((x) => x.startsWith(AUTOMATION_SUMMARY) || x.startsWith(CMUX_SUMMARY)),
      ).toEqual([]);
      expect(again.found.join("\n")).toContain(
        "cmux: volleyd's service reaches it (cmux's socket control mode: Automation mode) (`cmux capabilities` and `cmux list-workspaces`, run the way the service runs them)",
      );
      expect(m.ctx.cmuxSocketMode).toBe("automation");
    });

    it("the Automation change asks for the password when cmux was put in Password mode instead", async () => {
      const c = (await planTerminal(m.ctx)).changes.find((x) =>
        x.summary.startsWith(AUTOMATION_SUMMARY),
      );
      cmuxPassword = "pw";
      m.secrets = ["pw"];
      const out = await c?.apply();
      expect(m.secretPrompts).toEqual(["cmux socket password (hidden): "]);
      expect(out?.join("\n")).toContain("Stored the cmux socket password");
      expect(readCmuxPassword(m.ctx.volleydHome)).toBe("pw");
    });

    it("asks for the password (hidden), checks it as the service would, then stores it", async () => {
      cmuxPassword = "hunter2";
      m.secrets = ["hunter2"];
      const p = await planTerminal(m.ctx);
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
      await applyAll(await planServices(m.ctx));
      for (const f of readdirSync(join(m.ctx.home, "Library", "LaunchAgents"))) {
        expect(readFileSync(join(m.ctx.home, "Library", "LaunchAgents", f), "utf-8")).not.toContain(
          "hunter2",
        );
      }
      expect(checks.at(-1)?.CMUX_SOCKET_PASSWORD).toBe("hunter2");
      // A rerun (`--repair`) finds it in place.
      const again = await planTerminal(m.ctx);
      expect(again.changes).toEqual([]);
      expect(again.found.join("\n")).toContain(
        "cmux: volleyd's service reaches it (cmux's socket control mode: Password mode) (`cmux capabilities` and `cmux list-workspaces`, run the way the service runs them, with the stored socket password)",
      );
      expect(await again.verify?.()).toEqual([]);
    });

    it("names the stored password only in a mode that uses it", async () => {
      writeCmuxPassword(m.ctx.volleydHome, "pw");
      automation = true;
      openMode = "allow-all";
      const found = (await planTerminal(m.ctx)).found.join("\n");
      expect(found).toContain(
        "cmux: volleyd's service reaches it (cmux's socket control mode: Full open access)",
      );
      expect(found).not.toContain("with the stored socket password");
    });

    it("refuses a password cmux does not take, storing nothing", async () => {
      cmuxPassword = "right";
      m.secrets = ["wrong"];
      const c = cmuxChange(await planTerminal(m.ctx));
      await expect(c?.apply()).rejects.toThrow(
        "cmux refused that password (cmux said: Access denied - invalid socket password); nothing was stored",
      );
      expect(readCmuxPassword(m.ctx.volleydHome)).toBeNull();
      expect(m.keychain.has("volleyd")).toBe(false);
      m.secrets = [""];
      await expect(c?.apply()).rejects.toThrow(/no password entered/);
    });

    it("a stored password cmux no longer takes is offered again, saying why", async () => {
      writeCmuxPassword(m.ctx.volleydHome, "old");
      cmuxPassword = "new";
      const p = await planTerminal(m.ctx);
      expect(p.found.join("\n")).toContain("cmux refused the socket password volleyd has");
      expect(cmuxChange(p)).toBeDefined();
    });

    it("re-stores a working password the keychain lacks", async () => {
      writeCmuxPassword(m.ctx.volleydHome, "pw");
      cmuxPassword = "pw";
      const p = await planTerminal(m.ctx);
      const c = p.changes.find((x) => x.summary.startsWith("Store the cmux socket password"));
      expect(c?.summary).toContain("the macOS keychain, service volley-cmux");
      await c?.apply();
      expect(m.keychain.get("volleyd")).toBe("pw");
      chmodSync(join(m.ctx.volleydHome, "cmux.json"), 0o644);
      const loose = (await planTerminal(m.ctx)).changes.find((x) =>
        x.summary.startsWith("Store the cmux socket password"),
      );
      expect(loose?.summary).toContain("mode 0600");
      await loose?.apply();
      expect(statSync(join(m.ctx.volleydHome, "cmux.json")).mode & 0o777).toBe(0o600);
    });

    it("keeps a password's spaces: only the line ending goes", async () => {
      cmuxPassword = " two words ";
      m.secrets = [" two words \n"];
      await applyAll(await planTerminal(m.ctx));
      expect(readCmuxPassword(m.ctx.volleydHome)).toBe(" two words ");
    });

    it("a refusal worded in a way setup does not know still offers the password, quoting cmux", async () => {
      writeCmuxPassword(m.ctx.volleydHome, "old");
      cmuxPassword = "new";
      wrongPassword = "E_NOPE: go away";
      const p = await planTerminal(m.ctx);
      expect(p.found.join("\n")).toContain("(cmux said: E_NOPE: go away)");
      expect(p.found.join("\n")).toContain(CMUX_PASSWORD_STEPS);
      const c = cmuxChange(p);
      expect(c).toBeDefined();
      m.secrets = ["still-wrong"];
      await expect(c?.apply()).rejects.toThrow("(cmux said: E_NOPE: go away)");
      m.secrets = ["new"];
      await c?.apply();
      expect(readCmuxPassword(m.ctx.volleydHome)).toBe("new");
    });

    it("without a terminal it asks nothing, and the step is not done: its change says where to enter the password", async () => {
      cmuxPassword = "pw";
      wrongPassword = DENIED_PASSWORD;
      m.deps.interactive = false;
      const p = await planTerminal(m.ctx);
      expect(p.found.join("\n")).toContain(
        "run `volley setup --step terminal` in a terminal on this machine to enter the socket password",
      );
      expect(p.found.join("\n")).toContain(`(cmux said: ${DENIED_PASSWORD})`);
      const c = cmuxChange(p);
      expect(c?.summary).toContain("needs a terminal");
      // Applied last, after the choice is on record.
      expect(p.changes.at(-1)).toBe(c);
      await expect(c?.apply()).rejects.toThrow(`(cmux said: ${DENIED_PASSWORD})`);
      expect(m.secretPrompts).toEqual([]);
      // The Desk plans with no askSecret at all (its Services step makes the cmux check): the same.
      m.deps.interactive = true;
      const { askSecret: _a, ...noAsk } = m.deps;
      m.ctx.deps = noAsk;
      expect(cmuxChange(await planTerminal(m.ctx))?.summary).toContain("needs a terminal");
      expect(cmuxChange(await planServicesForDesk(m.ctx))?.summary).toContain("needs a terminal");
    });

    it("when cmux is not running, the step is not done: its change checks again", async () => {
      cmuxRunning = false;
      const p = await planTerminal(m.ctx);
      expect(p.found.join("\n")).toContain("open cmux");
      expect(p.found.join("\n")).toContain("(cmux said: Failed to connect");
      const c = p.changes.find((x) => x.summary.startsWith("Make volleyd's service reach cmux"));
      expect(c).toBeDefined();
      await expect(c?.apply()).rejects.toThrow("(cmux said: Failed to connect");
      // Opened (and in Password mode with the stored password): the change passes.
      cmuxRunning = true;
      cmuxPassword = "pw";
      writeCmuxPassword(m.ctx.volleydHome, "pw");
      expect(await c?.apply()).toEqual(["volleyd's service reaches cmux now."]);
    });

    it("chooses cmux, records it in config.yaml, and keeps today's check; Services no longer makes it", async () => {
      automation = true;
      const p = await planTerminal(m.ctx);
      expect(p.found[0]).toBe("Terminal: cmux (volleyd starts local agents in cmux workspaces)");
      expect(p.row).toBe("cmux (socket control mode: Automation mode)");
      const file = join(m.ctx.volleydHome, "config.yaml");
      expect(p.changes.map((c) => c.summary)).toEqual([
        `Record the local terminal in ${file} (fleet.local_terminal: cmux)`,
      ]);
      await applyAll(p);
      expect(readFileSync(file, "utf-8")).toBe("fleet:\n  local_terminal: cmux\n");
      expect(m.ctx.terminal).toBe("cmux");
      expect(await p.verify?.()).toEqual([]);
      // The CLI's Services step leaves cmux to this step; the Desk's still checks it.
      checks = [];
      const services = await planServices(m.ctx);
      expect(services.found.join("\n")).not.toMatch(/^cmux:/m);
      expect(checks).toEqual([]);
      const desk = await planServicesForDesk(m.ctx);
      expect(desk.found.join("\n")).toContain("cmux: volleyd's service reaches it");
    });

    it("keeps an explicit tmux in config.yaml while tmux is installed, and checks no cmux", async () => {
      mkdirSync(m.ctx.volleydHome, { recursive: true });
      writeFileSync(join(m.ctx.volleydHome, "config.yaml"), "fleet:\n  local_terminal: tmux\n");
      const p = await planTerminal(m.ctx);
      expect(p.changes).toEqual([]);
      expect(p.row).toBe("tmux (/usr/bin/tmux)");
      expect(p.found.join("\n")).toContain("chose it over cmux");
      expect(checks).toEqual([]);
      expect(m.ctx.terminal).toBe("tmux");
    });

    it("the Desk's Services step on a Mac without cmux says volleyd uses tmux", async () => {
      rmSync(join(m.ctx.home, "Applications"), { recursive: true });
      const p = await planServicesForDesk(m.ctx);
      expect(cmuxChange(p)).toBeUndefined();
      expect(p.found.join("\n")).toContain(
        "cmux: not installed, so volleyd starts local agents in tmux",
      );
      expect(checks).toEqual([]);
    });
  });

  describe("the Terminal step without cmux", () => {
    let dir: string;
    let fake: FakeDynsec;
    let m: FakeMachine;
    const config = () => join(m.ctx.volleydHome, "config.yaml");
    const words = (p: StepPlan) =>
      [
        ...p.found,
        p.blocked ?? "",
        p.skipped ?? "",
        p.row ?? "",
        ...p.changes.flatMap((c) => [c.summary, c.detail ?? ""]),
      ].join("\n");
    const start = async (platform: NodeJS.Platform) => {
      dir = tempDir("volley-setup-terminal-");
      fake = await startFakeDynsec();
      m = fakeMachine(fake, dir, { platform });
    };
    afterEach(async () => {
      await fake.close();
    });

    it("on a Mac without cmux, chooses tmux and records it in config.yaml", async () => {
      await start("darwin");
      const p = await planTerminal(m.ctx);
      expect(p.blocked).toBeUndefined();
      expect(p.found).toEqual([
        "Terminal: tmux at /usr/bin/tmux (volleyd starts local agents in tmux sessions; cmux is not installed)",
      ]);
      expect(p.row).toBe("tmux (/usr/bin/tmux)");
      expect(p.changes.map((c) => c.summary)).toEqual([
        `Record the local terminal in ${config()} (fleet.local_terminal: tmux)`,
      ]);
      expect(p.changes[0]?.detail).toContain("+  local_terminal: tmux");
      // Planning writes nothing.
      expect(existsSync(config())).toBe(false);
      expect(await p.changes[0]?.apply()).toEqual([
        `Wrote ${config()}: volleyd starts local agents in tmux (a running volleyd from its next start).`,
      ]);
      expect(readFileSync(config(), "utf-8")).toBe("fleet:\n  local_terminal: tmux\n");
      expect(m.ctx.terminal).toBe("tmux");
      // A rerun finds it in place.
      const { terminal: _t, ...rest } = m.ctx;
      const fresh: SetupContext = rest;
      const again = await planTerminal(fresh);
      expect(again.changes).toEqual([]);
      expect(again.found).toContain(`fleet.local_terminal: tmux in ${config()}`);
      expect(fresh.terminal).toBe("tmux");
    });

    it("on a Mac without cmux or tmux, blocks with the install line", async () => {
      await start("darwin");
      m.present.delete("/usr/bin/tmux");
      const p = await planTerminal(m.ctx);
      expect(p.blocked).toBe(
        "neither cmux nor tmux is installed, and volleyd starts local agents in one of them: install tmux (brew install tmux), or cmux, then rerun `volley setup --step terminal`",
      );
      expect(p.row).toBe("missing: cmux or tmux (brew install tmux)");
      expect(p.changes).toEqual([]);
      expect(existsSync(config())).toBe(false);
      // Homebrew's tmux counts: it is on the services' PATH.
      m.present.add("/opt/homebrew/bin");
      m.present.add("/opt/homebrew/bin/tmux");
      expect((await planTerminal(m.ctx)).row).toBe("tmux (/opt/homebrew/bin/tmux)");
    });

    it("on Linux, chooses tmux and never mentions cmux, even with a cmux on the PATH", async () => {
      await start("linux");
      const bin = join(m.ctx.home, "Applications", "cmux.app", "Contents", "Resources", "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "cmux"), "");
      const p = await planTerminal(m.ctx);
      expect(p.row).toBe("tmux (/usr/bin/tmux)");
      expect(words(p)).not.toMatch(/cmux/i);
      for (const c of p.changes) await c.apply();
      expect(readFileSync(config(), "utf-8")).toBe("fleet:\n  local_terminal: tmux\n");
      // An explicit cmux there (copied from a Mac) is not installed here: tmux, saying why.
      writeFileSync(config(), "fleet:\n  local_terminal: cmux\n");
      const moved = await planTerminal(m.ctx);
      expect(moved.found[0]).toBe(
        `${config()} chose cmux, which is not installed here: volleyd starts local agents in tmux instead`,
      );
      expect(moved.changes).toHaveLength(1);
    });

    it("on Linux without tmux, blocks with this machine's install line", async () => {
      await start("linux");
      m.present.delete("/usr/bin/tmux");
      const blocked = async () => (await planTerminal(m.ctx)).blocked;
      expect(await blocked()).toContain(
        "tmux is not installed, and volleyd starts local agents in it: install it (install tmux with this machine's package manager",
      );
      m.present.add("/usr/bin/dnf");
      expect(await blocked()).toBe(
        "tmux is not installed, and volleyd starts local agents in it: install it (sudo dnf install -y tmux), then rerun `volley setup --step terminal`",
      );
      m.present.add("/usr/bin/apt-get");
      const p = await planTerminal(m.ctx);
      expect(p.blocked).toBe(
        "tmux is not installed, and volleyd starts local agents in it: install it (sudo apt-get install -y tmux), then rerun `volley setup --step terminal`",
      );
      expect(p.row).toBe("missing: tmux (sudo apt-get install -y tmux)");
      expect(words(p)).not.toMatch(/cmux/i);
    });

    it("merges into an existing config.yaml, keeping every other key and comment", async () => {
      await start("linux");
      mkdirSync(m.ctx.volleydHome, { recursive: true });
      writeFileSync(
        config(),
        "# my supervisor\nspawn:\n  ceiling: 3 # busy\nfleet:\n  local_name: hub\n",
      );
      for (const c of (await planTerminal(m.ctx)).changes) await c.apply();
      expect(readFileSync(config(), "utf-8")).toBe(
        "# my supervisor\nspawn:\n  ceiling: 3 # busy\nfleet:\n  local_name: hub\n  local_terminal: tmux\n",
      );
    });

    it("blocks on a config.yaml that is not YAML, and never overwrites it", async () => {
      await start("linux");
      mkdirSync(m.ctx.volleydHome, { recursive: true });
      writeFileSync(config(), "fleet: [unclosed\n");
      const p = await planTerminal(m.ctx);
      expect(p.blocked).toMatch(/config\.yaml is not valid YAML: .*fix it/);
      expect(readFileSync(config(), "utf-8")).toBe("fleet: [unclosed\n");
    });
  });
  it("withLocalTerminal sets the key in any mapping, and refuses what volleyd would", () => {
    expect(withLocalTerminal("", "tmux")).toBe("fleet:\n  local_terminal: tmux\n");
    expect(withLocalTerminal("fleet:\n  local_terminal: cmux\n", "tmux")).toBe(
      "fleet:\n  local_terminal: tmux\n",
    );
    expect(() => withLocalTerminal("- a\n- b\n", "tmux")).toThrow(/not a YAML mapping/);
    expect(() => withLocalTerminal("fleet: 3\n", "tmux")).toThrow(/fleet/);
  });
});
