import { existsSync, readFileSync } from "node:fs";
import { connect as tcpConnect } from "node:net";
import { join } from "node:path";
import { configTraps, generateConfig, sameConfig, writeConfig } from "../auth/config";
import {
  ADMIN_FILE,
  type AdminCredentials,
  binaryOf,
  ensureOwnedDir,
  handAuthDirToInvoker,
  openAdmin,
  readCredentials,
  writeSecret,
} from "../auth/context";
import { ensureStateDir, includedFiles } from "../auth/migrate";
import { DYNSEC_ADMIN_USER } from "../auth/roles";
import { INSTALL_INSTRUCTIONS, checkBrokerVersion, detectBrokerVersion } from "../auth/version";
import type { AnonymousProbe, Change, SetupContext, StepPlan } from "./step";
import { lanWsUrl, unifiedDiff } from "./step";

/**
 * Steps 1 and 2 of `volley setup`: find the broker, then secure it the way `volley auth init`
 * does (mosquitto >= 2.1 + Dynamic Security: the config, the plugin's state file with its admin
 * login, a restart), and check that both listeners refuse anonymous clients.
 */

/** How long a restarted broker gets to accept the admin login, polled every RESTART_POLL_MS. */
export const RESTART_WAIT_MS = 10_000;
const RESTART_POLL_MS = 250;

/** An MQTT 3.1.1 CONNECT without credentials (clean session, keepalive 30 s). */
export function anonymousConnectPacket(clientId: string): Uint8Array {
  const id = new TextEncoder().encode(clientId);
  const variable = [0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 0x02, 0, 30];
  const remaining = variable.length + 2 + id.length;
  if (remaining > 127) throw new Error("client id too long for the probe");
  return Uint8Array.from([0x10, remaining, ...variable, id.length >> 8, id.length & 0xff, ...id]);
}

/** What a CONNACK at the start of `bytes` says, or null when there is no whole one yet. */
export function connackOutcome(bytes: Uint8Array): AnonymousProbe | null {
  if (bytes.length < 4 || bytes[0] !== 0x20 || bytes[1] !== 2) return null;
  return bytes[3] === 0 ? "accepted" : "refused";
}

/**
 * Send an anonymous CONNECT to a listener (mqtt:// over TCP, ws:// over a WebSocket with the
 * `mqtt` subprotocol) and read its CONNACK. Written on the wire directly: mqtt.js cannot open a
 * WebSocket under Bun. Anything but a CONNACK within `timeoutMs` is "unreachable".
 */
export function probeAnonymous(url: string, timeoutMs = 3_000): Promise<AnonymousProbe> {
  const packet = anonymousConnectPacket(`volley-setup-probe-${process.pid}`);
  return new Promise((resolve) => {
    let done = false;
    let cleanup = () => {};
    const finish = (r: AnonymousProbe) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cleanup();
      resolve(r);
    };
    const timer = setTimeout(() => finish("unreachable"), timeoutMs);
    let buf = new Uint8Array(0);
    const onBytes = (b: Uint8Array) => {
      const next = new Uint8Array(buf.length + b.length);
      next.set(buf);
      next.set(b, buf.length);
      buf = next;
      const r = connackOutcome(buf);
      if (r !== null) finish(r);
    };
    const u = new URL(url);
    if (u.protocol === "ws:" || u.protocol === "wss:") {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url, "mqtt");
      } catch {
        finish("unreachable");
        return;
      }
      ws.binaryType = "arraybuffer";
      cleanup = () => {
        try {
          ws.close();
        } catch {
          // already closed
        }
      };
      ws.onopen = () => ws.send(packet);
      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) onBytes(new Uint8Array(e.data));
      };
      ws.onerror = () => finish("unreachable");
      ws.onclose = () => finish("unreachable");
      return;
    }
    const sock = tcpConnect(Number(u.port || 1883), u.hostname.replace(/^\[|\]$/g, ""));
    cleanup = () => sock.destroy();
    sock.on("connect", () => sock.write(packet));
    sock.on("data", (d: Buffer) => onBytes(new Uint8Array(d)));
    sock.on("error", () => finish("unreachable"));
    sock.on("close", () => finish("unreachable"));
  });
}

const port = (url: string) => new URL(url).port || (url.startsWith("ws") ? "80" : "1883");

/** Statuses after which an agent is no longer running (SPEC §5.3). */
const ENDED = new Set(["done", "failed", "reaped"]);

/**
 * How many agents are running, from the retained `volley/+/+/status` messages: an LWT leaves the
 * registry entry behind (SPEC §5), so the registry alone counts dead agents too.
 */
export function countLiveAgents(statuses: readonly { payload: string }[]): number {
  return statuses.filter((s) => {
    if (s.payload === "") return false;
    try {
      const type = (JSON.parse(s.payload) as { type?: unknown }).type;
      return typeof type === "string" && !ENDED.has(type);
    } catch {
      return false;
    }
  }).length;
}

/** The question the security step asks when neither `--lan` nor `--no-lan` decides. */
export const LAN_QUESTION =
  "Let your phone and other devices on this network reach the broker's WebSocket listener (port 9001), so the Desk works from your phone? Every device still has to sign in, but the traffic is not encrypted until TLS is set up, so say yes only on a network you trust (home, not a café).";

