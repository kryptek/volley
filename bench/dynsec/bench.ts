#!/usr/bin/env bun
/**
 * Dynamic Security benchmark for Volley broker auth (bench/dynsec/README.md).
 *
 * Drives the mosquitto Dynamic Security plugin directly over MQTT
 * (`$CONTROL/dynamic-security/v1`) and measures every question the README's go/no-go table
 * answers: (a) `%u`/`%c` role ACLs, (b) create/delete latency, (c) churn isolation,
 * (d) scale, (e) persistence, (f) deleting/disabling a connected client, (g) expiry,
 * (h) listeners, (i) idempotent bootstrap, (k) per-agent roles at scale. (j) compares two runs
 * of this script.
 *
 * Not run directly: `run-local.sh` / `run-2.1.sh` start a throwaway broker and pass it in:
 *   BENCH_URL, BENCH_WS_URL       tcp + websocket listener of the broker under test
 *   BENCH_ADMIN_USER/_PASS        the admin client `mosquitto_ctrl dynsec init` created
 *   BENCH_JSON                    host path of the plugin's dynamic-security.json
 *   BENCH_START/_STOP/_KILL       shell commands: start, stop (SIGTERM, wait), SIGKILL
 *   BENCH_RSS                     shell command printing the broker's RSS in KiB
 *   BENCH_CPU                     optional: shell command printing the broker's CPU seconds
 *   BENCH_PLS_URL/_WS_URL/_STATUS a second broker with per_listener_settings true
 *   BENCH_INIT_RERUN              output of re-running `dynsec init` on an existing file
 *   BENCH_LABEL, BENCH_OUT, BENCH_QUICK=1 (smaller sizes), BENCH_ONLY=a,b (sections)
 */
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Duplex } from "node:stream";

// --- mqtt.js -------------------------------------------------------------------------
// bench/ is not a workspace package; borrow the mqtt install of volley-mcp. Only the
// slice of the client API used below is typed.

interface MqttClient {
  connected: boolean;
  /** The transport; destroying it without a DISCONNECT is how a crash looks to the broker. */
  stream: { destroy(): void };
  on(event: "message", cb: (topic: string, payload: Buffer) => void): MqttClient;
  on(event: "disconnect", cb: (packet: { reasonCode?: number }) => void): MqttClient;
  on(event: "error", cb: (err: Error & { code?: number }) => void): MqttClient;
  on(event: "connect" | "close", cb: () => void): MqttClient;
  publishAsync(
    topic: string,
    payload: string,
    opts?: { qos?: 0 | 1; retain?: boolean },
  ): Promise<unknown>;
  subscribeAsync(
    filter: string | string[],
    opts?: { qos?: 0 | 1 },
  ): Promise<Array<{ topic: string; qos: number }>>;
  endAsync(force?: boolean): Promise<void>;
}
interface MqttModule {
  connect(url: string, opts: Record<string, unknown>): MqttClient;
  MqttClient: new (streamBuilder: () => Duplex, opts: Record<string, unknown>) => MqttClient;
}
const mqttEntry = Bun.resolveSync("mqtt", join(import.meta.dir, "../../packages/volley-mcp"));
const mqttMod = (await import(mqttEntry)) as Partial<MqttModule> & { default?: MqttModule };
const mqtt: MqttModule = mqttMod.connect
  ? (mqttMod as MqttModule)
  : (mqttMod.default as MqttModule);

/**
 * mqtt.js's own WebSocket transport needs `ws.createWebSocketStream`, which Bun does not
 * implement, so ws:// connections run over Bun's native WebSocket through this stream.
 */
function webSocketStream(url: string): Duplex {
  const ws = new WebSocket(url, ["mqtt"]);
  ws.binaryType = "arraybuffer";
  const queued: Buffer[] = [];
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, cb) {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
      else queued.push(chunk);
      cb();
    },
    final(cb) {
      ws.close();
      cb();
    },
    destroy(err, cb) {
      ws.close();
      cb(err);
    },
  });
  ws.onopen = () => {
    for (const c of queued.splice(0)) ws.send(c);
  };
  ws.onmessage = (ev) => stream.push(Buffer.from(ev.data as ArrayBuffer));
  ws.onclose = () => stream.push(null);
  ws.onerror = () => stream.destroy(new Error(`websocket error on ${url}`));
  return stream;
}

// --- environment -----------------------------------------------------------------------

function need(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    console.error(`bench.ts: ${name} is not set (run it through run-local.sh or run-2.1.sh)`);
    process.exit(2);
  }
  return v;
}
const URL_TCP = need("BENCH_URL");
const URL_WS = need("BENCH_WS_URL");
const ADMIN_USER = need("BENCH_ADMIN_USER");
const ADMIN_PASS = need("BENCH_ADMIN_PASS");
const JSON_PATH = need("BENCH_JSON");
const START_CMD = need("BENCH_START");
const STOP_CMD = need("BENCH_STOP");
const KILL_CMD = need("BENCH_KILL");
const RSS_CMD = need("BENCH_RSS");
/** Optional: prints the broker's cumulative CPU time, as seconds or [[h:]m:]s. */
const CPU_CMD = process.env.BENCH_CPU;
const LABEL = process.env.BENCH_LABEL ?? "mosquitto";
const OUT_DIR = process.env.BENCH_OUT ?? ".";
const QUICK = process.env.BENCH_QUICK === "1";
const ONLY = process.env.BENCH_ONLY ? new Set(process.env.BENCH_ONLY.split(",")) : undefined;
for (const port of [URL_TCP, URL_WS].map((u) => new URL(u).port)) {
  if (port === "1883" || port === "9001" || port === "18830") {
    console.error(`bench.ts: refusing to run against port ${port} (a real Volley broker)`);
    process.exit(2);
  }
}

const CONTROL_TOPIC = "$CONTROL/dynamic-security/v1";
const RESPONSE_TOPIC = `${CONTROL_TOPIC}/response`;
/** A run tag, so usernames never collide between sections or reruns. */
const RUN = Math.random().toString(36).slice(2, 6);

// --- small helpers -----------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => performance.now();
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const pw = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const log = (msg: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

interface Summary {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}
function summary(samples: number[]): Summary {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] ?? 0;
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
  return {
    n: s.length,
    p50: round(at(0.5), 2),
    p95: round(at(0.95), 2),
    p99: round(at(0.99), 2),
    max: round(s[s.length - 1] ?? 0, 2),
    mean: round(mean, 2),
  };
}
const fmt = (s: Summary) =>
  s.n === 0 ? "none observed" : `p50 ${s.p50} / p95 ${s.p95} / p99 ${s.p99} ms`;

async function sh(cmd: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, out: (out + err).trim() };
}
async function cpuSeconds(): Promise<number | null> {
  if (!CPU_CMD) return null;
  const out = (await sh(CPU_CMD)).out.trim();
  const parts = out.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
async function rssKiB(): Promise<number | null> {
  const r = await sh(RSS_CMD);
  const n = Number.parseInt(r.out.replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

/** Resolves with `fn()`, or with `fallback` after `ms`. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, sleep(ms).then(() => fallback)]);
}

/** Runs `n` jobs with at most `conc` in flight; each worker gets its index. */
async function pool(n: number, conc: number, job: (i: number, worker: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(conc, n) }, async (_, w) => {
      while (next < n) {
        const i = next++;
        await job(i, w);
      }
    }),
  );
}

// --- MQTT connections ----------------------------------------------------------------------

interface ConnectOpts {
  url?: string;
  username?: string;
  password?: string;
  clientId?: string;
  /** Volley agents connect with v3.1.1 (volley-mcp's default); volleyd with v5. */
  protocolVersion?: 4 | 5;
  will?: { topic: string; payload: string; qos: 0 | 1; retain: boolean };
}

function connect(o: ConnectOpts = {}): Promise<MqttClient> {
  const url = o.url ?? URL_TCP;
  const opts = {
    clientId: o.clientId ?? `bench-${RUN}-${pw().slice(0, 8)}`,
    protocolVersion: o.protocolVersion ?? 5,
    reconnectPeriod: 0,
    connectTimeout: 15_000,
    clean: true,
    ...(o.username !== undefined ? { username: o.username } : {}),
    ...(o.password !== undefined ? { password: o.password } : {}),
    ...(o.will ? { will: o.will } : {}),
  };
  const client = url.startsWith("ws")
    ? new mqtt.MqttClient(() => webSocketStream(url), opts)
    : mqtt.connect(url, opts);
  return new Promise((resolve, reject) => {
    client.on("connect", () => resolve(client));
    client.on("error", (e) => {
      reject(e);
      void client.endAsync(true);
    });
    client.on("close", () => reject(new Error("connection closed before CONNACK")));
  });
}

/** "ok", or how the broker refused: used for the listener probes. */
async function tryConnect(o: ConnectOpts): Promise<string> {
  try {
    const c = await connect(o);
    await c.endAsync();
    return "ok";
  } catch (e) {
    const err = e as Error & { code?: number };
    return err.code !== undefined ? `refused (CONNACK ${err.code})` : `error: ${err.message}`;
  }
}

/** Resolves with the time the client's connection closed, or null after `ms`. */
function closedWithin(c: MqttClient, ms: number): Promise<number | null> {
  return within(new Promise<number | null>((r) => c.on("close", () => r(now()))), ms, null);
}

// --- the Dynamic Security control API ----------------------------------------------------------

interface DynsecCommand {
  command: string;
  correlationData?: string;
  [k: string]: unknown;
}
interface DynsecResponse {
  command: string;
  error?: string;
  data?: Record<string, unknown>;
  correlationData?: string;
}

/** One admin connection to `$CONTROL/dynamic-security/v1`, matching responses by correlationData. */
class Dynsec {
  private readonly pending = new Map<string, (r: DynsecResponse) => void>();
  private seq = 0;
  /** Responses that arrived here but answer a command sent on another connection. */
  foreign = 0;

  private constructor(
    readonly client: MqttClient,
    private readonly tag: string,
  ) {
    client.on("message", (topic, payload) => {
      if (topic !== RESPONSE_TOPIC) return;
      const body = JSON.parse(payload.toString()) as { responses?: DynsecResponse[] };
      for (const r of body.responses ?? []) {
        const id = r.correlationData;
        const cb = id !== undefined ? this.pending.get(id) : undefined;
        if (id !== undefined && cb) {
          this.pending.delete(id);
          cb(r);
        } else {
          this.foreign++;
        }
      }
    });
  }

  static async open(tag = "ctl", url = URL_TCP): Promise<Dynsec> {
    const c = await connect({
      url,
      username: ADMIN_USER,
      password: ADMIN_PASS,
      protocolVersion: 5,
    });
    await c.subscribeAsync(RESPONSE_TOPIC, { qos: 1 });
    return new Dynsec(c, `${tag}-${pw().slice(0, 6)}`);
  }

  /** Sends all commands in ONE control message; resolves with their responses, in order. */
  async run(commands: DynsecCommand[], timeoutMs = 120_000): Promise<DynsecResponse[]> {
    const waits = commands.map((cmd) => {
      const id = `${this.tag}-${++this.seq}`;
      cmd.correlationData = id;
      return new Promise<DynsecResponse>((resolve, reject) => {
        const t = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`no response to ${cmd.command} within ${timeoutMs} ms`));
        }, timeoutMs);
        this.pending.set(id, (r) => {
          clearTimeout(t);
          resolve(r);
        });
      });
    });
    // If the publish itself fails (broker gone), nobody awaits the waits: keep them handled.
    for (const w of waits) w.catch(() => {});
    await this.client.publishAsync(CONTROL_TOPIC, JSON.stringify({ commands }), { qos: 1 });
    // allSettled: one timeout must not leave the other waits as unhandled rejections.
    const settled = await Promise.allSettled(waits);
    const failed = settled.find((r) => r.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
    return settled.map((r) => (r as PromiseFulfilledResult<DynsecResponse>).value);
  }

  /** Like run(), but throws on the first error a response carries. */
  async ok(commands: DynsecCommand[], timeoutMs?: number): Promise<DynsecResponse[]> {
    const rs = await this.run(commands, timeoutMs);
    const bad = rs.find((r) => r.error !== undefined);
    if (bad) throw new Error(`${bad.command}: ${bad.error}`);
    return rs;
  }

  close(): Promise<void> {
    return this.client.endAsync(true);
  }
}

