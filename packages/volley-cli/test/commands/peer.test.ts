import { spawnSync } from "node:child_process";
import { constants, type JsonWebKeyInput, createPublicKey, publicEncrypt } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { VolleyError } from "volley-mcp/errors";
import {
  LAUNCHD_LABEL,
  PEER_DEFAULTS,
  type PeerConfig,
  type PeerDeps,
  type PeerExec,
  SYSTEMD_UNIT,
  currentUser,
  defaultName,
  hostKeyHint,
  localNotAdmin,
  machineEnvelope,
  machineTopic,
  peerDoctorStamp,
  peerFile,
  peerHeartbeat,
  peerTunnel,
  readPeerConfig,
  realDeps,
  redeemScript,
  runPeer,
  runService,
  tunnelArgv,
} from "../../src/commands/peer";
import { RECORD_LOCK_ARGV } from "../../src/deploy/peers";
import { EXIT } from "../../src/exit-codes";
import { makeBufferIO } from "../../src/io";
import { lockHash } from "../../src/peer/doctor";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";
import { FAKE_TOKEN, storeLogins, usageEndpoint } from "../helpers/fake-logins";
import { type FakePeerMachine, fakePeerMachine } from "../helpers/fake-peer-machine";
import { tempDir } from "../helpers/tmp";

const NS = "test";