const describeProbe = (p: AnonymousProbe) =>
  p === "refused"
    ? "refuses anonymous clients"
    : p === "accepted"
      ? "accepts anonymous clients"
      : "not listening";

/** The coordinator's credentials (written by setup's accounts step), or null. */
function coordinatorCreds(ctx: SetupContext): AdminCredentials | null {
  try {
    return readCredentials(join(ctx.auth.dir, "coordinator.json"));
  } catch {
    return null;
  }
}

function adminCreds(ctx: SetupContext): AdminCredentials | null {
  try {
    return readCredentials(join(ctx.auth.dir, ADMIN_FILE));
  } catch {
    return null;
  }
}

/** Whether the broker takes the admin login now (it runs the plugin with our state file). */
async function adminWorks(ctx: SetupContext): Promise<boolean> {
  try {
    const link = await openAdmin(ctx.auth);
    await link.close().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Step 1: which mosquitto, which version, what its listeners do, how many agents are registered. */
export async function planDetect(ctx: SetupContext): Promise<StepPlan> {
  const { layout, deps } = ctx.auth;
  const plan: StepPlan = {
    step: "detect",
    title: "Broker",
    found: [`Install: ${layout.name} (config ${ctx.config})`],
    changes: [],
  };
  const admin = adminCreds(ctx);
  const found = await detectBrokerVersion({
    sys: async () => {
      if (admin === null) return null;
      const link = await deps.connectAdmin(ctx.auth.url, admin);
      try {
        return await link.sysVersion();
      } finally {
        await link.close().catch(() => {});
      }
    },
    binary: () => deps.mosquittoVersion(binaryOf(layout)),
  });
  if (found === null) {
    plan.blocked = `no mosquitto found (${binaryOf(layout)} -h printed no version).\n${INSTALL_INSTRUCTIONS}`;
    return plan;
  }
  const v = checkBrokerVersion(found.version);
  if (!v.ok) {
    plan.blocked = `${v.code}: ${v.message}`;
    return plan;
  }
  plan.found.push(`mosquitto ${v.version} (from ${found.source})`);
  for (const url of [ctx.tcpUrl, ctx.wsUrl]) {
    plan.found.push(`Listener ${port(url)}: ${describeProbe(await ctx.deps.probeAnonymous(url))}`);
  }
  const coord = coordinatorCreds(ctx);
  if (coord !== null) {
    const n = await ctx.deps.liveAgents(ctx.auth.url, coord).catch(() => null);
    if (n !== null) plan.found.push(`${n} agent${n === 1 ? "" : "s"} running on the broker`);
  }
  return plan;
}

/** Step 2: the broker config, the plugin's state file and admin, a restart, the anonymous check. */
export async function planSecurity(ctx: SetupContext): Promise<StepPlan> {
  const { layout, deps, dir, io } = ctx.auth;
  const plan: StepPlan = { step: "security", title: "Security", found: [], changes: [] };
  const current = existsSync(ctx.config) ? readFileSync(ctx.config, "utf-8") : "";
  const traps = configTraps(current, includedFiles(current));
  if (traps.length > 0) {
    plan.blocked = `refusing to replace ${ctx.config}:\n${traps.map((t) => `  - ${t}`).join("\n")}\nFix it (or move it aside) and rerun.`;
    return plan;
  }
  let restart = false;
  const local = generateConfig({ ...layout, stateFile: ctx.stateFile, by: "volley setup" });
  const open = generateConfig({
    ...layout,
    stateFile: ctx.stateFile,
    wsBind: "",
    by: "volley setup",
  });
  // LAN reach: the flag decides; else what the config has; else ask (no question under --yes).
  let lan: boolean;
  if (local === open)
    lan = true; // the layout binds every interface already (a container)
  else if (ctx.lan !== undefined) lan = ctx.lan;
  else if (sameConfig(current, open) || sameConfig(current, local)) lan = sameConfig(current, open);
  else lan = ctx.yes ? false : await ctx.deps.confirm(LAN_QUESTION, true);
  ctx.lan = lan;
  if (local !== open) {
    plan.found.push(
      lan
        ? "LAN access: on. Devices on this network reach the WebSocket listener (port 9001) and must sign in; not encrypted (no TLS). `volley setup --no-lan` closes it."
        : "LAN access: off. The WebSocket listener (port 9001) is on this machine only, so the Desk cannot work from a phone. `volley setup --lan` opens it.",
    );
  }
  const wanted = lan ? open : local;
  // Only the header differs from a config `volley auth init` wrote: that one is in place too.
  if (sameConfig(current, wanted))
    plan.found.push(`${ctx.config} is Volley's Dynamic Security config`);
  else {
    restart = true;
    plan.changes.push({
      summary: `Write ${ctx.config} (Dynamic Security, both listeners authenticated${lan && local !== open ? ", WebSocket open to the LAN" : ""}; the old one backed up)`,
      detail: unifiedDiff(ctx.config, current, wanted),
      apply: async () => {
        const w = writeConfig(ctx.config, wanted, io.now());
        return [
          `Wrote ${ctx.config}.`,
          ...(w.backup !== null
            ? [`Backed the previous config up to ${w.backup} (rollback: copy it back, restart).`]
            : []),
        ];
      },
    });
  }

  const adminPath = join(dir, ADMIN_FILE);
  let admin: AdminCredentials | null;
  try {
    admin = readCredentials(adminPath);
  } catch (e) {
    plan.blocked = e instanceof Error ? e.message : String(e);
    return plan;
  }
  if (admin === null) {
    if (existsSync(ctx.stateFile)) {
      plan.blocked = `${ctx.stateFile} exists but ${adminPath} does not: put its admin login there as {"username","password"} (mode 0600), or move the state file aside to start over`;
      return plan;
    }
    restart = true;
    plan.changes.push({
      summary: `Create ${ctx.stateFile} with the admin login ${DYNSEC_ADMIN_USER}`,
      detail: `${layout.ctrl} dynsec init ${ctx.stateFile} ${DYNSEC_ADMIN_USER} <new password>; the login is stored in ${adminPath} (mode 0600)`,
      apply: async () => {
        ensureOwnedDir(deps, dir, null);
        ensureStateDir(deps, ctx.stateFile);
        const password = deps.generatePassword();
        const r = await deps.ctrlInit(layout.ctrl, ctx.stateFile, DYNSEC_ADMIN_USER, password);
        if (r.code !== 0 || !existsSync(ctx.stateFile)) {
          throw new Error(
            `${layout.ctrl} dynsec init ${ctx.stateFile} failed (exit ${r.code}): ${r.stderr.trim()}${r.code === 127 ? " (mosquitto_ctrl ships with mosquitto >= 2.0)" : ""}`,
          );
        }
        writeSecret(adminPath, `${JSON.stringify({ username: DYNSEC_ADMIN_USER, password })}\n`);
        handAuthDirToInvoker(ctx.auth);
        const owner = deps.brokerOwner();
        if (owner !== null) deps.chown(ctx.stateFile, owner.uid, owner.gid);
        return [`Created ${ctx.stateFile}; the admin login is in ${adminPath} (mode 0600).`];
      },
    });
  } else if (await adminWorks(ctx)) {
    plan.found.push(`The broker runs the plugin (admin login ${admin.username} accepted)`);
  } else {
    restart = true;
    plan.found.push("The broker refuses the admin login: it does not run the plugin yet");
  }

  // With LAN on, a phone's reach is checked too: it must get a refusal (reachable, logging in).
  const lanUrl = lanWsUrl(ctx);
  const probed = [ctx.tcpUrl, ctx.wsUrl, ...(lan && lanUrl !== ctx.wsUrl ? [lanUrl] : [])];
  for (const url of probed) {
    const p = await ctx.deps.probeAnonymous(url);
    plan.found.push(
      url === lanUrl && url !== ctx.wsUrl
        ? `Listener ${port(url)} from the LAN (${url}): ${describeProbe(p)}`
        : `Listener ${port(url)}: ${describeProbe(p)}`,
    );
    if (p !== "refused") restart = true;
  }
  if (restart) plan.changes.push(restartChange(ctx));
  plan.verify = async () => {
    const problems: string[] = [];
    plan.verified = [];
    for (const url of probed) {
      const p = await ctx.deps.probeAnonymous(url);
      if (p === "refused") {
        plan.verified.push(
          url === lanUrl && url !== ctx.wsUrl
            ? `Listener ${port(url)} from the LAN (${url}): reachable, refuses anonymous clients`
            : `Listener ${port(url)}: refuses anonymous clients`,
        );
      }
      if (p === "accepted") problems.push(`${url} still accepts anonymous clients`);
      if (p === "unreachable") {
        problems.push(
          url === lanUrl && url !== ctx.wsUrl
            ? `${url} is not reachable from the LAN (a firewall? the wrong address? pass --desk-host)`
            : `${url} is not listening`,
        );
      }
    }
    return problems;
  };
  return plan;
}

function restartChange(ctx: SetupContext): Change {
  const { layout } = ctx.auth;
  return {
    summary: `Restart the broker (${layout.restart})`,
    detail: "Clients reconnect on their own; agents' queued mailbox messages persist.",
    apply: async () => {
      if (layout.name === "container") {
        throw new Error(
          `restart your container yourself (${layout.restart}), then rerun \`volley setup\``,
        );
      }
      const r = await ctx.deps.exec(layout.restart.split(" "));
      if (r.code !== 0) {
        throw new Error(`\`${layout.restart}\` failed (exit ${r.code}): ${r.stderr.trim()}`);
      }
      for (let waited = 0; !(await adminWorks(ctx)); waited += RESTART_POLL_MS) {
        if (waited >= RESTART_WAIT_MS) {
          throw new Error(
            `the broker did not accept the admin login within ${RESTART_WAIT_MS / 1000} s of \`${layout.restart}\`; check its log`,
          );
        }
        await ctx.deps.sleep(RESTART_POLL_MS);
      }
      return [`Restarted the broker (${layout.restart}); it accepts the admin login.`];
    },
  };
}
