import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { type NetworkRecord, readNetworkRecord, recordNetwork } from "./journal";
import type { Change, SetupContext, StepPlan } from "./step";

/**
 * The Network step of `volley setup` (and `--peer`): how this machine is reached from outside its
 * own network. `tailscale` (the default when asked): Tailscale installed and signed in, its
 * MagicDNS name and tailnet IPv4 address recorded. `manual`: the person's own VPN, whose address
 * for this machine must be one of its interfaces'. `none`: this network only. The record goes to
 * setup.json's `network` (and from there into the machine record). Nothing here binds a listener,
 * and Volley never runs `tailscale funnel` or `tailscale serve`: nothing is exposed publicly.
 */

export const NETWORK_KINDS = ["tailscale", "manual", "none"] as const;
export type NetworkKind = (typeof NETWORK_KINDS)[number];

export const isNetworkKind = (v: unknown): v is NetworkKind =>
  typeof v === "string" && (NETWORK_KINDS as readonly string[]).includes(v);

/** The question the step asks when neither `--network` nor a record decides. */
export const NETWORK_QUESTION =
  "Reach this machine from outside this network? [Tailscale (recommended) / my own VPN / no]";
const ADDRESS_QUESTION = "The address your VPN gives this machine (host or IP): ";

/** Where the macOS app (App Store or `brew install --cask tailscale`) keeps its CLI. */
export const TAILSCALE_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/** Tailscale's own installer, which adds its package repository for the distribution (sudo). */
export const TAILSCALE_LINUX_INSTALL = "curl -fsSL https://tailscale.com/install.sh | sh";

export const BREW_TAILSCALE = ["brew", "install", "--cask", "tailscale"] as const;

/** The Tailscale subcommands setup runs, exactly: never `funnel`, `serve`, or an `up` flag. */
const TAILSCALE_ARGS = [["version"], ["status", "--json"], ["ip", "-4"], ["up"]];

/**
 * Whether `argv` is one of the Tailscale commands setup runs: `tailscale` (on PATH) or the macOS
 * app's CLI with exactly one of `TAILSCALE_ARGS`, or `brew install --cask tailscale`; with
 * `sudo`, also `sudo tailscale up` (Linux: the sign-in needs root).
 */
export function isTailscaleCommand(argv: readonly string[], opts: { sudo: boolean }): boolean {
  if (argv.length === BREW_TAILSCALE.length && BREW_TAILSCALE.every((w, i) => argv[i] === w)) {
    return true;
  }
  const sudo = argv[0] === "sudo";
  if (sudo && !opts.sudo) return false;
  const [bin, ...rest] = sudo ? argv.slice(1) : argv;
  if (bin !== "tailscale" && bin !== TAILSCALE_APP_CLI) return false;
  if (sudo) return rest.length === 1 && rest[0] === "up";
  return TAILSCALE_ARGS.some((w) => w.length === rest.length && w.every((x, i) => rest[i] === x));
}

export interface TailscaleStatus {
  /** `BackendState`: Running, NeedsLogin, Stopped, NoState… */
  state: string;
  running: boolean;
  /** `Self.DNSName` without its trailing dot (the MagicDNS name). */
  name: string | null;
  /** The first IPv4 address of `Self.TailscaleIPs`. */
  address: string | null;
}

/** `tailscale status --json`, read; null when it is not status JSON. */
export function parseTailscaleStatus(stdout: string): TailscaleStatus | null {
  let j: unknown;
  try {
    j = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return null;
  const s = j as { BackendState?: unknown; Self?: unknown };
  if (typeof s.BackendState !== "string") return null;
  const self = (typeof s.Self === "object" && s.Self !== null ? s.Self : {}) as {
    DNSName?: unknown;
    TailscaleIPs?: unknown;
  };
  const dns =
    typeof self.DNSName === "string" && self.DNSName !== "" ? self.DNSName.replace(/\.$/, "") : "";
  const ips = Array.isArray(self.TailscaleIPs)
    ? self.TailscaleIPs.filter((ip): ip is string => typeof ip === "string")
    : [];
  return {
    state: s.BackendState,
    running: s.BackendState === "Running",
    name: dns !== "" ? dns : null,
    address: ips.find((ip) => isIP(ip) === 4) ?? null,
  };
}

/** The record's one-line form: `tailscale: <name> (<address>)`, `manual: <address>`, `none`. */
export function describeNetwork(r: NetworkRecord): string {
  if (r.kind === "tailscale") {
    const where = [r.name, r.address].filter((x) => x !== undefined);
    return where.length === 2
      ? `tailscale: ${r.name} (${r.address})`
      : `tailscale${where.length === 1 ? `: ${where[0]}` : ""}`;
  }
  return r.kind === "manual" ? `manual: ${r.address ?? "?"}` : "none";
}

/** The end's Desk line with the private address beside the LAN one; null without one. */
export function privateDeskLine(
  lanHost: string,
  port: number,
  r: NetworkRecord | null | undefined,
): string | null {
  if (r === null || r === undefined || r.kind === "none" || r.address === undefined) return null;
  const host = (h: string) => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);
  return `Desk: http://${host(lanHost)}:${port} · on your private network: http://${host(r.address)}:${port}`;
}

