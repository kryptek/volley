import {
  existsSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS } from "../src/config-defaults";
import { type CoordinatorTarget, localTarget, remoteTarget } from "../src/coordinator/prepare";
import {
  COORDINATOR_SETTINGS,
  type CoordinatorRolePayload,
  renderCoordinatorMcp,
  renderCoordinatorScript,
} from "../src/coordinator/role";
import { CoordinatorRunner, type CoordinatorRunnerDeps } from "../src/coordinator/runner";
import type { RemoteStep } from "../src/fence";
import { type RemoteHostSpec, SshTmuxHost } from "../src/hosts/ssh-tmux";
import { validator } from "../src/schemas";
import type { CoordinatorConfig } from "../src/types";
import { fakeExec } from "./helpers/fake-exec";
import { tempDir } from "./helpers/tmp";

const BANNER = readFileSync(
  new URL("./fixtures/remote-control-banner.txt", import.meta.url),
  "utf-8",
);
const TRUST = readFileSync(
  new URL("./fixtures/remote-control-trust.txt", import.meta.url),
  "utf-8",
);
const LINK = "https://claude.ai/code/session_01FAKEFAKEFAKEFAKEFAKE0000";
const HOME = "/path/to/home";
const DIR = `${HOME}/.volley/coordinator`;
const SESSION = "volley-coordinator-coord-test";
/** Every payload the runner publishes must hold to the schema the topic promises. */
const rolePayload = validator("coordinator-role.schema.json#/allOf/1/properties/payload");
const LOGIN = `${JSON.stringify({ username: "coordinator", password: "pw-coordinator" })}\n`;

const SPEC: RemoteHostSpec = {
  name: "box-a",
  target: "dev@box-a",
  volley_dir: "/opt/volley",
  tunnel: { remote_port: 21883, supervise: false },
};

/** The script the runner must write for box-a (the render, byte for byte). */
const SCRIPT = renderCoordinatorScript({
  dir: DIR,
  name: "coord-test",
  namespace: "default",
  brokerPort: 21883,
  hooksDir: "/opt/volley/packages/volley-hooks",
  binDir: `${HOME}/.volley/bin`,
  capacity: 4,
  permissionMode: "acceptEdits",
  continueGraceS: 10,
});

/**
 * box-a behind the real SshTmuxHost: every step passes the real fence (the fake exec checks it)
 * and runs against this fake box: its files, its links, its one tmux session and its screen.
 */
function fakeBox() {
  const box = {
    files: new Map<string, string>([[".claude.json", "{}\n"]]),
    modes: new Map<string, string>(),
    links: new Map<string, string>(),
    session: false,
    screen: BANNER,
    steps: [] as RemoteStep[],
    launches: [] as string[][],
    kills: 0,
    /** kill-sessions still to fail as an unreachable machine does (the session stays). */
    failKills: 0,
  };
  const fx = fakeExec().on(["ssh", "-T"], (_argv, opts) => {
    let out = "";
    for (const s of opts.remote?.steps ?? []) {
      box.steps.push(s);
      const [p, ...a] = s.argv;
      if (s.stdout !== undefined) {
        box.files.set(s.stdout, Buffer.from(s.stdin ?? "", "base64").toString("utf-8"));
      } else if (p === "printenv") out += a[0] === "HOME" ? `${HOME}\n` : "/usr/bin:/bin\n";
      else if (p === "chmod") box.modes.set(a[1] as string, a[0] as string);
      else if (p === "ln") box.links.set(a[2] as string, a[1] as string);
      else if (p === "cat") {
        const f = box.files.get(a[0] as string);
        if (f === undefined) return { code: 1 };
        out += f;
      } else if (p === "mv") {
        box.files.set(a[2] as string, box.files.get(a[1] as string) ?? "");
        box.files.delete(a[1] as string);
      } else if (p === "tmux") {
        const sub = a[0];
        if (sub === "show-environment") out += "PATH=/usr/bin:/bin\n";
        else if (sub === "new-session") {
          box.session = true;
          box.launches.push([...s.argv]);
        } else if (sub === "has-session") {
          if (!box.session) return { code: 1, stderr: `can't find session: ${SESSION}\n` };
        } else if (sub === "capture-pane") {
          if (!box.session) return { code: 1 };
          out += box.screen;
        } else if (sub === "kill-session") {
          if (box.failKills > 0) {
            box.failKills--;
            return {
              code: 255,
              stderr: "ssh: connect to host box-a port 22: Connection refused\n",
            };
          }
          box.kills++;
          const had = box.session;
          box.session = false;
          if (!had) return { code: 1, stderr: `can't find session: ${SESSION}\n` };
        }
      }
    }
    return { stdout: out };
  });
  return { box, fx, host: new SshTmuxHost(SPEC, fx.exec) };
}