/**
 * createClient + addClientRole, in one control message. Role `agent` carries the `%u`
 * grants of row (a); `bench-open` grants `volley/bench/#` WITHOUT a pattern, so sections
 * that measure something other than ACLs work on brokers whose plugin ignores `%u`.
 */
const createAgent = (
  username: string,
  password: string,
  roles: string[] = ["agent", "bench-open"],
): DynsecCommand[] => [
  { command: "createClient", username, password },
  ...roles.map((rolename) => ({ command: "addClientRole", username, rolename })),
];

// --- the observer: an admin connection that sees everything under volley/# -----------------------

interface Seen {
  topic: string;
  payload: string;
  t: number;
}
class Observer {
  readonly seen: Seen[] = [];
  private waiters: Array<{ pred: (s: Seen) => boolean; resolve: (t: number) => void }> = [];
  private constructor(readonly client: MqttClient) {
    client.on("message", (topic, payload) => {
      const s = { topic, payload: payload.toString(), t: now() };
      this.seen.push(s);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(s)) return true;
        w.resolve(s.t);
        return false;
      });
    });
  }
  static async open(filter = "volley/#"): Promise<Observer> {
    const c = await connect({ username: ADMIN_USER, password: ADMIN_PASS });
    await c.subscribeAsync(filter, { qos: 1 });
    return new Observer(c);
  }
  /** Time the first message matching `pred` arrived (already seen counts), or null after `ms`. */
  waitFor(pred: (s: Seen) => boolean, ms: number): Promise<number | null> {
    const hit = this.seen.find(pred);
    if (hit) return Promise.resolve(hit.t);
    return within(
      new Promise<number | null>((resolve) => this.waiters.push({ pred, resolve })),
      ms,
      null,
    );
  }
}

// --- shared state across sections -------------------------------------------------------------

let ctl: Dynsec;
let obs: Observer;
const results: Record<string, unknown> = {
  label: LABEL,
  quick: QUICK,
  run: RUN,
  ...(process.env.BENCH_CROSS_VERSION ? { j_crossVersion: process.env.BENCH_CROSS_VERSION } : {}),
};

async function reopen(): Promise<void> {
  await ctl?.close().catch(() => {});
  await obs?.client.endAsync(true).catch(() => {});
  ctl = await Dynsec.open();
  obs = await Observer.open();
}

/** Waits until the admin can log in again; returns ms from `since`. */
async function waitForLogin(since: number, timeoutMs = 120_000): Promise<number> {
  while (now() - since < timeoutMs) {
    if ((await tryConnect({ username: ADMIN_USER, password: ADMIN_PASS })) === "ok") {
      return round(now() - since);
    }
    await sleep(20);
  }
  throw new Error(`broker did not accept the admin login within ${timeoutMs} ms`);
}

async function restart(): Promise<{ stopMs: number; startToLoginMs: number }> {
  await ctl.close().catch(() => {});
  await obs.client.endAsync(true).catch(() => {});
  const t0 = now();
  const stop = await sh(STOP_CMD);
  if (stop.code !== 0) throw new Error(`stop failed: ${stop.out}`);
  const stopMs = round(now() - t0);
  const t1 = now();
  const start = await sh(START_CMD);
  if (start.code !== 0) throw new Error(`start failed: ${start.out}`);
  const startToLoginMs = await waitForLogin(t1);
  await reopen();
  return { stopMs, startToLoginMs };
}

async function clientCount(): Promise<number> {
  const [r] = await ctl.ok([{ command: "listClients", count: 1, offset: 0 }]);
  return Number(r?.data?.totalCount ?? Number.NaN);
}

// --- (i) bootstrap -----------------------------------------------------------------------------

/** The ACL shape of examples/mosquitto-auth/acl.conf, as Dynamic Security roles. */
function bootstrapCommands(passwords: Record<string, string>): DynsecCommand[] {
  const send = (topic: string) => ({ acltype: "publishClientSend", topic, allow: true });
  const readAll = { acltype: "subscribePattern", topic: "volley/#", allow: true };
  const leases = send("volley/_system/leases/+/requests");
  const own = ["status", "progress", "result", "capability", "control", "_user/#"];
  const roles: Record<string, Array<Record<string, unknown>>> = {
    "volley-agent": [
      ...own.map((ch) => send(`volley/+/%u/${ch}`)),
      send("volley/_system/registry/%u"),
      leases,
      readAll,
    ],
    "volley-volleyd": [send("volley/#"), readAll],
    "volley-desk": [send("volley/+/+/mailbox"), leases, readAll],
    "volley-coordinator": [
      ...["mailbox", ...own].map((ch) => send(`volley/+/+/${ch}`)),
      send("volley/_system/registry/+"),
      leases,
      readAll,
    ],
  };
  const cmds: DynsecCommand[] = [];
  for (const [rolename, acls] of Object.entries(roles)) {
    cmds.push({ command: "createRole", rolename });
    for (const acl of acls) cmds.push({ command: "addRoleACL", rolename, ...acl });
  }
  for (const who of ["volleyd", "desk", "coordinator"]) {
    cmds.push({ command: "createClient", username: who, password: passwords[who] ?? pw() });
    cmds.push({ command: "addClientRole", username: who, rolename: `volley-${who}` });
    // acl.conf's `pattern` lines apply to every user, so the steering identities also get the
    // own-channel grants (volleyd already writes all of volley/#).
    if (who !== "volleyd") {
      cmds.push({ command: "addClientRole", username: who, rolename: "volley-agent" });
    }
  }
  return cmds;
}

async function sectionBootstrap() {
  const passwords = { volleyd: pw(), desk: pw(), coordinator: pw() };
  const t0 = now();
  const first = await ctl.run(bootstrapCommands(passwords));
  const firstMs = round(now() - t0);
  const firstErrors = first.filter((r) => r.error).map((r) => `${r.command}: ${r.error}`);
  const aclCount = async () => {
    const [r] = await ctl.ok([{ command: "getRole", rolename: "volley-agent" }]);
    return ((r?.data?.role as { acls?: unknown[] })?.acls ?? []).length;
  };
  const aclsAfterFirst = await aclCount();

  // Re-run with the fixed identities connected: a second `volley auth init` must not kick them.
  const volleyd = await connect({ username: "volleyd", password: passwords.volleyd });
  const desk = await connect({ username: "desk", password: passwords.desk, url: URL_WS });
  const closes = [closedWithin(volleyd, 2000), closedWithin(desk, 2000)];
  const t1 = now();
  const second = await ctl.run(bootstrapCommands({ volleyd: pw(), desk: pw(), coordinator: pw() }));
  const secondMs = round(now() - t1);
  const kicked = (await Promise.all(closes)).filter((t) => t !== null).length;
  const errorsByText: Record<string, number> = {};
  for (const r of second) {
    if (!r.error) continue;
    const k = `${r.command}: ${r.error}`;
    errorsByText[k] = (errorsByText[k] ?? 0) + 1;
  }
  // Exactly the rerun errors README (i) tolerates; anything else counts against idempotency.
  const tolerated: Record<string, RegExp> = {
    createRole: /^Role already exists$/,
    addRoleACL: /^ACL with this topic already exists$/,
    createClient: /^Client already exists$/,
    addClientRole: /^Internal error$/,
  };
  const untolerated = second.filter((r) => r.error && !tolerated[r.command]?.test(r.error)).length;
  // The `addClientRole` text is not specific, so check the roles really are assigned.
  const [desc] = await ctl.ok([{ command: "getClient", username: "coordinator" }]);
  const coordinatorRoles = (
    (desc?.data?.client as { roles?: Array<{ rolename: string }> })?.roles ?? []
  )
    .map((r) => r.rolename)
    .sort();
  // A rerun keeps the FIRST password: the original credential still logs in.
  const oldPasswordStillWorks =
    (await tryConnect({ username: "coordinator", password: passwords.coordinator })) === "ok";
  await volleyd.endAsync().catch(() => {});
  await desk.endAsync().catch(() => {});

  let initRerun: string | undefined = process.env.BENCH_INIT_RERUN;
  if (initRerun)
    initRerun = initRerun
      .replace(/\s+/g, " ")
      .trim()
      .replace(/'[^']*'/, "'<file>'");
  const mode = (statSync(JSON_PATH).mode & 0o777).toString(8);
  results.i_bootstrap = {
    commands: first.length,
    firstRunMs: firstMs,
    firstRunErrors: firstErrors,
    rerunMs: secondMs,
    rerunErrors: errorsByText,
    rerunUntoleratedErrors: untolerated,
    coordinatorRolesAfterRerun: coordinatorRoles,
    aclsAfterFirst,
    aclsAfterRerun: await aclCount(),
    connectedFixedIdentitiesKickedByRerun: kicked,
    rerunKeepsOriginalPassword: oldPasswordStillWorks,
    initRerunOnExistingFile: initRerun ?? "not recorded",
    dynsecJsonModeAfterPluginWrite: mode,
  };
}

