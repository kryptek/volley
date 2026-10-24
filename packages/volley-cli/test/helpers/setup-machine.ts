import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { LAYOUTS, type Layout } from "../../src/auth/config";
import type { AuthContext } from "../../src/auth/context";
import { type BufferIO, makeBufferIO } from "../../src/io";
import type {
  AnonymousProbe,
  ExecResult,
  SetupContext,
  SetupDeps,
  SetupExec,
} from "../../src/setup/step";
import { type TestDeps, fakeDeps } from "./auth-deps";
import type { FakeDynsec } from "./fake-dynsec";

/** A broker config with no authentication: what a stock install ships. */
export const ANONYMOUS_CONFIG = "listener 1883\nallow_anonymous true\n";

export const NOW = Date.parse("2026-10-18T12:00:00.000Z");

/** The merged settings the fake hooks installer reports and writes. */
export const HOOKED_SETTINGS = `${JSON.stringify(
  { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "volley-hooks" }] }] } },
  null,
  2,
)}\n`;

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

/**
 * A fake machine for `volley setup`: temp dirs for the broker config, auth dir, home and checkout;
 * the in-process Dynamic Security stand-in; and a fake exec that simulates the commands setup
 * runs (broker restart, launchctl / systemctl, the keychain, the hooks installer, the Desk build),
 * recording every argv.
 */
export interface FakeMachine {
  ctx: SetupContext;
  deps: SetupDeps;
  auth: TestDeps;
  io: BufferIO;
  layout: Layout;
  execCalls: string[][];
  /** What each exec call got on stdin (undefined: the terminal's), by call index. */
  execInputs: (string | undefined)[];
  /** The environment each exec call got (undefined: setup's own), by call index. */
  execEnvs: (Record<string, string | undefined> | undefined)[];
  anonymous: { tcp: AnonymousProbe; ws: AnonymousProbe };
  /** Whether the running broker's WebSocket listener is open to the LAN (set at restart). */
  lanWs: boolean;
  /** Answers `confirm` gives, in order (then false); and the questions it was asked. */
  answers: boolean[];
  questions: string[];
  /** Answers `askSecret` gives, in order (then null); and the prompts it showed. */
  secrets: (string | null)[];
  secretPrompts: string[];
  keychain: Map<string, string>;
  loaded: Set<string>;
  active: Set<string>;
  settingsFile: string;
  deskDist: string;
  /**
   * Paths outside the test's temp dir that exist on the fake machine (`/opt/homebrew/bin`, the
   * cmux app): setup never sees the real machine's, so a Mac with Homebrew and cmux gives the same
   * results as Linux CI.
   */
  present: Set<string>;
  /** Replace the context's IO (a fresh buffer per run). */
  freshIO: () => BufferIO;
}

