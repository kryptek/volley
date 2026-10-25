import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { LAYOUTS, type Layout, type LayoutName } from "../../src/auth/config";
import type { AuthContext } from "../../src/auth/context";
import { type BufferIO, makeBufferIO } from "../../src/io";
import type { WaveView } from "../../src/setup/first-wave";
import { TAILSCALE_APP_CLI } from "../../src/setup/network";
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

/** The hooks the fake hooks installer merges into settings.json. */
const HOOK = "bun /path/to/volley/packages/volley-hooks/src/hooks/session-start.ts";
const VOLLEY_HOOKS = { SessionStart: [{ hooks: [{ type: "command", command: HOOK }] }] };

/** The merged settings the fake hooks installer reports and writes over no settings. */
export const HOOKED_SETTINGS = `${JSON.stringify({ hooks: VOLLEY_HOOKS }, null, 2)}\n`;

/** settings.json with the fake hooks merged in (every other key kept, like install.sh). */
const hooked = (current: string | null, brokerUrl: string | undefined) => {
  let j: Record<string, unknown> = {};
  try {
    j = current !== null ? (JSON.parse(current) as Record<string, unknown>) : {};
  } catch {}
  const command = `${brokerUrl !== undefined ? `VOLLEY_BROKER_URL=${brokerUrl} ` : ""}${HOOK}`;
  return `${JSON.stringify(
    { ...j, hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } },
    null,
    2,
  )}\n`;
};

/** gh's credential helper in ~/.gitconfig (what `gh auth setup-git` writes). */
export const GH_GITCONFIG =
  '[credential "https://github.com"]\n\thelper =\n\thelper = !/usr/bin/gh auth git-credential\n';

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
  /** Claude Code: installed, signed in (and with what plan); `claude auth login` signs it in. */
  claude: { installed: boolean; signedIn: boolean; plan: string };
  /** gh: installed, signed in as `login`; `gh auth login` signs it in. */
  gh: { installed: boolean; signedIn: boolean; login: string };
  /** The answers `ask` gives, in order (then null); and the prompts it showed. */
  typed: (string | null)[];
  asked: string[];
  /** The user's ~/.claude.json. */
  claudeJson: string;
  /** The test wave's world: GitHub's answers, the clone's origin, the wave states read in turn. */
  firstWave: FirstWaveWorld;
  /**
   * Tailscale on the fake machine: installed (`brew install --cask tailscale` installs it), its
   * backend state, the MagicDNS name and addresses `status --json` reports, and what `up` prints.
   * `tailscale up` signs it in (state Running) unless `upCode` is not 0.
   */
  tailscale: {
    installed: boolean;
    state: string;
    name: string;
    ips: string[];
    url: string;
    upCode: number;
    /** `tailscale serve`'s config: each HTTPS port → its root proxy (`serve status --json`). */
    serves: Map<number, string>;
  };
  /** The machine's interfaces (`deps.interfaces`). */
  interfaces: Record<string, { address: string; family: "IPv4" | "IPv6"; internal: boolean }[]>;
  /** The fake clock (`deps.now`): `sleep` advances it. */
  clock: number;
  /** sudo on the fake machine: whether it needs a password (`sudo -n` then fails). */
  sudo: { passwordless: boolean };
  /**
   * What `sudo [-n] bun <volley cli> …` runs as root: given the argv after the CLI's path. Unset:
   * the command is unknown (127).
   */
  rootChild?: (argv: string[]) => Promise<ExecResult>;
}

export interface FirstWaveWorld {
  /** The GitHub owner `gh repo view` reports. */
  owner: string;
  /** `git remote get-url origin` of any clone (null: it has none). */
  origin: string | null;
  /** The number `gh issue create` gives the next issue. */
  nextIssue: number;
  /** The states `waveState` returns, in turn (the last one then repeats). */
  states: WaveView[];
  /** Where `volley repo add` clones it (`fleet.repo_root`). */
  repoRoot: string;
  /** An exit code for the command whose argv starts with this (a failure to inject). */
  fail?: { prefix: string; code: number; stderr: string };
  /** The wave ids `volleyd run` accepted: a second submit of one is refused, as the daemon does. */
  submitted: Set<string>;
}