// --- (a) role ACLs with %u / %c --------------------------------------------------------------------

const acl = (rolename: string, acltype: string, topic: string): DynsecCommand => ({
  command: "addRoleACL",
  rolename,
  acltype,
  topic,
  allow: true,
});

/** The roles every section uses. Tolerates "already exists", so a rerun is harmless. */
async function setupRoles() {
  await ctl.run([
    // Row (a): the shape S5 wants, one static role for every agent.
    { command: "createRole", rolename: "agent" },
    acl("agent", "publishClientSend", "volley/+/%u/#"),
    acl("agent", "publishClientSend", "volley/_system/registry/%u"),
    acl("agent", "subscribeLiteral", "volley/#"),
    acl("agent", "subscribePattern", "volley/#"),
    { command: "createRole", rolename: "agent-c" },
    acl("agent-c", "publishClientSend", "volley/+/%c/#"),
    // No pattern: lets the non-ACL sections publish on any broker version.
    { command: "createRole", rolename: "bench-open" },
    acl("bench-open", "publishClientSend", "volley/bench/#"),
  ]);
}

/** The parent an agent acks to, besides volleyd (SPEC §4.4: acks go to the sender's mailbox). */
const BENCH_PARENT = "coordinator-bench";

/**
 * S5's agent identity, and the fallback when `%u` is not substituted: one role
 * `agent:<id>` per agent with the id written into its topics, minted together with the
 * client in ONE control message (13 commands, 11 ACLs). Retire with deletePerAgentRole.
 */
function perAgentRole(username: string, password: string): DynsecCommand[] {
  const rolename = `agent:${username}`;
  const own = ["status", "progress", "result", "capability", "control", "_user/#"];
  return [
    { command: "createRole", rolename },
    ...own.map((ch) => acl(rolename, "publishClientSend", `volley/+/${username}/${ch}`)),
    acl(rolename, "publishClientSend", `volley/_system/registry/${username}`),
    acl(rolename, "publishClientSend", "volley/_system/leases/+/requests"),
    acl(rolename, "publishClientSend", `volley/+/${BENCH_PARENT}/mailbox`),
    acl(rolename, "publishClientSend", "volley/+/volleyd/mailbox"),
    acl(rolename, "subscribePattern", "volley/#"),
    { command: "createClient", username, password, roles: [{ rolename }] },
  ];
}
const deletePerAgentRole = (username: string): DynsecCommand[] => [
  { command: "deleteClient", username },
  { command: "deleteRole", rolename: `agent:${username}` },
];

async function sectionAcl() {
  const x = `${RUN}-x`;
  const y = `${RUN}-y`;
  const c = `${RUN}-c`;
  const cid = `${RUN}-cid`;
  const l = `${RUN}-l`;
  const pass = { x: pw(), y: pw(), c: pw(), l: pw() };
  await ctl.ok([
    ...createAgent(x, pass.x, ["agent"]),
    ...createAgent(y, pass.y, ["agent"]),
    ...createAgent(c, pass.c, ["agent-c"]),
    ...perAgentRole(l, pass.l),
  ]);

  const cx = await connect({ username: x, password: pass.x, clientId: x, protocolVersion: 4 });
  const cc = await connect({ username: c, password: pass.c, clientId: cid, protocolVersion: 4 });
  const cl = await connect({ username: l, password: pass.l, clientId: l, protocolVersion: 4 });
  const cases: Array<{
    who: string;
    client: MqttClient;
    topic: string;
    expect: boolean;
    note: string;
    literal?: true;
  }> = [
    {
      who: x,
      client: cx,
      topic: `volley/bench/${x}/status`,
      expect: true,
      note: "own status (%u)",
    },
    {
      who: x,
      client: cx,
      topic: `volley/bench/${y}/mailbox`,
      expect: false,
      note: "other agent's mailbox",
    },
    {
      who: x,
      client: cx,
      topic: `volley/bench/${y}/status`,
      expect: false,
      note: "other agent's status",
    },
    {
      who: x,
      client: cx,
      topic: `volley/_system/registry/${x}`,
      expect: true,
      note: "own registry entry",
    },
    {
      who: x,
      client: cx,
      topic: `volley/_system/registry/${y}`,
      expect: false,
      note: "other registry entry",
    },
    {
      who: c,
      client: cc,
      topic: `volley/bench/${cid}/status`,
      expect: true,
      note: "%c = client id",
    },
    {
      who: c,
      client: cc,
      topic: `volley/bench/${c}/status`,
      expect: false,
      note: "%c is not the username",
    },
    // The `+` caveat of acl.conf, unchanged under dynsec: `+` also matches reserved levels.
    {
      who: x,
      client: cx,
      topic: `volley/_waves/${x}/status`,
      expect: true,
      note: "`+` matches _waves (caveat)",
    },
    // Control cases: a per-agent role with the id written literally. Proves the observer
    // sees allowed traffic, so a non-delivery above is the plugin denying it.
    {
      who: l,
      client: cl,
      topic: `volley/bench/${l}/status`,
      expect: true,
      note: "per-agent literal role: own status",
      literal: true,
    },
    {
      who: l,
      client: cl,
      topic: `volley/bench/${y}/mailbox`,
      expect: false,
      note: "per-agent literal role: other mailbox",
      literal: true,
    },
  ];
  const rows = [];
  for (const k of cases) {
    const nonce = pw();
    await k.client.publishAsync(k.topic, nonce, { qos: 1 });
    const t = await obs.waitFor((s) => s.topic === k.topic && s.payload === nonce, 700);
    rows.push({ ...k, client: undefined, delivered: t !== null, pass: (t !== null) === k.expect });
  }
  // MQTT v5 publishers learn about the denial from the PUBACK reason code.
  const x5 = await connect({ username: x, password: pass.x, protocolVersion: 5 });
  let v5Denied = "PUBACK success (no reason code)";
  try {
    await x5.publishAsync(`volley/bench/${y}/mailbox`, "v5", { qos: 1 });
  } catch (e) {
    v5Denied = (e as Error).message;
  }
  const granted = await cx.subscribeAsync(["volley/bench/+/mailbox", "volley/#"], { qos: 1 });
  await Promise.all([cx.endAsync(), cc.endAsync(), cl.endAsync(), x5.endAsync()]);
  await ctl.ok(deletePerAgentRole(l));
  results.a_acl = {
    cases: rows.map(({ who, topic, expect, delivered, pass, note }) => ({
      who,
      topic,
      note,
      expect,
      delivered,
      pass,
    })),
    patternCasesPass: rows.filter((r) => !r.literal).every((r) => r.pass),
    literalControlPass: rows.filter((r) => r.literal).every((r) => r.pass),
    v5PubackOnDenied: v5Denied,
    v311PubackOnDenied: "PUBACK success (MQTT 3.1.1 has no reason code; the message is dropped)",
    subscribeGranted: granted.map((g) => `${g.topic} -> qos ${g.qos}`),
  };
}

// --- (h) listeners ------------------------------------------------------------------------------------

