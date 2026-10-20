import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { backupPath, writeConfig } from "../auth/config";
import { planCmux } from "./cmux";
import { DESK_STAMP, deskStamp, writeDeskStamp } from "./desk-build";
import { deskPortListeners, portConflict } from "./desk-port";
import { type LaunchdDeps, reloadLaunchd } from "./launchd";
import { stableServicePath } from "./service-path";
import type { Change, SetupContext, StepPlan } from "./step";
import { unifiedDiff } from "./step";

export { DESK_STAMP, deskStamp } from "./desk-build";

/**
 * Step 4 of `volley setup`: the `volley` and `volleyd` commands linked into ~/.volley/bin (on the
 * services' PATH: volleyd runs `volley auth` to redeem the Desk's sign-in links), volleyd as a
 * service (`volleyd install` on macOS, a systemd user unit on Linux), the Volley hooks for
 * coordinator sessions (volley-hooks' install.sh), and the built Desk served by
 * `volley desk serve` as a service, for the phone. On macOS it also checks that volleyd's
 * service can use cmux (cmux.ts), and it stops when another program has the Desk's port
 * (desk-port.ts).
 */

/** A long-running service setup installs. */
export interface ServiceSpec {
  /** systemd unit name (without `.service`). */
  name: string;
  /** launchd label. */
  label: string;
  description: string;
  args: string[];
  env: Record<string, string>;
  log: string;
  workdir: string;
}

export const DESK_LABEL = "systems.volley.desk";

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A launchd agent plist (RunAtLoad, KeepAlive), values XML-escaped. */
export function renderLaunchd(s: ServiceSpec): string {
  const env = Object.entries(s.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`volley setup\` (${xml(s.description)}). Rerun it rather than editing this file. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(s.label)}</string>
  <key>ProgramArguments</key>
  <array>
${s.args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(s.workdir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(s.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(s.log)}</string>
</dict>
</plist>
`;
}

/** systemd's quoting: a word with whitespace, quotes or a backslash goes in double quotes. */
const sdQuote = (s: string) =>
  /[\s"'\\]/.test(s) ? `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : s;

/** A systemd user unit (restarted on exit, started with the user's session). */
export function renderSystemd(s: ServiceSpec): string {
  return `# Written by \`volley setup\`. Rerun it rather than editing this file.
[Unit]
Description=${s.description}
After=network-online.target

[Service]
ExecStart=${s.args.map(sdQuote).join(" ")}
${Object.entries(s.env)
  .map(([k, v]) => `Environment="${`${k}=${v}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
  .join("\n")}
WorkingDirectory=${s.workdir}
Restart=always
RestartSec=10
StandardOutput=append:${s.log}
StandardError=append:${s.log}

[Install]
WantedBy=default.target
`;
}

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf-8") : "");

/** Write a unit file (backing a different one up first); returns the report lines. */
function writeUnit(ctx: SetupContext, path: string, text: string): string[] {
  mkdirSync(dirname(path), { recursive: true });
  const w = writeConfig(path, text, ctx.auth.io.now());
  return w.written
    ? [
        `Wrote ${path}.`,
        ...(w.backup !== null ? [`Backed the previous one up to ${w.backup}.`] : []),
      ]
    : [];
}

async function must(
  ctx: SetupContext,
  argv: string[],
  opts?: { cwd?: string; env?: Record<string, string | undefined> },
) {
  const r = await ctx.deps.exec(argv, opts);
  if (r.code !== 0) {
    throw new Error(
      `\`${argv.join(" ")}\` failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`,
    );
  }
  return r;
}

const systemdDir = (ctx: SetupContext) =>
  join(ctx.auth.env.XDG_CONFIG_HOME ?? join(ctx.home, ".config"), "systemd", "user");