export const HELLO_PR = "https://github.com/octo-volley/volley-hello-aaaa/pull/1";

/** A wave that runs one state, then completes with its PR merged. */
export const MERGING: WaveView[] = [
  { status: "running", tasks: [{ id: "T1", stage: "implement" }], open_decisions: [] },
  {
    status: "complete",
    tasks: [{ id: "T1", stage: "done", pr: { url: HELLO_PR, number: 1 } }],
    open_decisions: [],
  },
];

export function fakeMachine(
  fake: FakeDynsec,
  dir: string,
  opts: {
    platform?: NodeJS.Platform;
    repair?: boolean;
    lan?: boolean;
    /** The install (default brew-arm64); its files stay under `dir`. */
    layout?: LayoutName;
    uid?: number;
  } = {},
): FakeMachine {
  const layout: Layout = {
    ...LAYOUTS[opts.layout ?? "brew-arm64"],
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
    tailscale: {
      installed: false,
      state: "NoState",
      name: "studio.example.ts.net.",
      ips: ["100.64.0.2", "fd7a:115c:a1e0::2"],
      url: "https://login.tailscale.com/a/0123abcd",
      upCode: 0,
      serves: new Map(),
    },
    interfaces: {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [{ address: "192.0.2.10", family: "IPv4", internal: false }],
    },
    claude: { installed: true, signedIn: true, plan: "max" },
    gh: { installed: true, signedIn: true, login: "octo-volley" },
    typed: [],
    asked: [],
    claudeJson: join(home, ".claude.json"),
    firstWave: {
      owner: "octo-volley",
      origin: "https://github.com/octo-volley/existing.git",
      nextIssue: 7,
      states: [...MERGING],
      repoRoot: join(home, ".volley", "repos"),
      submitted: new Set(),
    },
    clock: NOW,
    sudo: { passwordless: true },
    loaded: new Set(),
    active: new Set(),
    settingsFile,
    deskDist,
    layout,
    auth,
    io: makeBufferIO({ now: () => new Date(NOW) }),
  } as unknown as FakeMachine;

  const volleydCli = join(repo, "packages", "volleyd", "src", "cli.ts");
  const volleyCli = join(repo, "packages", "volley-cli", "src", "cli.ts");
  const volleydPlist = join(home, "Library", "LaunchAgents", "systems.volley.volleyd.plist");
  const hooksInstall = join(repo, "packages", "volley-hooks", "scripts", "install.sh");

  const exec: SetupExec = async (argv, o) => {
    const a = [...argv];
    m.execCalls.push(a);
    m.execInputs.push(o?.input);
    m.execEnvs.push(o?.env);
    const line = a.join(" ");
    const fw = m.firstWave;
    if (fw.fail !== undefined && line.startsWith(fw.fail.prefix)) {
      return { code: fw.fail.code, stdout: "", stderr: fw.fail.stderr };
    }
    // The test wave: gh's repository and issue, git in the clone, volley repo, volleyd.
    if (a[0] === "gh" && a[1] === "repo" && a[2] === "create" && o?.cwd !== undefined) {
      mkdirSync(join(o.cwd, a[3] as string), { recursive: true });
      return ok(`https://github.com/${fw.owner}/${a[3]}\n`);
    }
    if (a[0] === "gh" && a[1] === "repo" && a[2] === "view" && o?.cwd !== undefined) {
      return ok(`${fw.owner}/${basename(o.cwd)}\n`);
    }
    if (a[0] === "gh" && a[1] === "issue" && a[2] === "create") {
      return ok(`https://github.com/${a[4]}/issues/${fw.nextIssue++}\n`);
    }
    if (a[0] === "git" && a[1] === "-C") {
      if (a[3] === "remote") {
        return fw.origin === null
          ? { code: 2, stdout: "", stderr: "error: No such remote 'origin'" }
          : ok(`${fw.origin}\n`);
      }
      return ok();
    }
    if (a[0] === "bun" && a[1] === volleyCli && a[2] === "repo") {
      const clone = join(fw.repoRoot, a[4] as string);
      if (a[3] === "add") {
        mkdirSync(join(clone, ".git"), { recursive: true });
        return ok(`Added ${a[4]} (private) to studio.\n  studio: ready (${clone})\n`);
      }
      return ok(
        JSON.stringify({
          repos: [
            { slug: a[4], machines: { studio: { state: "ready", path: clone, reasons: [] } } },
          ],
        }),
      );
    }
    if (a[0] === "bun" && a[1] === volleydCli && a[2] === "validate") return ok();
    // The broker steps as root (setup/escalate.ts): sudo's password, then the child run.
    const at = a.indexOf(volleyCli);
    if (a[0] === "sudo" && at > 0 && m.rootChild !== undefined) {
      if (a[1] === "-n" && !m.sudo.passwordless) {
        return { code: 1, stdout: "", stderr: "sudo: a password is required\n" };
      }
      return m.rootChild(a.slice(at + 1));
    }
    // Tailscale (setup/network.ts): the CLI on PATH, or the macOS app's, or `sudo` on Linux.
    const ts = a[0] === "sudo" ? a.slice(1) : a;
    if (ts[0] === "tailscale" || ts[0] === TAILSCALE_APP_CLI) {
      const t = m.tailscale;
      if (!t.installed) return { code: 127, stdout: "", stderr: `${ts[0]}: not found` };
      const sub = ts.slice(1).join(" ");
      if (sub === "version") return ok("1.76.1\n  tailscale commit: 0123456789\n");
      if (sub === "status --json") {
        return ok(
          JSON.stringify({
            BackendState: t.state,
            Self: t.state === "Running" ? { DNSName: t.name, TailscaleIPs: t.ips } : {},
          }),
        );
      }
      if (sub === "ip -4") return ok(`${t.ips[0]}\n`);
      // The Desk on the tailnet (setup/tailscale-serve.ts), as Tailscale 1.76 answers.
      const name = t.name.replace(/\.$/, "");
      if (sub === "serve status --json") {
        if (t.serves.size === 0) return ok("{}\n");
        return ok(
          JSON.stringify({
            TCP: Object.fromEntries([...t.serves.keys()].map((p) => [String(p), { HTTPS: true }])),
            Web: Object.fromEntries(
              [...t.serves].map(([p, proxy]) => [
                `${name}:${p}`,
                { Handlers: { "/": { Proxy: proxy } } },
              ]),
            ),
          }),
        );
      }
      const on = /^serve --bg --https=(\d+) (\S+)$/.exec(sub);
      if (on !== null) {
        t.serves.set(Number(on[1]), on[2] as string);
        return ok(
          `Available within your tailnet:\n\nhttps://${name}:${on[1]}/\n|-- proxy ${on[2]}\n`,
        );
      }
      const off = /^serve --https=(\d+) off$/.exec(sub);
      if (off !== null) {
        t.serves.delete(Number(off[1]));
        return ok();
      }
      if (sub === "up") {
        if (t.upCode === 0) t.state = "Running";
        return {
          code: t.upCode,
          stdout: "",
          stderr: `\nTo authenticate, visit:\n\n\t${t.url}\n\n`,
        };
      }
    }
    if (line === "brew install --cask tailscale") {
      m.tailscale.installed = true;
      m.tailscale.state = "NeedsLogin";
      return ok();
    }
    if (a[0] === "bun" && a[1] === volleydCli && a[2] === "run") {
      // The daemon takes a second submit of a wave id as a new version of that wave, which an
      // ended wave refuses: the step must give every run its own id.
      const id = /^wave: (\S+)$/m.exec(readText(a[3] as string) ?? "")?.[1] ?? "";
      if (fw.submitted.has(id)) {
        return {
          code: 1,
          stdout: "",
          stderr: `wave '${id}' is complete; a new version applies only to a live wave`,
        };
      }
      fw.submitted.add(id);
      return ok();
    }
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
      const at = a.indexOf("--broker-url");
      const merged = hooked(readText(settingsFile), at >= 0 ? a[at + 1] : undefined);
      if (a.includes("--dry-run")) return ok(merged);
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(settingsFile, merged);
      return ok(`installed volley-hooks into ${settingsFile}\n`);
    }
    const skill = SKILL_PKGS.find(
      (p) => a[0] === "bash" && a[1] === join(repo, "packages", p, "scripts", "install.sh"),
    );
    if (skill !== undefined) {
      // The skill installers: a link to the package; a folder of its own is backed up first.
      const target = join(home, ".claude", "skills", skill === "volley-skill" ? "volley" : skill);
      const pkg = join(repo, "packages", skill);
      mkdirSync(join(home, ".claude", "skills"), { recursive: true });
      let st: ReturnType<typeof lstatSync> | null = null;
      try {
        st = lstatSync(target);
      } catch {}
      if (st?.isSymbolicLink() === true && readlinkSync(target) === pkg) return ok("already\n");
      if (st?.isSymbolicLink() === true) rmSync(target);
      else if (st !== null) renameSync(target, `${target}.backup.20261018-120000`);
      symlinkSync(pkg, target);
      return ok(`installed ${target}\n`);
    }
    if (a[0] === "claude" && a[1] === "auth") {
      if (!m.claude.installed) return { code: 127, stdout: "", stderr: "not found" };
      if (a[2] === "status") {
        return m.claude.signedIn
          ? ok(`{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"${m.claude.plan}"}\n`)
          : { code: 1, stdout: '{"loggedIn":false}\n', stderr: "" };
      }
      if (a[2] === "login") {
        m.claude.signedIn = true;
        return ok();
      }
    }
    if (a[0] === "claude" && a[1] === "mcp") {
      const j = JSON.parse(readText(m.claudeJson) ?? "{}") as {
        mcpServers?: Record<string, unknown>;
      };
      if (a[2] === "add-json") {
        j.mcpServers = { ...(j.mcpServers ?? {}), [a[5] as string]: JSON.parse(a[6] as string) };
      } else if (a[2] === "remove") {
        delete j.mcpServers?.[a[5] as string];
      } else return ok();
      writeFileSync(m.claudeJson, `${JSON.stringify(j, null, 2)}\n`);
      return ok();
    }
    if (a[0] === "gh") {
      if (!m.gh.installed) return { code: 127, stdout: "", stderr: "not found" };
      if (a[1] === "auth" && a[2] === "status")
        return m.gh.signedIn ? ok() : { code: 1, stdout: "", stderr: "" };
      if (a[1] === "auth" && a[2] === "login") {
        m.gh.signedIn = true;
        return ok();
      }
      if (a[1] === "auth" && a[2] === "setup-git") {
        writeFileSync(join(home, ".gitconfig"), GH_GITCONFIG);
        return ok();
      }
      if (a[1] === "api" && a[2] === "user")
        return m.gh.signedIn ? ok(`${m.gh.login}\n`) : { code: 1, stdout: "", stderr: "" };
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
    ask: async (prompt) => {
      m.asked.push(prompt);
      return m.typed.shift() ?? null;
    },
    hostname: () => "Studio.local",
    askSecret: async (prompt) => {
      m.secretPrompts.push(prompt);
      return m.secrets.shift() ?? null;
    },
    sleep: async (ms) => {
      m.clock += ms;
    },
    now: () => m.clock,
    random: () => 0,
    // A wave volleyd was never given has no state.
    waveState: async (wave: string) =>
      !m.firstWave.submitted.has(wave)
        ? null
        : ((m.firstWave.states.length > 1 ? m.firstWave.states.shift() : m.firstWave.states[0]) ??
          null),
    platform: opts.platform ?? "darwin",
    uid: opts.uid ?? 501,
    lanHost: () => "desk.example",
    repoRoot: repo,
    bun: "bun",
    exists: (p) => (p === dir || p.startsWith(`${dir}/`) ? existsSync(p) : m.present.has(p)),
    interfaces: () => m.interfaces,
    resolveHost: async (host) => (host === "vpn.example.net" ? ["198.51.100.7"] : []),
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
  // Signed in to GitHub with git using that login: the sign-in step has nothing to sign in.
  writeFileSync(join(home, ".gitconfig"), GH_GITCONFIG);
  for (const p of SKILL_PKGS) mkdirSync(join(repo, "packages", p, "scripts"), { recursive: true });
  return m;
}

const SKILL_PKGS = ["volley-skill", "volley-issues", "volley-wait"];

export const readText = (p: string) => (existsSync(p) ? readFileSync(p, "utf-8") : null);