export function fakeMachine(
  fake: FakeDynsec,
  dir: string,
  opts: { platform?: NodeJS.Platform; repair?: boolean; lan?: boolean } = {},
): FakeMachine {
  const layout: Layout = {
    ...LAYOUTS["brew-arm64"],
    config: join(dir, "mosquitto.conf"),
    authDir: join(dir, "auth"),
    stateFile: join(dir, "dynamic-security.json"),
  };
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, "packages", "volley-desk"), { recursive: true });
  const auth = fakeDeps(fake, layout);
  // Before setup the broker runs a config without the plugin: the admin login is refused.
  auth.adminUp = false;
  const settingsFile = join(home, ".claude", "settings.json");
  const deskDist = join(repo, "packages", "volley-desk", "dist");
  const m: FakeMachine = {
    execCalls: [],
    execInputs: [],
    execEnvs: [],
    lanWs: false,
    anonymous: { tcp: "accepted", ws: "unreachable" },
    answers: [],
    questions: [],
    secrets: [],
    secretPrompts: [],
    keychain: new Map(),
    // tmux in /usr/bin: the Terminal step finds a terminal (a test deletes it to see it block).
    present: new Set(["/usr/bin/tmux"]),
    loaded: new Set(),
    active: new Set(),
    settingsFile,
    deskDist,
    layout,
    auth,
    io: makeBufferIO({ now: () => new Date(NOW) }),
  } as unknown as FakeMachine;

  const volleydCli = join(repo, "packages", "volleyd", "src", "cli.ts");
  const volleydPlist = join(home, "Library", "LaunchAgents", "systems.volley.volleyd.plist");
  const hooksInstall = join(repo, "packages", "volley-hooks", "scripts", "install.sh");

  const exec: SetupExec = async (argv, o) => {
    const a = [...argv];
    m.execCalls.push(a);
    m.execInputs.push(o?.input);
    m.execEnvs.push(o?.env);
    const line = a.join(" ");
    if (line === layout.restart) {
      auth.adminUp = true;
      m.anonymous = { tcp: "refused", ws: "refused" };
      // The broker now listens as its config says: `listener 9001` alone is every interface.
      m.lanWs = /^listener 9001$/m.test(readText(layout.config) ?? "");
      return ok();
    }
    if (a[0] === "bun" && a[1] === volleydCli && a[2] === "install") {
      const plist = "<plist>volleyd</plist>\n";
      if (a.includes("--dry-run")) return ok(`# ${volleydPlist}\n${plist}`);
      mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(volleydPlist, plist);
      m.loaded.add("systems.volley.volleyd");
      return ok(`installed ${volleydPlist}\n`);
    }
    if (a[0] === "launchctl") {
      const target = a[2] ?? "";
      const label = target.split("/").pop() ?? "";
      if (a[1] === "print")
        return m.loaded.has(label) ? ok() : { code: 113, stdout: "", stderr: "" };
      if (a[1] === "bootout") {
        m.loaded.delete(label);
        return ok();
      }
      if (a[1] === "bootstrap") {
        m.loaded.add(basename(a[3] ?? "", ".plist"));
        return ok();
      }
    }
    if (a[0] === "systemctl" && a[1] === "--user") {
      const unit = a[a.length - 1] ?? "";
      if (a[2] === "is-active")
        return m.active.has(unit) ? ok("active\n") : { code: 3, stdout: "inactive\n", stderr: "" };
      if (a[2] === "enable" || a[2] === "restart") {
        m.active.add(unit);
        return ok();
      }
      return ok();
    }
    if (a[0] === "bash" && a[1] === hooksInstall) {
      if (a[2] === "--dry-run") return ok(HOOKED_SETTINGS);
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(settingsFile, HOOKED_SETTINGS);
      return ok(`installed volley-hooks into ${settingsFile}\n`);
    }
    if (a[0] === "bun" && a[1] === "run" && a[2] === "build" && o?.cwd !== undefined) {
      mkdirSync(join(o.cwd, "dist"), { recursive: true });
      writeFileSync(join(o.cwd, "dist", "index.html"), "<!doctype html>");
      return ok();
    }
    if (a[0] === "security") {
      const account = a[a.indexOf("-a") + 1] ?? "";
      if (a[1] === "find-generic-password") {
        const pw = m.keychain.get(account);
        return pw === undefined ? { code: 44, stdout: "", stderr: "not found" } : ok(`${pw}\n`);
      }
      if (a[1] === "-i") {
        // Interactive mode: one command per stdin line, double-quoted words with \-escapes.
        for (const cmdLine of (o?.input ?? "").split("\n").filter((l) => l !== "")) {
          const words = [...cmdLine.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((w) =>
            w[1] !== undefined ? w[1].replace(/\\(.)/g, "$1") : (w[2] as string),
          );
          if (words[0] !== "add-generic-password") {
            return { code: 1, stdout: "", stderr: `unknown command ${words[0]}` };
          }
          m.keychain.set(
            words[words.indexOf("-a") + 1] ?? "",
            words[words.indexOf("-w") + 1] ?? "",
          );
        }
        return ok();
      }
    }
    return { code: 127, stdout: "", stderr: `fake exec: unknown command ${line}` };
  };

  const deps: SetupDeps = {
    auth,
    exec,
    probeAnonymous: async (url) => {
      if (!url.startsWith("ws:")) return m.anonymous.tcp;
      // From the LAN (the Desk's host) the WebSocket listener answers only when it is open to it.
      if (new URL(url).hostname === "desk.example" && !m.lanWs) return "unreachable";
      return m.anonymous.ws;
    },
    liveAgents: async () => 2,
    confirm: async (q) => {
      m.questions.push(q);
      return m.answers.shift() ?? false;
    },
    interactive: true,
    askSecret: async (prompt) => {
      m.secretPrompts.push(prompt);
      return m.secrets.shift() ?? null;
    },
    sleep: async () => {},
    platform: opts.platform ?? "darwin",
    uid: 501,
    lanHost: () => "desk.example",
    repoRoot: repo,
    bun: "bun",
    exists: (p) => (p === dir || p.startsWith(`${dir}/`) ? existsSync(p) : m.present.has(p)),
  };
  const authCtx: AuthContext = {
    dir: layout.authDir,
    layout,
    url: fake.url,
    io: m.io,
    env: { HOME: home, VOLLEYD_HOME: join(home, ".volley", "volleyd") },
    deps: auth,
  };
  const ctx: SetupContext = {
    auth: authCtx,
    deps,
    config: layout.config,
    stateFile: layout.stateFile,
    tcpUrl: "mqtt://127.0.0.1:1883",
    wsUrl: "ws://127.0.0.1:9001",
    home,
    volleydHome: join(home, ".volley", "volleyd"),
    repair: opts.repair ?? false,
    yes: false,
    ...(opts.lan !== undefined ? { lan: opts.lan } : {}),
    deskHost: "desk.example",
    deskPort: 5199,
  };
  m.ctx = ctx;
  m.deps = deps;
  m.freshIO = () => {
    const io = makeBufferIO({ now: () => new Date(NOW) });
    m.io = io;
    ctx.auth.io = io;
    return io;
  };
  writeFileSync(layout.config, ANONYMOUS_CONFIG);
  return m;
}

export const readText = (p: string) => (existsSync(p) ? readFileSync(p, "utf-8") : null);
