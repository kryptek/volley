import { constants, type JsonWebKeyInput, createPublicKey, publicEncrypt } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
  defaultName,
  machineTopic,
  peerFile,
  runPeer,
  runService,
  tunnelArgv,
} from "../../src/commands/peer";
import { EXIT } from "../../src/exit-codes";
import { makeBufferIO } from "../../src/io";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";
import { type FakePeerMachine, fakePeerMachine } from "../helpers/fake-peer-machine";

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
    if (r === undefined) return machine.exec(argv, opts);
    return { code: 0, stdout: "", stderr: "", ...r };
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
  const m = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| (.+) peer redeem/.exec(script);
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
    expect(r.stdout).toContain("fix: install tmux");
    expect(r.stderr).toContain("the code is still valid");
    expect(r.stderr).toContain("volley peer doctor");
    expect(existsSync(peerFile(home))).toBe(false);
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
    expect(volley).toBe("volley");
    expect(request).toEqual({
      code: "abcd-efgh",
      name: "box-a",
      target: "dev@Box-A.lan",
      volley_dir: box.volleyDir,
      repo,
      port: 21883,
      os: "linux",
      cores: 8,
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
    expect(f.calls.filter((c) => c.argv[0] === "launchctl").map((c) => c.argv)).toEqual([
      ["launchctl", "bootout", `gui/501/${LAUNCHD_LABEL}`],
      ["launchctl", "bootout", `user/501/${LAUNCHD_LABEL}`],
      ["launchctl", "bootstrap", "gui/501", plist],
    ]);
    expect(r.stdout).toContain("(domain gui/501)");
    expect(r.stdout).toContain(`Claude Code trusts ${repo} on this machine.`);
    const ssh = f.calls.filter((c) => c.argv[0] === "ssh");
    expect(redeemRequest(ssh[1]?.input as string).volley).toBe("/opt/bin/volley");
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
    expect(r.stdout).toContain("volley peer join ABCD-EFGH --to dev@Box-A.lan");
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
      "volley peer join ABCD-EFGH --to dev@Box-A.lan --name box-a --replace",
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

  /** Run the service on a fake clock for `beats` heartbeats; every record it published. */
  async function heartbeats(beats: number, f = fakeExec(() => undefined)) {
    let t = Date.parse("2026-10-19T09:00:00.000Z");
    const stop = new AbortController();
    let n = 0;
    const d = deps(f.exec, {
      now: () => new Date(t),
      sleep: async (ms) => {
        if (ms !== PEER_DEFAULTS.heartbeat_ms) return;
        t += ms;
        if (++n >= beats) stop.abort();
      },
    });
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
    // The supervisor's verdict names the version it requires (only volleyd's is believed).
    const sup = new VolleyBroker();
    await sup.connect({ url: tb.url, agentId: "volleyd" });
    await sup.publish(
      "volley/_system/machines/box-a/readiness",
      JSON.stringify(
        buildEnvelope({
          agentId: "volleyd",
          parentId: null,
          channel: "_system/machines",
          type: "readiness",
          payload: { name: "box-a", requirements: { volley: "0.5.0" } },
        }),
      ),
      { qos: 1, retain: true },
    );
    await sup.disconnect();
    const { code, records } = await heartbeats(3);
    expect(code).toBe(0);
    const up = records
      .map((r) => parseEnvelope(r))
      .filter((e) => e?.payload && (e.payload as { tunnel?: string }).tunnel === "up");
    expect(up.length).toBeGreaterThanOrEqual(3);
    for (const raw of records) expectValidRecord(raw);
    const p = up[0]?.payload as Record<string, unknown>;
    expect(p).toMatchObject({
      name: "box-a",
      kind: "peer",
      memory: { total_mb: 16384, available_pct: 50 },
      disk: { free_gb: 500, free_pct: 50 },
      uptime_s: 86_400,
      versions: { peer: "0.4.0", volley: "0.4.0", bun: "1.3.2", git: "2.43.0" },
      auth: { gh: "ok", claude: "signed_in", trust: "ok", claude_plan: "max" },
      repo: { path: box.repoPath, exists: true, origin: "github.com/example-org/example-repo" },
      doctor_at: "2026-10-19T09:00:00.000Z",
    });
    const checks = p.checks as { id: string; ok: boolean; fix?: unknown }[];
    expect(checks.find((c) => c.id === "volley.version")).toMatchObject({ ok: false });
    // Fix text never travels in the record.
    expect(checks.some((c) => "fix" in c)).toBe(false);
    // Heartbeats between doctor runs repeat its result.
    const later = up[2]?.payload as Record<string, unknown>;
    expect(later.doctor_at).toBe("2026-10-19T09:00:00.000Z");
    expect(later.last_seen).toBe("2026-10-19T09:01:00.000Z");
  });

  it("re-runs the doctor after doctor_interval_s and not before", async () => {
    writeCfg({ repo: box.repoPath });
    const perInterval = PEER_DEFAULTS.doctor_interval_s / (PEER_DEFAULTS.heartbeat_ms / 1000);
    const doctorRuns = (f: { calls: Call[] }) =>
      f.calls.filter((c) => c.argv.join(" ") === "claude auth status").length;
    const before = await heartbeats(perInterval);
    expect(doctorRuns(before.f)).toBe(1);
    const after = await heartbeats(perInterval + 1);
    expect(doctorRuns(after.f)).toBe(2);
    const last = parseEnvelope(
      after.records.filter((r) => r.includes('"tunnel":"up"')).at(-1) ?? "",
    )?.payload as { doctor_at?: string };
    expect(last.doctor_at).toBe("2026-10-19T09:10:00.000Z");
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
