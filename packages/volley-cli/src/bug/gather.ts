import { join, resolve } from "node:path";
import { volleydHome } from "../auth/context";
import { whereAmI } from "../supervisor/probes";

/**
 * What `volley bug` gathers: the version and install method, `volley setup --check`, `volley peer
 * doctor`, `volleyd status`, the tools' versions, the wave's last journal events, its newest wave
 * file and the service logs. Every probe runs through the injected exec under its own timeout,
 * and a failure is one line in its section, never the end of the report: a report is most
 * wanted on a machine where things fail. Nothing here changes the machine or needs the daemon,
 * the broker or sudo. Credential files are never opened (`NEVER_READ`).
 */

export interface BugExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type BugExec = (argv: string[], opts?: { timeoutMs?: number }) => Promise<BugExecResult>;

/** Everything `volley bug` touches, injectable for tests (the shape of `PeerDeps`). */
export interface BugDeps {
  exec: BugExec;
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  arch: string;
  now: () => Date;
  /** A file's text (at most its last few MB), or null when it cannot be read. */
  readFile: (path: string) => string | null;
  listDir: (path: string) => string[] | null;
  mtimeMs: (path: string) => number | null;
  isTTY: boolean;
  hostname: () => string;
  username: () => string;
  /** The directory this CLI's source runs from (`packages/volley-cli/src`). */
  cliDir: string;
  version: string;
  /** How to run this CLI and volleyd (`[bun, <checkout>/packages/…/cli.ts]`). */
  volley: string[];
  volleyd: string[];
}

export const BUG_DEFAULTS = {
  exec_timeout_ms: 20_000,
  events: 40,
  lines: 80,
  system_events: 10,
  /** A probe's output past this many characters is cut (a wave's status JSON can be huge). */
  section_max: 12_000,
  url_max: 6_000,
  body_max: 65_536,
} as const;

/**
 * Files `volley bug` never opens: an agent's identity, the auth dir and every login in it, the
 * broker's Dynamic Security state, volleyd's own logins and any screen capture. The read helper
 * refuses them too, so a later section cannot add one by accident.
 */
export const NEVER_READ: readonly RegExp[] = [
  /(^|\/)\.volley\/agent\.json$/,
  /(^|\/)auth(\/|$)/,
  /(^|\/)(coordinator|admin|accounts|tokens)\.json$/,
  /(^|\/)dynamic-security\.json$/,
  /(^|\/)(broker|dynsec-admin)\.json$/,
  /(^|\/)screens(\/|$)/,
];

export type InstallMethod = "installer" | "homebrew" | "clone";

/** How Volley was installed, read from where this CLI runs. */
export function installMethodOf(cliDir: string, home: string): InstallMethod {
  if (cliDir.startsWith(`${join(home, ".volley", "src")}/`)) return "installer";
  if (cliDir.includes("/Cellar/volley/") || cliDir.includes("/opt/volley/libexec/")) {
    return "homebrew";
  }
  return "clone";
}

/** The last `n` lines of `text` (a torn last line kept as it is; the trailing newline dropped). */
export function tailLines(text: string, n: number): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return n <= 0 ? [] : lines.slice(-n);
}

/** The wave whose `journal.jsonl` is newest under `wavesDir` (`_system` excluded), or null. */
export function newestWave(deps: Pick<BugDeps, "listDir" | "mtimeMs">, wavesDir: string) {
  let best: { wave: string; at: number } | null = null;
  for (const wave of deps.listDir(wavesDir) ?? []) {
    if (wave === "_system") continue;
    const at = deps.mtimeMs(join(wavesDir, wave, "journal.jsonl"));
    if (at !== null && (best === null || at > best.at)) best = { wave, at };
  }
  return best?.wave ?? null;
}

export interface Section {
  id: string;
  title: string;
  /** Trimmed first when the report is too long: logs, then the journal. */
  kind: "info" | "journal" | "log";
  body: string;
  /** Fenced as this language (`json`, `yaml`, …); absent: plain text. */
  lang?: string;
}