const sameRecord = (a: NetworkRecord | null, b: NetworkRecord) =>
  a !== null && a.kind === b.kind && a.name === b.name && a.address === b.address;

/** The kind the person chose: the flag, else the record, else asked (none under --yes/--check). */
async function chooseKind(ctx: SetupContext, prior: NetworkRecord | null): Promise<NetworkKind> {
  if (ctx.network !== undefined) return ctx.network;
  if (prior !== null) return prior.kind;
  if (ctx.yes || ctx.check === true || ctx.deps.ask === undefined) return "none";
  for (let tries = 0; tries < 3; tries++) {
    const a = await ctx.deps.ask(`${NETWORK_QUESTION} `);
    if (a === null) return "none";
    const t = a.trim().toLowerCase();
    if (t === "" || t.startsWith("t")) return "tailscale";
    if (t.startsWith("m") || t.startsWith("v") || t.includes("vpn")) return "manual";
    if (t.startsWith("n")) return "none";
  }
  return "none";
}

/** Every non-internal address of this machine, with its interface. */
function addressesOf(ctx: SetupContext): { name: string; address: string }[] {
  const ifs = (ctx.deps.interfaces ?? networkInterfaces)();
  return Object.entries(ifs).flatMap(([name, addrs]) =>
    (addrs ?? []).filter((a) => !a.internal).map((a) => ({ name, address: a.address })),
  );
}