async function sectionListeners() {
  const u = `${RUN}-h`;
  const p = pw();
  const y = `${RUN}-hy`;
  // Literal per-agent role: the WebSocket ACL check must not depend on `%u` support.
  await ctl.ok([...perAgentRole(u, p), ...createAgent(y, pw(), ["agent"])]);
  const main: Record<string, string> = {};
  for (const [name, url] of [
    ["tcp", URL_TCP],
    ["ws", URL_WS],
  ] as const) {
    main[`${name} dynsec client`] = await tryConnect({
      url,
      username: u,
      password: p,
      protocolVersion: 4,
    });
    main[`${name} wrong password`] = await tryConnect({
      url,
      username: u,
      password: "nope",
      protocolVersion: 4,
    });
    main[`${name} anonymous`] = await tryConnect({ url, protocolVersion: 4 });
  }
  // The ACL holds over the WebSocket listener too.
  const ws = await connect({ url: URL_WS, username: u, password: p, protocolVersion: 4 });
  const nonce = pw();
  await ws.publishAsync(`volley/bench/${y}/mailbox`, nonce, { qos: 1 });
  await ws.publishAsync(`volley/bench/${u}/status`, nonce, { qos: 1 });
  const deniedSeen = await obs.waitFor(
    (s) => s.topic === `volley/bench/${y}/mailbox` && s.payload === nonce,
    700,
  );
  const ownSeen = await obs.waitFor(
    (s) => s.topic === `volley/bench/${u}/status` && s.payload === nonce,
    700,
  );
  await ws.endAsync();
  main["ws ACL: other mailbox delivered"] = String(deniedSeen !== null);
  main["ws ACL: own status delivered"] = String(ownSeen !== null);
  await ctl.ok([...deletePerAgentRole(u), { command: "deleteClient", username: y }]);

  const pls: Record<string, string> = { status: process.env.BENCH_PLS_STATUS ?? "not started" };
  const plsTcp = process.env.BENCH_PLS_URL;
  const plsWs = process.env.BENCH_PLS_WS_URL;
  if (plsTcp && plsWs && pls.status === "started") {
    for (const [name, url] of [
      ["tcp", plsTcp],
      ["ws", plsWs],
    ] as const) {
      pls[`${name} dynsec admin`] = await tryConnect({
        url,
        username: ADMIN_USER,
        password: ADMIN_PASS,
      });
      pls[`${name} wrong password`] = await tryConnect({
        url,
        username: ADMIN_USER,
        password: "nope",
      });
      pls[`${name} anonymous`] = await tryConnect({ url, protocolVersion: 4 });
    }
    // Each listener loaded its own plugin instance over the same file: do they share clients?
    const plsCtl = await Dynsec.open("pls", plsTcp);
    const u2 = `${RUN}-pls`;
    const p2 = pw();
    await plsCtl.ok([{ command: "createClient", username: u2, password: p2 }]);
    pls["client created via tcp instance: tcp login"] = await tryConnect({
      url: plsTcp,
      username: u2,
      password: p2,
    });
    pls["client created via tcp instance: ws login"] = await tryConnect({
      url: plsWs,
      username: u2,
      password: p2,
    });
    await plsCtl.close();
  }
  results.h_listeners = { perListenerSettingsFalse: main, perListenerSettingsTrue: pls };
}

// --- (g) expiry -----------------------------------------------------------------------------------

async function sectionExpiry() {
  const u = `${RUN}-g`;
  // Unknown fields are offered on purpose: does the plugin keep anything like a TTL?
  const [created] = await ctl.run([
    { command: "createClient", username: u, password: pw(), expiry: 60, ttl: 60, expiresAt: 1 },
  ]);
  const [got] = await ctl.ok([{ command: "getClient", username: u }]);
  const client = (got?.data?.client ?? {}) as Record<string, unknown>;
  const file = readFileSync(JSON_PATH, "utf8");
  const entry = (JSON.parse(file) as { clients?: Array<Record<string, unknown>> }).clients?.find(
    (c) => c.username === u,
  );
  const keys = Object.keys(client);
  results.g_expiry = {
    createWithUnknownFields: created?.error ?? "accepted",
    getClientFields: keys,
    fileEntryFields: Object.keys(entry ?? {}),
    anyExpiryField: [...keys, ...Object.keys(entry ?? {})].some((k) => /expir|ttl/i.test(k)),
  };
  await ctl.ok([{ command: "deleteClient", username: u }]);
}

// --- (f) deleting / disabling a connected client -------------------------------------------------------

async function sectionKick() {
  const trials = QUICK ? 5 : 20;
  const out: Record<string, unknown> = {};
  for (const action of ["deleteClient", "disableClient"] as const) {
    const ack: number[] = [];
    const closed: number[] = [];
    const will: number[] = [];
    let notClosed = 0;
    let closedBeforeAck = 0;
    let noWill = 0;
    let reconnectWhileDisabled = "n/a";
    let reconnectAfterEnable = "n/a";
    for (let i = 0; i < trials; i++) {
      const u = `${RUN}-f${action.slice(0, 3)}${i}`;
      const p = pw();
      await ctl.ok(createAgent(u, p));
      const willTopic = `volley/bench/${u}/status`;
      const c = await connect({
        username: u,
        password: p,
        clientId: u,
        protocolVersion: 4,
        will: { topic: willTopic, payload: `{"type":"crashed","n":${i}}`, qos: 1, retain: true },
      });
      await sleep(30);
      const closeP = closedWithin(c, 5000);
      const willP = obs.waitFor(
        (s) => s.topic === willTopic && s.payload.includes("crashed"),
        3000,
      );
      const t0 = now();
      await ctl.ok([{ command: action, username: u }]);
      ack.push(now() - t0);
      const tAck = now();
      const tc = await closeP;
      if (tc === null) notClosed++;
      else closed.push(tc - t0);
      // Client-side order only: the ack and the close arrive on different sockets.
      if (tc !== null && tc < tAck) closedBeforeAck++;
      const tw = await willP;
      if (tw === null) noWill++;
      else will.push(tw - t0);
      if (tc === null) await c.endAsync(true);
      if (action === "disableClient") {
        if (i === 0) {
          reconnectWhileDisabled = await tryConnect({
            username: u,
            password: p,
            protocolVersion: 4,
          });
          await ctl.ok([{ command: "enableClient", username: u }]);
          reconnectAfterEnable = await tryConnect({ username: u, password: p, protocolVersion: 4 });
        }
        await ctl.ok([{ command: "deleteClient", username: u }]);
      }
    }
    // One v5 trial for the DISCONNECT reason code a kicked client sees.
    const u = `${RUN}-f${action.slice(0, 3)}v5`;
    const p = pw();
    await ctl.ok(createAgent(u, p));
    const c5 = await connect({ username: u, password: p, protocolVersion: 5 });
    const reason = within(
      new Promise<string>((r) =>
        c5.on("disconnect", (pk) => r(`DISCONNECT reason ${pk.reasonCode}`)),
      ),
      3000,
      "no DISCONNECT packet (socket closed)",
    );
    await ctl.ok([{ command: action, username: u }]);
    const v5Reason = await reason;
    await c5.endAsync(true);
    if (action === "disableClient") await ctl.ok([{ command: "deleteClient", username: u }]);
    // Control: the same client crashing (socket dropped, no DISCONNECT) does publish its will.
    const uc = `${RUN}-f${action.slice(0, 3)}crash`;
    const pc = pw();
    await ctl.ok(createAgent(uc, pc));
    const crashTopic = `volley/bench/${uc}/status`;
    const cc = await connect({
      username: uc,
      password: pc,
      clientId: uc,
      protocolVersion: 4,
      will: { topic: crashTopic, payload: '{"type":"crashed"}', qos: 1, retain: true },
    });
    await sleep(30);
    const tCrash = now();
    cc.stream.destroy();
    const crashWill = await obs.waitFor((s) => s.topic === crashTopic, 3000);
    await ctl.ok([{ command: "deleteClient", username: uc }]);
    out[action] = {
      trials,
      controlCrashWillMs: crashWill === null ? null : round(crashWill - tCrash, 2),
      ackMs: summary(ack),
      disconnectMs: summary(closed),
      notDisconnected: notClosed,
      closedBeforeAckClientSide: closedBeforeAck,
      willMs: summary(will),
      noWill,
      v5Reason,
      ...(action === "disableClient" ? { reconnectWhileDisabled, reconnectAfterEnable } : {}),
    };
  }
  results.f_kick = out;
}

// --- (b) create + delete latency -----------------------------------------------------------------------

async function sectionLatency() {
  const levels = QUICK ? [1, 10, 50] : [1, 10, 50, 200];
  const rows = [];
  for (const mode of ["shared", "per-worker"] as const) {
    for (const conc of levels) {
      const ops = QUICK ? 50 : Math.max(200, conc * 2);
      const conns =
        mode === "shared"
          ? [ctl]
          : await Promise.all(Array.from({ length: conc }, () => Dynsec.open("w")));
      const names = Array.from({ length: ops }, (_, i) => `${RUN}-b${mode[0]}${conc}-${i}`);
      const create: number[] = [];
      const del: number[] = [];
      let t0 = now();
      await pool(ops, conc, async (i, w) => {
        const d = conns[mode === "shared" ? 0 : w] as Dynsec;
        const t = now();
        await d.ok(createAgent(names[i] as string, pw(), ["agent"]));
        create.push(now() - t);
      });
      const createWall = now() - t0;
      t0 = now();
      await pool(ops, conc, async (i, w) => {
        const d = conns[mode === "shared" ? 0 : w] as Dynsec;
        const t = now();
        await d.ok([{ command: "deleteClient", username: names[i] as string }]);
        del.push(now() - t);
      });
      const deleteWall = now() - t0;
      const foreign = mode === "shared" ? 0 : conns.reduce((a, d) => a + d.foreign, 0);
      if (mode === "per-worker") await Promise.all(conns.map((d) => d.close()));
      rows.push({
        mode,
        concurrency: conc,
        ops,
        create: { ...summary(create), opsPerSec: round(ops / (createWall / 1000)) },
        delete: { ...summary(del), opsPerSec: round(ops / (deleteWall / 1000)) },
        responsesSeenByOtherConnections: foreign,
      });
      log(
        `(b) ${mode} c=${conc}: create ${fmt(summary(create))}, ${round(ops / (createWall / 1000))} ops/s`,
      );
    }
  }
  // createClient with the role inline (one command instead of two), sequential.
  const inline: number[] = [];
  for (let i = 0; i < (QUICK ? 30 : 100); i++) {
    const u = `${RUN}-bi-${i}`;
    const t = now();
    await ctl.ok([
      { command: "createClient", username: u, password: pw(), roles: [{ rolename: "agent" }] },
    ]);
    inline.push(now() - t);
    await ctl.ok([{ command: "deleteClient", username: u }]);
  }
  // Per-agent roles (mint + retire pairs) are measured in section (k).
  results.b_latency = { rows, inlineRoleCreate: summary(inline) };
}

// --- (c) churn isolation + role edits with agents connected ---------------------------------------------

interface Agent {
  name: string;
  password: string;
  client: MqttClient;
  acked: Set<number>;
  closes: number;
}

