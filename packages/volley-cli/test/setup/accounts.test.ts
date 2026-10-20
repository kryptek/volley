import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realAuthDeps } from "../../src/auth/context";
import { type DynsecCommand, cmd } from "../../src/auth/dynsec";
import { ROLE_ACLS, VOLLEY_ROLES, roleName } from "../../src/auth/roles";
import {
  PHONE_LABEL,
  keychainAddCommand,
  newDeskPassword,
  planAccounts,
  planPhone,
} from "../../src/setup/accounts";
import { planSecurity } from "../../src/setup/broker";
import { encodeQr, renderQr } from "../../src/setup/qr";
import type { StepPlan } from "../../src/setup/step";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { type FakeMachine, fakeMachine } from "../helpers/setup-machine";

describe("setup: accounts", () => {
  let dir: string;
  let fake: FakeDynsec;
  let m: FakeMachine;
  const authFile = (f: string) => join(m.layout.authDir, f);
  const volleydFile = (f: string) => join(m.ctx.volleydHome, f);
  const creds = (p: string) =>
    JSON.parse(readFileSync(p, "utf-8")) as { username: string; password: string };

  const applyAll = async (plan: StepPlan) => {
    const out: string[] = [];
    for (const c of plan.changes) out.push(...(await c.apply()));
    return out;
  };
  /** Run commands as the dynsec admin setup created. */
  const admin = async (commands: DynsecCommand[]) => {
    const link = await realAuthDeps.connectAdmin(fake.url, creds(authFile("admin.json")));
    try {
      return await link.session.run(commands);
    } finally {
      await link.close();
    }
  };
  const setUp = async (opts: { platform?: NodeJS.Platform; repair?: boolean } = {}) => {
    m = fakeMachine(fake, dir, opts);
    await applyAll(await planSecurity(m.ctx));
    m.freshIO();
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "volley-setup-accounts-"));
    fake = await startFakeDynsec();
  });
  afterEach(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is blocked until the broker takes the admin login", async () => {
    m = fakeMachine(fake, dir);
    const p = await planAccounts(m.ctx);
    expect(p.blocked).toContain("admin.json does not exist");
  });

  it("plans the roles, the identities, the keychain and the admin token, changing nothing", async () => {
    await setUp();
    const before = [...fake.clients().keys()].sort();
    const p = await planAccounts(m.ctx);
    expect(p.blocked).toBeUndefined();
    expect(p.changes.map((c) => c.summary)).toEqual([
      "Create Volley's 8 shared roles and the identities volleyd, desk, coordinator (passwords shown once)",
      "Store the coordinator's broker login in the macOS keychain (service volley-broker)",
      "Issue a one-time admin token (10 minutes, single use) to sign in to the Desk as admin",
    ]);
    expect([...fake.clients().keys()].sort()).toEqual(before);
    expect(existsSync(authFile("coordinator.json"))).toBe(false);
    expect(m.keychain.size).toBe(0);
  });

  it("applies: roles, identities, credential files (0600), keychain, one-time token in the terminal", async () => {
    await setUp();
    await applyAll(await planAccounts(m.ctx));
    const roles = [...fake.roles().keys()].filter((r) => r.startsWith("volley-")).sort();
    expect(roles).toEqual(VOLLEY_ROLES.map(roleName).sort());
    for (const u of ["volleyd", "desk", "coordinator"]) expect(fake.clients().has(u)).toBe(true);

    const coordinator = creds(authFile("coordinator.json"));
    expect(statSync(authFile("coordinator.json")).mode & 0o777).toBe(0o600);
    expect(fake.clients().get("coordinator")?.password).toBe(coordinator.password);
    expect(creds(volleydFile("broker.json")).username).toBe("volleyd");
    expect(creds(volleydFile("dynsec-admin.json")).username).toBe("dynsec-admin");
    expect(m.keychain.get("coordinator")).toBe(coordinator.password);
    // The keychain write feeds `security -i` on stdin: the password is never on any argv (`ps`).
    const at = m.execCalls.findIndex((a) => a.join(" ") === "security -i");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(m.execInputs[at]).toContain(`-w "${coordinator.password}"`);
    expect(m.execCalls.some((a) => a.some((w) => w.includes(coordinator.password)))).toBe(false);

    const out = m.io.readStdout();
    expect(out).toContain("New passwords (shown ONCE");
    expect(out).toMatch(/vly_admin_[0-9a-f]{8}_[0-9a-f]{32}/);
    const tokens = JSON.parse(readFileSync(authFile("tokens.json"), "utf-8")).tokens;
    expect(tokens).toHaveLength(1);
    expect(tokens[0].kind).toBe("admin");
  });

  it("hands the one-time admin token to deliverToken when set, never to stdout", async () => {
    await setUp();
    const delivered: { token: string; token_id: string; expires_at: string }[] = [];
    m.ctx.deliverToken = (t) => {
      delivered.push(t);
    };
    const lines = await applyAll(await planAccounts(m.ctx));
    expect(delivered).toHaveLength(1);
    const [t] = delivered;
    expect(t?.token).toMatch(/^vly_admin_[0-9a-f]{8}_[0-9a-f]{32}$/);
    expect(t?.token).toContain(`_${t?.token_id}_`);
    const stored = JSON.parse(readFileSync(authFile("tokens.json"), "utf-8")).tokens;
    expect(t?.expires_at).toBe(stored[0].expires_at);
    expect(m.io.readStdout()).not.toMatch(/vly_admin_/);
    expect(lines.join("\n")).not.toMatch(/vly_admin_/);
    expect(lines).toContain(
      `Issued a one-time admin token (${t?.token_id}, until ${t?.expires_at}).`,
    );
  });

  it("a second plan finds everything done (the admin token is pending)", async () => {
    await setUp();
    await applyAll(await planAccounts(m.ctx));
    const again = await planAccounts(m.ctx);
    expect(again.changes).toEqual([]);
    expect(again.found.join("\n")).toContain("A one-time admin token is pending until");
  });

  it("re-creates a missing identity only, keeping every other login", async () => {
    await setUp();
    await applyAll(await planAccounts(m.ctx));
    const before = fake.clients();
    await admin([cmd.deleteClient("desk")]);
    const p = await planAccounts(m.ctx);
    expect(p.changes.map((c) => c.summary)).toEqual([
      "Create the missing identity desk (password shown once)",
    ]);
    m.freshIO();
    await applyAll(p);
    const after = fake.clients();
    expect(after.has("desk")).toBe(true);
    for (const u of ["volleyd", "coordinator", "dynsec-admin"]) {
      expect(after.get(u)?.password).toBe(before.get(u)?.password);
    }
    expect(m.io.readStdout()).toMatch(/desk\s+pw-/);
    expect(m.io.readStdout()).not.toMatch(/coordinator\s+pw-/);
    expect((await planAccounts(m.ctx)).changes).toEqual([]);
  });

  it("under the Desk (deliverToken set), never promises a desk password it will not show", async () => {
    await setUp();
    m.ctx.deliverToken = () => {};
    const [create] = (await planAccounts(m.ctx)).changes;
    expect(create?.summary).toBe(
      "Create Volley's 8 shared roles and the identities volleyd, desk, coordinator (desk's password is not shown here: Setup & Security › New desk password issues one, shown once)",
    );
    await applyAll(await planAccounts(m.ctx));
    await admin([cmd.deleteClient("coordinator")]);
    // coordinator's password goes to its file: nothing to say about it.
    expect((await planAccounts(m.ctx)).changes[0]?.summary).toBe(
      "Create the missing identity coordinator",
    );
  });

  it("newDeskPassword gives the desk login a new password and returns it, once", async () => {
    await setUp();
    await applyAll(await planAccounts(m.ctx));
    const before = fake.clients();
    m.freshIO();
    const password = await newDeskPassword(m.ctx);
    expect(fake.clients().get("desk")?.password).toBe(password);
    expect(password).not.toBe(before.get("desk")?.password);
    for (const u of ["volleyd", "coordinator", "dynsec-admin"]) {
      expect(fake.clients().get(u)?.password).toBe(before.get(u)?.password);
    }
    expect(m.io.readStdout()).not.toContain(password);
  });

  it("newDeskPassword refuses while the desk login does not exist", async () => {
    await setUp();
    await expect(newDeskPassword(m.ctx)).rejects.toThrow(/no desk login .*accounts step/);
  });

  it("rotates an identity whose credential file is gone, writing the file", async () => {
    await setUp();
    await applyAll(await planAccounts(m.ctx));
    rmSync(authFile("coordinator.json"));
    rmSync(volleydFile("broker.json"));
    const p = await planAccounts(m.ctx);
    expect(p.changes.map((c) => c.summary)).toEqual([
      `New password for coordinator, written to ${authFile("coordinator.json")} (disconnects its sessions)`,
      `New password for volleyd, written to ${volleydFile("broker.json")} (disconnects its sessions)`,
      "Store the coordinator's broker login in the macOS keychain (service volley-broker)",
    ]);
    await applyAll(p);
    expect(fake.clients().get("coordinator")?.password).toBe(
      creds(authFile("coordinator.json")).password,
    );
    expect(fake.clients().get("volleyd")?.password).toBe(
      creds(volleydFile("broker.json")).password,
    );
    expect(m.keychain.get("coordinator")).toBe(creds(authFile("coordinator.json")).password);
  });

  it("offers `migrate --roles` for a drifted role, showing the change first", async () => {
    await setUp();
    await applyAll(await planAccounts(m.ctx));
    const usage = ROLE_ACLS.agent.find((a) => a.topic.endsWith("/usage"));
    if (usage === undefined) throw new Error("no usage grant");
    await admin([cmd.removeRoleACL(roleName("agent"), usage)]);
    const p = await planAccounts(m.ctx);
    expect(p.changes.map((c) => c.summary)).toEqual([
      "Update the drifted role volley-agent (volley auth migrate --roles; disconnects every client holding it)",
    ]);
    expect(p.changes[0]?.detail).toContain(`+ publishClientSend ${usage.topic}`);
    await applyAll(p);
    expect(
      fake
        .roles()
        .get(roleName("agent"))
        ?.some((a) => a.topic === usage.topic),
    ).toBe(true);
    expect((await planAccounts(m.ctx)).changes).toEqual([]);
  });

  it("fails the keychain change when the stored password does not read back", async () => {
    await setUp();
    const exec = m.deps.exec;
    m.deps.exec = async (argv, o) =>
      argv[1] === "-i"
        ? { code: 0, stdout: "", stderr: "User interaction is not allowed." }
        : exec(argv, o);
    await expect(applyAll(await planAccounts(m.ctx))).rejects.toThrow(
      /security add-generic-password failed.*User interaction is not allowed/,
    );
  });

  it("quotes the keychain command for `security -i`", () => {
    expect(keychainAddCommand('a"b\\c')).toBe(
      'add-generic-password -U -s volley-broker -a coordinator -l "Volley broker login (coordinator)" -w "a\\"b\\\\c"',
    );
  });

  it("keeps the credentials in the auth dir (0600) where there is no keychain", async () => {
    await setUp({ platform: "linux" });
    const p = await planAccounts(m.ctx);
    expect(p.changes.map((c) => c.summary).some((s) => s.includes("keychain"))).toBe(false);
    await applyAll(p);
    expect(m.execCalls.some((a) => a[0] === "security")).toBe(false);
    expect((await planAccounts(m.ctx)).found.join("\n")).toContain(
      `coordinator's login: ${authFile("coordinator.json")} (mode 0600; no OS keychain here)`,
    );
  });

  it("issues no admin token under --repair, nor once an admin account exists", async () => {
    await setUp({ repair: true });
    let p = await planAccounts(m.ctx);
    expect(p.changes.some((c) => c.summary.includes("admin token"))).toBe(false);
    m.ctx.repair = false;
    writeFileSync(
      authFile("accounts.json"),
      JSON.stringify({
        accounts: [{ name: "admin-0000beef", role: "admin", kind: "device", created: "x" }],
      }),
    );
    p = await planAccounts(m.ctx);
    expect(p.changes.some((c) => c.summary.includes("admin token"))).toBe(false);
    expect(p.found.join("\n")).toContain("admin account admin-0000beef");
  });

  it("issues a new admin token once the pending one has expired", async () => {
    await setUp();
    await applyAll(await planAccounts(m.ctx));
    const file = authFile("tokens.json");
    const t = JSON.parse(readFileSync(file, "utf-8"));
    t.tokens[0].expires_at = "2026-10-18T11:00:00.000Z";
    writeFileSync(file, JSON.stringify(t));
    const p = await planAccounts(m.ctx);
    expect(p.changes.map((c) => c.summary)).toEqual([
      "Issue a one-time admin token (10 minutes, single use) to sign in to the Desk as admin",
    ]);
  });
});