/** A launchd agent from `spec`: write the plist when it differs, (re)load it when needed. */
async function launchdChange(
  ctx: SetupContext,
  spec: ServiceSpec,
  summary: string,
  found: string[],
): Promise<Change | null> {
  const path = join(ctx.home, "Library", "LaunchAgents", `${spec.label}.plist`);
  const text = renderLaunchd(spec);
  const current = read(path);
  const target = `gui/${ctx.deps.uid}/${spec.label}`;
  const loaded = (await ctx.deps.exec(["launchctl", "print", target])).code === 0;
  if (current === text && loaded) {
    found.push(`${spec.name}: installed and loaded (${path})`);
    return null;
  }
  return {
    summary,
    detail:
      current === text
        ? `launchctl bootstrap gui/${ctx.deps.uid} ${path} (installed, not loaded)`
        : unifiedDiff(path, current, text),
    apply: async () => {
      mkdirSync(spec.workdir, { recursive: true });
      const before = read(path);
      const out = writeUnit(ctx, path, text);
      const domain = `gui/${ctx.deps.uid}`;
      const d = launchdDeps(ctx);
      const r = await reloadLaunchd(d, domain, spec.label, path);
      if (r.ok) return [...out, `Loaded ${spec.label} (logs: ${spec.log}).`];
      // Never leave the service down: put the previous plist back and load that.
      if (before !== "" && before !== text) {
        writeFileSync(path, before);
        const back = await reloadLaunchd(d, domain, spec.label, path);
        throw new Error(
          back.ok
            ? `${r.error}. Restored the previous ${path} and loaded it again: ${spec.name} runs as before. Rerun \`volley setup --repair\`.`
            : `${r.error}. Restored the previous ${path}, but it did not load either (${back.error}): ${spec.name} is down. Load it by hand: launchctl bootstrap ${domain} ${path}`,
        );
      }
      throw new Error(
        `${r.error}. ${spec.name} is not loaded: load it by hand (launchctl bootstrap ${domain} ${path}), then rerun \`volley setup --repair\`.`,
      );
    },
  };
}

const launchdDeps = (ctx: SetupContext): LaunchdDeps => ({
  exec: (argv) => ctx.deps.exec(argv),
  sleep: (ms) => ctx.deps.sleep(ms),
});

/** A systemd user unit from `spec`: write it when it differs, enable and (re)start it. */
async function systemdChange(
  ctx: SetupContext,
  spec: ServiceSpec,
  summary: string,
  found: string[],
): Promise<Change | null> {
  const unit = `${spec.name}.service`;
  const path = join(systemdDir(ctx), unit);
  const text = renderSystemd(spec);
  const current = read(path);
  const active = (await ctx.deps.exec(["systemctl", "--user", "is-active", unit])).code === 0;
  if (current === text && active) {
    found.push(`${spec.name}: installed and active (${path})`);
    return null;
  }
  return {
    summary,
    detail:
      current === text
        ? `systemctl --user restart ${unit} (installed, not active)`
        : unifiedDiff(path, current, text),
    apply: async () => {
      mkdirSync(spec.workdir, { recursive: true });
      const out = writeUnit(ctx, path, text);
      await must(ctx, ["systemctl", "--user", "daemon-reload"]);
      await must(ctx, ["systemctl", "--user", "enable", unit]);
      await must(ctx, ["systemctl", "--user", "restart", unit]);
      return [
        ...out,
        `Enabled and started ${unit} (logs: ${spec.log}). To keep it running while you are logged out: loginctl enable-linger`,
      ];
    },
  };
}

/** Where setup links the `volley` and `volleyd` commands. */
export const binDir = (ctx: SetupContext) => join(ctx.home, ".volley", "bin");

/**
 * The services' PATH: the linked commands first, then a fixed list (`stableServicePath`), never
 * the invoking shell's whole PATH, so a rerun from another terminal changes nothing.
 */
export function servicePath(ctx: SetupContext): string {
  return stableServicePath({
    home: ctx.home,
    bun: ctx.deps.bun,
    tmpdir: ctx.auth.env.TMPDIR,
    ...(ctx.deps.exists !== undefined ? { exists: ctx.deps.exists } : {}),
  });
}