const sealTo = (jwk: unknown, secret: unknown) =>
  publicEncrypt(
    {
      key: createPublicKey({ key: jwk as JsonWebKeyInput["key"], format: "jwk" }),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(JSON.stringify(secret)),
  ).toString("base64url");

/** A minimal volleyd: live status, and a mailbox that answers each control query. */
async function fakeVolleyd(
  url: string,
  answer: (op: string, p: Record<string, unknown>) => unknown,
) {
  const b = new VolleyBroker();
  await b.connect({ url, agentId: "volleyd" });
  const env = (channel: string, type: string, payload: unknown, correlationId?: string) =>
    JSON.stringify(
      buildEnvelope({
        agentId: "volleyd",
        parentId: null,
        channel,
        type,
        payload,
        ...(correlationId !== undefined ? { correlationId } : {}),
      }),
    );
  await b.publish(`volley/${NS}/volleyd/status`, env("status", "working", {}), {
    qos: 1,
    retain: true,
  });
  const seen: Record<string, unknown>[] = [];
  /** The account-op topics each admin op arrived on. */
  const adminTopics: string[] = [];
  // Admin ops: the sender's own account-op topic, answered on the correlation id's reply topic.
  await b.subscribeStream("volley/_system/auth/ops/+", ({ topic, payload }) => {
    const q = parseEnvelope(payload);
    if (q?.type !== "query" || q.correlation_id === null) return;
    const p = q.payload as Record<string, unknown>;
    seen.push(p);
    adminTopics.push(topic);
    void b.publish(
      `volley/_system/auth/replies/${q.correlation_id}`,
      env(
        "_system/auth",
        "ack",
        { text: "ACKED", acked_type: "query", op: p.op, ...(answer(p.op as string, p) as object) },
        q.correlation_id,
      ),
      { qos: 1, retain: false },
    );
  });
  await b.subscribeStream(`volley/${NS}/volleyd/mailbox`, ({ payload }) => {
    const q = parseEnvelope(payload);
    if (q?.type !== "query" || q.correlation_id === null) return;
    const p = q.payload as Record<string, unknown>;
    seen.push(p);
    void b.publish(
      `volley/${NS}/${q.agent_id}/mailbox`,
      env(
        "mailbox",
        "ack",
        { text: "ACKED", op: p.op, ...(answer(p.op as string, p) as object) },
        q.correlation_id,
      ),
      { qos: 1, retain: false },
    );
  });
  return { b, seen, adminTopics };
}

interface Call {
  argv: string[];
  input?: string;
}

type Reply = Partial<{ code: number; stdout: string; stderr: string }>;

/**
 * Fake exec: records argv + stdin; `reply` answers by argv. A reply of undefined hands the call
 * to the fake box (the doctor's probes: a healthy machine unless the test changes it).
 */
function fakeExec(reply: (c: Call) => Reply | undefined, machine: FakePeerMachine = box) {
  const calls: Call[] = [];
  const exec: PeerExec = async (argv, opts = {}) => {
    const c: Call = { argv, ...(opts.input !== undefined ? { input: opts.input } : {}) };
    calls.push(c);
    if (argv[0] === "ssh" && argv[1] === "-N") {
      // The tunnel: runs until aborted.
      await new Promise<void>((r) => opts.signal?.addEventListener("abort", () => r()));
      return { code: 143, stdout: "", stderr: "" };
    }
    const r = reply(c);
    // launchd has no job loaded unless a test says so.
    const base = argv[0] === "launchctl" && argv[1] === "print" ? 113 : 0;
    if (r === undefined && base === 0) return machine.exec(argv, opts);
    return { code: base, stdout: "", stderr: "", ...r };
  };
  return { exec, calls };
}

let tb: TestBroker;
let home: string;
/** This machine: a healthy box (tools, volley checkout, a trusted clone of the wave repo). */
let box: FakePeerMachine;
beforeEach(async () => {
  tb = await startTestBroker();
  box = fakePeerMachine({ trusted: true });
  home = box.home;
});
afterEach(async () => {
  await tb.close();
  box.cleanup();
});

function deps(exec: PeerExec, over: Partial<PeerDeps> = {}): PeerDeps {
  return {
    ...box.deps(),
    exec,
    home,
    platform: "linux",
    hostname: () => "Box-A.lan",
    user: () => "dev",
    uid: () => 501,
    arch: "x64",
    cpus: () => 8,
    loadavg: () => [0.5, 0.25, 0.125],
    now: () => new Date("2026-10-19T09:00:00.000Z"),
    monotonic: () => 0,
    envPath: () => "/path/to/home/.bun/bin:/usr/local/bin:/usr/bin:/bin",
    sleep: async () => {},
    readStdin: async () => "",
    volleyArgv: ["/usr/local/bin/bun", "/opt/volley/packages/volley-cli/src/cli.ts"],
    volleyDir: box.volleyDir,
    // The "tunnel": this machine's port is the test broker.
    connect: async (_url, auth, will) => {
      const b = new VolleyBroker();
      await b.connect({
        url: tb.url,
        agentId: "peer-test",
        ...(will !== undefined
          ? { willTopic: will.topic, willPayload: will.payload, willRetain: will.retain }
          : {}),
        ...(auth ?? {}),
      });
      return b;
    },
    ...over,
  };
}

const run = async (argv: string[], d: PeerDeps, env: Record<string, string> = {}) => {
  const io = makeBufferIO();
  const exitCode = await runPeer(
    // VOLLEY_AUTH_DIR: never this machine's own coordinator.json.
    {
      argv,
      env: { VOLLEY_BROKER_URL: tb.url, VOLLEY_NAMESPACE: NS, VOLLEY_AUTH_DIR: home, ...env },
      io,
    },
    d,
  );
  return { exitCode, stdout: io.readStdout(), stderr: io.readStderr() };
};

const JOINED = {
  name: "box-a",
  namespace: "default",
  broker: { host: "127.0.0.1", port: 1883 },
  remote_port: 21883,
  username: "box-a",
  password: "peer-secret",
};

/** The host's answers over ssh: the reachability probe, then the redeem. */
const hostSsh =
  (redeem: Partial<{ code: number; stdout: string; stderr: string }>) =>
  (c: Call): Reply | undefined => {
    if (c.argv[0] !== "ssh") return undefined;
    if (c.input?.includes("volley-peer-ok")) return { stdout: "volley-peer-ok\n" };
    if (c.input?.includes("peer redeem")) return redeem;
    return { code: 127, stderr: "unexpected script" };
  };

/** The JSON the redeem script pipes into `volley peer redeem` on the host. */
const redeemRequest = (script: string) => {
  const m = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| (.+?) peer redeem/.exec(script);
  if (m === null) throw new Error(`no redeem in ${script}`);
  return { request: JSON.parse(Buffer.from(m[1] as string, "base64").toString()), volley: m[2] };
};

/** `volley/_system/machines/<name>` envelopes must validate against the F0 machine schema. */
const SCHEMAS = fileURLToPath(new URL("../../../../spec/schemas/", import.meta.url));
let ajv: Ajv2020 | null = null;
function expectValidRecord(raw: string) {
  if (ajv === null) {
    ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    for (const f of readdirSync(SCHEMAS).filter((f) => f.endsWith(".schema.json"))) {
      ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS, f), "utf-8")));
    }
  }
  const validate = ajv.getSchema("https://volley.systems/schemas/0.1/machine.schema.json");
  if (validate === undefined) throw new Error("machine.schema.json not loaded");
  const ok = validate(JSON.parse(raw));
  expect(validate.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

describe("volley peer join (on the machine to pair)", () => {
  it("runs the doctor first: a block check stops before the code is sent, so it stays usable", async () => {
    box.tools.tmux.path = null;
    box.tools.tmux.sshPath = null;
    const f = fakeExec(hostSsh({ stdout: JSON.stringify(JOINED) }));
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "dev@host", "--repo", box.repoPath],
      deps(f.exec),
    );
    expect(r.exitCode).toBe(1);
    expect(f.calls.some((c) => c.argv[0] === "ssh")).toBe(false);
    expect(r.stdout).toContain("✗ tool.tmux: tmux is not installed");
    expect(r.stdout).toContain("fix: sudo apt-get install -y tmux");
    expect(r.stderr).toContain("the code is still valid");
    // The exact doctor command, with the join's own --repo (no peer.json before pairing).
    expect(r.stderr).toContain(`volley peer doctor --fix --repo '${box.repoPath}'`);
    expect(existsSync(peerFile(home))).toBe(false);
  });

  it("the estimated ssh PATH never stops a join: it warns, and the supervisor's own probe decides", async () => {
    box.tools.claude.path = "/path/to/home/.local/bin/claude";
    box.tools.claude.sshPath = null;
    const f = fakeExec(hostSsh({ stdout: JSON.stringify(JOINED) }));
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "dev@host", "--repo", box.repoPath],
      deps(f.exec),
    );
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^! claude_on_path: estimated: /m);
    expect(r.stdout).toContain(
      "fix: sudo ln -s /path/to/home/.local/bin/claude /usr/local/bin/claude",
    );
    expect(f.calls.filter((c) => c.argv[0] === "ssh")).toHaveLength(2);
  });

  it("the stop message carries --volley-dir when the join was given one", async () => {
    box.tools.tmux.path = null;
    box.tools.tmux.sshPath = null;
    const f = fakeExec(hostSsh({ stdout: JSON.stringify(JOINED) }));
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "dev@host", "--volley-dir", box.volleyDir],
      deps(f.exec),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      `volley peer doctor --fix --repo <path> --volley-dir '${box.volleyDir}'`,
    );
  });

  it("no --repo is a block check: the join stops before redeeming", async () => {
    const f = fakeExec(hostSsh({ stdout: JSON.stringify(JOINED) }));
    const r = await run(["join", "ABCD-EFGH", "--to", "dev@host"], deps(f.exec));
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("✗ repo.clone: no wave repo: pass --repo");
    expect(f.calls.some((c) => c.argv[0] === "ssh")).toBe(false);
  });

  it("warn checks are printed and the join continues", async () => {
    box.cleanup();
    box = fakePeerMachine({ trusted: true, gh: { signedIn: false } });
    home = box.home;
    const f = fakeExec(hostSsh({ stdout: JSON.stringify(JOINED) }));
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "dev@host", "--repo", box.repoPath],
      deps(f.exec),
    );
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("! gh.auth: gh is not signed in");
    expect(r.stdout).toContain("fix: gh auth login && gh auth setup-git");
    expect(f.calls.filter((c) => c.argv[0] === "ssh")).toHaveLength(2);
    expect(existsSync(peerFile(home))).toBe(true);
  });

  it("join --replace sends replace: true (a re-pairing code from invite --for)", async () => {
    const f = fakeExec(hostSsh({ stdout: JSON.stringify(JOINED) }));
    const r = await run(
      [
        "join",
        "ABCD-EFGH",
        "--to",
        "dev@host",
        "--repo",
        box.repoPath,
        "--name",
        "box-a",
        "--replace",
      ],
      deps(f.exec),
    );
    expect(r.exitCode).toBe(0);
    const ssh = f.calls.filter((c) => c.argv[0] === "ssh");
    expect(redeemRequest(ssh[1]?.input as string).request).toMatchObject({
      name: "box-a",
      replace: true,
    });
    // A plain join sends no replace.
    const g = fakeExec(hostSsh({ stdout: JSON.stringify(JOINED) }));
    await run(["join", "ABCD-EFGH", "--to", "dev@host", "--repo", box.repoPath], deps(g.exec));
    const plain = redeemRequest(g.calls.filter((c) => c.argv[0] === "ssh")[1]?.input as string);
    expect(plain.request.replace).toBeUndefined();
  });

  it("a machine whose total memory reads 0 sends no memory_total_mb: its size stays unknown (#324)", async () => {
    const f = fakeExec(hostSsh({ stdout: JSON.stringify(JOINED) }));
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "dev@host", "--repo", box.repoPath],
      deps(f.exec, { totalmem: () => 0 }),
    );
    expect(r.exitCode).toBe(0);
    const { request } = redeemRequest(
      f.calls.filter((c) => c.argv[0] === "ssh")[1]?.input as string,
    );
    expect(request.cores).toBe(8);
    expect(request.memory_total_mb).toBeUndefined();
  });

  it("runs every remote step as a script under bash -s, writes peer.json, installs the service, prints trust, registers", async () => {
    const repo = box.repoPath;
    rmSync(join(home, ".claude.json"));
    const f = fakeExec(hostSsh({ stdout: `${JSON.stringify(JOINED)}\n` }));
    const r = await run(
      ["join", "abcd-efgh", "--to", "dev@host", "--repo", repo, "--port", "21883"],
      deps(f.exec),
    );
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);

    // Remote steps: ssh -T <host> bash -s with the script on stdin, never a command string.
    const ssh = f.calls.filter((c) => c.argv[0] === "ssh");
    expect(ssh).toHaveLength(2);
    for (const c of ssh) {
      expect(c.argv.slice(0, 2)).toEqual(["ssh", "-T"]);
      expect(c.argv.slice(-3)).toEqual(["dev@host", "bash", "-s"]);
      expect(c.input).toBeDefined();
    }
    expect(ssh[0]?.input).toContain("echo volley-peer-ok");
    // The host checks it can ssh back here before the code is used up; -n keeps that ssh off
    // the script's own stdin.
    const script = ssh[1]?.input as string;
    const probe = script.indexOf(
      "ssh -n -o BatchMode=yes -o ConnectTimeout=10 'dev@Box-A.lan' true",
    );
    expect(probe).toBeGreaterThan(-1);
    expect(probe).toBeLessThan(script.indexOf("peer redeem"));
    const { request, volley } = redeemRequest(script);
    // No --remote-volley: volley on the host's PATH, else the one `volley setup` installs.
    expect(volley).toBe("if command -v volley >/dev/null 2>&1; then volley");
    expect(script).toContain("; else ~/.volley/bin/volley peer redeem; fi");
    expect(request).toEqual({
      code: "abcd-efgh",
      name: "box-a",
      target: "dev@Box-A.lan",
      volley_dir: box.volleyDir,
      repo,
      port: 21883,
      os: "linux",
      cores: 8,
      // With cores, what volleyd sizes the machine's max_agents from (#324).
      memory_total_mb: 16384,
    });

    // peer.json, mode 0600, with the account.
    const file = peerFile(home);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
      name: "box-a",
      host: "dev@host",
      target: "dev@Box-A.lan",
      namespace: "default",
      broker: { host: "127.0.0.1", port: 1883 },
      remote_port: 21883,
      username: "box-a",
      password: "peer-secret",
      repo,
      joined_at: "2026-10-19T09:00:00.000Z",
    });
    expect(r.stdout).not.toContain("peer-secret");

    // The service: a systemd user unit running `volley peer run`, enabled and started.
    const unit = readFileSync(join(home, ".config", "systemd", "user", SYSTEMD_UNIT), "utf-8");
    expect(unit).toContain(
      "ExecStart=/usr/local/bin/bun /opt/volley/packages/volley-cli/src/cli.ts peer run",
    );
    expect(unit).toContain("Restart=on-failure");
    // join's PATH, so the heartbeat's doctor finds what this terminal finds.
    expect(unit).toContain("Environment=PATH=/path/to/home/.bun/bin:/usr/local/bin:/usr/bin:/bin");
    expect(unit).not.toContain("network-online.target");
    // Lingering first (the service must outlive this ssh session), then enable + restart (a
    // re-join replaces a running service).
    expect(
      f.calls
        .filter((c) => ["systemctl", "loginctl"].includes(c.argv[0] as string))
        .map((c) => c.argv),
    ).toEqual([
      ["loginctl", "enable-linger", "dev"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", SYSTEMD_UNIT],
      ["systemctl", "--user", "restart", SYSTEMD_UNIT],
    ]);

    // Trust: the repo is not trusted yet; the join says what to accept.
    expect(r.stdout).toContain(`Claude Code does not trust ${repo} on this machine yet`);
    expect(r.stdout).toContain("repo_untrusted");

    // Registered: the retained machine record, published as the peer.
    const reader = new VolleyBroker();
    await reader.connect({ url: tb.url, agentId: "reader" });
    const raw = await reader.queryRetained(machineTopic("box-a"), 500);
    await reader.disconnect();
    const env = parseEnvelope(raw ?? "");
    expect(env).toMatchObject({ agent_id: "box-a", channel: "_system/machines", type: "machine" });
    expect(env?.payload).toMatchObject({
      name: "box-a",
      kind: "peer",
      os: "linux",
      arch: "x64",
      cores: 8,
      tunnel: "up",
      load: [0.5, 0.25, 0.13],
      agents: 0,
      remote_port: 21883,
      last_seen: "2026-10-19T09:00:00.000Z",
      // The join's own doctor run.
      doctor_at: "2026-10-19T09:00:00.000Z",
      auth: { gh: "ok", claude: "signed_in", trust: "missing", claude_plan: "max" },
    });
    expectValidRecord(raw ?? "");
    expect(r.stdout).toContain("Registered: volley/_system/machines/box-a");
  });

  it("on macOS installs a launchd agent and bootstraps it; a trusted repo says so", async () => {
    const repo = box.repoPath;
    const f = fakeExec(hostSsh({ stdout: JSON.stringify(JOINED) }));
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "host", "--repo", repo, "--remote-volley", "/opt/bin/volley"],
      deps(f.exec, { platform: "darwin" }),
    );
    expect(r.exitCode).toBe(0);
    const plist = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    const text = readFileSync(plist, "utf-8");
    expect(text).toContain("<string>peer</string>");
    expect(text).toContain("<string>run</string>");
    expect(text).toContain("<key>SuccessfulExit</key><false/>");
    // launchd's own PATH is /usr/bin:/bin:/usr/sbin:/sbin: the service gets join's.
    expect(text).toContain(
      "<key>EnvironmentVariables</key>\n  <dict><key>PATH</key><string>/path/to/home/.bun/bin:/usr/local/bin:/usr/bin:/bin</string></dict>",
    );
    // Nothing loaded yet: nothing to boot out.
    expect(
      f.calls.filter((c) => c.argv[0] === "launchctl" && c.argv[1] !== "print").map((c) => c.argv),
    ).toEqual([["launchctl", "bootstrap", "gui/501", plist]]);
    expect(r.stdout).toContain("(domain gui/501)");
    expect(r.stdout).toContain(`Claude Code trusts ${repo} on this machine.`);
    const ssh = f.calls.filter((c) => c.argv[0] === "ssh");
    expect(redeemRequest(ssh[1]?.input as string).volley).toBe("/opt/bin/volley");
  });

  it("a re-join replaces the loaded agent: boots it out, waits until launchd lets it go, then loads it", async () => {
    let loaded = true;
    let teardown = 0;
    const f = fakeExec((c) => {
      if (c.argv[0] !== "launchctl") return hostSsh({ stdout: JSON.stringify(JOINED) })(c);
      const gui = (c.argv[2] ?? "").startsWith("gui/");
      if (c.argv[1] === "print") {
        if (gui && teardown > 0 && --teardown === 0) loaded = false;
        return { code: gui && loaded ? 0 : 113 };
      }
      if (c.argv[1] === "bootout" && gui) teardown = 3;
      if (c.argv[1] === "bootstrap" && loaded) {
        return { code: 5, stderr: "Bootstrap failed: 5: Input/output error" };
      }
      return {};
    });
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "host", "--repo", box.repoPath],
      deps(f.exec, { platform: "darwin" }),
    );
    expect(r.exitCode).toBe(0);
    const sub = f.calls.filter((c) => c.argv[0] === "launchctl").map((c) => c.argv[1]);
    expect(sub.filter((s) => s !== "print")).toEqual(["bootout", "bootstrap"]);
    expect(r.stdout).toContain("(domain gui/501)");
  });

  it("a re-join whose new plist will not load puts the previous one back, loads it, and says so", async () => {
    const plist = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, "<plist>previous</plist>");
    let loaded = true;
    const f = fakeExec((c) => {
      if (c.argv[0] !== "launchctl") return hostSsh({ stdout: JSON.stringify(JOINED) })(c);
      const gui = (c.argv[2] ?? "").startsWith("gui/");
      if (c.argv[1] === "print") return { code: gui && loaded ? 0 : 113 };
      if (c.argv[1] === "bootout") {
        loaded = false;
        return {};
      }
      if (c.argv[1] === "bootstrap") {
        // launchd refuses the new plist anywhere, and takes the previous one back.
        if (readFileSync(plist, "utf-8") !== "<plist>previous</plist>") {
          return { code: 1, stderr: "Bootstrap failed: 122: Path had bad ownership/permissions" };
        }
        loaded = gui;
        return {};
      }
      return {};
    });
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "host", "--repo", box.repoPath],
      deps(f.exec, { platform: "darwin" }),
    );
    expect(r.exitCode).not.toBe(0);
    expect(readFileSync(plist, "utf-8")).toBe("<plist>previous</plist>");
    expect(loaded).toBe(true);
    expect(r.stderr).toContain("bad ownership/permissions");
    expect(r.stderr).toContain("Restored the previous");
  });

  it("on a Mac with nobody at the console, falls back to the user/<uid> domain and says so", async () => {
    const f = fakeExec((c) =>
      c.argv[0] === "launchctl" && c.argv[1] === "bootstrap" && c.argv[2] === "gui/501"
        ? { code: 125, stderr: "Domain does not support specified action" }
        : hostSsh({ stdout: JSON.stringify(JOINED) })(c),
    );
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "host", "--repo", box.repoPath],
      deps(f.exec, { platform: "darwin" }),
    );
    expect(r.exitCode).toBe(0);
    const plist = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    expect(f.calls.filter((c) => c.argv[1] === "bootstrap").map((c) => c.argv)).toEqual([
      ["launchctl", "bootstrap", "gui/501", plist],
      ["launchctl", "bootstrap", "user/501", plist],
    ]);
    expect(r.stdout).toContain("(domain user/501)");
  });

  it("without lingering the service is installed, with a loud warning naming the fix", async () => {
    const f = fakeExec((c) =>
      c.argv[0] === "loginctl"
        ? { code: 1, stderr: "Could not enable linger: Access denied" }
        : hostSsh({ stdout: JSON.stringify(JOINED) })(c),
    );
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "host", "--repo", box.repoPath],
      deps(f.exec),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain(
      `Installed the tunnel service: systemd user unit ${join(home, ".config", "systemd", "user", SYSTEMD_UNIT)}.`,
    );
    expect(r.stderr).toContain("lingering is off for dev");
    expect(r.stderr).toContain("sudo loginctl enable-linger dev");
    expect(r.stderr).toContain("stops when you log out");
  });

  it("a failed service install after the pairing says how to finish or start over", async () => {
    const f = fakeExec((c) =>
      c.argv[0] === "systemctl" && c.argv[2] === "restart"
        ? { code: 1, stderr: "Failed to connect to bus: No medium found" }
        : hostSsh({ stdout: JSON.stringify(JOINED) })(c),
    );
    const repo = box.repoPath;
    rmSync(join(home, ".claude.json"));
    const r = await run(["join", "ABCD-EFGH", "--to", "dev@host", "--repo", repo], deps(f.exec));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("No medium found");
    expect(r.stderr).toContain("paired as box-a");
    expect(r.stderr).toContain("`volley peer run`");
    expect(r.stderr).toContain("`volley peer remove box-a` on dev@host");
    // The pairing stands: peer.json is there, and the trust check still ran.
    expect(existsSync(peerFile(home))).toBe(true);
    expect(r.stdout).toContain(`Claude Code does not trust ${repo}`);
  });

  it("a host that cannot ssh back here stops before the code is used", async () => {
    const f = fakeExec(
      hostSsh({
        code: 3,
        stderr:
          "dev@Box-A.lan: Permission denied (publickey).\nthe supervisor's machine cannot ssh to dev@Box-A.lan\n",
      }),
    );
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "dev@host", "--repo", box.repoPath],
      deps(f.exec),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("dev@host cannot ssh to dev@Box-A.lan");
    expect(r.stderr).toContain("--target");
    expect(r.stderr).toContain("the code is still valid");
    expect(r.stderr).toContain("Permission denied (publickey)");
    expect(existsSync(peerFile(home))).toBe(false);
    expect(f.calls.some((c) => c.argv[0] === "systemctl")).toBe(false);
  });

  it("checks claude, bun and tmux on this machine's non-interactive ssh PATH before redeeming", () => {
    // Run the real script under bash: a stub `ssh` runs its command with a PATH that has bun
    // and tmux but no claude, as a zsh login shell without ~/.zshenv would.
    const box = tempDir("volley-peer-redeem-");
    const write = (p: string, text: string) => {
      writeFileSync(p, text);
      chmodSync(p, 0o755);
    };
    mkdirSync(join(box, "bin"));
    mkdirSync(join(box, "tools"));
    write(
      join(box, "bin", "ssh"),
      // The login shell is fish, which cannot parse POSIX `for … do`: only `sh -c` gets through.
      '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -n|-T) shift;; -o) shift 2;; *) break;; esac; done\nshift\ncase "$*" in true|"sh -c "*) ;; *) echo "fish: Unknown command" >&2; exit 127;; esac\nexec /usr/bin/env -i PATH="$TOOLS" SHELL=/usr/bin/fish /bin/sh -c "$*"\n',
    );
    symlinkSync("/bin/sh", join(box, "tools", "sh"));
    write(join(box, "tools", "bun"), "#!/bin/sh\n");
    write(join(box, "tools", "tmux"), "#!/bin/sh\n");
    // Like `volley peer redeem`, it reads the whole request from stdin (a stub that does not
    // could exit first, and base64 then dies of SIGPIPE: exit 141 under pipefail).
    write(join(box, "volley"), `#!/bin/sh\ncat > ${join(box, "redeemed")}\n`);
    const script = redeemScript(
      { code: "ABCD-EFGH", name: "box-a", target: "dev@box-a", volley_dir: "/opt/volley" },
      join(box, "volley"),
    );
    const r = spawnSync("bash", ["-s"], {
      input: script,
      encoding: "utf-8",
      env: { PATH: `${join(box, "bin")}:/usr/bin:/bin`, TOOLS: join(box, "tools") },
    });
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("volley-peer-missing: claude");
    expect(r.stderr).toContain("volley-peer-shell: fish");
    expect(existsSync(join(box, "redeemed"))).toBe(false);
    // With claude there too, the code is redeemed.
    write(join(box, "tools", "claude"), "#!/bin/sh\n");
    const ok = spawnSync("bash", ["-s"], {
      input: script,
      encoding: "utf-8",
      env: { PATH: `${join(box, "bin")}:/usr/bin:/bin`, TOOLS: join(box, "tools") },
    });
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(box, "redeemed"), "utf-8"))).toMatchObject({
      code: "ABCD-EFGH",
      target: "dev@box-a",
    });
  });

  it("a PATH check that fails on its own is not reported as the host failing to ssh", async () => {
    const f = fakeExec(
      hostSsh({ code: 5, stderr: "sh: 1: Syntax error: end of file unexpected\n" }),
    );
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "dev@host", "--repo", box.repoPath],
      deps(f.exec),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain("cannot ssh to");
    expect(r.stderr).toContain(
      "dev@host could not check claude, bun and tmux on dev@Box-A.lan's ssh PATH",
    );
    expect(r.stderr).toContain("Syntax error");
    expect(r.stderr).toContain("the code is still valid");
  });

  it("names the missing tools and the exact line for the login shell's file", async () => {
    const f = fakeExec(
      hostSsh({ code: 4, stderr: "volley-peer-missing: claude bun\nvolley-peer-shell: zsh\n" }),
    );
    const which = (c: string) =>
      c === "claude"
        ? "/path/to/home/.local/bin/claude"
        : c === "bun"
          ? "/opt/homebrew/bin/bun"
          : null;
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "dev@host", "--repo", box.repoPath],
      deps(f.exec, { which }),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("claude, bun are not on the PATH of a non-interactive ssh session");
    expect(r.stderr).toContain("~/.zshenv");
    expect(r.stderr).toContain('export PATH="/path/to/home/.local/bin:/opt/homebrew/bin:$PATH"');
    expect(r.stderr).toContain("the code is still valid");
    expect(existsSync(peerFile(home))).toBe(false);
    // bash: the top of ~/.bashrc; a tool this shell cannot find either: install it.
    const b = fakeExec(
      hostSsh({ code: 4, stderr: "volley-peer-missing: claude\nvolley-peer-shell: bash\n" }),
    );
    const rb = await run(
      ["join", "ABCD-EFGH", "--to", "dev@host", "--repo", box.repoPath],
      deps(b.exec, { which: () => null }),
    );
    expect(rb.stderr).toContain("the top of ~/.bashrc");
    expect(rb.stderr).toContain("Install claude on this machine");
  });

  it("an untrusted host key says so, with the one-time command, not 'set up key-based ssh'", async () => {
    const f = fakeExec((c) =>
      c.argv[0] === "ssh" ? { code: 255, stderr: "Host key verification failed.\n" } : undefined,
    );
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "dev@host", "--repo", box.repoPath],
      deps(f.exec),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("does not trust dev@host's host key yet");
    expect(r.stderr).toContain("ssh dev@host true");
    expect(r.stderr).not.toContain("key-based");
    // The host's ssh back here, refused for the same reason: the command runs there.
    expect(hostKeyHint("Host key verification failed.", "dev@box-a", "dev@host")).toContain(
      "On dev@host, run once: ssh dev@box-a true",
    );
    expect(
      hostKeyHint("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@", "dev@host"),
    ).toContain("ssh-keygen -R dev@host");
    expect(hostKeyHint("Permission denied (publickey).", "dev@host")).toBeNull();
  });

  it("a repo trusted through a parent folder counts as trusted (T4's rule)", async () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ projects: { [dirname(box.repoPath)]: { hasTrustDialogAccepted: true } } }),
    );
    const f = fakeExec(hostSsh({ stdout: JSON.stringify(JOINED) }));
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "host", "--repo", box.repoPath],
      deps(f.exec),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`Claude Code trusts ${box.repoPath} on this machine.`);
  });

  it("refuses a --target that is not an ssh destination", async () => {
    const f = fakeExec(() => ({}));
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "host", "--target=-oProxyCommand=x"],
      deps(f.exec),
    );
    expect(r.exitCode).toBe(2);
    expect(f.calls).toHaveLength(0);
  });

  it("an unreachable host stops before anything is redeemed or written", async () => {
    const f = fakeExec((c) =>
      c.argv[0] === "ssh"
        ? { code: 255, stderr: "ssh: connect to host: Connection refused" }
        : undefined,
    );
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "host", "--repo", box.repoPath],
      deps(f.exec),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("cannot reach host over ssh");
    expect(f.calls.filter((c) => c.argv[0] === "ssh")).toHaveLength(1);
    expect(existsSync(peerFile(home))).toBe(false);
  });

  it("volley neither on the host's ssh PATH nor at ~/.volley/bin/volley: says to run volley setup there, and the code still works", async () => {
    const f = fakeExec(
      hostSsh({
        code: 127,
        stderr: "bash: line 13: /path/to/home/.volley/bin/volley: No such file or directory\n",
      }),
    );
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "dev@host", "--repo", box.repoPath],
      deps(f.exec),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("No such file or directory");
    expect(r.stderr).toContain("`/path/to/home/.volley/bin/volley` does not exist on dev@host");
    // The fallback was tried already: never suggested again.
    expect(r.stderr).toContain("Run `volley setup` on dev@host");
    expect(r.stderr).toContain("--remote-volley");
    expect(r.stderr).not.toContain("--remote-volley '~/.volley/bin/volley'");
    expect(r.stderr).toContain("the code is still valid");
    expect(existsSync(peerFile(home))).toBe(false);
  });

  it("volley not on the host's ssh PATH: the redeem falls back to ~/.volley/bin/volley without --remote-volley", () => {
    // The real script under bash: the stub ssh's PATH has the agent tools, the host's own PATH
    // has no volley, and its home has the one `volley setup` installs.
    const tmp = tempDir("volley-peer-fallback-");
    const write = (p: string, text: string) => {
      writeFileSync(p, text);
      chmodSync(p, 0o755);
    };
    for (const d of ["bin", "tools", "home/.volley/bin"])
      mkdirSync(join(tmp, d), { recursive: true });
    write(
      join(tmp, "bin", "ssh"),
      '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -n|-T) shift;; -o) shift 2;; *) break;; esac; done\nshift\nexec /usr/bin/env -i PATH="$TOOLS" /bin/sh -c "$*"\n',
    );
    symlinkSync("/bin/sh", join(tmp, "tools", "sh"));
    for (const t of ["bun", "tmux", "claude"]) write(join(tmp, "tools", t), "#!/bin/sh\n");
    write(
      join(tmp, "home", ".volley", "bin", "volley"),
      `#!/bin/sh\necho "$*" > ${join(tmp, "argv")}\ncat > ${join(tmp, "redeemed")}\n`,
    );
    const script = redeemScript(
      { code: "ABCD-EFGH", name: "box-a", target: "dev@box-a", volley_dir: "/opt/volley" },
      null,
    );
    expect(script).toContain("~/.volley/bin/volley peer redeem");
    const r = spawnSync("bash", ["-s"], {
      input: script,
      encoding: "utf-8",
      env: {
        PATH: `${join(tmp, "bin")}:/usr/bin:/bin`,
        TOOLS: join(tmp, "tools"),
        HOME: join(tmp, "home"),
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(tmp, "argv"), "utf-8").trim()).toBe("peer redeem");
    expect(JSON.parse(readFileSync(join(tmp, "redeemed"), "utf-8"))).toMatchObject({
      code: "ABCD-EFGH",
    });
  });

  it("bun missing on the host's ssh PATH: names bun, never says volley is missing", async () => {
    for (const stderr of [
      "env: bun: No such file or directory\n",
      "/usr/bin/env: 'bun': No such file or directory\n",
    ]) {
      const f = fakeExec(hostSsh({ code: 127, stderr }));
      const r = await run(
        [
          "join",
          "ABCD-EFGH",
          "--to",
          "dev@host",
          "--repo",
          box.repoPath,
          "--remote-volley",
          "~/.volley/bin/volley",
        ],
        deps(f.exec),
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(
        "`bun` is not on dev@host's PATH for a non-interactive ssh command",
      );
      expect(r.stderr).toContain("rerun `volley setup` on dev@host");
      expect(r.stderr).toContain("--remote-volley '<full path of bun there> ~/.volley/bin/volley'");
      expect(r.stderr).not.toContain("does not exist");
      expect(r.stderr).toContain("the code is still valid");
    }
  });

  it("a --remote-volley path that is missing names that path, without suggesting it again", async () => {
    const g = fakeExec(
      hostSsh({
        code: 127,
        stderr: "bash: line 6: /opt/volley/bin/volley: No such file or directory\n",
      }),
    );
    const r = await run(
      [
        "join",
        "ABCD-EFGH",
        "--to",
        "dev@host",
        "--repo",
        box.repoPath,
        "--remote-volley",
        "/opt/volley/bin/volley",
      ],
      deps(g.exec),
    );
    expect(r.stderr).toContain("`/opt/volley/bin/volley` does not exist on dev@host.");
    expect(r.stderr).toContain("--remote-volley '~/.volley/bin/volley'");
    // The suggested path itself missing: setup has not run there.
    const h = fakeExec(
      hostSsh({
        code: 127,
        stderr: "bash: line 6: /path/to/home/.volley/bin/volley: No such file or directory\n",
      }),
    );
    const again = await run(
      [
        "join",
        "ABCD-EFGH",
        "--to",
        "dev@host",
        "--repo",
        box.repoPath,
        "--remote-volley",
        "~/.volley/bin/volley",
      ],
      deps(h.exec),
    );
    expect(again.stderr).toContain(
      "`/path/to/home/.volley/bin/volley` does not exist on dev@host.",
    );
    expect(again.stderr).toContain(
      "Run `volley setup` on dev@host (it installs ~/.volley/bin/volley)",
    );
    expect(again.stderr).not.toContain("--remote-volley '~/.volley/bin/volley'");
  });

  it("a refused code writes nothing and installs nothing", async () => {
    const f = fakeExec(
      hostSsh({ code: 1, stderr: "volley peer redeem: invalid or expired pairing code\n" }),
    );
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "host", "--repo", box.repoPath],
      deps(f.exec),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("invalid or expired pairing code");
    expect(existsSync(peerFile(home))).toBe(false);
    expect(f.calls.some((c) => c.argv[0] === "systemctl")).toBe(false);
  });

  it("refuses a name that cannot be an account; defaults it from the hostname", async () => {
    expect(defaultName("Box-A.lan")).toBe("box-a");
    expect(defaultName("My Mac.local")).toBe("my-mac");
    const f = fakeExec(() => ({}));
    const r = await run(["join", "X", "--to", "h", "--name", "Bad Name"], deps(f.exec));
    expect(r.exitCode).toBe(2);
    expect(f.calls).toHaveLength(0);
  });

  it("needs --to", async () => {
    const r = await run(["join", "ABCD-EFGH"], deps(fakeExec(() => ({})).exec));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--to");
  });
});