async function connectAgent(a: Omit<Agent, "client"> & { client?: MqttClient }): Promise<Agent> {
  const client = await connect({
    username: a.name,
    password: a.password,
    clientId: a.name,
    protocolVersion: 4,
    will: {
      topic: `volley/bench/${a.name}/status`,
      payload: '{"type":"crashed"}',
      qos: 1,
      retain: true,
    },
  });
  const agent = a as Agent;
  agent.client = client;
  client.on("close", () => agent.closes++);
  return agent;
}

async function sectionChurn() {
  const nAgents = 50;
  const nChurn = QUICK ? 50 : 200;
  const durationMs = QUICK ? 8_000 : 30_000;
  const agents: Agent[] = [];
  const setup: DynsecCommand[] = [];
  for (let i = 0; i < nAgents; i++) {
    const a = { name: `${RUN}-ca${i}`, password: pw(), acked: new Set<number>(), closes: 0 };
    setup.push(...createAgent(a.name, a.password));
    agents.push(a as Agent);
  }
  await ctl.ok(setup);
  await Promise.all(agents.map((a) => connectAgent(a)));

  const counter = await Observer.open("volley/bench/+/progress");
  let observerCloses = 0;
  counter.client.on("close", () => observerCloses++);
  const received = new Map<string, Set<number>>();
  counter.client.on("message", (topic, payload) => {
    const name = topic.split("/")[2] as string;
    const s = received.get(name) ?? new Set<number>();
    received.set(name, s);
    s.add(Number(payload.toString()));
  });

  const stopAt = now() + durationMs;
  const publishers = agents.map(async (a) => {
    let seq = 0;
    while (now() < stopAt) {
      const n = seq++;
      a.client
        .publishAsync(`volley/bench/${a.name}/progress`, String(n), { qos: 1 })
        .then(() => a.acked.add(n))
        .catch(() => {});
      await sleep(100);
    }
  });

  // Churn: nChurn slots, each looping create -> connect -> publish -> delete (kick) -> repeat.
  const cycle: number[] = [];
  let churnErrors = 0;
  let firstChurnError: string | undefined;
  let cycles = 0;
  const churners = Array.from({ length: nChurn }, async (_, slot) => {
    let k = 0;
    while (now() < stopAt) {
      const u = `${RUN}-cc${slot}-${k++}`;
      const p = pw();
      const t = now();
      try {
        await ctl.ok(createAgent(u, p));
        const c = await connect({ username: u, password: p, clientId: u, protocolVersion: 4 });
        await c.publishAsync(`volley/bench/${u}/status`, "{}", { qos: 1 });
        const closed = closedWithin(c, 3000);
        await ctl.ok([{ command: "deleteClient", username: u }]);
        if ((await closed) === null) await c.endAsync(true);
        cycle.push(now() - t);
        cycles++;
      } catch (e) {
        churnErrors++;
        firstChurnError ??= (e as Error).message;
        await sleep(100);
      }
    }
  });
  await Promise.all([...publishers, ...churners]);
  await sleep(1500);

  let acked = 0;
  let lost = 0;
  for (const a of agents) {
    const got = received.get(a.name) ?? new Set<number>();
    acked += a.acked.size;
    for (const n of a.acked) if (!got.has(n)) lost++;
  }
  const disconnects = agents.reduce((s, a) => s + a.closes, 0);
  results.c_churn = {
    agents: nAgents,
    msgPerSecPerAgent: 10,
    churnSlots: nChurn,
    durationS: durationMs / 1000,
    churnCycles: cycles,
    churnCyclesPerSec: round(cycles / (durationMs / 1000)),
    churnCycleMs: summary(cycle),
    churnErrors,
    ...(firstChurnError ? { firstChurnError } : {}),
    agentMessagesAcked: acked,
    agentMessagesLost: lost,
    agentDisconnects: disconnects,
    observerDisconnects: observerCloses,
  };
  await counter.client.endAsync();
  await sectionRoleEdits(agents);
  await Promise.all(agents.map((a) => a.client.endAsync().catch(() => {})));
  await ctl.ok(agents.map((a) => ({ command: "deleteClient", username: a.name })));
}

/** Which control operations kick the 50 connected agents (they all hold role `agent`). */
async function sectionRoleEdits(agents: Agent[]) {
  const [a0, a1] = agents as [Agent, Agent];
  const extra = { acltype: "publishClientSend", topic: "volley/bench/extra/#", allow: true };
  const newPass = pw();
  const steps: Array<[string, DynsecCommand[], (() => void)?]> = [
    [
      "addRoleACL (new ACL) on role agent",
      [{ command: "addRoleACL", rolename: "agent", ...extra }],
    ],
    [
      "addRoleACL (same ACL again) on role agent",
      [{ command: "addRoleACL", rolename: "agent", ...extra }],
    ],
    [
      "removeRoleACL on role agent",
      [{ command: "removeRoleACL", rolename: "agent", acltype: extra.acltype, topic: extra.topic }],
    ],
    [
      "createRole + addRoleACL on an unrelated role",
      [
        { command: "createRole", rolename: `${RUN}-other` },
        { command: "addRoleACL", rolename: `${RUN}-other`, ...extra },
      ],
    ],
    [
      "addClientRole on one connected agent",
      [{ command: "addClientRole", username: a0.name, rolename: `${RUN}-other` }],
    ],
    [
      "setClientPassword on one connected agent",
      [{ command: "setClientPassword", username: a1.name, password: newPass }],
      () => {
        a1.password = newPass;
      },
    ],
    [
      "createClient + deleteClient of an unrelated client",
      [
        { command: "createClient", username: `${RUN}-unrel`, password: pw() },
        { command: "deleteClient", username: `${RUN}-unrel` },
      ],
    ],
  ];
  const rows: Record<string, unknown> = {};
  for (const [name, cmds, after] of steps) {
    const before = agents.map((a) => a.closes);
    const rs = await ctl.run(cmds);
    after?.();
    await sleep(1500);
    const kicked = agents.filter((a, i) => a.closes > (before[i] ?? 0));
    rows[name] = {
      kickedOf50: kicked.length,
      errors: rs.filter((r) => r.error).map((r) => r.error),
    };
    // Reconnect whoever was kicked, so every step starts with 50 connected agents.
    await Promise.all(kicked.map((a) => a.client.endAsync(true).then(() => connectAgent(a))));
  }
  results.c_roleEdits = rows;
}

// --- (d) scale --------------------------------------------------------------------------------------

async function sectionScale(target: number) {
  const before = await clientCount();
  const toCreate = Math.max(0, target - before);
  const batch = 100;
  const batchMs: number[] = [];
  const sample: Array<{ name: string; password: string }> = [];
  const t0 = now();
  for (let i = 0; i < toCreate; i += batch) {
    const cmds: DynsecCommand[] = [];
    for (let j = i; j < Math.min(toCreate, i + batch); j++) {
      const name = `${RUN}-d${target}-${j}`;
      const password = pw();
      if (j % Math.max(1, Math.floor(toCreate / 10)) === 0) sample.push({ name, password });
      cmds.push({
        command: "createClient",
        username: name,
        password,
        roles: [{ rolename: "agent" }],
      });
    }
    const t = now();
    await ctl.ok(cmds, 600_000);
    batchMs.push(now() - t);
    if ((i / batch) % 20 === 0) log(`(d) ${target}: ${i + cmds.length}/${toCreate} created`);
  }
  const bulkMs = now() - t0;
  const total = await clientCount();

  const single: number[] = [];
  const singleDelete: number[] = [];
  for (let i = 0; i < (QUICK ? 5 : 20); i++) {
    const u = `${RUN}-ds${target}-${i}`;
    let t = now();
    // 2 commands (createClient + addClientRole): 2 file writes on 2.0, 1 on 2.1.
    await ctl.ok(createAgent(u, pw(), ["agent"]));
    single.push(now() - t);
    t = now();
    await ctl.ok([{ command: "deleteClient", username: u }]);
    singleDelete.push(now() - t);
  }
  const listAll: number[] = [];
  let listAllBytes = 0;
  for (let i = 0; i < 5; i++) {
    const t = now();
    const [r] = await ctl.ok([{ command: "listClients", verbose: false }], 600_000);
    listAll.push(now() - t);
    listAllBytes = JSON.stringify(r).length;
  }
  const listPage: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t = now();
    await ctl.ok([
      { command: "listClients", verbose: false, count: 100, offset: Math.floor(total / 2) },
    ]);
    listPage.push(now() - t);
  }
  const loginMs: number[] = [];
  for (const s of sample.slice(0, 5)) {
    const t = now();
    const r = await tryConnect({ username: s.name, password: s.password, protocolVersion: 4 });
    if (r !== "ok") throw new Error(`scale sample ${s.name} could not log in: ${r}`);
    loginMs.push(now() - t);
  }
  const jsonBytes = statSync(JSON_PATH).size;
  const rss = await rssKiB();
  const rs = await restart();
  const s0 = sample[0];
  const sampleLoginAfterRestart = s0
    ? await tryConnect({ username: s0.name, password: s0.password, protocolVersion: 4 })
    : "n/a";
  const key = `d_scale_${target}`;
  results[key] = {
    clients: total,
    bulkCreate: {
      created: toCreate,
      batchSize: batch,
      seconds: round(bulkMs / 1000),
      clientsPerSec: round(toCreate / (bulkMs / 1000)),
      firstBatchMs: round(batchMs[0] ?? 0),
      lastBatchMs: round(batchMs[batchMs.length - 1] ?? 0),
    },
    singleCreateAtSize: summary(single),
    singleDeleteAtSize: summary(singleDelete),
    listClientsAll: { ...summary(listAll), responseBytes: listAllBytes },
    listClientsPage100: summary(listPage),
    loginAtSize: summary(loginMs),
    dynsecJsonBytes: jsonBytes,
    brokerRssKiB: rss,
    rssAfterRestartKiB: await rssKiB(),
    gracefulStopMs: rs.stopMs,
    restartToFirstLoginMs: rs.startToLoginMs,
    sampleLoginAfterRestart,
  };
  return sample;
}