interface Rig {
  runner: CoordinatorRunner;
  published: (CoordinatorRolePayload | null)[];
  states: () => string[];
  last: () => CoordinatorRolePayload | null;
  cfg: CoordinatorConfig;
  advance: (s: number) => Promise<void>;
  tick: () => Promise<void>;
  up: Set<string>;
  stopped: { v: boolean };
  name: { v: string | null };
  login: { v: string | null };
  logs: string[];
}

function rig(
  targets: Record<string, CoordinatorTarget>,
  over: Partial<CoordinatorConfig> = {},
): Rig {
  let now = Date.parse("2026-10-24T12:00:00.000Z");
  const published: (CoordinatorRolePayload | null)[] = [];
  const cfg: CoordinatorConfig = { ...CONFIG_DEFAULTS.coordinator, machine: "box-a", ...over };
  const up = new Set(Object.keys(targets));
  const stopped = { v: false };
  const name = { v: "coord-test" as string | null };
  const login = { v: LOGIN as string | null };
  const logs: string[] = [];
  const deps: CoordinatorRunnerDeps = {
    now: () => now,
    config: () => cfg,
    name: () => name.v,
    namespace: "default",
    target: (m) => targets[m] ?? `no machine '${m}'`,
    up: (m) => up.has(m),
    login: () => login.v,
    repos: (m, home) =>
      m === "box-a" ? [{ slug: "acme/app", target: `${home}/.volley/repos/acme/app` }] : [],
    publish: async (p) => {
      if (p !== null && !rolePayload(p))
        throw new Error(`schema: ${JSON.stringify(rolePayload.errors)} in ${JSON.stringify(p)}`);
      published.push(p);
    },
    stopped: {
      get: () => stopped.v,
      set: (v) => {
        stopped.v = v;
      },
    },
    log: (m) => {
      logs.push(m);
    },
  };
  const runner = new CoordinatorRunner(deps);
  return {
    runner,
    published,
    states: () => published.map((p) => (p === null ? "(cleared)" : p.state)),
    last: () => published.at(-1) ?? null,
    cfg,
    advance: async (s) => {
      now += s * 1000;
    },
    tick: () => runner.tick(),
    up,
    stopped,
    name,
    login,
    logs,
  };
}