/**
 * The environment the services run with: where volleyd lives, which broker, the auth dir its
 * `volley auth` calls use (the one setup used, even when `--dir` / `--layout` chose it), a usable
 * PATH.
 */
function serviceEnv(ctx: SetupContext): Record<string, string> {
  return {
    VOLLEYD_HOME: ctx.volleydHome,
    VOLLEY_BROKER_URL: ctx.auth.url,
    VOLLEY_AUTH_DIR: ctx.auth.dir,
    VOLLEY_NAMESPACE: ctx.auth.env.VOLLEY_NAMESPACE ?? "default",
    PATH: servicePath(ctx),
  };
}

/** The first line after the shebang of a command script `volley setup` wrote. */
const SCRIPT_MARK = "# Written by `volley setup`";

const shQuote = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;

/**
 * The script setup installs as ~/.volley/bin/<name>: it runs `cli` with setup's own `bun` by its
 * full path, so it works on any PATH, a non-interactive ssh session's too (where `bun` usually
 * is not, and `#!/usr/bin/env bun` would fail).
 */
export function commandScript(bun: string, cli: string): string {
  return `#!/bin/sh
${SCRIPT_MARK}: this checkout's command, run with the bun setup found, so it works on any
# PATH (a non-interactive ssh session's too). Rerun \`volley setup --step services\` to update it.
exec ${shQuote(bun)} ${shQuote(cli)} "$@"
`;
}

type AtPath =
  | { kind: "script"; text: string; ours: boolean }
  | { kind: "link"; target: string }
  | { kind: "directory" }
  | null;

/** What is at a command's path: a file (setup's script or not), a symlink, a directory, nothing. */
function atPath(path: string): AtPath {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return { kind: "link", target: readlinkSync(path) };
    if (st.isDirectory()) return { kind: "directory" };
    const text = readFileSync(path, "utf-8");
    return { kind: "script", text, ours: text.split("\n")[1]?.startsWith(SCRIPT_MARK) === true };
  } catch {
    return null;
  }
}

/** `<path>.volley-backup-<timestamp>`, with `-1`, `-2`… when one from this second exists. */
function freeBackup(path: string, now: Date): string {
  const base = backupPath(path, now);
  let candidate = base;
  for (let i = 1; existsSync(candidate); i++) candidate = `${base}-${i}`;
  return candidate;
}

/**
 * `volley` and `volleyd` installed in ~/.volley/bin from this checkout. volleyd runs `volley auth`
 * by name (redeeming the Desk's sign-in links and admin tokens), so the services need it on their
 * PATH; a fresh machine has it nowhere else. `volleydService` is read when the change is applied:
 * the plan's change to volleyd's own service (null: none needed), or undefined where there is no
 * service manager.
 */