describe("volley peer on the supervisor's machine", () => {
  const ADMIN = { VOLLEY_AUTH_USERNAME: "admin-1", VOLLEY_AUTH_PASSWORD: "a-pw" };

  it("invite is an admin op on the admin's account-op topic; prints the sealed code and the join command", async () => {
    const v = await fakeVolleyd(tb.url, (_op, p) => ({
      ok: true,
      result: { expires_at: "2026-10-19T09:10:00.000Z", ttl_s: 600 },
      sealed: sealTo(p.reply_key, { code: "ABCD-EFGH" }),
    }));
    const r = await run(["invite"], deps(fakeExec(() => ({})).exec), ADMIN);
    await v.b.disconnect();
    expect(r.exitCode).toBe(0);
    expect(v.adminTopics).toEqual(["volley/_system/auth/ops/admin-1"]);
    expect(v.seen[0]).toMatchObject({ op: "peer_invite", reply_key: { kty: "RSA" } });
    expect(r.stdout).toContain("Pairing code: ABCD-EFGH");
    expect(r.stdout).toContain(
      "volley peer join ABCD-EFGH --to dev@Box-A.lan --repo <path to its clone of the wave repo>",
    );
  });

  it("invite --for <name> mints a re-pairing code bound to the name and prints a join with --replace", async () => {
    const v = await fakeVolleyd(tb.url, (_op, p) => ({
      ok: true,
      result: { expires_at: "2026-10-19T09:10:00.000Z", ttl_s: 600, for: p.for },
      sealed: sealTo(p.reply_key, { code: "ABCD-EFGH" }),
    }));
    const r = await run(["invite", "--for", "box-a"], deps(fakeExec(() => ({})).exec), ADMIN);
    await v.b.disconnect();
    expect(r.exitCode).toBe(0);
    expect(v.seen[0]).toMatchObject({ op: "peer_invite", for: "box-a" });
    expect(r.stdout).toContain(
      "volley peer join ABCD-EFGH --to dev@Box-A.lan --repo <path to its clone of the wave repo> --name box-a --replace",
    );
    expect(r.stdout).toContain("re-pairs box-a");
  });

  it("invite --for refuses a name that cannot be a machine", async () => {
    const r = await run(["invite", "--for", "Bad Name"], deps(fakeExec(() => ({})).exec), ADMIN);
    expect(r.exitCode).toBe(2);
  });

  it("redeem hands the stdin request to volleyd and prints the unsealed account as JSON", async () => {
    const v = await fakeVolleyd(tb.url, (_op, p) => ({
      ok: true,
      result: {
        name: p.name,
        namespace: "default",
        broker: { host: "127.0.0.1", port: 1883 },
        remote_port: p.port,
      },
      sealed: sealTo(p.reply_key, { username: p.name, password: "peer-secret" }),
    }));
    const req = {
      code: "ABCD-EFGH",
      name: "box-a",
      target: "dev@box-a",
      volley_dir: "/opt/volley",
      port: 21883,
    };
    const r = await run(
      ["redeem"],
      deps(fakeExec(() => ({})).exec, { readStdin: async () => JSON.stringify(req) }),
    );
    await v.b.disconnect();
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(v.seen[0]).toMatchObject({ op: "peer_join", ...req });
    expect(JSON.parse(r.stdout)).toEqual({ ...JOINED, namespace: "default" });
  });

  it("redeem reports volleyd's refusal on stderr with exit 1", async () => {
    const v = await fakeVolleyd(tb.url, () => ({
      ok: false,
      error: "invalid or expired pairing code",
    }));
    const r = await run(
      ["redeem"],
      deps(fakeExec(() => ({})).exec, { readStdin: async () => "{}" }),
    );
    await v.b.disconnect();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("invalid or expired pairing code");
    expect(r.stdout).toBe("");
  });

  it("remove sends peer_remove and reports the account revoked and the host cleared", async () => {
    const v = await fakeVolleyd(tb.url, (_op, p) => ({
      ok: true,
      result: { name: p.name, revoked: true, host_removed: true },
    }));
    const r = await run(["remove", "box-a"], deps(fakeExec(() => ({})).exec), ADMIN);
    await v.b.disconnect();
    expect(r.exitCode).toBe(0);
    expect(v.adminTopics).toEqual(["volley/_system/auth/ops/admin-1"]);
    expect(v.seen[0]).toMatchObject({ op: "peer_remove", name: "box-a" });
    expect(r.stdout).toContain("removed box-a: account revoked, hosts.box-a removed");
  });

  it("remove --drain sends drain: true and says the machine is drained, then removed", async () => {
    const v = await fakeVolleyd(tb.url, (_op, p) => ({
      ok: true,
      result: { name: p.name, removing: "drain", agents: 2, revoked: false, host_removed: false },
    }));
    const r = await run(["remove", "box-a", "--drain"], deps(fakeExec(() => ({})).exec), ADMIN);
    await v.b.disconnect();
    expect(r.exitCode).toBe(0);
    expect(v.seen[0]).toMatchObject({ op: "peer_remove", name: "box-a", drain: true });
    expect(v.seen[0]?.now).toBeUndefined();
    expect(r.stdout).toBe(
      "draining box-a: nothing new starts there; 2 agents left. volleyd removes it (revokes its account, drops hosts.box-a) once they finish.\n",
    );
  });

  it("remove --now sends now: true and says the agents are being stopped", async () => {
    const v = await fakeVolleyd(tb.url, (_op, p) => ({
      ok: true,
      result: { name: p.name, removing: "now", agents: 1, revoked: false, host_removed: false },
    }));
    const r = await run(["remove", "box-a", "--now"], deps(fakeExec(() => ({})).exec), ADMIN);
    await v.b.disconnect();
    expect(r.exitCode).toBe(0);
    expect(v.seen[0]).toMatchObject({ op: "peer_remove", name: "box-a", now: true });
    expect(r.stdout).toContain("stopping 1 agent on box-a");
    expect(r.stdout).toContain("respawn");
  });

  it("remove --drain on an idle machine removes it at once, as plain remove does", async () => {
    const v = await fakeVolleyd(tb.url, (_op, p) => ({
      ok: true,
      result: { name: p.name, revoked: true, host_removed: true },
    }));
    const r = await run(["remove", "box-a", "--drain"], deps(fakeExec(() => ({})).exec), ADMIN);
    await v.b.disconnect();
    expect(r.stdout).toContain("removed box-a: account revoked, hosts.box-a removed");
  });

  it("remove refuses --drain with --now, and --drain on another verb", async () => {
    const both = await run(
      ["remove", "box-a", "--drain", "--now"],
      deps(fakeExec(() => ({})).exec),
    );
    expect(both.exitCode).toBe(2);
    expect(both.stderr).toContain("--drain and --now exclude each other");
    const other = await run(["list", "--drain"], deps(fakeExec(() => ({})).exec));
    expect(other.exitCode).toBe(2);
    expect(other.stderr).toContain("--drain is an option of volley peer remove only");
  });

  it("list prints each machine's health", async () => {
    const v = await fakeVolleyd(tb.url, () => ({
      ok: true,
      result: {
        machines: [
          {
            name: "box-a",
            os: "linux",
            cores: 8,
            tunnel: "down",
            reason: "heartbeat_timeout",
            load: [1, 0.5, 0.25],
            agents: 2,
            last_seen: "2026-10-19T09:00:00.000Z",
          },
        ],
        hosts: ["box-a", "box-b"],
      },
    }));
    const r = await run(["list"], deps(fakeExec(() => ({})).exec));
    await v.b.disconnect();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("box-a\ttunnel down (heartbeat_timeout)");
    expect(r.stdout).toContain("box-b\tno heartbeat yet");
  });

  it("without VOLLEY_AUTH_* a host command signs in with the coordinator's file (redeem runs over ssh)", async () => {
    const locked = await startTestBroker({
      credentials: { username: "coordinator", password: "c-pw" },
    });
    try {
      const d = deps(fakeExec(() => ({})).exec);
      const env = { VOLLEY_BROKER_URL: locked.url };
      // No credentials anywhere: the broker refuses.
      expect((await run(["list"], d, env)).stderr).toContain("refused");
      writeFileSync(
        join(home, "coordinator.json"),
        JSON.stringify({ username: "coordinator", password: "c-pw" }),
        { mode: 0o600 },
      );
      // Signed in (it gets as far as finding no volleyd).
      expect((await run(["list"], d, env)).stderr).toContain("volleyd is not running");
    } finally {
      await locked.close();
    }
  });

  it("redeem after a `--dir` setup finds the coordinator's file in the auth dir setup.json recorded", async () => {
    const locked = await startTestBroker({
      credentials: { username: "coordinator", password: "c-pw" },
    });
    try {
      // `volley setup --dir <dir>` recorded the dir; ssh gives redeem no VOLLEY_AUTH_DIR.
      const dir = join(home, "custom-auth");
      const vhome = join(home, "volleyd");
      mkdirSync(dir, { recursive: true });
      mkdirSync(vhome, { recursive: true });
      writeFileSync(
        join(dir, "coordinator.json"),
        JSON.stringify({ username: "coordinator", password: "c-pw" }),
        { mode: 0o600 },
      );
      writeFileSync(
        join(vhome, "setup.json"),
        JSON.stringify({
          layout: "etc",
          config: "/etc/mosquitto/mosquitto.conf",
          state_file: "/var/lib/mosquitto/dynamic-security.json",
          auth_dir: dir,
        }),
      );
      const io = makeBufferIO();
      const code = await runPeer(
        {
          argv: ["redeem"],
          env: { VOLLEY_BROKER_URL: locked.url, VOLLEY_NAMESPACE: NS, VOLLEYD_HOME: vhome },
          io,
        },
        deps(fakeExec(() => ({})).exec, { readStdin: async () => "{}" }),
      );
      // Signed in (it gets as far as finding no volleyd), not refused for want of credentials.
      expect(io.readStderr()).toContain("volleyd is not running");
      expect(code).toBe(EXIT.ERROR);
    } finally {
      await locked.close();
    }
  });

  it("invite and remove never sign in with the coordinator's file: they need an admin login", async () => {
    writeFileSync(
      join(home, "coordinator.json"),
      JSON.stringify({ username: "coordinator", password: "c-pw" }),
      { mode: 0o600 },
    );
    for (const argv of [["invite"], ["remove", "box-a"]]) {
      const r = await run(argv, deps(fakeExec(() => ({})).exec));
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("admin");
      expect(r.stderr).toContain("VOLLEY_AUTH_USERNAME");
    }
  });

  it("invite with a login this machine knows is not an admin refuses at once, without asking volleyd", async () => {
    writeFileSync(
      join(home, "accounts.json"),
      JSON.stringify({
        accounts: [
          { name: "steer-1", role: "steer", kind: "device", created: "2026-10-19T00:00:00.000Z" },
          { name: "boss", role: "admin", kind: "human", created: "2026-10-19T00:00:00.000Z" },
        ],
      }),
    );
    const started = Date.now();
    const r = await run(["invite"], deps(fakeExec(() => ({})).exec), {
      VOLLEY_AUTH_USERNAME: "steer-1",
      VOLLEY_AUTH_PASSWORD: "s-pw",
    });
    expect(r.exitCode).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("steer-1 is a steer account, not an admin one");
    expect(r.stderr).not.toContain("did not answer");
    expect(Date.now() - started).toBeLessThan(2_000);
    const env = { VOLLEY_AUTH_DIR: home };
    expect(localNotAdmin("coordinator", env)).toContain("fixed identity");
    expect(localNotAdmin("boss", env)).toBeNull();
    // Not in this machine's registry (another install's admin): volleyd decides.
    expect(localNotAdmin("someone-else", env)).toBeNull();
  });

  it("an unanswered admin op (the broker drops a non-admin's request) says it needs an admin", async () => {
    // A volleyd that answers only its mailbox: as if the broker dropped the ops-topic publish.
    const b = new VolleyBroker();
    await b.connect({ url: tb.url, agentId: "volleyd" });
    await b.publish(
      `volley/${NS}/volleyd/status`,
      JSON.stringify(
        buildEnvelope({
          agentId: "volleyd",
          parentId: null,
          channel: "status",
          type: "working",
          payload: {},
        }),
      ),
      { qos: 1, retain: true },
    );
    const r = await run(["invite", "--timeout", "1"], deps(fakeExec(() => ({})).exec), {
      VOLLEY_AUTH_USERNAME: "steer-1",
      VOLLEY_AUTH_PASSWORD: "s-pw",
    });
    await b.disconnect();
    expect(r.exitCode).toBe(EXIT.TIMEOUT);
    expect(r.stderr).toContain("admin ops");
    expect(r.stderr).toContain("is steer-1 one?");
  });

  it("a host command with volleyd down says so", async () => {
    const r = await run(["list"], deps(fakeExec(() => ({})).exec));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("volleyd is not running");
  });
});