async function sectionBaselineRestart() {
  results.d_scale_baseline = {
    clients: await clientCount(),
    dynsecJsonBytes: statSync(JSON_PATH).size,
    brokerRssKiB: await rssKiB(),
    ...(await restart()),
  };
}

// --- (e) persistence ---------------------------------------------------------------------------------

async function sectionPersistence(earlier: Array<{ name: string; password: string }>) {
  // Write cadence: is the file rewritten (atomically?) before the command is acknowledged?
  const dir = dirname(JSON_PATH);
  const names = new Set<string>();
  const watcher = watch(dir, (_ev, f) => {
    if (f) names.add(String(f));
  });
  const visibleDelay: number[] = [];
  let visibleAtAck = 0;
  let inodeChanges = 0;
  const writes = QUICK ? 10 : 30;
  for (let i = 0; i < writes; i++) {
    const u = `${RUN}-ew${i}`;
    const ino = statSync(JSON_PATH).ino;
    await ctl.ok(createAgent(u, pw(), ["agent"]));
    const tAck = now();
    if (readFileSync(JSON_PATH, "utf8").includes(`"${u}"`)) {
      visibleAtAck++;
      visibleDelay.push(0);
    } else {
      while (now() - tAck < 30_000) {
        await sleep(5);
        if (readFileSync(JSON_PATH, "utf8").includes(`"${u}"`)) break;
      }
      visibleDelay.push(now() - tAck);
    }
    if (statSync(JSON_PATH).ino !== ino) inodeChanges++;
    await sleep(50);
  }
  watcher.close();
  const base = basename(JSON_PATH);
  const cadence = {
    writes,
    visibleInFileAtAck: visibleAtAck,
    visibleDelayMs: summary(visibleDelay),
    fileReplacedByRename: inodeChanges,
    tempFilesSeen: [...names].filter((n) => n.startsWith(base) && n !== base),
  };

  // kill -9 mid-churn.
  const trials = QUICK ? 3 : 10;
  const rows = [];
  for (let k = 0; k < trials; k++) {
    const acked: Array<{ name: string; password: string }> = [];
    let stop = false;
    const workers = Array.from({ length: 10 }, async (_, w) => {
      for (let n = 0; !stop; n++) {
        const name = `${RUN}-ek${k}-${w}-${n}`;
        const password = pw();
        try {
          await ctl.ok(createAgent(name, password, ["agent"]), 10_000);
          // Every ack the client received is a real ack, even one read after the kill.
          acked.push({ name, password });
        } catch {
          return;
        }
      }
    });
    await sleep(300 + Math.random() * 1200);
    const kill = await sh(KILL_CMD);
    stop = true;
    if (kill.code !== 0) throw new Error(`kill failed: ${kill.out}`);
    await ctl.close().catch(() => {});
    await obs.client.endAsync(true).catch(() => {});
    await Promise.all(workers);
    let parse = "ok";
    let present = new Set<string>();
    try {
      const doc = JSON.parse(readFileSync(JSON_PATH, "utf8")) as {
        clients: Array<{ username: string }>;
      };
      present = new Set(doc.clients.map((c) => c.username));
    } catch (e) {
      parse = `CORRUPT: ${(e as Error).message}`;
    }
    const leftovers = readdirSync(dir).filter((f) => f.startsWith(base) && f !== base);
    const missing = acked.filter((a) => !present.has(a.name)).length;
    const t = now();
    const start = await sh(START_CMD);
    if (start.code !== 0) throw new Error(`start after kill failed: ${start.out}`);
    const restartMs = await waitForLogin(t);
    await reopen();
    const probe = [...acked.slice(-5), ...acked.slice(0, 5), ...earlier.slice(0, 3)];
    let loginOk = 0;
    for (const a of probe) {
      if (
        (await tryConnect({ username: a.name, password: a.password, protocolVersion: 4 })) === "ok"
      )
        loginOk++;
    }
    rows.push({
      acked: acked.length,
      json: parse,
      ackedButMissing: missing,
      leftovers,
      restartMs,
      loginOk,
      loginTried: probe.length,
    });
    log(`(e) kill -9 trial ${k}: ${acked.length} acked, ${missing} missing, json ${parse}`);
  }
  results.e_persistence = {
    cadence,
    kill9: {
      trials,
      corruptFiles: rows.filter((r) => r.json !== "ok").length,
      ackedButMissing: rows.reduce((s, r) => s + r.ackedButMissing, 0),
      ackedTotal: rows.reduce((s, r) => s + r.acked, 0),
      loginFailures: rows.reduce((s, r) => s + (r.loginTried - r.loginOk), 0),
      rows,
    },
  };
}

// --- (k) per-agent roles at scale (S5's identity shape) -------------------------------------------

interface FileClient {
  username: string;
  roles?: Array<{ rolename: string }>;
  [k: string]: unknown;
}
interface FileRole {
  rolename: string;
  acls?: Array<Record<string, unknown>>;
}

/**
 * The file entries `commands` would create, for writing a population into the stopped broker's
 * dynamic-security.json: minting 10,000 agents over the API takes hours on 2.0.x, which rewrites
 * the whole file after every command. The 2.0 hash format (PBKDF2-SHA512, 101 iterations) loads
 * on 2.0 and 2.1 alike; each population is checked by logging in as one of its agents.
 */
function fileEntries(commands: DynsecCommand[]): { clients: FileClient[]; roles: FileRole[] } {
  const roles = new Map<string, FileRole>();
  const clients: FileClient[] = [];
  for (const c of commands) {
    if (c.command === "createRole")
      roles.set(String(c.rolename), { rolename: String(c.rolename), acls: [] });
    if (c.command === "addRoleACL") {
      roles
        .get(String(c.rolename))
        ?.acls?.push({ acltype: c.acltype, topic: c.topic, allow: true });
    }
    if (c.command === "createClient") {
      const salt = randomBytes(12);
      const hash = pbkdf2Sync(String(c.password), salt, 101, 64, "sha512");
      clients.push({
        username: String(c.username),
        password: hash.toString("base64"),
        salt: salt.toString("base64"),
        iterations: 101,
        roles: (c.roles as Array<{ rolename: string }>) ?? [],
      });
    }
  }
  return { clients, roles: [...roles.values()] };
}

/** A population of `n` agents: per-agent roles, or clients sharing role `agent` (client-only). */
function population(n: number, tag: string, perAgent: boolean) {
  const password = pw();
  const cmds: DynsecCommand[] = [];
  for (let i = 0; i < n; i++) {
    const username = `${RUN}-${tag}-${i}`;
    if (perAgent) cmds.push(...perAgentRole(username, password));
    else cmds.push({ command: "createClient", username, password, roles: [{ rolename: "agent" }] });
  }
  return { ...fileEntries(cmds), sample: { name: `${RUN}-${tag}-${n - 1}`, password } };
}

/**
 * Stops the broker, replaces every agent in its file with `pop` (keeping the admin, the fixed
 * identities and the publishers), starts it again and measures the load.
 */
async function loadPopulation(
  pop: { clients: FileClient[]; roles: FileRole[]; sample?: { name: string; password: string } },
  keep: (username: string) => boolean,
) {
  await ctl.close().catch(() => {});
  await obs.client.endAsync(true).catch(() => {});
  const stop = await sh(STOP_CMD);
  if (stop.code !== 0) throw new Error(`stop failed: ${stop.out}`);
  const doc = JSON.parse(readFileSync(JSON_PATH, "utf8")) as {
    clients: FileClient[];
    roles: FileRole[];
  };
  doc.clients = doc.clients.filter((c) => keep(c.username)).concat(pop.clients);
  const held = new Set(doc.clients.flatMap((c) => (c.roles ?? []).map((r) => r.rolename)));
  doc.roles = doc.roles
    .filter((r) => !r.rolename.startsWith("agent:") || held.has(r.rolename))
    .concat(pop.roles);
  writeFileSync(JSON_PATH, JSON.stringify(doc), { mode: 0o600 });
  const t = now();
  const start = await sh(START_CMD);
  if (start.code !== 0) throw new Error(`start failed: ${start.out}`);
  const toAdminLoginMs = await waitForLogin(t);
  let toAgentLoginMs: number | null = null;
  if (pop.sample) {
    const r = await tryConnect({
      username: pop.sample.name,
      password: pop.sample.password,
      protocolVersion: 4,
    });
    if (r !== "ok") throw new Error(`injected agent ${pop.sample.name} cannot log in: ${r}`);
    toAgentLoginMs = round(now() - t);
  }
  await reopen();
  // Make the plugin rewrite the file in its own format before measuring its size.
  const dummy = `${RUN}-ksave`;
  await ctl.ok([
    { command: "createClient", username: dummy, password: pw() },
    { command: "deleteClient", username: dummy },
  ]);
  return {
    agents: pop.clients.length,
    rolesInFile: doc.roles.length,
    toAdminLoginMs,
    toAgentLoginMs,
    dynsecJsonBytes: statSync(JSON_PATH).size,
    brokerRssKiB: await rssKiB(),
  };
}

/** Mints and immediately retires `n` agents, one at a time: the population stays constant. */
async function mintRetire(n: number, tag: string) {
  const mint: number[] = [];
  const retire: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = `${RUN}-${tag}-${i}`;
    let t = now();
    await ctl.ok(perAgentRole(u, pw()));
    mint.push(now() - t);
    t = now();
    await ctl.ok(deletePerAgentRole(u));
    retire.push(now() - t);
  }
  return { mintMs: summary(mint), retireMs: summary(retire) };
}