describe("the coordinator on a paired machine (box-a)", () => {
  it("prepares the directory, launches the sealed script, publishes starting then running with the link", async () => {
    const { box, host } = fakeBox();
    const r = rig({ "box-a": remoteTarget(host) });
    await r.tick();
    // The five artefacts, each a fenced REMOTE step, in order, then the trust record.
    const writes = box.steps.filter((s) => s.stdout !== undefined).map((s) => s.stdout);
    expect(writes).toEqual([
      `${DIR}/.volley/coordinator.sh`,
      `${DIR}/.volley/auth/coordinator.json`,
      `${DIR}/.mcp.json`,
      `${DIR}/.claude/settings.json`,
      ".claude.json.volleyd.tmp",
    ]);
    expect(box.files.get(`${DIR}/.volley/coordinator.sh`)).toBe(SCRIPT);
    expect(box.files.get(`${DIR}/.volley/auth/coordinator.json`)).toBe(LOGIN);
    expect(box.modes.get(`${DIR}/.volley/auth/coordinator.json`)).toBe("600");
    expect(box.files.get(`${DIR}/.mcp.json`)).toBe(
      renderCoordinatorMcp("/opt/volley/packages/volley-mcp/src/index.ts", {
        dir: DIR,
        name: "coord-test",
        namespace: "default",
        brokerPort: 21883,
        hooksDir: "/opt/volley/packages/volley-hooks",
      }),
    );
    expect(box.files.get(`${DIR}/.mcp.json`)).not.toContain("pw-coordinator");
    expect(box.files.get(`${DIR}/.claude/settings.json`)).toBe(COORDINATOR_SETTINGS);
    expect(box.links.get(`${DIR}/repos/acme/app`)).toBe(`${HOME}/.volley/repos/acme/app`);
    expect(JSON.parse(box.files.get(".claude.json") ?? "{}").projects[DIR]).toEqual({
      hasTrustDialogAccepted: true,
    });
    expect(box.launches).toEqual([
      ["tmux", "new-session", "-d", "-s", SESSION, "-c", DIR, "bash .volley/coordinator.sh"],
    ]);
    expect(r.states()).toEqual(["starting"]);
    await r.advance(2);
    await r.tick();
    expect(r.states()).toEqual(["starting", "running"]);
    expect(r.last()).toMatchObject({
      machine: "box-a",
      name: "coord-test",
      state: "running",
      session_url: LINK,
      restarts: 0,
      dir: DIR,
    });
    // Nothing changes while it runs: nothing more is published.
    await r.advance(30);
    await r.tick();
    expect(r.published).toHaveLength(2);
  });

  it("deaths back off 5 s, 30 s, then 120 s; three quick deaths are failed; restart starts again", async () => {
    const { box, host } = fakeBox();
    const r = rig({ "box-a": remoteTarget(host) });
    await r.tick();
    await r.tick();
    const relaunchAfter = async (s: number) => {
      const before = box.launches.length;
      await r.advance(s - 1);
      await r.tick();
      expect(box.launches.length, `not before ${s} s`).toBe(before);
      await r.advance(1);
      await r.tick();
      expect(box.launches.length, `after ${s} s`).toBe(before + 1);
    };
    box.screen = "claude: error: lost the connection\n";
    await r.advance(30);
    await r.tick();
    box.session = false;
    await r.tick();
    expect(r.last()).toMatchObject({ state: "restarting", restarts: 1 });
    expect(r.last()?.last_error).toContain("lost the connection");
    expect(r.last()?.session_url).toBeUndefined();
    await relaunchAfter(5);
    box.screen = BANNER;
    await r.tick();
    expect(r.last()).toMatchObject({ state: "running", session_url: LINK, restarts: 1 });
    box.session = false;
    await r.tick();
    expect(r.last()).toMatchObject({ state: "restarting", restarts: 2 });
    await relaunchAfter(30);
    // Up for 200 s (past the ladder's 155 s window, under the 600 s reset): the next rung.
    await r.tick();
    await r.advance(200);
    box.session = false;
    await r.tick();
    expect(r.last()).toMatchObject({ state: "restarting", restarts: 3 });
    await relaunchAfter(120);
    // Three quick deaths in a row: failed, with the screen's last lines.
    for (let i = 0; i < 2; i++) {
      box.session = false;
      await r.tick();
      expect(r.last()?.state).toBe("restarting");
      await r.advance(120);
      await r.tick();
    }
    box.screen = "Error: something broke\n";
    await r.tick();
    expect(r.last()?.state).toBe("restarting");
    box.session = false;
    await r.tick();
    expect(r.last()).toMatchObject({ state: "failed", restarts: 6 });
    expect(r.last()?.last_error).toContain("something broke");
    const launches = box.launches.length;
    await r.advance(600);
    await r.tick();
    expect(box.launches.length).toBe(launches);
    // coordinator_restart: the backoff is cleared and it starts at once.
    box.screen = BANNER;
    const p = await r.runner.restart();
    expect(box.launches.length).toBe(launches + 1);
    expect(p).toMatchObject({ state: "starting", restarts: 0 });
  });

  it("the folder-trust question on its screen is reported, not answered", async () => {
    const { box, host } = fakeBox();
    const r = rig({ "box-a": remoteTarget(host) });
    box.screen = TRUST;
    await r.tick();
    await r.tick();
    expect(r.last()).toMatchObject({ state: "starting", needs_terminal: "trust" });
    expect(r.last()?.last_error).toContain(`tmux attach -t ${SESSION}`);
    expect(box.steps.some((s) => s.argv.includes("send-keys"))).toBe(false);
    box.screen = BANNER;
    await r.tick();
    expect(r.last()).toMatchObject({ state: "running", session_url: LINK });
    expect(r.last()?.needs_terminal).toBeUndefined();
  });

  it("machine: null kills the session and clears the topic", async () => {
    const { box, host } = fakeBox();
    const r = rig({ "box-a": remoteTarget(host) });
    await r.tick();
    await r.tick();
    r.cfg.machine = null;
    await r.tick();
    expect(box.kills).toBe(1);
    expect(box.session).toBe(false);
    expect(r.last()).toBeNull();
    const kill = box.steps.find((s) => s.argv[1] === "kill-session");
    expect(kill?.argv).toEqual(["tmux", "kill-session", "-t", `=${SESSION}`]);
  });

  it("a volleyd restart adopts the session already running; its shutdown leaves it alone", async () => {
    const { box, host } = fakeBox();
    const first = rig({ "box-a": remoteTarget(host) });
    await first.tick();
    await first.tick();
    // No stop hook: the session simply keeps running when the daemon goes.
    const second = rig({ "box-a": remoteTarget(host) });
    await second.tick();
    expect(box.launches).toHaveLength(1);
    expect(box.kills).toBe(0);
    expect(second.last()).toMatchObject({ state: "running", session_url: LINK, restarts: 0 });
  });

  it("stop keeps it stopped until restart", async () => {
    const { box, host } = fakeBox();
    const r = rig({ "box-a": remoteTarget(host) });
    await r.tick();
    await r.tick();
    const p = await r.runner.stop();
    expect(p?.state).toBe("stopped");
    expect(box.session).toBe(false);
    await r.advance(600);
    await r.tick();
    expect(box.launches).toHaveLength(1);
    expect(r.stopped.v).toBe(true);
    await r.runner.restart();
    expect(box.launches).toHaveLength(2);
    expect(r.stopped.v).toBe(false);
  });

  it("a down machine starts nothing; a machine change stops the old session first", async () => {
    const a = fakeBox();
    const b = fakeBox();
    const r = rig({ "box-a": remoteTarget(a.host), "box-b": remoteTarget(b.host) });
    r.up.delete("box-a");
    await r.tick();
    expect(a.box.launches).toHaveLength(0);
    expect(r.last()).toMatchObject({ state: "stopped", last_error: "box-a is not up" });
    r.up.add("box-a");
    await r.tick();
    await r.tick();
    expect(r.last()).toMatchObject({ machine: "box-a", state: "running" });
    r.cfg.machine = "box-b";
    await r.tick();
    expect(a.box.session).toBe(false);
    expect(b.box.launches).toHaveLength(1);
    expect(r.last()).toMatchObject({ machine: "box-b", state: "starting" });
  });

  it("a stop whose kill fails is not reported stopped; the kill is retried until the session is gone", async () => {
    const { box, host } = fakeBox();
    const r = rig({ "box-a": remoteTarget(host) });
    await r.tick();
    await r.tick();
    // The stop's own kill and its pass's retry both fail.
    box.failKills = 2;
    const p = await r.runner.stop();
    expect(box.session).toBe(true);
    expect(p?.state).not.toBe("stopped");
    await r.tick();
    expect(box.session).toBe(false);
    expect(r.last()).toMatchObject({ state: "stopped" });
    expect(box.launches).toHaveLength(1);
  });

  it("a volleyd restart with the stop persisted kills a session still running", async () => {
    const { box, host } = fakeBox();
    const first = rig({ "box-a": remoteTarget(host) });
    await first.tick();
    await first.tick();
    const second = rig({ "box-a": remoteTarget(host) });
    second.stopped.v = true;
    await second.tick();
    expect(box.session).toBe(false);
    expect(second.last()).toMatchObject({ state: "stopped" });
  });

  it("a machine change while the old machine is unreachable kills the old session once it answers", async () => {
    const a = fakeBox();
    const b = fakeBox();
    const r = rig({ "box-a": remoteTarget(a.host), "box-b": remoteTarget(b.host) });
    await r.tick();
    await r.tick();
    a.box.failKills = 1;
    r.cfg.machine = "box-b";
    await r.tick();
    expect(a.box.session).toBe(true);
    expect(b.box.launches).toHaveLength(1);
    await r.tick();
    expect(a.box.session).toBe(false);
    const kills = a.box.kills;
    await r.tick();
    expect(a.box.kills).toBe(kills);
  });

  it("machine: null while the machine is unreachable kills the session once it answers", async () => {
    const { box, host } = fakeBox();
    const r = rig({ "box-a": remoteTarget(host) });
    await r.tick();
    await r.tick();
    box.failKills = 1;
    r.cfg.machine = null;
    await r.tick();
    expect(box.session).toBe(true);
    expect(r.last()).toBeNull();
    await r.tick();
    expect(box.session).toBe(false);
  });

  it("a machine it cannot drive is reported once, not republished every tick", async () => {
    const r = rig({});
    r.cfg.machine = "box-x";
    r.up.add("box-x");
    await r.tick();
    expect(r.last()).toMatchObject({ state: "stopped", last_error: "no machine 'box-x'" });
    const n = r.published.length;
    await r.advance(10);
    await r.tick();
    expect(r.published).toHaveLength(n);
  });

  it("its machine going down while it runs is stopped, not left running with a dead link", async () => {
    const { box, host } = fakeBox();
    const r = rig({ "box-a": remoteTarget(host) });
    await r.tick();
    await r.tick();
    expect(r.last()).toMatchObject({ state: "running", session_url: LINK });
    r.up.delete("box-a");
    await r.tick();
    expect(r.last()).toMatchObject({ state: "stopped", last_error: "box-a is not up" });
    expect(r.last()?.session_url).toBeUndefined();
    const n = r.published.length;
    await r.tick();
    expect(r.published).toHaveLength(n);
    // Back up with its session still there: adopted, not counted as a death.
    r.up.add("box-a");
    await r.tick();
    await r.tick();
    expect(box.launches).toHaveLength(1);
    expect(r.last()).toMatchObject({ state: "running", session_url: LINK, restarts: 0 });
    expect(r.last()?.last_error).toBeUndefined();
  });

  it("a start that fails backs off on the ladder and is failed after three in a row", async () => {
    const { box, host } = fakeBox();
    let prepares = 0;
    const real = remoteTarget(host);
    const target: CoordinatorTarget = {
      ...real,
      home: () => real.home(),
      kill: (s, t) => real.kill(s, t),
      prepare: async () => {
        prepares++;
        throw new Error("ssh: connect to host box-a: Connection refused");
      },
    };
    const r = rig({ "box-a": target });
    await r.tick();
    expect(prepares).toBe(1);
    expect(r.last()).toMatchObject({ state: "stopped" });
    expect(r.last()?.last_error).toContain("Connection refused");
    await r.advance(4);
    await r.tick();
    expect(prepares, "not before 5 s").toBe(1);
    await r.advance(1);
    await r.tick();
    expect(prepares).toBe(2);
    await r.advance(29);
    await r.tick();
    expect(prepares, "not before 30 s").toBe(2);
    await r.advance(1);
    await r.tick();
    expect(prepares).toBe(3);
    expect(r.last()?.state).toBe("failed");
    await r.advance(600);
    await r.tick();
    expect(prepares).toBe(3);
    expect(box.launches).toHaveLength(0);
  });

  it("no coordinator login is reported once per backoff, not every tick", async () => {
    const { box, host } = fakeBox();
    const r = rig({ "box-a": remoteTarget(host) });
    r.login.v = null;
    await r.tick();
    expect(r.last()).toMatchObject({ state: "stopped" });
    expect(r.last()?.last_error).toContain("coordinator.json");
    const said = () => r.logs.filter((l) => l.includes("cannot start")).length;
    expect(said()).toBe(1);
    await r.tick();
    await r.tick();
    expect(said()).toBe(1);
    r.login.v = LOGIN;
    await r.advance(5);
    await r.tick();
    expect(box.launches).toHaveLength(1);
    expect(r.last()?.state).toBe("starting");
  });

  it("no coordinator name from setup: nothing runs", async () => {
    const { box, host } = fakeBox();
    const r = rig({ "box-a": remoteTarget(host) });
    r.name.v = null;
    await r.tick();
    expect(box.launches).toHaveLength(0);
    expect(r.published).toEqual([null]);
  });
});