describe("volley peer run (the service)", () => {
  const cfg: PeerConfig = {
    name: "box-a",
    host: "dev@host",
    target: "dev@box-a",
    namespace: "default",
    broker: { host: "127.0.0.1", port: 1883 },
    remote_port: 21883,
    username: "box-a",
    password: "peer-secret",
    joined_at: "2026-10-19T09:00:00.000Z",
  };
  const writeCfg = (over: Partial<PeerConfig> = {}) => {
    mkdirSync(join(home, ".volley"), { recursive: true });
    writeFileSync(peerFile(home), JSON.stringify({ ...cfg, ...over }), { mode: 0o600 });
  };

  it("the record carries laptop: true on a machine with a battery, nothing on one without", async () => {
    const f = fakeExec(() => ({}));
    const on = await machineEnvelope(deps(f.exec, { laptop: async () => true }), cfg, "up");
    expect(parseEnvelope(on)?.payload).toMatchObject({ name: "box-a", laptop: true });
    expectValidRecord(on);
    const off = await machineEnvelope(deps(f.exec, { laptop: async () => false }), cfg, "up");
    expect(parseEnvelope(off)?.payload).not.toHaveProperty("laptop");
  });

  /** A retained readiness verdict for box-a, published as `agentId`. */
  async function readiness(agentId: string, payload: Record<string, unknown>) {
    const sup = new VolleyBroker();
    await sup.connect({ url: tb.url, agentId });
    await sup.publish(
      "volley/_system/machines/box-a/readiness",
      JSON.stringify(
        buildEnvelope({
          agentId,
          parentId: null,
          channel: "_system/machines",
          type: "readiness",
          payload: { name: "box-a", ...payload },
        }),
      ),
      { qos: 1, retain: true },
    );
    await sup.disconnect();
  }

  /**
   * Run the service on a fake clock for `beats` heartbeats; every record it published. Each beat
   * also lets a little real time pass (the last one more), so the doctor, which runs beside the
   * beats, can finish.
   */
  async function heartbeats(
    beats: number,
    f: { exec: PeerExec; calls: Call[] } = fakeExec(() => undefined),
    opts: {
      between?: (beat: number) => void | Promise<void>;
      deps?: (d: PeerDeps) => void;
      over?: Partial<PeerDeps>;
      /** How long (real ms) the first beat's wait for the start-up doctor lasts (default 0). */
      firstDoctorWait?: number;
    } = {},
  ) {
    const start = Date.parse("2026-10-19T09:00:00.000Z");
    let t = start;
    const stop = new AbortController();
    let n = 0;
    const d = deps(f.exec, {
      now: () => new Date(t),
      monotonic: () => t - start,
      sleep: async (ms, signal) => {
        if (ms === PEER_DEFAULTS.first_doctor_wait_ms && opts.firstDoctorWait !== undefined) {
          await new Promise<void>((r) => {
            const t = setTimeout(r, opts.firstDoctorWait);
            signal?.addEventListener("abort", () => {
              clearTimeout(t);
              r();
            });
          });
          return;
        }
        if (ms !== PEER_DEFAULTS.heartbeat_ms) return;
        const last = ++n >= beats;
        await new Promise((r) => setTimeout(r, last ? 300 : 30));
        if (last) stop.abort();
        else {
          await opts.between?.(n);
          t += ms;
        }
      },
      ...opts.over,
    });
    opts.deps?.(d);
    const reader = new VolleyBroker();
    await reader.connect({ url: tb.url, agentId: "reader" });
    const records: string[] = [];
    const unsubscribe = await reader.subscribeStream(machineTopic("box-a"), ({ payload }) => {
      records.push(payload);
    });
    const code = await runService(makeBufferIO(), d, stop.signal);
    await new Promise((r) => setTimeout(r, 100));
    await unsubscribe();
    await reader.disconnect();
    return { code, records, f };
  }

  it("embeds the doctor in every heartbeat; the record validates against machine.schema.json", async () => {
    writeCfg({ repo: box.repoPath });
    // The default profile's login, as Claude Code records it beside the trust table.
    const claudeJsonFile = join(box.home, ".claude.json");
    const claudeJson = JSON.parse(readFileSync(claudeJsonFile, "utf-8")) as Record<string, unknown>;
    writeFileSync(
      claudeJsonFile,
      JSON.stringify({
        ...claudeJson,
        oauthAccount: { emailAddress: "owner@example.com", organizationName: "Example Org" },
      }),
    );
    // The supervisor's verdict names the version it requires (only volleyd's is believed).
    await readiness("volleyd", { requirements: { volley: "0.5.0" } });
    const { code, records } = await heartbeats(3);
    expect(code).toBe(0);
    const up = records
      .map((r) => parseEnvelope(r))
      .filter((e) => e?.payload && (e.payload as { tunnel?: string }).tunnel === "up")
      .map((e) => e?.payload as Record<string, unknown>);
    expect(up.length).toBeGreaterThanOrEqual(3);
    for (const raw of records) expectValidRecord(raw);
    // Here the first beat's wait for the start-up doctor ends at once (the fake sleep), so it may
    // go out before the doctor finishes; the record published when the doctor finishes, and
    // every beat after, carries its result.
    const doctored = up.filter((p) => p.doctor_at !== undefined);
    expect(doctored.length).toBeGreaterThanOrEqual(1);
    expect(up.at(-1)?.doctor_at).toBeDefined();
    const p = doctored[0] as Record<string, unknown>;
    expect(p).toMatchObject({
      name: "box-a",
      kind: "peer",
      memory: { total_mb: 16384, available_pct: 50 },
      disk: { free_gb: 500, free_pct: 50 },
      uptime_s: 86_400,
      versions: { peer: "0.4.0", volley: "0.4.0", bun: "1.3.2", git: "2.43.0" },
      auth: {
        gh: "ok",
        claude: "signed_in",
        trust: "ok",
        claude_plan: "max",
        claude_email: "owner@example.com",
        claude_org: "Example Org",
      },
      repo: { path: box.repoPath, exists: true, origin: "github.com/example-org/example-repo" },
    });
    // When the doctor finished: the first beat's time, or the next one's.
    expect(p.doctor_at).toMatch(/^2026-10-19T09:00:(00|30)\.000Z$/);
    const checks = p.checks as { id: string; ok: boolean; fix?: unknown }[];
    expect(checks.find((c) => c.id === "volley.version")).toMatchObject({ ok: false });
    // Fix text never travels in the record.
    expect(checks.some((c) => "fix" in c)).toBe(false);
    // Heartbeats between doctor runs repeat its result.
    const later = up.at(-1) as Record<string, unknown>;
    expect(later.doctor_at).toBe(p.doctor_at);
    expect(later.last_seen).toBe("2026-10-19T09:01:00.000Z");
  });

  it("heartbeats carry the last doctor run's claude_logins, and none before it", async () => {
    writeCfg({ repo: box.repoPath });
    await readiness("volleyd", {});
    storeLogins(box.home, { default: Date.parse("2026-10-20T09:00:00.000Z") });
    const api = usageEndpoint();
    const { records } = await heartbeats(
      3,
      fakeExec(() => undefined),
      { over: { fetch: api.fetch } },
    );
    const up = records
      .map((r) => parseEnvelope(r)?.payload as Record<string, unknown>)
      .filter((p) => p?.tunnel === "up");
    for (const raw of records) expectValidRecord(raw);
    for (const p of up.filter((p) => p.doctor_at === undefined)) {
      expect(p).not.toHaveProperty("claude_logins");
    }
    expect(up.at(-1)?.claude_logins).toMatchObject([
      { profile: "default", state: "ok", reading: { five_hour: { pct: 37 } } },
    ]);
    for (const r of records) expect(r).not.toContain(FAKE_TOKEN);
  });

  it("a doctor that hangs never holds up a heartbeat, and never runs twice at once", async () => {
    writeCfg({ repo: box.repoPath });
    await readiness("volleyd", {});
    const f = fakeExec(() => undefined);
    let hangs = 0;
    const hung: PeerExec = (argv, o) => {
      if (basename(argv[0] ?? "") !== "claude" || argv[1] !== "auth") return f.exec(argv, o);
      hangs++;
      return new Promise(() => {});
    };
    const perInterval = PEER_DEFAULTS.doctor_interval_s / (PEER_DEFAULTS.heartbeat_ms / 1000);
    const { records } = await heartbeats(perInterval + 2, { exec: hung, calls: f.calls });
    const up = records.filter((r) => r.includes('"tunnel":"up"'));
    // One record per beat, though the doctor never finished.
    expect(up).toHaveLength(perInterval + 2);
    expect(up.some((r) => r.includes("doctor_at"))).toBe(false);
    expect(hangs).toBe(1);
  });

  it("a token planted in every probe's output never reaches a heartbeat record", async () => {
    box.cleanup();
    const token = "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    box = fakePeerMachine({
      trusted: true,
      plant: token,
      origin: `https://x-access-token:${token}@github.com/example-org/example-repo.git`,
      gh: { user: token },
      claudeStatus: { loggedIn: true, subscriptionType: token },
    });
    home = box.home;
    writeCfg({ repo: box.repoPath });
    await readiness("volleyd", {});
    const { records } = await heartbeats(3);
    expect(records.some((r) => r.includes("doctor_at"))).toBe(true);
    for (const r of records) expect(r).not.toContain(token);
  });

  it("re-runs the doctor after doctor_interval_s and not before", async () => {
    writeCfg({ repo: box.repoPath });
    await readiness("volleyd", {});
    const perInterval = PEER_DEFAULTS.doctor_interval_s / (PEER_DEFAULTS.heartbeat_ms / 1000);
    const doctorRuns = (f: { calls: Call[] }) =>
      f.calls.filter((c) => basename(c.argv[0] ?? "") === "claude" && c.argv[1] === "auth").length;
    const before = await heartbeats(perInterval);
    expect(doctorRuns(before.f)).toBe(1);
    const after = await heartbeats(perInterval + 1);
    expect(doctorRuns(after.f)).toBe(2);
    const last = parseEnvelope(
      after.records.filter((r) => r.includes('"tunnel":"up"')).at(-1) ?? "",
    )?.payload as { doctor_at?: string };
    expect(last.doctor_at).toBe("2026-10-19T09:10:00.000Z");
  });

  const doctorRuns = (f: { calls: Call[] }) =>
    f.calls.filter((c) => basename(c.argv[0] ?? "") === "claude" && c.argv[1] === "auth").length;
  const lastUp = (records: string[]) =>
    parseEnvelope(records.filter((r) => r.includes('"tunnel":"up"')).at(-1) ?? "")?.payload as {
      doctor_at?: string;
      versions?: { peer: string; volley: string };
      checks?: { id: string; ok: boolean; detail: string }[];
    };

  it("a checkout update between heartbeats re-runs the doctor at once and re-reads both versions", async () => {
    writeCfg({ repo: box.repoPath });
    await readiness("volleyd", {});
    let cliVersion = "0.4.0";
    const f = fakeExec(() => undefined);
    const { records } = await heartbeats(4, f, {
      // After the first beat: the checkout moves to 0.5.0 (package.json, bun.lock), and the
      // doctor's own install of it rewrites the lock marker.
      between: (beat) => {
        if (beat !== 1) return;
        writeFileSync(
          join(box.volleyDir, "package.json"),
          JSON.stringify({ name: "volley", version: "0.5.0" }),
        );
        writeFileSync(
          join(box.volleyDir, "bun.lock"),
          '{ "lockfileVersion": 1, "for": "0.5.0" }\n',
        );
        writeFileSync(
          join(box.volleyDir, "node_modules", ".volley-lock-sha256"),
          `${lockHash(box.volleyDir)}\n`,
        );
        cliVersion = "0.5.0";
      },
      // The CLI's own version follows its checkout's package.json (realDeps reads it per run).
      deps: (d) => Object.defineProperty(d, "version", { get: () => cliVersion }),
    });
    expect(doctorRuns(f)).toBe(2);
    const last = lastUp(records);
    expect(last.versions).toMatchObject({ peer: "0.5.0", volley: "0.5.0" });
    expect(last.doctor_at).not.toBe("2026-10-19T09:00:00.000Z");
    expect(last.checks?.find((c) => c.id === "volley.installed")).toMatchObject({ ok: true });
  });

  it("runs the doctor at start: the first up record carries a fresh run, never none", async () => {
    writeCfg({ repo: box.repoPath });
    await readiness("volleyd", {});
    const { records } = await heartbeats(
      2,
      fakeExec(() => undefined),
      { firstDoctorWait: 5_000 },
    );
    const up = records
      .map((r) => parseEnvelope(r)?.payload as Record<string, unknown>)
      .filter((p) => p?.tunnel === "up");
    expect(up[0]?.doctor_at).toBe("2026-10-19T09:00:00.000Z");
    expect(up[0]?.checks).toBeDefined();
  });

  it("a stale bun.lock verdict clears on restart after the deploy's install records the lock", async () => {
    writeCfg({ repo: box.repoPath });
    await readiness("volleyd", {});
    const marker = join(box.volleyDir, "node_modules", ".volley-lock-sha256");
    // Installed by hand: the marker names another bun.lock.
    writeFileSync(marker, "0".repeat(64));
    const installed = (records: string[]) =>
      (
        records
          .map((r) => parseEnvelope(r)?.payload as Record<string, unknown>)
          .find((p) => p?.tunnel === "up")?.checks as { id: string; ok: boolean }[] | undefined
      )?.find((c) => c.id === "volley.installed");
    const before = await heartbeats(
      1,
      fakeExec(() => undefined),
      { firstDoctorWait: 5_000 },
    );
    expect(installed(before.records)).toMatchObject({ ok: false });
    // What `volley deploy` runs on the machine after its `bun install --frozen-lockfile`.
    const [cmd, ...args] = RECORD_LOCK_ARGV;
    const r = spawnSync(cmd as string, args, { cwd: box.volleyDir, encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe(`${lockHash(box.volleyDir)}\n`);
    const after = await heartbeats(
      1,
      fakeExec(() => undefined),
      { firstDoctorWait: 5_000 },
    );
    expect(installed(after.records)).toMatchObject({ ok: true });
  });

  it("only the lock marker changing (bun install by hand) re-runs the doctor on the next beat", async () => {
    writeCfg({ repo: box.repoPath });
    await readiness("volleyd", {});
    const f = fakeExec(() => undefined);
    await heartbeats(4, f, {
      between: (beat) => {
        if (beat === 1)
          writeFileSync(join(box.volleyDir, "node_modules", ".volley-lock-sha256"), "0".repeat(64));
      },
    });
    expect(doctorRuns(f)).toBe(2);
  });

  it("the doctor verb's stamp (a run of volley peer doctor) re-runs the service's doctor on its next beat", async () => {
    writeCfg({ repo: box.repoPath });
    await readiness("volleyd", {});
    const f = fakeExec(() => undefined);
    let stamp = "";
    await heartbeats(4, f, {
      between: (beat) => {
        if (beat !== 1) return;
        // What `volley peer doctor` leaves behind, written by a real run of the verb.
        stamp = peerDoctorStamp(home);
        mkdirSync(dirname(stamp), { recursive: true });
        writeFileSync(stamp, "2026-10-19T09:00:30.000Z\n");
      },
    });
    expect(stamp).not.toBe("");
    expect(doctorRuns(f)).toBe(2);
  });

  it("doctor --fix beside a running service: it re-runs within a beat, republishing the current version", async () => {
    writeCfg({ repo: box.repoPath });
    await readiness("volleyd", {});
    let cliVersion = "0.4.0";
    const f = fakeExec(() => undefined);
    let verb: Promise<{ stdout: string }> | undefined;
    const { records } = await heartbeats(4, f, {
      between: async (beat) => {
        if (beat === 1) {
          // The fix moves this checkout's CLI on; the verb runs between the service's beats and
          // waits (in real time) for the service's record to carry a run after its own.
          cliVersion = "0.5.0";
          verb = run(
            ["doctor", "--fix", "--yes"],
            deps(fakeExec(() => undefined).exec, {
              now: () => new Date("2026-10-19T09:00:15.000Z"),
              sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 100))),
            }),
          );
        }
        // The verb's own doctor takes real time (slow on CI): hold the service's next beat until
        // it has left its stamp, then let the service's re-run land before the beats run out.
        if (beat === 2) {
          for (let i = 0; !existsSync(peerDoctorStamp(home)); i++) {
            if (i >= 3_000) throw new Error("the verb never wrote its doctor-ran stamp (30 s)");
            await new Promise((r) => setTimeout(r, 10));
          }
        }
        if (beat === 3) await verb;
      },
      deps: (d) => Object.defineProperty(d, "version", { get: () => cliVersion }),
    });
    expect(verb).toBeDefined();
    expect((await verb)?.stdout).toContain("readiness republished");
    expect(doctorRuns(f)).toBe(2);
    const last = lastUp(records);
    expect(last.versions?.peer).toBe("0.5.0");
    expect(Date.parse(last.doctor_at ?? "")).toBeGreaterThan(
      Date.parse("2026-10-19T09:00:15.000Z"),
    );
  });

  it("keeps the -L tunnel up and heartbeats the record; a clean stop leaves it tunnel: down", async () => {
    writeCfg();
    const f = fakeExec(() => ({}));
    const stop = new AbortController();
    let beats = 0;
    const d = deps(f.exec, {
      sleep: async (_ms, signal) => {
        beats++;
        if (beats >= 3) stop.abort();
        await Promise.resolve();
        if (signal?.aborted) return;
      },
    });
    const io = makeBufferIO();
    const code = await runService(io, d, stop.signal);
    expect(code).toBe(0);
    expect(f.calls.find((c) => c.argv[1] === "-N")?.argv).toEqual(tunnelArgv(cfg));
    expect(tunnelArgv(cfg)).toContain("127.0.0.1:21883:127.0.0.1:1883");
    const reader = new VolleyBroker();
    await reader.connect({ url: tb.url, agentId: "reader" });
    const env = parseEnvelope((await reader.queryRetained(machineTopic("box-a"), 500)) ?? "");
    await reader.disconnect();
    expect(env?.payload).toMatchObject({ name: "box-a", tunnel: "down", reason: "disconnect" });
  });

  it("stops (exit 0, tunnel killed) once the broker refuses the revoked peer account", async () => {
    writeCfg();
    const f = fakeExec(() => ({}));
    const d = deps(f.exec, {
      connect: async () => {
        throw new VolleyError("AUTH_FAILED", "broker refused box-a");
      },
    });
    const io = makeBufferIO();
    const code = await runService(io, d);
    expect(code).toBe(0);
    expect(io.readStderr()).toContain("unpaired");
    expect(f.calls.some((c) => c.argv[1] === "-N")).toBe(true);
  });

  it("without peer.json there is nothing to run", async () => {
    const io = makeBufferIO();
    expect(await runService(io, deps(fakeExec(() => ({})).exec))).toBe(1);
    expect(io.readStderr()).toContain("volley peer join");
  });
});