/** Mints `n` pairs at concurrency `conc` on the one control connection, then retires them. */
async function mintBatch(n: number, conc: number, tag: string) {
  const names = Array.from({ length: n }, (_, i) => `${RUN}-${tag}-${i}`);
  const mint: number[] = [];
  const retire: number[] = [];
  let t0 = now();
  await pool(n, conc, async (i) => {
    const t = now();
    await ctl.ok(perAgentRole(names[i] as string, pw()));
    mint.push(now() - t);
  });
  const mintWall = now() - t0;
  t0 = now();
  await pool(n, conc, async (i) => {
    const t = now();
    await ctl.ok(deletePerAgentRole(names[i] as string));
    retire.push(now() - t);
  });
  const retireWall = now() - t0;
  return {
    pairs: n,
    concurrency: conc,
    mint: { ...summary(mint), pairsPerSec: round(n / (mintWall / 1000)) },
    retire: { ...summary(retire), pairsPerSec: round(n / (retireWall / 1000)) },
  };
}

/** One mint + retire pair per second for `seconds`: the pace a supervisor actually mints at. */
async function pacedMintRetire(seconds: number, tag: string) {
  const mint: number[] = [];
  const retire: number[] = [];
  for (let i = 0; i < seconds; i++) {
    const t0 = now();
    const u = `${RUN}-${tag}-${i}`;
    await ctl.ok(perAgentRole(u, pw()));
    mint.push(now() - t0);
    const t1 = now();
    await ctl.ok(deletePerAgentRole(u));
    retire.push(now() - t1);
    await sleep(Math.max(0, 1000 - (now() - t0)));
  }
  return { pairs: seconds, mintMs: summary(mint), retireMs: summary(retire) };
}

/**
 * The publishers publish 10 msg/s each (QoS 1, `<seq>:<sent at>`) until `minMs` has passed AND
 * `during` (if any) has finished. Returns end-to-end latency, losses, disconnects and broker CPU.
 * A message counts as lost only if it has not arrived once the subscriber has been quiet for 2 s
 * (late ones are in the latency). The subscriber is a real one: when the broker stalls, its queue
 * (`max_queued_messages`, default 1000) overflows exactly as a Desk's would.
 */
async function publishRun<T>(agents: Agent[], minMs: number, during?: () => Promise<T>) {
  const counter = await Observer.open("volley/bench/+/progress");
  const latency: number[] = [];
  const got = new Map<string, Set<number>>();
  let lastMessageAt = now();
  counter.client.on("message", (topic, payload) => {
    lastMessageAt = now();
    const [seq, sent] = payload.toString().split(":");
    latency.push(now() - Number(sent));
    const name = topic.split("/")[2] as string;
    const set = got.get(name) ?? new Set<number>();
    got.set(name, set);
    set.add(Number(seq));
  });
  const acked = new Map(agents.map((a) => [a.name, new Set<number>()]));
  const closesBefore = agents.map((a) => a.closes);
  const cpu0 = await cpuSeconds();
  const t0 = now();
  let done = false;
  const extra = (during ? during() : Promise.resolve(undefined)).finally(() => {
    done = true;
  });
  const publishers = agents.map(async (a) => {
    for (let seq = 0; !(done && now() - t0 >= minMs); seq++) {
      a.client
        .publishAsync(`volley/bench/${a.name}/progress`, `${seq}:${now()}`, { qos: 1 })
        .then(() => acked.get(a.name)?.add(seq))
        .catch(() => {});
      await sleep(100);
    }
  });
  const duringResult = await extra;
  await Promise.all(publishers);
  const seconds = (now() - t0) / 1000;
  const cpu1 = await cpuSeconds();
  const drainStart = now();
  while (now() - lastMessageAt < 2000 && now() - drainStart < 180_000) await sleep(100);
  await counter.client.endAsync();
  let sent = 0;
  let lost = 0;
  for (const [name, seqs] of acked) {
    sent += seqs.size;
    for (const n of seqs) if (!got.get(name)?.has(n)) lost++;
  }
  return {
    seconds: round(seconds),
    messagesAcked: sent,
    messagesLost: lost,
    disconnects: agents.reduce((s, a, i) => s + a.closes - (closesBefore[i] ?? 0), 0),
    latencyMs: summary(latency),
    deliveredLaterThan1s: latency.filter((l) => l > 1000).length,
    brokerCpuPercent:
      cpu0 !== null && cpu1 !== null ? round(((cpu1 - cpu0) / seconds) * 100, 2) : null,
    ...(duringResult !== undefined ? { during: duringResult } : {}),
  };
}

/**
 * Every publisher sends `perAgent` QoS 1 messages at once. Timed to the last PUBACK: the
 * publish ACL check happens before it. A subscriber stays attached (so the receive check runs
 * too) but delivery is not waited for: its queue limit, not the ACL, would set the pace.
 */
async function flood(agents: Agent[], perAgent: number) {
  const counter = await Observer.open("volley/bench/+/progress");
  let received = 0;
  counter.client.on("message", () => {
    received++;
  });
  const total = agents.length * perAgent;
  const cpu0 = await cpuSeconds();
  const t0 = now();
  await Promise.all(
    agents.map((a) =>
      Promise.all(
        Array.from({ length: perAgent }, (_, i) =>
          a.client.publishAsync(`volley/bench/${a.name}/progress`, `f${i}:${now()}`, { qos: 1 }),
        ),
      ),
    ),
  );
  const seconds = (now() - t0) / 1000;
  const cpu1 = await cpuSeconds();
  await sleep(500);
  await counter.client.endAsync();
  return {
    messages: total,
    seconds: round(seconds, 2),
    pubackedPerSec: round(total / seconds),
    deliveredToSubscriber: received,
    brokerCpuSecPer10k:
      cpu0 !== null && cpu1 !== null ? round(((cpu1 - cpu0) / total) * 10_000, 3) : null,
  };
}

async function sectionPerAgent() {
  const sizes = QUICK ? [100, 500, 2000] : [100, 1000, 10_000];
  const samples = QUICK ? 10 : 50;
  const runMs = QUICK ? 5_000 : 20_000;
  const floodPerAgent = QUICK ? 50 : 200;
  const fixed = new Set([ADMIN_USER, "volleyd", "desk", "coordinator"]);
  const keep = (u: string) => fixed.has(u) || u.startsWith(`${RUN}-kp`);
  const out: Record<string, unknown> = {
    aclsPerRole: 11,
    commandsPerMint: 13,
    commandsPerRetire: 2,
  };

  // 50 publishers, minted over the API; they survive every population swap.
  const agents: Agent[] = [];
  for (let i = 0; i < 50; i++) {
    const a = { name: `${RUN}-kp${i}`, password: pw(), acked: new Set<number>(), closes: 0 };
    await ctl.ok(perAgentRole(a.name, a.password));
    agents.push(a as Agent);
  }
  const connectAll = () => Promise.all(agents.map((a) => connectAgent(a)));
  const disconnectAll = () => Promise.all(agents.map((a) => a.client.endAsync().catch(() => {})));

  // Baseline: no agents besides the 50 publishers.
  const base = await loadPopulation({ clients: [], roles: [] }, keep);
  await connectAll();
  out.baseline = {
    ...base,
    publish: await publishRun(agents, runMs),
    flood: await flood(agents, floodPerAgent),
  };
  await disconnectAll();
  log("(k) baseline done");

  for (const n of sizes) {
    const row: Record<string, unknown> = {};
    if (n >= 1000) {
      row.clientOnly = await loadPopulation(population(n, `kc${n}`, false), keep);
      log(`(k) ${n}: client-only loaded`);
    }
    row.perAgent = await loadPopulation(population(n, `ka${n}`, true), keep);
    log(`(k) ${n}: per-agent loaded, ${JSON.stringify(row.perAgent)}`);
    row.mintRetire = await mintRetire(samples, `km${n}`);
    log(`(k) ${n}: mint/retire ${JSON.stringify(row.mintRetire)}`);
    if (n === sizes[0]) {
      row.concurrency = [];
      for (const conc of [1, 10, 50]) {
        (row.concurrency as unknown[]).push(await mintBatch(QUICK ? 30 : 200, conc, `kb${conc}`));
      }
    }
    if (n >= 1000) {
      await connectAll();
      row.publish = await publishRun(agents, runMs);
      row.flood = await flood(agents, floodPerAgent);
      // 1,000 other agents minted and retired while the publishers keep publishing; fewer
      // (about two minutes' worth) where 1,000 would take longer than that.
      const mr = row.mintRetire as { mintMs: Summary; retireMs: Summary };
      const pairMs = mr.mintMs.mean + mr.retireMs.mean;
      const full = QUICK ? 100 : 1000;
      const churn = pairMs * full > 120_000 ? Math.max(20, Math.floor(120_000 / pairMs)) : full;
      row.pacedChurnWhilePublishing = await publishRun(agents, runMs, () =>
        pacedMintRetire(runMs / 1000, `ky${n}`),
      );
      log(`(k) ${n}: paced churn: ${JSON.stringify(row.pacedChurnWhilePublishing)}`);
      row.churnWhilePublishing = await publishRun(agents, runMs, () =>
        mintBatch(churn, 10, `kx${n}`),
      );
      log(`(k) ${n}: churn ${churn} pairs: ${JSON.stringify(row.churnWhilePublishing)}`);
      await disconnectAll();
    }
    if (n === sizes[sizes.length - 1]) {
      const r = await restart();
      const t = now();
      const p0 = agents[0] as Agent;
      const login = await tryConnect({
        username: p0.name,
        password: p0.password,
        protocolVersion: 4,
      });
      row.gracefulRestart = {
        ...r,
        publisherLogin: login,
        publisherLoginMs: round(now() - t),
        rssAfterRestartKiB: await rssKiB(),
      };
    }
    out[`agents_${n}`] = row;
  }
  results.k_perAgent = out;
}

// --- main ----------------------------------------------------------------------------------------