export interface Gathered {
  header: string;
  sections: Section[];
  wave: string | null;
  version: string;
  /** For the title and the browser page's summary: the first blocked setup step or failing check. */
  firstFailure: string | null;
  failures: string[];
  ghSignedIn: boolean;
  /** What the redaction needs that the probes found. */
  identity: { ghLogin: string | null; gitNames: string[]; repos: string[]; hosts: string[] };
}

const na = (why: string) => `(not available: ${why})`;

function why(r: BugExecResult): string {
  if (r.timedOut === true) return `timed out after ${BUG_DEFAULTS.exec_timeout_ms / 1000} s`;
  const first = (r.stderr || r.stdout).trim().split("\n")[0] ?? "";
  return r.code === 127 ? "exit 127" : `exit ${r.code}${first !== "" ? `: ${first}` : ""}`;
}

async function run(deps: BugDeps, argv: string[]): Promise<BugExecResult> {
  try {
    return await deps.exec(argv, { timeoutMs: BUG_DEFAULTS.exec_timeout_ms });
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

/** `deps.readFile`, refusing every path `NEVER_READ` names. */
function read(deps: BugDeps, path: string): string | null {
  if (NEVER_READ.some((re) => re.test(path))) return null;
  return deps.readFile(path);
}

function jsonOf(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const SLUG_RE =
  /(?:repo:\s*|"(?:repo|slug)"\s*:\s*"|github\.com[/:]|-\s+)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?=\s|$|["',])/gm;

/** Repository slugs named in `text` (wave files, config.yaml, the doctor's output). */
export function slugsIn(text: string): string[] {
  return [...text.matchAll(SLUG_RE)].map((m) => m[1] as string).filter((s) => !s.startsWith("."));
}

const HOST_RE = /"(?:host|hostname|machine)"\s*:\s*"([^"\s]+)"|\bmachine:\s*([A-Za-z0-9][\w.-]*)/g;

/** Machine names in `text` (`"host"`, `"hostname"`, `"machine"` fields): other machines' names. */
export function hostsIn(text: string): string[] {
  return [...text.matchAll(HOST_RE)]
    .map((m) => (m[1] ?? m[2]) as string)
    .filter((h) => !/^(localhost|127\.|0\.0\.0\.0|::1?$)/.test(h) && !h.includes("/"));
}

/** This OS and version: `macOS 15.6`, `Ubuntu 24.04.1 LTS`, else the platform. */
async function osName(deps: BugDeps): Promise<string> {
  if (deps.platform === "darwin") {
    const r = await run(deps, ["sw_vers", "-productVersion"]);
    return r.code === 0 ? `macOS ${r.stdout.trim()}` : "macOS";
  }
  const pretty = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(read(deps, "/etc/os-release") ?? "");
  return pretty?.[1] ?? deps.platform;
}

/** Gather every section of the report (none of it redacted yet: `redactReport` does that last). */
export async function gatherReport(
  deps: BugDeps,
  opts: { wave?: string; events: number; lines: number },
): Promise<Gathered> {
  const vhome = volleydHome(deps.env, deps.home);
  const checkout = resolve(deps.cliDir, "..", "..", "..");
  const sections: Section[] = [];
  const failures: string[] = [];
  const repos: string[] = [];

  // The install, and the tools.
  const method = installMethodOf(deps.cliDir, deps.home);
  const describe =
    method === "homebrew"
      ? null
      : await run(deps, ["git", "-C", checkout, "describe", "--tags", "--always", "--dirty"]);
  const described = describe !== null && describe.code === 0 ? describe.stdout.trim() : null;
  const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";
  const tools: [string, string[], (r: BugExecResult) => string | null][] = [
    ["bun", ["bun", "--version"], (r) => (r.code === 0 ? firstLine(r.stdout) : null)],
    ["tmux", ["tmux", "-V"], (r) => (r.code === 0 ? firstLine(r.stdout) : null)],
    ["gh", ["gh", "--version"], (r) => (r.code === 0 ? firstLine(r.stdout) : null)],
    ["claude", ["claude", "--version"], (r) => (r.code === 0 ? firstLine(r.stdout) : null)],
    [
      "mosquitto",
      ["mosquitto", "-h"],
      // `mosquitto -h` exits non-zero by design; its first line names the version.
      (r) => /mosquitto version \S+/i.exec(`${r.stdout}\n${r.stderr}`)?.[0] ?? null,
    ],
  ];
  const toolLines: string[] = [];
  const versions: Record<string, string | null> = {};
  for (const [name, argv, pick] of tools) {
    const r = await run(deps, argv);
    let v = pick(r);
    if (v === null && name === "mosquitto" && deps.platform === "linux") {
      const snap = await run(deps, ["snap", "list", "mosquitto"]);
      v = snap.code === 0 ? firstLine(snap.stdout.split("\n").slice(1).join("\n")) || null : null;
    }
    versions[name] = v;
    toolLines.push(`${name}: ${v ?? na(why(r))}`);
  }
  toolLines.push(
    `checkout: ${method}${described !== null ? ` (${described})` : describe !== null ? ` ${na(why(describe))}` : ""}`,
  );
  const gh = await run(deps, ["gh", "auth", "status"]);
  const ghLogin = /account (\S+)/.exec(`${gh.stdout}\n${gh.stderr}`)?.[1] ?? null;
  const ghSignedIn = gh.code === 0;
  toolLines.push(`gh sign-in: ${ghSignedIn ? "signed in" : "not signed in"}`);
  const gitName = await run(deps, ["git", "config", "--get", "user.name"]);
  const gitNames =
    gitName.code === 0 && gitName.stdout.trim() !== "" ? [gitName.stdout.trim()] : [];
  sections.push({ id: "tools", title: "Tools", kind: "info", body: toolLines.join("\n") });

  // setup.json: the layout, network kind, terminal and Desk port; nothing else of it.
  const setup = jsonOf(read(deps, join(vhome, "setup.json")));
  const network = (setup.network ?? {}) as Record<string, unknown>;
  const setupLines = [
    ["layout", setup.layout],
    ["network", network.kind],
    ["local_terminal", setup.terminal ?? setup.local_terminal],
    ["desk_port", setup.desk_port],
  ]
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .map(([k, v]) => `${k}: ${v}`);
  // peer.json: its machine name and remote_port only.
  const peer = jsonOf(read(deps, join(deps.home, ".volley", "peer.json")));
  if (typeof peer.name === "string") setupLines.push(`paired machine: ${peer.name}`);
  if (typeof peer.remote_port === "number") setupLines.push(`remote_port: ${peer.remote_port}`);
  sections.push({
    id: "setup",
    title: "setup.json",
    kind: "info",
    body: setupLines.length > 0 ? setupLines.join("\n") : na("no setup.json"),
  });
  const config = read(deps, join(vhome, "config.yaml"));
  if (config !== null) repos.push(...slugsIn(config));

  // The probes: each its own section; a failure is the section's one line.
  const probe = async (id: string, title: string, argv: string[], lang?: string) => {
    const r = await run(deps, argv);
    const body =
      r.code === 0
        ? r.stdout.trim()
        : r.code === 69
          ? // The unreachable-supervisor diagnosis is itself the finding.
            (r.stderr || r.stdout).trim()
          : r.stdout.trim() !== "" && lang === "json"
            ? `${r.stdout.trim()}\n(exit ${r.code})`
            : na(why(r));
    const capped =
      body.length > BUG_DEFAULTS.section_max
        ? `${body.slice(0, BUG_DEFAULTS.section_max)}\n… cut at ${BUG_DEFAULTS.section_max} characters (of ${body.length})`
        : body;
    sections.push({
      id,
      title,
      kind: "info",
      body: capped,
      ...(lang !== undefined ? { lang } : {}),
    });
    return r;
  };
  const check = await probe(
    "setup-check",
    "volley setup --check",
    [...deps.volley, "setup", "--check", "--json"],
    "json",
  );
  try {
    const rows = (JSON.parse(check.stdout) as { steps?: { name: string; status: string }[] }).steps;
    for (const s of rows ?? []) {
      if (s.status === "blocked" || s.status === "pending")
        failures.push(`setup step ${s.name} ${s.status}`);
    }
  } catch {}
  const doctor = await probe(
    "doctor",
    "volley peer doctor",
    [...deps.volley, "peer", "doctor", "--json"],
    "json",
  );
  try {
    const d = JSON.parse(doctor.stdout) as {
      checks?: { id: string; ok: boolean; repo?: string }[];
    };
    for (const c of d.checks ?? []) {
      if (!c.ok) failures.push(`doctor check ${c.id} failing`);
      if (typeof c.repo === "string") repos.push(c.repo);
    }
  } catch {}
  repos.push(...slugsIn(doctor.stdout));
  await probe("status", "volleyd status", [...deps.volleyd, "status", "--json"], "json");

  // The wave: its journal's last events, _system's, its newest wave file.
  const waves = join(vhome, "waves");
  const wave = opts.wave ?? newestWave(deps, waves);
  if (wave !== null) {
    await probe(
      "status-wave",
      `volleyd status ${wave}`,
      [...deps.volleyd, "status", wave, "--json"],
      "json",
    );
    const journal = read(deps, join(waves, wave, "journal.jsonl"));
    if (journal !== null) repos.push(...slugsIn(tailLines(journal, opts.events).join("\n")));
    sections.push({
      id: "journal",
      title: `Journal: ${wave} (last ${opts.events} events)`,
      kind: "journal",
      body: journal === null ? na("no journal.jsonl") : tailLines(journal, opts.events).join("\n"),
      lang: "jsonl",
    });
    const files = (deps.listDir(join(waves, wave)) ?? [])
      .map((f) => ({ f, n: /^v(\d+)\.yaml$/.exec(f)?.[1] }))
      .filter((x): x is { f: string; n: string } => x.n !== undefined)
      .sort((a, b) => Number(b.n) - Number(a.n));
    const newest = files[0];
    const waveFile = newest !== undefined ? read(deps, join(waves, wave, newest.f)) : null;
    if (waveFile !== null) repos.push(...slugsIn(waveFile));
    sections.push({
      id: "wave-file",
      title: `Wave file: ${wave}${newest !== undefined ? `/${newest.f}` : ""}`,
      kind: "info",
      body: waveFile?.trim() ?? na("no wave file"),
      lang: "yaml",
    });
    sections.push({
      id: "screens",
      title: "Screen captures",
      kind: "info",
      body: `Not included: ${join(waves, wave, "screens")} holds each agent's last screen. Read one, then attach it to the issue if it helps.`,
    });
  }
  const system = read(deps, join(waves, "_system", "journal.jsonl"));
  if (system !== null) {
    repos.push(...slugsIn(tailLines(system, BUG_DEFAULTS.system_events).join("\n")));
  }
  sections.push({
    id: "journal-system",
    title: `Journal: _system (last ${BUG_DEFAULTS.system_events} events)`,
    kind: "journal",
    body:
      system === null
        ? na("no journal.jsonl")
        : tailLines(system, BUG_DEFAULTS.system_events).join("\n"),
    lang: "jsonl",
  });

  // The logs.
  for (const [id, title, path] of [
    ["log-volleyd", "volleyd.log", join(vhome, "volleyd.log")],
    ["log-desk", "desk.log", join(vhome, "desk.log")],
    ["log-peer", "peer.log", join(deps.home, ".volley", "peer.log")],
    ["log-setup", "setup.log", join(vhome, "setup.log")],
  ] as const) {
    const text = read(deps, path);
    sections.push({
      id,
      title: `${title} (last ${opts.lines} lines)`,
      kind: "log",
      body: text === null ? na("no such file") : tailLines(text, opts.lines).join("\n"),
    });
  }

  // The header line.
  const where = whereAmI(deps.home, deps.env, "");
  const header = [
    `volley ${deps.version}`,
    `${method}${described !== null ? ` (${described})` : ""}`,
    `${await osName(deps)} ${deps.arch}`,
    `bun ${versions.bun ?? "?"}`,
    `layout ${typeof setup.layout === "string" ? setup.layout : "?"}`,
    `network ${typeof network.kind === "string" ? network.kind : "?"}`,
    `this machine: ${where.kind}`,
  ].join(" · ");

  return {
    header,
    sections,
    wave,
    version: deps.version,
    firstFailure: failures[0] ?? null,
    failures,
    ghSignedIn,
    identity: {
      ghLogin,
      gitNames,
      repos: [...new Set(repos)],
      hosts: [...new Set(sections.flatMap((x) => hostsIn(x.body)))],
    },
  };
}