describe("setup: phone", () => {
  let dir: string;
  let fake: FakeDynsec;
  let m: FakeMachine;
  const applyAll = async (plan: StepPlan) => {
    for (const c of plan.changes) await c.apply();
  };
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "volley-setup-phone-"));
    fake = await startFakeDynsec();
    m = fakeMachine(fake, dir, { lan: true });
    await applyAll(await planSecurity(m.ctx));
    await applyAll(await planAccounts(m.ctx));
    m.freshIO();
  });
  afterEach(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("issues a steer sign-in link for the phone and prints it as a QR code and a URL", async () => {
    const p = await planPhone(m.ctx);
    expect(p.changes.map((c) => c.summary)).toEqual([
      `Issue a one-time steer sign-in link for "${PHONE_LABEL}" (10 minutes, single use), shown as a QR code`,
    ]);
    await applyAll(p);
    const out = m.io.readStdout();
    const link = /http:\/\/desk\.example:5199\/#signin=(vly_signin_[0-9a-f]{8}_[0-9a-f]{32})/.exec(
      out,
    );
    expect(link).not.toBeNull();
    // The QR code encodes exactly the printed link.
    expect(out).toContain(renderQr(encodeQr(link?.[0] as string)));
    expect(out).toContain("single use");
    const tokens = JSON.parse(readFileSync(join(m.layout.authDir, "tokens.json"), "utf-8")).tokens;
    const t = tokens.find((x: { kind: string }) => x.kind === "signin");
    expect(t).toMatchObject({ role: "steer", label: PHONE_LABEL });
    // The token itself is never written anywhere but the terminal.
    expect(readFileSync(join(m.layout.authDir, "tokens.json"), "utf-8")).not.toContain(link?.[1]);
  });

  it("is done while the link is pending, and once the phone has signed in", async () => {
    await applyAll(await planPhone(m.ctx));
    let p = await planPhone(m.ctx);
    expect(p.changes).toEqual([]);
    expect(p.found.join("\n")).toContain("A phone sign-in link is pending until");
    writeFileSync(join(m.layout.authDir, "tokens.json"), JSON.stringify({ tokens: [] }));
    writeFileSync(
      join(m.layout.authDir, "accounts.json"),
      JSON.stringify({
        accounts: [
          {
            name: "steer-0000beef",
            role: "steer",
            kind: "device",
            created: "x",
            label: PHONE_LABEL,
          },
        ],
      }),
    );
    p = await planPhone(m.ctx);
    expect(p.changes).toEqual([]);
    expect(p.found.join("\n")).toContain("steer-0000beef");
  });

  it("with LAN access off, is skipped, saying how to fix it, and issues no link", async () => {
    // The broker restarted on the loopback-only config: a phone cannot reach port 9001.
    m.ctx.lan = false;
    await applyAll(await planSecurity(m.ctx));
    expect(m.lanWs).toBe(false);
    const tokens = readFileSync(join(m.layout.authDir, "tokens.json"), "utf-8");
    const p = await planPhone(m.ctx);
    expect(p.changes).toEqual([]);
    expect(p.skipped).toContain("ws://desk.example:9001");
    expect(p.skipped).toContain("volley setup --lan");
    expect(p.skipped).toContain('volley auth signin-link --role steer --label "Desk on phone"');
    expect(readFileSync(join(m.layout.authDir, "tokens.json"), "utf-8")).toBe(tokens);
  });

  it("with LAN access on, the phone reaches the listener and gets its link", async () => {
    expect(m.lanWs).toBe(true);
    const p = await planPhone(m.ctx);
    expect(p.skipped).toBeUndefined();
    expect(p.changes).toHaveLength(1);
  });

  it("issues nothing under --repair", async () => {
    m.ctx.repair = true;
    const p = await planPhone(m.ctx);
    expect(p.changes).toEqual([]);
    expect(p.found.join("\n")).toContain("--repair");
  });
});