async function section(key: string, fn: () => Promise<unknown>) {
  if (ONLY && !ONLY.has(key)) return;
  log(`section (${key}) ...`);
  const t = now();
  try {
    await fn();
  } catch (e) {
    results[`${key}_error`] = (e as Error).stack ?? String(e);
    log(`section (${key}) FAILED: ${(e as Error).message}`);
    // A failed section may leave the broker down; bring it back for the next one.
    if (!(await tryConnect({ username: ADMIN_USER, password: ADMIN_PASS })).startsWith("ok")) {
      await sh(START_CMD);
      await waitForLogin(now()).catch(() => {});
    }
    await reopen().catch(() => {});
  }
  log(`section (${key}) done in ${round((now() - t) / 1000)} s`);
}

function table(): string {
  const r = results as Record<string, Record<string, unknown> | undefined>;
  const get = (path: string): unknown =>
    path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], r);
  const s = (path: string) => {
    const v = get(path) as Summary | undefined;
    return v ? fmt(v) : "n/a";
  };
  const lines = [`| item | ${LABEL} |`, "|---|---|"];
  const row = (k: string, v: string) => lines.push(`| ${k} | ${v} |`);
  const lat =
    (get("b_latency.rows") as Array<Record<string, Record<string, number> | string | number>>) ??
    [];
  row("(a) %u/%c ACL cases pass", String(get("a_acl.patternCasesPass") ?? "n/a"));
  row(
    "(a) per-agent literal role (control) pass",
    String(get("a_acl.literalControlPass") ?? "n/a"),
  );
  for (const l of lat) {
    const c = l.create as Record<string, number>;
    const d = l.delete as Record<string, number>;
    row(
      `(b) ${l.mode} c=${l.concurrency}`,
      `create p50 ${c.p50} p95 ${c.p95} p99 ${c.p99} ms, ${c.opsPerSec}/s; delete p50 ${d.p50} p95 ${d.p95} p99 ${d.p99} ms, ${d.opsPerSec}/s`,
    );
  }
  row(
    "(c) churn: lost / agent disconnects",
    `${get("c_churn.agentMessagesLost") ?? "n/a"} of ${get("c_churn.agentMessagesAcked") ?? "n/a"} / ${get("c_churn.agentDisconnects") ?? "n/a"} (${get("c_churn.churnCycles") ?? "?"} churn cycles)`,
  );
  for (const k of Object.keys((get("c_roleEdits") as object) ?? {})) {
    row(`(c) kicks: ${k}`, `${get(`c_roleEdits.${k}.kickedOf50`)} of 50`);
  }
  for (const n of ["baseline", "1000", "10000", "300"]) {
    if (!get(`d_scale_${n}`)) continue;
    row(
      `(d) ${get(`d_scale_${n}.clients`)} clients`,
      `json ${get(`d_scale_${n}.dynsecJsonBytes`)} B, RSS ${get(`d_scale_${n}.brokerRssKiB`)} KiB, restart ${get(`d_scale_${n}.restartToFirstLoginMs`) ?? get(`d_scale_${n}.startToLoginMs`)} ms, listAll ${s(`d_scale_${n}.listClientsAll`)}, page ${s(`d_scale_${n}.listClientsPage100`)}, create ${s(`d_scale_${n}.singleCreateAtSize`)}`,
    );
  }
  row(
    "(e) kill -9: corrupt / acked-but-missing",
    `${get("e_persistence.kill9.corruptFiles") ?? "n/a"} / ${get("e_persistence.kill9.ackedButMissing") ?? "n/a"} of ${get("e_persistence.kill9.ackedTotal") ?? "n/a"}; visible at ack ${get("e_persistence.cadence.visibleInFileAtAck") ?? "n/a"}/${get("e_persistence.cadence.writes") ?? ""}`,
  );
  row("(f) deleteClient -> disconnect", s("f_kick.deleteClient.disconnectMs"));
  row(
    "(f) deleteClient -> LWT",
    `${s("f_kick.deleteClient.willMs")} (no will: ${get("f_kick.deleteClient.noWill")})`,
  );
  row("(f) disableClient -> disconnect", s("f_kick.disableClient.disconnectMs"));
  row("(g) any expiry field", String(get("g_expiry.anyExpiryField") ?? "n/a"));
  const pls = (get("h_listeners.perListenerSettingsFalse") ?? {}) as Record<string, string>;
  row(
    "(h) ws anonymous / ws dynsec client",
    `${pls["ws anonymous"] ?? "n/a"} / ${pls["ws dynsec client"] ?? "n/a"}`,
  );
  row(
    "(i) rerun untolerated errors / kicks",
    `${get("i_bootstrap.rerunUntoleratedErrors") ?? "n/a"} / ${get("i_bootstrap.connectedFixedIdentitiesKickedByRerun") ?? "n/a"}`,
  );
  const k = get("k_perAgent") as Record<string, Record<string, unknown>> | undefined;
  for (const [key, v] of Object.entries(k ?? {})) {
    if (!key.startsWith("agents_")) continue;
    const n = key.slice("agents_".length);
    row(
      `(k) ${n} agents: mint / retire`,
      `${s(`k_perAgent.${key}.mintRetire.mintMs`)} / ${s(`k_perAgent.${key}.mintRetire.retireMs`)}`,
    );
    const pa = v.perAgent as Record<string, unknown> | undefined;
    const co = v.clientOnly as Record<string, unknown> | undefined;
    row(
      `(k) ${n} agents: json / RSS / load`,
      `${pa?.dynsecJsonBytes} B / ${pa?.brokerRssKiB} KiB / ${pa?.toAgentLoginMs} ms${co ? ` (client-only: ${co.dynsecJsonBytes} B / ${co.brokerRssKiB} KiB / ${co.toAgentLoginMs} ms)` : ""}`,
    );
    if (v.publish) {
      row(
        `(k) ${n} agents: publish p50/p99, CPU`,
        `${get(`k_perAgent.${key}.publish.latencyMs.p50`)} / ${get(`k_perAgent.${key}.publish.latencyMs.p99`)} ms, ${get(`k_perAgent.${key}.publish.brokerCpuPercent`)}%; flood ${get(`k_perAgent.${key}.flood.pubackedPerSec`)}/s, ${get(`k_perAgent.${key}.flood.brokerCpuSecPer10k`)} CPU-s/10k`,
      );
      row(
        `(k) ${n} agents: 1 pair/s paced`,
        `disconnects ${get(`k_perAgent.${key}.pacedChurnWhilePublishing.disconnects`)}, lost ${get(`k_perAgent.${key}.pacedChurnWhilePublishing.messagesLost`)}, publish p50 ${get(`k_perAgent.${key}.pacedChurnWhilePublishing.latencyMs.p50`)} p99 ${get(`k_perAgent.${key}.pacedChurnWhilePublishing.latencyMs.p99`)} max ${get(`k_perAgent.${key}.pacedChurnWhilePublishing.latencyMs.max`)} ms`,
      );
      row(
        `(k) ${n} agents: churn ${get(`k_perAgent.${key}.churnWhilePublishing.during.pairs`)} pairs`,
        `disconnects ${get(`k_perAgent.${key}.churnWhilePublishing.disconnects`)}, lost ${get(`k_perAgent.${key}.churnWhilePublishing.messagesLost`)} of ${get(`k_perAgent.${key}.churnWhilePublishing.messagesAcked`)}, publish p99 ${get(`k_perAgent.${key}.churnWhilePublishing.latencyMs.p99`)} ms, mint ${get(`k_perAgent.${key}.churnWhilePublishing.during.mint.pairsPerSec`)} pairs/s`,
      );
    }
  }
  if (k?.baseline) {
    row(
      "(k) baseline (50 roles): publish p50/p99, CPU",
      `${get("k_perAgent.baseline.publish.latencyMs.p50")} / ${get("k_perAgent.baseline.publish.latencyMs.p99")} ms, ${get("k_perAgent.baseline.publish.brokerCpuPercent")}%; flood ${get("k_perAgent.baseline.flood.pubackedPerSec")}/s, ${get("k_perAgent.baseline.flood.brokerCpuSecPer10k")} CPU-s/10k`,
    );
  }
  return lines.join("\n");
}

ctl = await Dynsec.open();
obs = await Observer.open();
log(`connected to ${URL_TCP} as ${ADMIN_USER}; run ${RUN}`);
results.brokerVersion = await new Promise<string>((resolve) => {
  obs.client.on("message", (topic, payload) => {
    if (topic === "$SYS/broker/version") resolve(payload.toString());
  });
  void obs.client.subscribeAsync("$SYS/broker/version");
  setTimeout(() => resolve("unknown"), 3000);
});

await setupRoles();
await section("i", sectionBootstrap);
await section("a", sectionAcl);
await section("h", sectionListeners);
await section("g", sectionExpiry);
await section("f", sectionKick);
await section("b", sectionLatency);
await section("c", sectionChurn);
let earlier: Array<{ name: string; password: string }> = [];
await section("d", async () => {
  await sectionBaselineRestart();
  earlier = await sectionScale(QUICK ? 300 : 1000);
});
await section("e", () => sectionPersistence(earlier));
if (!QUICK) await section("d", () => sectionScale(10_000));
await section("k", sectionPerAgent);

await ctl.close().catch(() => {});
await obs.client.endAsync(true).catch(() => {});
const slug = LABEL.toLowerCase().replace(/[^a-z0-9.]+/g, "-");
const outFile = join(OUT_DIR, `dynsec-${slug}.json`);
// Results are meant to be committed: no machine-local paths (work directory, checkout).
const scrubbed = JSON.stringify(results, null, 2)
  .split(dirname(dirname(JSON_PATH)))
  .join("<work>")
  .split(join(import.meta.dir, "../.."))
  .join("<repo>");
if (existsSync(OUT_DIR)) writeFileSync(outFile, `${scrubbed}\n`);
console.log(table());
console.log(`\nfull results: ${outFile}`);
process.exit(0);