function commandsChange(
  ctx: SetupContext,
  repo: string,
  found: string[],
  volleydService: () => Change | null | undefined,
): Change | null {
  const bin = binDir(ctx);
  const commands: [string, string][] = [
    ["volley", commandScript(ctx.deps.bun, join(repo, "packages", "volley-cli", "src", "cli.ts"))],
    ["volleyd", commandScript(ctx.deps.bun, join(repo, "packages", "volleyd", "src", "cli.ts"))],
  ];
  const wrong = commands.filter(([name, text]) => {
    const at = atPath(join(bin, name));
    return !(at?.kind === "script" && at.text === text);
  });
  if (wrong.length === 0) {
    found.push(`volley, volleyd: installed in ${bin}`);
    return null;
  }
  const describe = (at: AtPath) =>
    at === null
      ? "nothing"
      : at.kind === "link"
        ? `a link to ${at.target}`
        : at.kind === "directory"
          ? "a directory; backed up first"
          : at.ours
            ? "volley setup's script for another checkout or bun"
            : "a file; backed up first";
  return {
    summary: `Install the volley and volleyd commands in ${bin} (volleyd runs \`volley auth\` to redeem the Desk's sign-in links)`,
    detail: wrong
      .map(([name]) => {
        const path = join(bin, name);
        return `${path}: runs this checkout's ${name} with ${ctx.deps.bun} (now: ${describe(atPath(path))})`;
      })
      .join("\n"),
    apply: async () => {
      mkdirSync(bin, { recursive: true });
      const lines: string[] = [];
      for (const [name, text] of wrong) {
        const path = join(bin, name);
        const at = atPath(path);
        if (at?.kind === "directory" || (at?.kind === "script" && !at.ours)) {
          // Never delete what someone put here (their own script, a directory): move it aside.
          const backup = freeBackup(path, ctx.auth.io.now());
          renameSync(path, backup);
          lines.push(
            `Moved ${path} aside to ${backup} (${at.kind === "directory" ? "a directory" : "a file"}).`,
          );
        } else if (at !== null) rmSync(path);
        writeFileSync(path, text, { mode: 0o755 });
      }
      const service = volleydService();
      return [
        ...lines,
        `Installed ${wrong.map(([name]) => name).join(" and ")} in ${bin} (scripts that run this checkout with ${ctx.deps.bun}).`,
        service === undefined
          ? `Run volleyd with ${bin} first on its PATH, or the Desk's sign-in links fail.`
          : service === null
            ? "volleyd already runs with it on its PATH: sign-in links work now."
            : `Sign-in links work once volleyd runs with it on its PATH: the change “${service.summary}” in this step does that (from a terminal, when the Desk lists it there).`,
        `To run them from your shell, add it to your PATH (in ~/.zshrc or ~/.bashrc): export PATH="${bin}:$PATH"`,
      ];
    },
  };
}

/** What the hooks change says about the user's own status line (install.sh chains it). */
const STATUS_LINE_NOTE =
  "Your Claude Code status line keeps working: Volley runs it after its own (same input, 2 s timeout).";

/** Vite's env files for a production build (gitignored: a developer's own). */
const VITE_ENV_FILES = [".env", ".env.local", ".env.production", ".env.production.local"];

/** The Desk's env files that set a broker URL or login, which Vite would inline into the page. */
export function deskEnvLeaks(deskDir: string): string[] {
  return VITE_ENV_FILES.filter((f) => {
    const text = read(join(deskDir, f));
    return /^\s*(export\s+)?VITE_VOLLEY_BROKER_\w*\s*=/m.test(text);
  });
}

/**
 * Why the Desk cannot have its port: another program listening on it (any address), or null.
 * The Desk's own service is no conflict. A probe that cannot tell says so in `found`.
 */
async function deskPortConflict(
  ctx: SetupContext,
  platform: NodeJS.Platform,
  found: string[],
): Promise<string | null> {
  const listeners = await deskPortListeners(ctx.deps.exec, ctx.deskPort);
  if (!Array.isArray(listeners)) {
    found.push(
      `Desk port ${ctx.deskPort}: could not check who listens on it (${listeners.cannotTell}). If http://localhost:${ctx.deskPort} does not reach the Desk, run \`volley setup --repair\` in a terminal`,
    );
    return null;
  }
  if (listeners.length === 0) return null;
  const own = await deskServicePid(ctx, platform);
  const others = listeners.filter((l) => l.pid === null || l.pid !== own);
  return others.length === 0 ? null : portConflict(ctx.deskPort, others);
}

