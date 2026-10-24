import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  LAUNCHD_LABEL,
  PEER_DEFAULTS,
  SYSTEMD_UNIT,
  type ServiceDeps,
  installService,
  launchdPlist,
  peerFile,
  serviceFile,
  systemdUnit,
} from "../commands/peer";
import { isLoaded } from "./launchd";
import { servicePath } from "./service-path";
import type { SetupContext, StepPlan } from "./step";

/**
 * `volley setup --peer`'s service step: `volley peer run` (the tunnel and the machine's
 * heartbeat) as the user service, in place of volleyd, written by the same unit writers
 * `volley peer join` uses. Before the pairing there is nothing to run (`peer run` needs
 * `~/.volley/peer.json`): the step is skipped, and join installs the service. A rerun finds the
 * unit as it would write it, and loaded, and changes nothing.
 */

/** The tunnel's URL on this machine: what the hooks of its Claude profile name. */
export function peerBrokerUrl(home: string): string {
  let port: number = PEER_DEFAULTS.remote_port;
  try {
    const cfg = JSON.parse(readFileSync(peerFile(home), "utf-8")) as { remote_port?: unknown };
    if (typeof cfg.remote_port === "number") port = cfg.remote_port;
  } catch {}
  return `mqtt://127.0.0.1:${port}`;
}

/** The argv of `volley peer run` from this checkout. */
const runArgv = (ctx: SetupContext, repo: string) => [
  ctx.deps.bun,
  join(repo, "packages", "volley-cli", "src", "cli.ts"),
  "peer",
  "run",
];

function serviceDeps(ctx: SetupContext, repo: string, user: string): ServiceDeps {
  return {
    exec: (argv) => ctx.deps.exec(argv),
    home: ctx.home,
    platform: ctx.deps.platform,
    user: () => user,
    uid: () => ctx.deps.uid,
    sleep: (ms) => ctx.deps.sleep(ms),
    envPath: () => servicePath(ctx),
    // `installService` appends `peer run`.
    volleyArgv: runArgv(ctx, repo).slice(0, 2),
  };
}

export async function planPeerService(ctx: SetupContext): Promise<StepPlan> {
  const plan: StepPlan = { step: "peer-service", title: "Peer service", found: [], changes: [] };
  if (ctx.auth.deps.invokingUser(ctx.auth.env) !== null) {
    plan.skipped =
      "running as root, and the service is your user's: run `volley setup --peer --step peer-service` as that user (without sudo)";
    return plan;
  }
  const repo = ctx.deps.repoRoot;
  if (repo === null) {
    plan.blocked =
      "no Volley checkout found (bun.lock's directory): run `volley setup --peer` from the checkout `install.sh --peer` made";
    return plan;
  }
  const platform = ctx.deps.platform;
  const file = serviceFile(platform, ctx.home);
  if (file === null) {
    plan.blocked = `no service manager for ${platform}: run \`volley peer run\` yourself`;
    return plan;
  }
  if (!existsSync(peerFile(ctx.home))) {
    plan.skipped =
      "not paired yet: `volley peer join <code> --to <host>` installs `volley peer run` as the service";
    plan.row = "not paired yet";
    return plan;
  }
  const argv = runArgv(ctx, repo);
  const want =
    platform === "linux"
      ? systemdUnit(argv, servicePath(ctx))
      : launchdPlist(argv, join(ctx.home, ".volley", "peer.log"), servicePath(ctx));
  let have: string | null = null;
  try {
    have = readFileSync(file, "utf-8");
  } catch {}
  const running =
    platform === "linux"
      ? (await ctx.deps.exec(["systemctl", "--user", "is-active", SYSTEMD_UNIT])).code === 0
      : await (async () => {
          const ld = { exec: (a: string[]) => ctx.deps.exec(a), sleep: ctx.deps.sleep };
          for (const d of [`gui/${ctx.deps.uid}`, `user/${ctx.deps.uid}`]) {
            if (await isLoaded(ld, `${d}/${LAUNCHD_LABEL}`)) return true;
          }
          return false;
        })();
  if (have === want && running) {
    plan.found.push(`\`volley peer run\` runs as the service (${file})`);
    plan.row = "✓ volley peer run is the service";
    return plan;
  }
  const why = have === null ? "not installed" : have !== want ? "differs" : "not running";
  plan.row = `volley peer run: ${why}`;
  const user = ctx.auth.env.USER ?? ctx.auth.env.LOGNAME ?? userInfo().username;
  plan.changes.push({
    summary: `Install \`volley peer run\` as the service (${file}: ${why})`,
    detail: `Runs ${argv.join(" ")}: the tunnel and this machine's heartbeat.`,
    apply: async () => {
      const r = await installService(serviceDeps(ctx, repo, user));
      if (!r.ok) throw new Error(r.error);
      return [`Installed: ${r.what}.`, ...(r.warning !== undefined ? [r.warning] : [])];
    },
  });
  plan.verify = async () => {
    const again = await planPeerService({ ...ctx, check: true });
    return again.changes.map((c) => `still not in place: ${c.summary}`);
  };
  return plan;
}
