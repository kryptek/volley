import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { writeConfig } from "../auth/config";
import type { Change, SetupContext, StepPlan } from "./step";
import { unifiedDiff } from "./step";

/**
 * Step 4 of `volley setup`: volleyd as a service (`volleyd install` on macOS, a systemd user
 * unit on Linux), the Volley hooks for coordinator sessions (volley-hooks' install.sh), and the
 * built Desk served by `volley desk serve` as a service, for the phone.
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
      const out = writeUnit(ctx, path, text);
      await ctx.deps.exec(["launchctl", "bootout", target]); // not loaded is fine
      await must(ctx, ["launchctl", "bootstrap", `gui/${ctx.deps.uid}`, path]);
      return [...out, `Loaded ${spec.label} (logs: ${spec.log}).`];
    },
  };
}

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

/** The environment the services run with: where volleyd lives, which broker, a usable PATH. */
function serviceEnv(ctx: SetupContext): Record<string, string> {
  const env = ctx.auth.env;
  return {
    VOLLEYD_HOME: ctx.volleydHome,
    VOLLEY_BROKER_URL: ctx.auth.url,
    VOLLEY_NAMESPACE: env.VOLLEY_NAMESPACE ?? "default",
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  };
}

/** Where a Desk build records what it was built from (`deskStamp` of its checkout). */
export const DESK_STAMP = ".volley-build";

/** The Desk's sources a build depends on, besides bun.lock at the repo root. */
const DESK_INPUTS = [
  "src",
  "public",
  "index.html",
  "package.json",
  "vite.config.ts",
  "tsconfig.json",
];

/**
 * A hash of the Desk's sources and the lockfile: a build whose recorded stamp differs is stale
 * (an update since, or a build made outside setup).
 */
export function deskStamp(repo: string): string {
  const desk = join(repo, "packages", "volley-desk");
  const files: string[] = [];
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) {
      for (const e of readdirSync(p).sort()) walk(join(p, e));
    } else files.push(p);
  };
  for (const i of DESK_INPUTS) walk(join(desk, i));
  files.push(join(repo, "bun.lock"));
  const h = createHash("sha256");
  for (const f of files) {
    h.update(`${relative(repo, f)}\0`);
    h.update(existsSync(f) ? readFileSync(f) : "");
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

/** Vite's env files for a production build (gitignored: a developer's own). */
const VITE_ENV_FILES = [".env", ".env.local", ".env.production", ".env.production.local"];

/** The Desk's env files that set a broker URL or login, which Vite would inline into the page. */
export function deskEnvLeaks(deskDir: string): string[] {
  return VITE_ENV_FILES.filter((f) => {
    const text = read(join(deskDir, f));
    return /^\s*(export\s+)?VITE_VOLLEY_BROKER_\w*\s*=/m.test(text);
  });
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

  // volleyd.
  const volleydCli = join(repo, "packages", "volleyd", "src", "cli.ts");
  if (platform === "darwin") {
    const install = [bun, volleydCli, "install", "--broker-url", ctx.auth.url];
    const dry = await ctx.deps.exec([...install, "--dry-run"]);
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
    if (current === text && loaded) plan.found.push(`volleyd: installed and loaded (${path})`);
    else {
      plan.changes.push({
        summary: "Install volleyd as a launchd service (volleyd install)",
        detail: current === text ? "installed, not loaded" : unifiedDiff(path, current, text),
        apply: async () => {
          const r = await must(ctx, install);
          return [r.stdout.trim()];
        },
      });
    }
  } else if (platform === "linux") {
    push(
      await systemdChange(
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
      ),
    );
  } else {
    plan.found.push(
      `no launchd or systemd here (${platform}): run \`volleyd daemon\` and \`volley desk serve --host 0.0.0.0\` yourself`,
    );
  }

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
      detail: unifiedDiff(settings, currentSettings, dry.stdout),
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
        writeFileSync(join(dist, DESK_STAMP), `${stamp}\n`);
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
  // After the changes every service must be in place: planning again must find nothing to do.
  plan.verify = async () =>
    (await planServices(ctx)).changes.map((c) => `still not in place: ${c.summary}`);
  return plan;
}