/** The PID of the running Desk service, or null. */
async function deskServicePid(
  ctx: SetupContext,
  platform: NodeJS.Platform,
): Promise<number | null> {
  const r =
    platform === "darwin"
      ? await ctx.deps.exec(["launchctl", "print", `gui/${ctx.deps.uid}/${DESK_LABEL}`])
      : platform === "linux"
        ? await ctx.deps.exec([
            "systemctl",
            "--user",
            "show",
            "-p",
            "MainPID",
            "--value",
            "volley-desk.service",
          ])
        : null;
  if (r === null || r.code !== 0) return null;
  const pid = Number(
    platform === "darwin" ? /^\s*pid = (\d+)/m.exec(r.stdout)?.[1] : r.stdout.trim(),
  );
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export async function planServices(ctx: SetupContext): Promise<StepPlan> {
  const plan: StepPlan = { step: "services", title: "Services", found: [], changes: [] };
  const repo = ctx.deps.repoRoot;
  if (ctx.auth.deps.invokingUser(ctx.auth.env) !== null) {
    plan.skipped =
      "running as root, and the services and the Claude Code hooks belong to your user: run `volley setup --step services` as that user (without sudo) to install them";
    return plan;
  }
  if (repo === null) {
    plan.blocked = "cannot find this Volley checkout (no bun.lock above the CLI)";
    return plan;
  }
  const { platform, bun } = ctx.deps;
  const env = serviceEnv(ctx);
  const push = (c: Change | null) => {
    if (c !== null) plan.changes.push(c);
  };

  // volleyd's own service change in this plan (undefined: no service manager here), which the
  // commands change names when it is applied.
  let volleydService: Change | null | undefined;
  push(commandsChange(ctx, repo, plan.found, () => volleydService));

  // volleyd.
  const volleydCli = join(repo, "packages", "volleyd", "src", "cli.ts");
  if (platform === "darwin") {
    const install = [bun, volleydCli, "install", "--broker-url", ctx.auth.url];
    // `volleyd install` writes the PATH it runs with into the plist.
    const installEnv = { ...ctx.auth.env, PATH: env.PATH, VOLLEY_AUTH_DIR: ctx.auth.dir };
    const dry = await ctx.deps.exec([...install, "--dry-run"], { env: installEnv });
    if (dry.code !== 0) {
      plan.blocked = `\`volleyd install --dry-run\` failed (exit ${dry.code}): ${dry.stderr.trim()}`;
      return plan;
    }
    const [head, ...rest] = dry.stdout.split("\n");
    const path = (head ?? "").replace(/^# /, "");
    const text = rest.join("\n");
    const current = read(path);
    const loaded =
      (await ctx.deps.exec(["launchctl", "print", `gui/${ctx.deps.uid}/systems.volley.volleyd`]))
        .code === 0;
    volleydService = null;
    if (current === text && loaded) plan.found.push(`volleyd: installed and loaded (${path})`);
    else {
      volleydService = {
        summary: "Install volleyd as a launchd service (volleyd install)",
        detail: current === text ? "installed, not loaded" : unifiedDiff(path, current, text),
        apply: async () => {
          const r = await must(ctx, install, { env: installEnv });
          return [r.stdout.trim()];
        },
      };
      plan.changes.push(volleydService);
    }
  } else if (platform === "linux") {
    volleydService = await systemdChange(
      ctx,
      {
        name: "volleyd",
        label: "systems.volley.volleyd",
        description: "Volley wave supervisor (volleyd)",
        args: [bun, volleydCli, "daemon"],
        env,
        log: join(ctx.volleydHome, "volleyd.log"),
        workdir: ctx.volleydHome,
      },
      "Install volleyd as a systemd user service (volleyd.service)",
      plan.found,
    );
    push(volleydService);
  } else {
    plan.found.push(
      `no launchd or systemd here (${platform}): run \`volleyd daemon\` and \`volley desk serve --host 0.0.0.0\` yourself`,
    );
  }

  // cmux (macOS): volleyd's service must reach its socket to start local agents. Its change is
  // applied last: one only a terminal can make fails after every other change is in place.
  const cmux = await planCmux(ctx, env, plan.found);

  // The hooks, for coordinator sessions.
  const settings = ctx.auth.env.CLAUDE_SETTINGS ?? join(ctx.home, ".claude", "settings.json");
  const hooks = join(repo, "packages", "volley-hooks", "scripts", "install.sh");
  const hooksEnv = { ...ctx.auth.env, CLAUDE_SETTINGS: settings };
  const dry = await ctx.deps.exec(["bash", hooks, "--dry-run"], { env: hooksEnv });
  if (dry.code !== 0) {
    plan.blocked = `\`${hooks} --dry-run\` failed (exit ${dry.code}): ${dry.stderr.trim()}`;
    return plan;
  }
  const currentSettings = read(settings);
  if (dry.stdout === currentSettings) plan.found.push(`volley-hooks: installed in ${settings}`);
  else {
    plan.changes.push({
      summary: `Install the Volley hooks for coordinator sessions into ${settings}`,
      detail: `${STATUS_LINE_NOTE}\n${unifiedDiff(settings, currentSettings, dry.stdout)}`,
      apply: async () => {
        // install.sh backs the settings file up itself (<file>.bak-<timestamp>).
        const r = await must(ctx, ["bash", hooks], { env: hooksEnv });
        return [r.stdout.trim()];
      },
    });
  }

  // The Desk: built, rebuilt when its sources changed since, then served.
  const deskDir = join(repo, "packages", "volley-desk");
  const dist = join(deskDir, "dist");
  const stamp = deskStamp(repo);
  const built = existsSync(join(dist, "index.html"));
  const builtFrom = read(join(dist, DESK_STAMP)).trim();
  if (built && builtFrom === stamp) {
    plan.found.push(`The Desk is built from this checkout (${dist})`);
  } else {
    const leaks = deskEnvLeaks(deskDir);
    if (leaks.length > 0) {
      plan.blocked = `${leaks.map((f) => join(deskDir, f)).join(", ")} set${leaks.length === 1 ? "s" : ""} VITE_VOLLEY_BROKER_*: Vite would build that broker URL or login into the page served to your network. Remove those lines (or move the file aside) and rerun`;
      return plan;
    }
    plan.changes.push({
      summary: !built
        ? "Build the Desk (vite build in packages/volley-desk)"
        : builtFrom === ""
          ? "Rebuild the Desk (the build in packages/volley-desk/dist was not made by setup)"
          : `Rebuild the Desk (built from ${builtFrom}, the checkout is now ${stamp})`,
      detail: `cd ${deskDir} && ${bun} run build (no VITE_VOLLEY_BROKER_URL: the page uses port 9001 on the host it came from)`,
      apply: async () => {
        // Vite inlines VITE_* into the bundle: never a broker URL or a dev login.
        const {
          VITE_VOLLEY_BROKER_URL: _u,
          VITE_VOLLEY_BROKER_USERNAME: _n,
          VITE_VOLLEY_BROKER_PASSWORD: _p,
          ...buildEnv
        } = ctx.auth.env;
        await must(ctx, [bun, "run", "build"], { cwd: deskDir, env: buildEnv });
        writeDeskStamp(dist, stamp);
        return [`Built the Desk into ${dist} (${stamp}).`];
      },
    });
  }
  const desk: ServiceSpec = {
    name: "volley-desk",
    label: DESK_LABEL,
    description: "Volley Desk static server (volley desk serve)",
    args: [
      bun,
      join(repo, "packages", "volley-cli", "src", "cli.ts"),
      "desk",
      "serve",
      "--host",
      "0.0.0.0",
      "--port",
      String(ctx.deskPort),
    ],
    env: { PATH: env.PATH as string },
    log: join(ctx.volleydHome, "desk.log"),
    workdir: ctx.volleydHome,
  };
  const on = `0.0.0.0:${ctx.deskPort}`;
  const conflict = await deskPortConflict(ctx, platform, plan.found);
  if (conflict !== null) {
    plan.blocked = conflict;
    return plan;
  }
  if (platform === "darwin") {
    push(
      await launchdChange(
        ctx,
        desk,
        `Install \`volley desk serve\` as a launchd service on ${on}`,
        plan.found,
      ),
    );
  } else if (platform === "linux") {
    push(
      await systemdChange(
        ctx,
        desk,
        `Install \`volley desk serve\` as a systemd user service (volley-desk.service) on ${on}`,
        plan.found,
      ),
    );
  }
  push(cmux);
  // After the changes every service must be in place: planning again must find nothing to do.
  plan.verify = async () => {
    const again = await planServices(ctx);
    return [
      ...(again.blocked !== undefined ? [again.blocked] : []),
      ...again.changes.map((c) => `still not in place: ${c.summary}`),
    ];
  };
  return plan;
}