describe("every machine through its own tunnel (#460)", () => {
  const cfg: PeerConfig = {
    name: "box-a",
    host: "dev@host",
    target: "dev@box-a",
    namespace: "default",
    broker: { host: "127.0.0.1", port: 1883 },
    remote_port: 21883,
    username: "box-a",
    password: "peer-secret",
    joined_at: "2026-10-19T09:00:00.000Z",
  };
  const writeCfg = (over: Partial<PeerConfig> = {}) => {
    mkdirSync(join(home, ".volley"), { recursive: true });
    writeFileSync(peerFile(home), JSON.stringify({ ...cfg, ...over }), { mode: 0o600 });
  };
  /** The service for `beats` heartbeats; the URLs it connected to. */
  async function serve(beats: number, f = fakeExec(() => ({}))) {
    const stop = new AbortController();
    let n = 0;
    const urls: string[] = [];
    const base = deps(f.exec);
    const d = deps(f.exec, {
      sleep: async (ms) => {
        if (ms !== PEER_DEFAULTS.heartbeat_ms) return;
        await new Promise((r) => setTimeout(r, 20));
        if (++n >= beats) stop.abort();
      },
      connect: async (url, auth, will) => {
        urls.push(url);
        return base.connect(url, auth, will);
      },
    });
    const code = await runService(makeBufferIO(), d, stop.signal);
    return { code, urls, f };
  }

  it("a peer.json without the new keys reads as tunnel: ssh, heartbeat: true", () => {
    writeCfg();
    const read = readPeerConfig(home);
    expect(peerTunnel(read)).toBe("ssh");
    expect(peerHeartbeat(read)).toBe(true);
    writeCfg({ tunnel: "none", heartbeat: false });
    expect(peerTunnel(readPeerConfig(home))).toBe("none");
    expect(peerHeartbeat(readPeerConfig(home))).toBe(false);
  });

  it("tunnel: none spawns no ssh and connects to the broker on this machine's loopback", async () => {
    writeCfg({ tunnel: "none", remote_port: 1883 });
    const { code, urls, f } = await serve(2);
    expect(code).toBe(0);
    expect(f.calls.some((c) => c.argv[0] === "ssh")).toBe(false);
    expect(urls[0]).toBe("mqtt://127.0.0.1:1883");
  });

  it("heartbeat: false publishes no record and still keeps the tunnel", async () => {
    writeCfg({ heartbeat: false });
    const reader = new VolleyBroker();
    await reader.connect({ url: tb.url, agentId: "reader" });
    const records: string[] = [];
    const unsubscribe = await reader.subscribeStream(machineTopic("box-a"), ({ payload }) => {
      records.push(payload);
    });
    const { code, urls, f } = await serve(3);
    await new Promise((r) => setTimeout(r, 100));
    await unsubscribe();
    await reader.disconnect();
    expect(code).toBe(0);
    expect(urls).toEqual([]);
    expect(records).toEqual([]);
    expect(f.calls.find((c) => c.argv[1] === "-N")?.argv).toEqual(tunnelArgv(cfg));
  });

  /** retarget on a fake clock: the probe answers from `answersAt` (ms after the start) on. */
  function retargetDeps(f: ReturnType<typeof fakeExec>, answersAt: number | null) {
    let t = Date.parse("2026-10-19T09:00:00.000Z");
    const start = t;
    const probed: number[] = [];
    const d = deps(f.exec, {
      now: () => new Date(t),
      sleep: async (ms) => {
        t += ms;
      },
      probePort: async (port) => {
        probed.push(port);
        return answersAt !== null && t - start >= answersAt;
      },
    });
    return { d, probed };
  }

  it("retarget rewrites host and remote_port, restarts the unit and exits 0 once the tunnel answers", async () => {
    writeCfg({ repos: { "acme/widgets": "/path/to/repo" } });
    const f = fakeExec(() => ({}));
    const { d, probed } = retargetDeps(f, 3_000);
    const r = await run(["retarget", "--to", "dev@other", "--port", "21884"], d);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const after = JSON.parse(readFileSync(peerFile(home), "utf-8")) as PeerConfig;
    expect(after).toMatchObject({
      ...cfg,
      host: "dev@other",
      remote_port: 21884,
      tunnel: "ssh",
      repos: { "acme/widgets": "/path/to/repo" },
    });
    expect(statSync(peerFile(home)).mode & 0o777).toBe(0o600);
    expect(f.calls.filter((c) => c.argv[0] === "systemctl").map((c) => c.argv)).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", SYSTEMD_UNIT],
      ["systemctl", "--user", "restart", SYSTEMD_UNIT],
    ]);
    expect(new Set(probed)).toEqual(new Set([21884]));
    expect(r.stdout).toContain("dev@other");
    expect(r.stdout).toContain("21884");
  });

  it("retarget exits 1 when the tunnel does not answer within 30 s", async () => {
    writeCfg();
    const f = fakeExec(() => ({}));
    const { d, probed } = retargetDeps(f, null);
    const r = await run(["retarget", "--to", "dev@other"], d);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("did not answer");
    expect(r.stderr).toContain("30 s");
    expect(probed.length).toBeGreaterThan(1);
    expect(probed.length).toBeLessThanOrEqual(32);
  });

  it("retarget --tunnel none points remote_port at the broker's port and runs no ssh", async () => {
    writeCfg();
    const f = fakeExec(() => ({}));
    const { d, probed } = retargetDeps(f, 0);
    const r = await run(["retarget", "--to", "dev@broker-box", "--tunnel", "none"], d);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(peerFile(home), "utf-8"))).toMatchObject({
      host: "dev@broker-box",
      tunnel: "none",
      remote_port: 1883,
    });
    expect(probed).toEqual([1883]);
    expect(f.calls.some((c) => c.argv[0] === "ssh")).toBe(false);
  });

  it("retarget from none to ssh without --port takes the tunnel's default port, not the broker's", async () => {
    writeCfg({ tunnel: "none", remote_port: 1883 });
    const f = fakeExec(() => ({}));
    const { d, probed } = retargetDeps(f, 0);
    const r = await run(["retarget", "--to", "dev@other", "--tunnel", "ssh"], d);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(peerFile(home), "utf-8"))).toMatchObject({
      tunnel: "ssh",
      remote_port: PEER_DEFAULTS.remote_port,
    });
    expect(probed).toEqual([PEER_DEFAULTS.remote_port]);
  });

  it("retarget puts peer.json back when the service cannot be restarted", async () => {
    writeCfg();
    const before = JSON.parse(readFileSync(peerFile(home), "utf-8"));
    const f = fakeExec((c) => (c.argv[0] === "systemctl" ? { code: 1, stderr: "no" } : {}));
    const { d } = retargetDeps(f, 0);
    const r = await run(["retarget", "--to", "dev@other"], d);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not restarted");
    expect(JSON.parse(readFileSync(peerFile(home), "utf-8"))).toEqual(before);
  });

  it("retarget refuses a missing or option-like --to and a bad --tunnel", async () => {
    writeCfg();
    const f = fakeExec(() => ({}));
    const { d } = retargetDeps(f, 0);
    expect((await run(["retarget"], d)).exitCode).toBe(2);
    expect((await run(["retarget", "--to=-oProxyCommand=x"], d)).exitCode).toBe(2);
    expect((await run(["retarget", "--to", "dev@a b"], d)).exitCode).toBe(2);
    expect((await run(["retarget", "--to", "dev@x", "--tunnel", "udp"], d)).exitCode).toBe(2);
    expect(f.calls).toEqual([]);
  });

  it("join --tunnel none asks for no tunnel, and peer.json keeps it", async () => {
    const f = fakeExec(hostSsh({ stdout: JSON.stringify({ ...JOINED, remote_port: 1883 }) }));
    const r = await run(
      [
        "join",
        "ABCD-EFGH",
        "--to",
        "dev@host",
        "--name",
        "box-a",
        "--target",
        "dev@box-a",
        "--tunnel",
        "none",
        "--repo",
        box.repoPath,
        "--no-service",
      ],
      deps(f.exec),
    );
    expect(r.exitCode).toBe(0);
    const ssh = f.calls.filter((c) => c.argv[0] === "ssh");
    expect(redeemRequest(ssh[1]?.input as string).request).toMatchObject({ tunnel: "none" });
    expect(JSON.parse(readFileSync(peerFile(home), "utf-8"))).toMatchObject({
      tunnel: "none",
      remote_port: 1883,
    });
  });

  it("join without --tunnel sends and writes no tunnel key (an ssh tunnel is the default)", async () => {
    const f = fakeExec(hostSsh({ stdout: JSON.stringify(JOINED) }));
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "dev@host", "--repo", box.repoPath, "--no-service"],
      deps(f.exec),
    );
    expect(r.exitCode).toBe(0);
    const ssh = f.calls.filter((c) => c.argv[0] === "ssh");
    expect(redeemRequest(ssh[1]?.input as string).request.tunnel).toBeUndefined();
    expect(JSON.parse(readFileSync(peerFile(home), "utf-8")).tunnel).toBeUndefined();
    expect((await run(["join", "X", "--to", "h", "--tunnel", "udp"], deps(f.exec))).exitCode).toBe(
      2,
    );
  });
});

