import { simulated } from "./first-wave";
import { type NetworkRecord, readNetworkRecord } from "./journal";
import { TAILSCALE_APP_CLI } from "./network";
import type { Change, SetupContext } from "./step";

/**
 * The Desk on the tailnet (`volley desk install --tailscale`, and the Services step when the
 * Network step recorded Tailscale): two `tailscale serve` targets, both loopback-only, so the
 * Desk is HTTPS at the machine's MagicDNS name with a certificate Tailscale issues, and its page
 * reaches the broker's WebSocket listener as `wss://` on a second HTTPS port:
 *
 *   https://<name>       → http://127.0.0.1:<desk port>
 *   https://<name>:8443  → http://127.0.0.1:9001
 *
 * Two ports rather than one path: mosquitto's WebSocket listener answers at the root. Nothing is
 * public (never `tailscale funnel`), `tailscale serve reset` is never run (it would drop the
 * owner's other serves), and removing takes off only these two ports, each only while it still
 * proxies what Volley put there. `tailscale serve status --json` is how Volley reads what is set.
 */

/** The Desk's HTTPS port at the machine's name (the default, so its URL names none). */
export const DESK_HTTPS_PORT = 443;
/** The HTTPS port the broker's WebSocket listener is served on. */
export const WS_HTTPS_PORT = 8443;
/** The broker's WebSocket listener on this machine's loopback. */
export const WS_LISTENER_PORT = 9001;

/** One `tailscale serve` target: HTTPS `https` at the machine's name → loopback `port`. */
export interface ServeTarget {
  https: number;
  port: number;
}

export const loopbackTarget = (port: number) => `http://127.0.0.1:${port}`;

/** The Desk's two serves, for the Desk on `deskPort`. */
export const deskServeTargets = (deskPort: number): ServeTarget[] => [
  { https: DESK_HTTPS_PORT, port: deskPort },
  { https: WS_HTTPS_PORT, port: WS_LISTENER_PORT },
];

/** `tailscale serve --bg --https=<https> http://127.0.0.1:<port>`: in the background, kept. */
export const serveArgv = (t: ServeTarget, bin = "tailscale"): string[] => [
  bin,
  "serve",
  "--bg",
  `--https=${t.https}`,
  loopbackTarget(t.port),
];

/** `tailscale serve --https=<https> off`: that one port's serve removed, the others kept. */
export const serveOffArgv = (https: number, bin = "tailscale"): string[] => [
  bin,
  "serve",
  `--https=${https}`,
  "off",
];

export const serveStatusArgv = (bin = "tailscale"): string[] => [bin, "serve", "status", "--json"];

/** The Desk's address on the private network. */
export const privateDeskUrl = (name: string) => `https://${name}`;
/** The broker's WebSocket listener as a page served from `privateDeskUrl` reaches it. */
export const privateWsUrl = (name: string) => `wss://${name}:${WS_HTTPS_PORT}`;

/**
 * `tailscale serve status --json`, read: each HTTPS port that serves something → the proxy its
 * root (`/`) handler names, `tcp://<target>` for a TCP forward, `another handler` for anything
 * else (a path, a file, a handler below the root). Null when it is not serve status JSON.
 */