async function resolveAll(ctx: SetupContext, host: string): Promise<string[]> {
  if (isIP(host) !== 0) return [host];
  try {
    if (ctx.deps.resolveHost !== undefined) return await ctx.deps.resolveHost(host);
    return (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return [];
  }
}

/** A change that records `r` (setup.json's `network`, and the run's context). */
function recordChange(ctx: SetupContext, r: NetworkRecord, summary: string): Change {
  return {
    summary,
    apply: async () => {
      recordNetwork(ctx, r);
      ctx.networkRecord = r;
      return [`Recorded ${describeNetwork(r)} in setup.json.`];
    },
  };
}

const recordSummary = (r: NetworkRecord) =>
  r.kind === "none"
    ? "Record that this machine is reached on its own network only (network: none)"
    : `Record this machine's private address in setup.json (${r.kind}: ${[r.name, r.address].filter((x) => x !== undefined).join(", ")})`;

/** The Network step. */
export async function planNetwork(ctx: SetupContext): Promise<StepPlan> {
  const plan: StepPlan = { step: "network", title: "Network", found: [], changes: [] };
  const prior = readNetworkRecord(ctx.volleydHome);
  const kind = await chooseKind(ctx, prior);
  ctx.network = kind;
  const want = (r: NetworkRecord) => {
    plan.row = describeNetwork(r);
    if (!sameRecord(prior, r)) plan.changes.push(recordChange(ctx, r, recordSummary(r)));
  };

  if (kind === "none") {
    plan.found.push("Reached on this network only: no private network");
    want({ kind: "none" });
    return plan;
  }

  if (kind === "manual") {
    let address = ctx.networkAddress ?? (prior?.kind === "manual" ? prior.address : undefined);
    if (address === undefined && !ctx.yes && ctx.check !== true && ctx.deps.ask !== undefined) {
      address = (await ctx.deps.ask(ADDRESS_QUESTION))?.trim() || undefined;
    }
    if (address === undefined) {
      plan.blocked =
        "your own VPN needs this machine's address on it: `volley setup --network manual --network-address <host-or-ip>`";
      return plan;
    }
    ctx.networkAddress = address;
    const mine = addressesOf(ctx);
    const resolved = await resolveAll(ctx, address);
    const bound = mine.find((a) => resolved.includes(a.address));
    if (bound === undefined) {
      const list = mine.map((a) => `${a.name} ${a.address}`).join(", ");
      plan.blocked = `${address} is not an address of this machine (interfaces: ${list === "" ? "none" : list})`;
      return plan;
    }
    plan.found.push(
      `Your own VPN: ${address} (${bound.address === address ? "" : `${bound.address}, `}on ${bound.name})`,
    );
    want({ kind: "manual", address });
    return plan;
  }

  // Tailscale: the CLI on PATH, else the macOS app's (resolved again after an install).
  const exec = ctx.deps.exec;
  let bin = "tailscale";
  const findBin = async () => {
    bin = "tailscale";
    let v = await exec([bin, "version"]).catch(() => null);
    if (
      (v === null || v.code !== 0) &&
      ctx.deps.platform === "darwin" &&
      (ctx.deps.exists ?? (() => false))(TAILSCALE_APP_CLI)
    ) {
      bin = TAILSCALE_APP_CLI;
      v = await exec([bin, "version"]).catch(() => null);
    }
    return v;
  };
  const version = await findBin();
  const installed = version !== null && version.code === 0;
  const linux = ctx.deps.platform !== "darwin";
  const upArgv = () => (linux && ctx.deps.uid !== 0 ? ["sudo", bin, "up"] : [bin, "up"]);
  const status = async () => {
    const r = await exec([bin, "status", "--json"]).catch(() => null);
    return r === null ? null : parseTailscaleStatus(r.stdout);
  };
  let handedOff = false;
  const recordRunning = async (): Promise<string[]> => {
    const s = await status();
    if (s === null || !s.running) return [];
    const r: NetworkRecord = {
      kind: "tailscale",
      ...(s.name !== null ? { name: s.name } : {}),
      ...(s.address !== null ? { address: s.address } : {}),
    };
    recordNetwork(ctx, r);
    ctx.networkRecord = r;
    return [`Recorded ${describeNetwork(r)} in setup.json.`];
  };

  if (!installed) {
    plan.found.push("Tailscale: not installed");
    plan.row = "tailscale: not installed";
    plan.changes.push(
      linux
        ? {
            summary: "Install Tailscale (needs sudo: Tailscale's package repository)",
            detail: `In a terminal: ${TAILSCALE_LINUX_INSTALL} (or rerun install.sh with --network tailscale, which installs it with the other packages)`,
            apply: async () => {
              throw new Error(
                `installing Tailscale needs sudo: run \`${TAILSCALE_LINUX_INSTALL}\`, then \`volley setup --step network\``,
              );
            },
          }
        : {
            summary: `Install Tailscale (${BREW_TAILSCALE.join(" ")})`,
            apply: async () => {
              const r = await exec(BREW_TAILSCALE);
              if (r.code !== 0) {
                throw new Error(
                  `\`${BREW_TAILSCALE.join(" ")}\` failed (exit ${r.code}): ${r.stderr.trim()}`,
                );
              }
              return [
                "Installed Tailscale. Open the Tailscale app once if macOS asks to allow it.",
              ];
            },
          },
    );
  }
  const s = installed ? await status() : null;
  const v = installed ? (version?.stdout.split("\n")[0]?.trim() ?? "") : "";
  if (installed && s !== null && s.running) {
    plan.found.push(
      `Tailscale ${v}: signed in as ${[s.name ?? "?", `(${s.address ?? "no IPv4 address"})`].join(" ")}`,
    );
    want({
      kind: "tailscale",
      ...(s.name !== null ? { name: s.name } : {}),
      ...(s.address !== null ? { address: s.address } : {}),
    });
    return plan;
  }
  if (installed) {
    plan.found.push(`Tailscale ${v}: not signed in (${s?.state ?? "tailscaled not answering"})`);
    plan.row = `tailscale: not signed in (${s?.state ?? "tailscaled not answering"})`;
  }
  plan.changes.push({
    summary: `Sign in to Tailscale (${upArgv()[0] === "sudo" ? "sudo " : ""}tailscale up: prints a sign-in link to open in your browser)`,
    apply: async () => {
      if (!installed) await findBin();
      const up = upArgv();
      ctx.metrics?.signIn();
      const timeoutMs = ctx.networkSigninTimeoutMs;
      if (timeoutMs !== undefined) {
        // The Desk: nobody at a terminal. The link goes back to the page (a phone can open it).
        const r = await exec(up, { timeoutMs });
        const url = /https:\/\/\S+/.exec(`${r.stdout}\n${r.stderr}`)?.[0];
        const link = url !== undefined ? [`Sign in to Tailscale: ${url}`] : [];
        if (r.code === 0) return [...link, ...(await recordRunning())];
        if (url === undefined) {
          throw new Error(`\`${up.join(" ")}\` printed no sign-in link (exit ${r.code})`);
        }
        handedOff = true;
        return [
          ...link,
          "Open it (on this machine or your phone), sign in, then plan the Network step again: it records the name and address once Tailscale runs.",
        ];
      }
      const r = await exec(up, { tty: true });
      if (r.code !== 0) {
        throw new Error(
          `\`${up.join(" ")}\` failed (exit ${r.code})${linux ? "" : ": open the Tailscale app once (it asks to allow its VPN configuration), then rerun `volley setup --step network`"}`,
        );
      }
      return recordRunning();
    },
  });
  plan.verify = async () => {
    plan.verified = [];
    if (handedOff) return [];
    const now = await status();
    if (now === null || !now.running) {
      return [`Tailscale is not signed in (${now?.state ?? "tailscaled not answering"})`];
    }
    plan.verified.push(`Tailscale: ${now.name ?? "?"} (${now.address ?? "no IPv4 address"})`);
    return [];
  };
  return plan;
}