describe("volley peer doctor (the verb)", () => {
  const writeCfg = (over: Partial<PeerConfig> = {}) => {
    mkdirSync(join(home, ".volley"), { recursive: true });
    writeFileSync(
      peerFile(home),
      JSON.stringify({
        name: "box-a",
        host: "dev@host",
        target: "dev@box-a",
        namespace: "default",
        broker: { host: "127.0.0.1", port: 1883 },
        remote_port: 21883,
        username: "box-a",
        password: "peer-secret",
        joined_at: "2026-10-19T09:00:00.000Z",
        ...over,
      }),
      { mode: 0o600 },
    );
  };
  const readiness = async (agentId: string, volley: string) => {
    const b = new VolleyBroker();
    await b.connect({ url: tb.url, agentId });
    await b.publish(
      "volley/_system/machines/box-a/readiness",
      JSON.stringify(
        buildEnvelope({
          agentId,
          parentId: null,
          channel: "_system/machines",
          type: "readiness",
          payload: { name: "box-a", requirements: { volley } },
        }),
      ),
      { qos: 1, retain: true },
    );
    await b.disconnect();
  };
  const doctorJson = async (argv: string[], over: Partial<PeerDeps> = {}) => {
    const f = fakeExec(() => undefined);
    const r = await run(["doctor", "--json", ...argv], deps(f.exec, over));
    return { ...r, f, report: r.exitCode === 2 ? null : JSON.parse(r.stdout) };
  };
  const check = (r: { checks: { id: string }[] }, id: string) =>
    r.checks.find((c) => c.id === id) as { ok: boolean; detail: string } | undefined;

  it("refuses an --origin that carries a password or a token, or reads like an option", async () => {
    for (const origin of [
      "https://user:pw@github.com/example-org/example-repo.git",
      "https://x-access-token:ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789@github.com/o/r",
      "-oProxyCommand=sh",
    ]) {
      const r = await doctorJson(["--origin", origin]);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("--origin");
      expect(r.stderr).not.toContain("ghp_");
    }
  });

  it("--clone needs --fix", async () => {
    const r = await doctorJson(["--clone", "--repo", box.repoPath]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--clone needs --fix");
  });

  it("the doctor's flags are refused on the other verbs (never silently ignored)", async () => {
    const f = fakeExec(() => undefined);
    const join = await run(["join", "ABCD-EFGH", "--to", "dev@host", "--clone"], deps(f.exec));
    expect(join.exitCode).toBe(2);
    expect(join.stderr).toContain("--clone is an option of volley peer doctor only");
    expect(f.calls).toEqual([]);
    const invite = await run(["invite", "--fix"], deps(f.exec));
    expect(invite.exitCode).toBe(2);
    const doctor = await run(["doctor", "--for", "box-a"], deps(f.exec));
    expect(doctor.exitCode).toBe(2);
    expect(doctor.stderr).toContain("--for is an option of volley peer invite only");
  });

  it("--repo defaults to peer.json's; the supervisor's requirement is read through the tunnel", async () => {
    writeCfg({ repo: box.repoPath });
    await readiness("volleyd", "0.5.0");
    const r = await doctorJson([]);
    expect(r.exitCode).toBe(1);
    expect(r.report.repo.path).toBe(box.repoPath);
    expect(check(r.report, "volley.version")?.ok).toBe(false);
    expect(check(r.report, "volley.version")?.detail).toContain("0.5.0");
    // --repo wins over peer.json's.
    const other = await doctorJson(["--repo", join(box.root, "elsewhere")]);
    expect(other.report.repo.path).toBe(join(box.root, "elsewhere"));
  });

  it("a readiness verdict from anyone but the supervisor is ignored", async () => {
    writeCfg({ repo: box.repoPath });
    await readiness("box-b", "0.5.0");
    const r = await doctorJson([]);
    expect(check(r.report, "volley.version")).toMatchObject({ ok: true });
    expect(check(r.report, "volley.version")?.detail).toContain("not known here");
  });

  it("a tunnel that is down leaves the requirement unknown; the doctor still runs", async () => {
    writeCfg({ repo: box.repoPath });
    const r = await doctorJson([], {
      connect: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:21883");
      },
    });
    expect(r.exitCode).toBe(0);
    expect(check(r.report, "volley.version")?.detail).toContain("not known here");
  });

  it("every run on a paired machine leaves the stamp the service watches", async () => {
    writeCfg({ repo: box.repoPath });
    expect(existsSync(peerDoctorStamp(home))).toBe(false);
    await doctorJson([]);
    expect(readFileSync(peerDoctorStamp(home), "utf-8").trim()).toBe("2026-10-19T09:00:00.000Z");
  });

  /** The service's retained record for box-a, carrying a doctor run from `doctorAt`. */
  const serviceRecord = async (doctorAt: string) => {
    const b = new VolleyBroker();
    await b.connect({ url: tb.url, agentId: "box-a" });
    await b.publish(
      machineTopic("box-a"),
      JSON.stringify(
        buildEnvelope({
          agentId: "box-a",
          parentId: null,
          channel: "_system/machines",
          type: "machine",
          payload: { name: "box-a", tunnel: "up", checks: [], doctor_at: doctorAt },
        }),
      ),
      { qos: 1, retain: true },
    );
    await b.disconnect();
  };

  it("--fix: says readiness was republished once the service's record carries a run after it", async () => {
    writeCfg({ repo: box.repoPath });
    // The record the service sent before the fix; it re-runs (and republishes) while we poll.
    await serviceRecord("2026-10-19T08:50:00.000Z");
    let polls = 0;
    const f = fakeExec(() => undefined);
    const r = await run(
      ["doctor", "--fix", "--yes"],
      deps(f.exec, {
        sleep: async (ms) => {
          if (ms === PEER_DEFAULTS.republish_poll_ms && ++polls === 2) {
            await serviceRecord("2026-10-19T09:00:30.000Z");
          }
        },
      }),
    );
    expect(r.stdout).toContain("readiness republished");
    expect(polls).toBe(2);
  });

  it("--fix: a service that never picks the run up is named, with how to restart it", async () => {
    writeCfg({ repo: box.repoPath });
    await serviceRecord("2026-10-19T08:50:00.000Z");
    const f = fakeExec(() => undefined);
    const r = await run(["doctor", "--fix", "--yes"], deps(f.exec));
    expect(r.stdout).not.toContain("readiness republished");
    // It says it is waiting before it polls, and how long it waited, not a worst-case sum.
    expect(r.stdout).toMatch(
      /Waiting for the peer service to run the doctor again \(up to about 2 minutes\)[^\n]*\n[\s\S]*within about 2 minutes/,
    );
    expect(r.stdout).toContain(`systemctl --user restart ${SYSTEMD_UNIT}`);
    const mac = await run(["doctor", "--fix", "--yes"], deps(f.exec, { platform: "darwin" }));
    expect(mac.stdout).toContain(`launchctl kickstart -k gui/501/${LAUNCHD_LABEL}`);
  });

  it("--json --fix (the supervisor's Repair) prints only the report: no republish line", async () => {
    writeCfg({ repo: box.repoPath });
    await serviceRecord("2026-10-19T09:00:00.000Z");
    const r = await doctorJson(["--fix", "--yes"]);
    expect(r.report).toMatchObject({ checks: expect.any(Array) });
    expect(r.stdout).not.toContain("republished");
  });

  it("--fix: a broker that refuses the republish check says it could not check, not that it waited", async () => {
    writeCfg({ repo: box.repoPath });
    const f = fakeExec(() => undefined);
    const base = deps(f.exec);
    // The first connect (the requirements) works; the second (the republish poll) is refused.
    let connects = 0;
    const r = await run(
      ["doctor", "--fix", "--yes"],
      deps(f.exec, {
        connect: async (...a) => {
          if (++connects === 2) throw new Error("connect ECONNREFUSED 127.0.0.1:21883");
          return base.connect(...a);
        },
      }),
    );
    expect(connects).toBe(2);
    expect(r.stdout).toContain("could not check");
    expect(r.stdout).not.toContain("did not run the doctor again");
    expect(r.stdout).toContain(`systemctl --user restart ${SYSTEMD_UNIT}`);
  });

  it("--fix with the tunnel down says the service is not running, at once", async () => {
    writeCfg({ repo: box.repoPath });
    const f = fakeExec(() => undefined);
    const r = await run(
      ["doctor", "--fix", "--yes"],
      deps(f.exec, {
        connect: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:21883");
        },
      }),
    );
    expect(r.stdout).toContain("the peer service is not connected");
    expect(r.stdout).toContain(`systemctl --user restart ${SYSTEMD_UNIT}`);
  });

  it("--volley-dir checks that checkout instead of the running one", async () => {
    const dir = join(box.root, "other-volley");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "volley", version: "0.3.9" }));
    const r = await doctorJson(["--repo", box.repoPath, "--volley-dir", dir]);
    expect(r.report.versions.volley).toBe("0.3.9");
    expect(check(r.report, "volley.installed")?.ok).toBe(false);
    expect(check(r.report, "volley.installed")?.detail).toContain(dir);
  });
});

