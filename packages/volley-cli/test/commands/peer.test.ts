import { constants, type JsonWebKeyInput, createPublicKey, publicEncrypt } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { VolleyError } from "volley-mcp/errors";
import {
  LAUNCHD_LABEL,
  type PeerConfig,
  type PeerDeps,
  type PeerExec,
  SYSTEMD_UNIT,
  currentUser,
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

/** Fake exec: records argv + stdin; `reply` answers by argv. */
function fakeExec(reply: (c: Call) => Partial<{ code: number; stdout: string; stderr: string }>) {
  const calls: Call[] = [];
  const exec: PeerExec = async (argv, opts = {}) => {
    const c: Call = { argv, ...(opts.input !== undefined ? { input: opts.input } : {}) };
    calls.push(c);
    if (argv[0] === "ssh" && argv[1] === "-N") {
      // The tunnel: runs until aborted.
      await new Promise<void>((r) => opts.signal?.addEventListener("abort", () => r()));
      return { code: 143, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "", ...reply(c) };
  };
  return { exec, calls };
}

let tb: TestBroker;
let home: string;
beforeEach(async () => {
  tb = await startTestBroker();
  home = mkdtempSync(join(tmpdir(), "volley-peer-home-"));
});
afterEach(async () => {
  await tb.close();
  rmSync(home, { recursive: true, force: true });
});

function deps(exec: PeerExec, over: Partial<PeerDeps> = {}): PeerDeps {
  return {
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
    volleyDir: "/opt/volley",
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
  (redeem: Partial<{ code: number; stdout: string; stderr: string }>) => (c: Call) => {
    if (c.argv[0] !== "ssh") return {};
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

describe("volley peer join (on the machine to pair)", () => {
  it("runs every remote step as a script under bash -s, writes peer.json, installs the service, prints trust, registers", async () => {
    const repo = join(home, "src", "repo");
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
      volley_dir: "/opt/volley",
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
    expect(env?.payload).toEqual({
      name: "box-a",
      os: "linux",
      arch: "x64",
      cores: 8,
      tunnel: "up",
      load: [0.5, 0.25, 0.13],
      agents: 0,
      remote_port: 21883,
      last_seen: "2026-10-19T09:00:00.000Z",
    });
    expect(r.stdout).toContain("Registered: volley/_system/machines/box-a");
  });

  it("on macOS installs a launchd agent and bootstraps it; a trusted repo says so", async () => {
    const repo = "/srv/src/repo";
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    );
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
      ["join", "ABCD-EFGH", "--to", "host"],
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
    const r = await run(["join", "ABCD-EFGH", "--to", "host"], deps(f.exec));
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
    const repo = join(home, "repo");
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
    const r = await run(["join", "ABCD-EFGH", "--to", "dev@host"], deps(f.exec));
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
      JSON.stringify({ projects: { "/srv/src": { hasTrustDialogAccepted: true } } }),
    );
    const f = fakeExec(hostSsh({ stdout: JSON.stringify(JOINED) }));
    const r = await run(
      ["join", "ABCD-EFGH", "--to", "host", "--repo", "/srv/src/repo"],
      deps(f.exec),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Claude Code trusts /srv/src/repo on this machine.");
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
      c.argv[0] === "ssh" ? { code: 255, stderr: "ssh: connect to host: Connection refused" } : {},
    );
    const r = await run(["join", "ABCD-EFGH", "--to", "host"], deps(f.exec));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("cannot reach host over ssh");
    expect(f.calls).toHaveLength(1);
    expect(existsSync(peerFile(home))).toBe(false);
  });

  it("volley missing on the host's ssh PATH: says to pass --remote-volley, and the code still works", async () => {
    const f = fakeExec(hostSsh({ code: 127, stderr: "bash: line 6: volley: command not found\n" }));
    const r = await run(["join", "ABCD-EFGH", "--to", "dev@host"], deps(f.exec));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("volley: command not found");
    expect(r.stderr).toContain(
      "`volley` is not on dev@host's PATH for a non-interactive ssh command",
    );
    // Quoted, so the host's shell expands ~ (its home, not this machine's).
    expect(r.stderr).toContain("--remote-volley '~/.volley/bin/volley'");
    expect(r.stderr).toContain("the code is still valid");
    expect(existsSync(peerFile(home))).toBe(false);
  });

  it("bun missing on the host's ssh PATH: names bun, never says volley is missing", async () => {
    for (const stderr of [
      "env: bun: No such file or directory\n",
      "/usr/bin/env: 'bun': No such file or directory\n",
    ]) {
      const f = fakeExec(hostSsh({ code: 127, stderr }));
      const r = await run(
        ["join", "ABCD-EFGH", "--to", "dev@host", "--remote-volley", "~/.volley/bin/volley"],
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
      ["join", "ABCD-EFGH", "--to", "dev@host", "--remote-volley", "/opt/volley/bin/volley"],
      deps(g.exec),
    );
    expect(r.stderr).toContain("`/opt/volley/bin/volley` does not exist on dev@host.");
    expect(r.stderr).toContain("--remote-volley '~/.volley/bin/volley'");
    // The suggested path itself missing: setup has not run there.
    const h = fakeExec(
      hostSsh({
        code: 127,
        stderr: "bash: line 6: /home/dev/.volley/bin/volley: No such file or directory\n",
      }),
    );
    const again = await run(
      ["join", "ABCD-EFGH", "--to", "dev@host", "--remote-volley", "~/.volley/bin/volley"],
      deps(h.exec),
    );
    expect(again.stderr).toContain("`/home/dev/.volley/bin/volley` does not exist on dev@host.");
    expect(again.stderr).toContain(
      "Run `volley setup` on dev@host (it installs ~/.volley/bin/volley)",
    );
    expect(again.stderr).not.toContain("--remote-volley '~/.volley/bin/volley'");
  });

  it("a refused code writes nothing and installs nothing", async () => {
    const f = fakeExec(
      hostSsh({ code: 1, stderr: "volley peer redeem: invalid or expired pairing code\n" }),
    );
    const r = await run(["join", "ABCD-EFGH", "--to", "host"], deps(f.exec));
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
  const writeCfg = () => {
    mkdirSync(join(home, ".volley"), { recursive: true });
    writeFileSync(peerFile(home), JSON.stringify(cfg), { mode: 0o600 });
  };

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