export function parseServeStatus(stdout: string): Map<number, string> | null {
  let j: unknown;
  try {
    j = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return null;
  const obj = (v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const s = j as { TCP?: unknown; Web?: unknown };
  const out = new Map<number, string>();
  for (const [port, h] of Object.entries(obj(s.TCP))) {
    const fwd = obj(h).TCPForward;
    if (typeof fwd === "string" && fwd !== "") out.set(Number(port), `tcp://${fwd}`);
  }
  for (const [hostPort, web] of Object.entries(obj(s.Web))) {
    const port = Number(hostPort.slice(hostPort.lastIndexOf(":") + 1));
    if (!Number.isInteger(port)) continue;
    const proxy = obj(obj(obj(web).Handlers)["/"]).Proxy;
    out.set(port, typeof proxy === "string" ? proxy : "another handler");
  }
  return out;
}

export type DeskServePlan =
  | { blocked: string }
  | {
      name: string;
      /** `https://<name>`: the Desk on the private network. */
      url: string;
      /** `wss://<name>:8443`: what `/desk-config.json` gives the page as `ws_url`. */
      wsUrl: string;
      configured: ServeTarget[];
      missing: ServeTarget[];
    };

/** The line every refusal for want of a Tailscale record ends with. */
export const NEEDS_TAILSCALE = "run `volley setup --network tailscale` first";

/**
 * What serving the Desk on `deskPort` takes, from the Network step's record and what `tailscale
 * serve status` reports (`served`): the two targets, those already in place, those to add. Blocked
 * without a Tailscale record or a MagicDNS name, or when one of the two HTTPS ports serves
 * something else (the owner's own: never replaced).
 */
export function planDeskServe(
  record: NetworkRecord | null | undefined,
  served: Map<number, string>,
  deskPort: number,
): DeskServePlan {
  if (record?.kind !== "tailscale") {
    return { blocked: `this machine has no Tailscale record: ${NEEDS_TAILSCALE}` };
  }
  if (record.name === undefined) {
    return {
      blocked:
        "the Tailscale record has no MagicDNS name (turn MagicDNS on in the Tailscale admin console), then rerun `volley setup --step network`",
    };
  }
  const name = record.name;
  const configured: ServeTarget[] = [];
  const missing: ServeTarget[] = [];
  for (const t of deskServeTargets(deskPort)) {
    const now = served.get(t.https);
    if (now === loopbackTarget(t.port)) configured.push(t);
    else if (now === undefined) missing.push(t);
    else {
      return {
        blocked: `HTTPS port ${t.https} on ${name} already serves ${now}, not ${loopbackTarget(t.port)}: Volley never replaces another serve. Free it with \`tailscale serve --https=${t.https} off\` and rerun, or keep the Desk on your LAN only`,
      };
    }
  }
  return { name, url: privateDeskUrl(name), wsUrl: privateWsUrl(name), configured, missing };
}

/** `http://127.0.0.1:<1..65535>`, exactly. */
const LOOPBACK = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;

/**
 * Whether `argv` is one of the `tailscale serve` commands Volley runs: `tailscale` (on PATH) or
 * the macOS app's CLI with `serve status --json`, `serve --bg --https=443 http://127.0.0.1:<p>`,
 * `serve --bg --https=8443 http://127.0.0.1:9001`, or `serve --https=<443|8443> off`; with
 * `sudo` (Linux: serve changes need root), the same under `sudo`. Never `funnel`, never `reset`.
 */
export function isTailscaleServeCommand(argv: readonly string[], opts: { sudo: boolean }): boolean {
  const sudo = argv[0] === "sudo";
  if (sudo && !opts.sudo) return false;
  const [bin, verb, ...rest] = sudo ? argv.slice(1) : argv;
  if ((bin !== "tailscale" && bin !== TAILSCALE_APP_CLI) || verb !== "serve") return false;
  const line = rest.join(" ");
  if (line === "status --json") return true;
  if (rest.length === 2 && rest[1] === "off") {
    return rest[0] === `--https=${DESK_HTTPS_PORT}` || rest[0] === `--https=${WS_HTTPS_PORT}`;
  }
  if (rest.length !== 3 || rest[0] !== "--bg") return false;
  const port = Number(LOOPBACK.exec(rest[2] ?? "")?.[1] ?? Number.NaN);
  if (!(port >= 1 && port <= 65_535)) return false;
  return (
    rest[1] === `--https=${DESK_HTTPS_PORT}` ||
    (rest[1] === `--https=${WS_HTTPS_PORT}` && port === WS_LISTENER_PORT)
  );
}

/** The serve change's summary start (volleyd keeps Linux's, under sudo, for a terminal). */
export const SERVE_SUMMARY = "Serve the Desk on your private network (";

/** Tailscale's CLI here: on PATH, else the macOS app's; null when neither answers. */
async function findTailscale(ctx: SetupContext): Promise<string | null> {
  const answers = async (bin: string) => {
    const r = await ctx.deps.exec([bin, "version"]).catch(() => null);
    return r !== null && r.code === 0;
  };
  if (await answers("tailscale")) return "tailscale";
  if (
    ctx.deps.platform === "darwin" &&
    (ctx.deps.exists ?? (() => false))(TAILSCALE_APP_CLI) &&
    (await answers(TAILSCALE_APP_CLI))
  ) {
    return TAILSCALE_APP_CLI;
  }
  return null;
}

/**
 * Whether a serve change runs under sudo: on Linux it needs root (or Tailscale's operator). Not
 * against volley-sim: its fake tailscale is first on PATH, which sudo would reset.
 */
const needsSudo = (ctx: SetupContext) =>
  ctx.deps.platform !== "darwin" && ctx.deps.uid !== 0 && !simulated(ctx);

/** `argv` as this machine runs a serve change (under sudo with the terminal, on Linux). */
async function runServe(ctx: SetupContext, argv: string[]): Promise<void> {
  const sudo = needsSudo(ctx);
  const full = sudo ? ["sudo", ...argv] : argv;
  const r = await ctx.deps.exec(full, sudo ? { tty: true } : undefined);
  if (r.code !== 0) {
    throw new Error(
      `\`${full.join(" ")}\` failed (exit ${r.code})${r.stderr.trim() !== "" ? `: ${r.stderr.trim()}` : ""}. If Tailscale asks for HTTPS certificates, turn them on in its admin console (DNS › HTTPS Certificates), then rerun`,
    );
  }
}

/** What `tailscale serve status --json` reports here, or why it cannot be read. */
async function readServed(
  ctx: SetupContext,
  bin: string,
): Promise<Map<number, string> | { error: string }> {
  const r = await ctx.deps.exec(serveStatusArgv(bin)).catch((e: unknown) => ({
    code: -1,
    stdout: "",
    stderr: e instanceof Error ? e.message : String(e),
  }));
  const served = r.code === 0 ? parseServeStatus(r.stdout) : null;
  if (served === null) {
    return {
      error: `could not read \`tailscale serve status --json\` (exit ${r.code}): ${(r.stderr || r.stdout).trim() || "not serve status"}`,
    };
  }
  return served;
}

/**
 * The Desk's serve, planned for the Desk on `deskPort`: its private address and `ws_url`, and
 * the change that adds the serves missing (null: both in place, said in `found`). Blocked
 * without a Tailscale record, without Tailscale answering here, or with one of the two ports
 * serving something else.
 */
export async function planServeChange(
  ctx: SetupContext,
  deskPort: number,
  found: string[],
): Promise<{ blocked: string } | { url: string; wsUrl: string; change: Change | null }> {
  const record = ctx.networkRecord ?? readNetworkRecord(ctx.volleydHome);
  if (record?.kind !== "tailscale")
    return planDeskServe(record, new Map(), deskPort) as { blocked: string };
  const bin = await findTailscale(ctx);
  if (bin === null) {
    return {
      blocked: `Tailscale does not answer here (\`tailscale version\`): ${NEEDS_TAILSCALE}`,
    };
  }
  const served = await readServed(ctx, bin);
  if ("error" in served) return { blocked: served.error };
  const p = planDeskServe(record, served, deskPort);
  if ("blocked" in p) return p;
  if (p.missing.length === 0) {
    found.push(
      `The Desk on your private network: ${p.url} (tailscale serve: ${p.configured.map((t) => `${t.https} → 127.0.0.1:${t.port}`).join(", ")})`,
    );
    return { url: p.url, wsUrl: p.wsUrl, change: null };
  }
  const sudo = needsSudo(ctx);
  const argvs = p.missing.map((t) => serveArgv(t, bin));
  return {
    url: p.url,
    wsUrl: p.wsUrl,
    change: {
      summary: `${SERVE_SUMMARY}${sudo ? "sudo tailscale serve: " : ""}${p.url})`,
      detail: [
        ...argvs.map((a) => (sudo ? ["sudo", ...a] : a).join(" ")),
        `HTTPS at your machine's Tailscale name with a certificate Tailscale issues; reachable only on your tailnet (never Funnel). The page reaches the broker at ${p.wsUrl}.`,
      ].join("\n"),
      apply: async () => {
        for (const a of argvs) await runServe(ctx, a);
        return [
          `Serving ${p.url} → http://127.0.0.1:${deskPort} and ${p.wsUrl} → the broker's WebSocket listener (tailscale serve; private to your tailnet).`,
          "Open it on any device signed in to your Tailscale account (the Tailscale app on your phone).",
        ];
      },
    },
  };
}

/**
 * Take the Desk's serves off (`volley desk uninstall`): each of the two ports only while it still
 * proxies the Desk's target, never anything else. Returns the report lines.
 */
export async function removeDeskServes(ctx: SetupContext, deskPort: number): Promise<string[]> {
  const bin = await findTailscale(ctx);
  if (bin === null) return ["Tailscale does not answer here: no serve to take off."];
  const served = await readServed(ctx, bin);
  if ("error" in served) throw new Error(served.error);
  const ours = deskServeTargets(deskPort).filter(
    (t) => served.get(t.https) === loopbackTarget(t.port),
  );
  for (const t of ours) await runServe(ctx, serveOffArgv(t.https, bin));
  return ours.length === 0
    ? ["The Desk's serves are already off."]
    : [
        `Took the Desk's serves off (tailscale serve --https=${ours.map((t) => t.https).join(", --https=")} off; any other serve is kept).`,
      ];
}