describe("peer.json's repositories (#435)", () => {
  const SLUG = "example-org/example-repo";
  const writeCfg = (over: Record<string, unknown> = {}) => {
    mkdirSync(join(home, ".volley"), { recursive: true });
    writeFileSync(
      peerFile(home),
      JSON.stringify({
        name: "box-a",
        host: "dev@host",
        target: "dev@box-a",
        namespace: "default",
        broker: { host: "127.0.0.1", port: 1883 },
        remote_port: 21883,
        username: "box-a",
        password: "peer-secret",
        joined_at: "2026-10-19T09:00:00.000Z",
        ...over,
      }),
      { mode: 0o600 },
    );
  };
  const peerJson = () => JSON.parse(readFileSync(peerFile(home), "utf-8")) as PeerConfig;
  const doctorJson = async (argv: string[]) => {
    const f = fakeExec(() => undefined);
    const r = await run(["doctor", "--json", ...argv], deps(f.exec));
    return { ...r, f, report: r.exitCode === 2 ? null : JSON.parse(r.stdout) };
  };
  type Row = { id: string; ok: boolean; repo?: string; detail: string };
  const forRepo = (r: { checks: Row[] }, id: string, repo: string) =>
    r.checks.find((c) => c.id === id && c.repo === repo);
  const managedPath = (slug: string) => join(home, ".volley", "repos", slug);

  it("--repo-add <owner/name> adds a managed clone; =<path> adopts one; --repo-remove drops it", async () => {
    writeCfg({ repos: { [SLUG]: box.repoPath } });
    const added = await doctorJson(["--repo-add", "c/c"]);
    expect(added.exitCode).toBe(1);
    expect(peerJson().repos).toEqual({ [SLUG]: box.repoPath, "c/c": managedPath("c/c") });
    expect(forRepo(added.report, "repo.clone", "c/c")).toMatchObject({ ok: false });
    expect(forRepo(added.report, "repo.clone", SLUG)).toMatchObject({ ok: true });

    const other = join(box.root, "work", "d");
    await doctorJson(["--repo-add", `d/d=${other}`, "--repo-remove", "C/C"]);
    expect(peerJson().repos).toEqual({ [SLUG]: box.repoPath, "d/d": other });
    // peer.json keeps its mode: it holds the peer's password.
    expect(statSync(peerFile(home)).mode & 0o777).toBe(0o600);
  });

  it("--repo-add <owner/name>=~/<path> expands ~ (the shell does not after =)", async () => {
    writeCfg({ repos: { [SLUG]: box.repoPath } });
    await doctorJson(["--repo-add", "d/d=~/code/d"]);
    expect(peerJson().repos).toEqual({ [SLUG]: box.repoPath, "d/d": join(home, "code", "d") });
  });

  it("a flag-less run (what volley deploy and the service send) reads the map", async () => {
    writeCfg({ repos: { [SLUG]: box.repoPath } });
    const r = await doctorJson([]);
    expect(r.report.repos.map((x: { slug: string }) => x.slug)).toEqual([SLUG]);
    expect(forRepo(r.report, "repo.origin", SLUG)).toMatchObject({ ok: true });
    // Exactly one repository: the legacy `repo` too.
    expect(r.report.repo.path).toBe(box.repoPath);
  });

  it("a legacy `repo` migrates into `repos` on the first doctor run; a non-GitHub origin stays", async () => {
    writeCfg({ repo: box.repoPath });
    await doctorJson([]);
    const cfg = peerJson();
    expect(cfg.repos).toEqual({ [SLUG]: box.repoPath });
    expect(cfg.repo).toBeUndefined();

    box.state.origin = "ssh://git@git.example.com/team/repo.git";
    writeCfg({ repo: box.repoPath });
    const r = await doctorJson([]);
    expect(peerJson().repo).toBe(box.repoPath);
    expect(peerJson().repos).toBeUndefined();
    expect(r.report.repo.path).toBe(box.repoPath);
  });

  it("refuses a --repo-add or --repo-remove that is not owner/name[=<path>]", async () => {
    writeCfg({ repos: { [SLUG]: box.repoPath } });
    for (const argv of [
      ["--repo-add", "../x"],
      ["--repo-add", "a"],
      ["--repo-add", "a/b/c"],
      ["--repo-add", "a/a="],
      ["--repo-add", "https://github.com/a/a"],
      ["--repo-remove", "a/a=/srv/a"],
    ]) {
      const r = await doctorJson(argv);
      expect(r.exitCode, argv.join(" ")).toBe(2);
      expect(r.stderr).toContain(argv[0] as string);
    }
    expect(peerJson().repos).toEqual({ [SLUG]: box.repoPath });
  });

  it("--fix --clone clones an added repository without --origin", async () => {
    writeCfg({ repos: { [SLUG]: box.repoPath } });
    const r = await run(
      ["doctor", "--json", "--fix", "--yes", "--clone", "--repo-add", "c/c"],
      deps(fakeExec(() => undefined).exec),
    );
    expect(r.stderr).not.toContain("--origin");
    expect(box.clones.has(managedPath("c/c"))).toBe(true);
    expect(box.clones.get(managedPath("c/c"))?.origin).toBe("https://github.com/c/c.git");
  });

  it("join --repo takes <owner/name>[=<path>], repeatable, and writes peer.json's repos", async () => {
    const f = fakeExec(hostSsh({ stdout: `${JSON.stringify(JOINED)}\n` }));
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "dev@host", "--repo", `${SLUG}=${box.repoPath}`],
      deps(f.exec),
    );
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const cfg = peerJson();
    expect(cfg.repos).toEqual({ [SLUG]: box.repoPath });
    expect(cfg.repo).toBeUndefined();
    // One repository: the supervisor still learns its path (hosts.<name>.repo) for one release.
    const script = f.calls.find((c) => c.input?.includes("peer redeem"))?.input as string;
    expect(redeemRequest(script).request.repo).toBe(box.repoPath);
  });

  it("join --repo with a bare path still works (the legacy single clone)", async () => {
    const f = fakeExec(hostSsh({ stdout: `${JSON.stringify(JOINED)}\n` }));
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "dev@host", "--repo", box.repoPath],
      deps(f.exec),
    );
    expect(r.exitCode).toBe(0);
    expect(peerJson().repo).toBe(box.repoPath);
  });
});

describe("the real dependencies", () => {
  it("report the checkout's package.json version", () => {
    const file = fileURLToPath(new URL("../../package.json", import.meta.url));
    const { version } = JSON.parse(readFileSync(file, "utf-8")) as { version: string };
    expect(realDeps().version).toBe(version);
  });
});

describe("the current user's name", () => {
  it("uses os.userInfo(), and `id -un` when bun's userInfo has only $USER's fallback", () => {
    expect(
      currentUser(
        () => "dev",
        () => "other",
      ),
    ).toBe("dev");
    expect(
      currentUser(
        () => "unknown",
        () => "owner\n",
      ),
    ).toBe("owner");
    expect(
      currentUser(
        () => "",
        () => "owner",
      ),
    ).toBe("owner");
    // Neither knows: the name stays unknown rather than empty.
    expect(
      currentUser(
        () => "unknown",
        () => null,
      ),
    ).toBe("unknown");
  });
});