describe("the coordinator on this machine (machine: local)", () => {
  it("writes the directory itself and starts its tmux session under the same fence shapes", async () => {
    const root = realpathSync(tempDir("volleyd-coord-"));
    const claudeJson = join(root, "claude.json");
    writeFileSync(claudeJson, "{}\n");
    let alive = false;
    const fx = fakeExec()
      .on(["tmux", "new-session"], () => {
        alive = true;
        return {};
      })
      .on(["tmux", "has-session"], () => (alive ? {} : { code: 1 }))
      .on(["tmux", "capture-pane"], { stdout: BANNER });
    const target = localTarget({
      exec: fx.exec,
      brokerPort: 1883,
      claudeJsonPath: claudeJson,
      home: root,
      hooksDir: "/opt/volley/packages/volley-hooks",
      mcpEntry: "/opt/volley/packages/volley-mcp/src/index.ts",
    });
    const r = rig({ local: target }, { machine: "local", dir: "~/coord" });
    await r.tick();
    const dir = join(root, "coord");
    expect(fx.argvs(["tmux", "new-session"])).toEqual([
      ["tmux", "new-session", "-d", "-s", SESSION, "-c", dir, "bash .volley/coordinator.sh"],
    ]);
    expect(readFileSync(join(dir, ".volley", "coordinator.sh"), "utf-8")).toContain(
      "export VOLLEY_BROKER_URL='mqtt://127.0.0.1:1883'",
    );
    expect(statSync(join(dir, ".volley", "auth", "coordinator.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
    expect(readFileSync(join(dir, ".claude", "settings.json"), "utf-8")).toBe(COORDINATOR_SETTINGS);
    expect(JSON.parse(readFileSync(claudeJson, "utf-8")).projects[dir]).toEqual({
      hasTrustDialogAccepted: true,
    });
    await r.tick();
    expect(r.last()).toMatchObject({ machine: "local", state: "running", session_url: LINK });
    r.cfg.machine = null;
    await r.tick();
    expect(fx.argvs(["tmux", "kill-session"])).toEqual([
      ["tmux", "kill-session", "-t", `=${SESSION}`],
    ]);
    void readlinkSync;
  });
});
