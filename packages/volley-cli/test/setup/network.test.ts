import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readNetworkRecord, setupInstallFile } from "../../src/setup/journal";
import { recordNetwork } from "../../src/setup/journal";
import {
  NETWORK_KINDS,
  NETWORK_QUESTION,
  TAILSCALE_APP_CLI,
  TAILSCALE_LINUX_INSTALL,
  parseTailscaleStatus,
  planNetwork,
  privateDeskLine,
} from "../../src/setup/network";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { type FakeMachine, fakeMachine } from "../helpers/setup-machine";
import { tempDir } from "../helpers/tmp";

const RUNNING = {
  Version: "1.76.1",
  BackendState: "Running",
  Self: {
    DNSName: "studio.example.ts.net.",
    TailscaleIPs: ["fd7a:115c:a1e0::2", "100.64.0.2"],
  },
};

describe("parseTailscaleStatus", () => {
  it("reads Running, the MagicDNS name without its trailing dot and the first IPv4 address", () => {
    expect(parseTailscaleStatus(JSON.stringify(RUNNING))).toEqual({
      state: "Running",
      running: true,
      name: "studio.example.ts.net",
      address: "100.64.0.2",
    });
  });

  it("tolerates NeedsLogin (no Self yet) and refuses what is not status JSON", () => {
    expect(
      parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin", Self: null })),
    ).toEqual({ state: "NeedsLogin", running: false, name: null, address: null });
    expect(parseTailscaleStatus("failed to connect to local tailscaled")).toBeNull();
    expect(parseTailscaleStatus("[]")).toBeNull();
  });

  it("knows exactly the three kinds", () => {
    expect([...NETWORK_KINDS]).toEqual(["tailscale", "manual", "none"]);
  });
});

describe("the Network step", () => {
  let dir: string;
  let fake: FakeDynsec;
  let m: FakeMachine;
  beforeEach(async () => {
    dir = tempDir("volley-network-");
    fake = await startFakeDynsec();
    m = fakeMachine(fake, dir);
  });
  afterEach(async () => {
    await fake.close();
  });

  const tsCalls = () =>
    m.execCalls.filter((a) => a.includes("tailscale") || a.includes(TAILSCALE_APP_CLI));
  const applyAll = async (plan: Awaited<ReturnType<typeof planNetwork>>) => {
    const lines: string[] = [];
    for (const c of plan.changes) lines.push(...(await c.apply()));
    return lines;
  };

  it("Tailscale missing (macOS): install with brew, then sign in; applying records the name and address", async () => {
    m.ctx.network = "tailscale";
    const plan = await planNetwork(m.ctx);
    expect(plan.title).toBe("Network");
    expect(plan.changes.map((c) => c.summary)).toEqual([
      "Install Tailscale (brew install --cask tailscale)",
      "Sign in to Tailscale (tailscale up: prints a sign-in link to open in your browser)",
    ]);
    expect(plan.found).toContain("Tailscale: not installed");
    // Planning installs and signs in nothing.
    expect(m.tailscale.installed).toBe(false);
    expect(m.execCalls.some((a) => a.join(" ") === "brew install --cask tailscale")).toBe(false);
    await applyAll(plan);
    expect(m.execCalls).toContainEqual(["brew", "install", "--cask", "tailscale"]);
    expect(m.execCalls).toContainEqual(["tailscale", "up"]);
    expect(await plan.verify?.()).toEqual([]);
    expect(plan.verified).toEqual(["Tailscale: studio.example.ts.net (100.64.0.2)"]);
    expect(readNetworkRecord(m.ctx.volleydHome)).toEqual({
      kind: "tailscale",
      name: "studio.example.ts.net",
      address: "100.64.0.2",
    });
    expect(m.ctx.networkRecord).toEqual(readNetworkRecord(m.ctx.volleydHome));
  });

  it("Tailscale missing (Linux): the install needs sudo, so it names the command; `sudo tailscale up` signs in", async () => {
    m = fakeMachine(fake, tempDir("volley-network-linux-"), { platform: "linux" });
    m.ctx.network = "tailscale";
    const plan = await planNetwork(m.ctx);
    expect(plan.changes.map((c) => c.summary)).toEqual([
      "Install Tailscale (needs sudo: Tailscale's package repository)",
      "Sign in to Tailscale (sudo tailscale up: prints a sign-in link to open in your browser)",
    ]);
    expect(plan.changes[0]?.detail).toContain(TAILSCALE_LINUX_INSTALL);
    await expect(plan.changes[0]?.apply()).rejects.toThrow(TAILSCALE_LINUX_INSTALL);
    m.tailscale.installed = true;
    await plan.changes[1]?.apply();
    expect(m.execCalls).toContainEqual(["sudo", "tailscale", "up"]);
  });

  it("installed and NeedsLogin: the sign-in change only, run on the terminal", async () => {
    m.tailscale.installed = true;
    m.tailscale.state = "NeedsLogin";
    m.ctx.network = "tailscale";
    let signIns = 0;
    m.ctx.metrics = { signIn: () => signIns++ };
    const plan = await planNetwork(m.ctx);
    expect(plan.found).toContain("Tailscale 1.76.1: not signed in (NeedsLogin)");
    expect(plan.changes.map((c) => c.summary)).toEqual([
      "Sign in to Tailscale (tailscale up: prints a sign-in link to open in your browser)",
    ]);
    await applyAll(plan);
    expect(signIns).toBe(1);
    expect(readNetworkRecord(m.ctx.volleydHome)?.address).toBe("100.64.0.2");
  });

  it("the Desk's sign-in (a timeout set) reports the link as `Sign in to Tailscale: <url>`", async () => {
    m.tailscale.installed = true;
    m.tailscale.state = "NeedsLogin";
    m.tailscale.upCode = 124; // killed at the timeout: nobody signed in yet
    m.ctx.network = "tailscale";
    m.ctx.networkSigninTimeoutMs = 20_000;
    const plan = await planNetwork(m.ctx);
    const lines = await applyAll(plan);
    expect(lines).toContain("Sign in to Tailscale: https://login.tailscale.com/a/0123abcd");
    // Not signed in yet: nothing to record, and nothing for verify to fail on.
    expect(readNetworkRecord(m.ctx.volleydHome)).toBeNull();
    expect(await plan.verify?.()).toEqual([]);
  });

  it("Running with no record: one change records it; Running with the record: nothing to do", async () => {
    m.tailscale.installed = true;
    m.tailscale.state = "Running";
    m.ctx.network = "tailscale";
    const plan = await planNetwork(m.ctx);
    expect(plan.found).toContain(
      "Tailscale 1.76.1: signed in as studio.example.ts.net (100.64.0.2)",
    );
    expect(plan.changes.map((c) => c.summary)).toEqual([
      "Record this machine's private address in setup.json (tailscale: studio.example.ts.net, 100.64.0.2)",
    ]);
    await applyAll(plan);
    const { network: _flag, ...noFlag } = m.ctx;
    const again = await planNetwork(noFlag);
    expect(again.changes).toEqual([]);
    expect(again.row).toBe("tailscale: studio.example.ts.net (100.64.0.2)");
    // No sign-in and no install ran.
    expect(tsCalls().some((a) => a.includes("up"))).toBe(false);
  });

  it("the macOS app's CLI when no `tailscale` is on PATH", async () => {
    m.tailscale.installed = true;
    m.tailscale.state = "Running";
    m.present.add(TAILSCALE_APP_CLI);
    const exec = m.ctx.deps.exec;
    m.ctx.deps.exec = async (argv, o) =>
      argv[0] === "tailscale" ? { code: 127, stdout: "", stderr: "not found" } : exec(argv, o);
    m.ctx.network = "tailscale";
    const plan = await planNetwork(m.ctx);
    expect(plan.found).toContain(
      "Tailscale 1.76.1: signed in as studio.example.ts.net (100.64.0.2)",
    );
    expect(m.execCalls).toContainEqual([TAILSCALE_APP_CLI, "status", "--json"]);
  });

  it("manual with an address of this machine: records it, installs nothing", async () => {
    m.ctx.network = "manual";
    m.ctx.networkAddress = "192.0.2.10";
    const plan = await planNetwork(m.ctx);
    expect(plan.blocked).toBeUndefined();
    expect(plan.changes.map((c) => c.summary)).toEqual([
      "Record this machine's private address in setup.json (manual: 192.0.2.10)",
    ]);
    await applyAll(plan);
    expect(readNetworkRecord(m.ctx.volleydHome)).toEqual({ kind: "manual", address: "192.0.2.10" });
    expect(tsCalls()).toEqual([]);
  });

  it("manual with a host name that resolves to an address of this machine", async () => {
    m.interfaces.wg0 = [{ address: "198.51.100.7", family: "IPv4", internal: false }];
    m.ctx.network = "manual";
    m.ctx.networkAddress = "vpn.example.net";
    const plan = await planNetwork(m.ctx);
    expect(plan.blocked).toBeUndefined();
    expect(plan.found).toContain("Your own VPN: vpn.example.net (198.51.100.7, on wg0)");
  });

  it("manual with an address this machine does not have: blocked with the interfaces, nothing recorded", async () => {
    m.ctx.network = "manual";
    m.ctx.networkAddress = "203.0.113.7";
    const plan = await planNetwork(m.ctx);
    expect(plan.blocked).toBe(
      "203.0.113.7 is not an address of this machine (interfaces: en0 192.0.2.10)",
    );
    expect(plan.changes).toEqual([]);
    expect(readNetworkRecord(m.ctx.volleydHome)).toBeNull();
  });

  it("manual without an address and nobody to ask: blocked, naming the flag", async () => {
    m.ctx.network = "manual";
    m.ctx.yes = true;
    const plan = await planNetwork(m.ctx);
    expect(plan.blocked).toContain("--network-address <host-or-ip>");
  });

  it("none: records kind none; an explicit --network none clears a tailscale record", async () => {
    recordNetwork(m.ctx, {
      kind: "tailscale",
      name: "studio.example.ts.net",
      address: "100.64.0.2",
    });
    m.ctx.network = "none";
    const plan = await planNetwork(m.ctx);
    expect(plan.changes.map((c) => c.summary)).toEqual([
      "Record that this machine is reached on its own network only (network: none)",
    ]);
    await applyAll(plan);
    expect(readNetworkRecord(m.ctx.volleydHome)).toEqual({ kind: "none" });
    expect(tsCalls()).toEqual([]);
  });

  it("--yes without --network: none, nothing installed, nothing asked", async () => {
    m.ctx.yes = true;
    const plan = await planNetwork(m.ctx);
    expect(m.ctx.network).toBe("none");
    expect(m.asked).toEqual([]);
    expect(tsCalls()).toEqual([]);
    await applyAll(plan);
    expect(readNetworkRecord(m.ctx.volleydHome)).toEqual({ kind: "none" });
  });

  it("asks once with no flag and no record; Enter takes Tailscale", async () => {
    m.tailscale.installed = true;
    m.tailscale.state = "Running";
    m.typed.push("");
    await planNetwork(m.ctx);
    expect(m.asked).toEqual([`${NETWORK_QUESTION} `]);
    expect(m.ctx.network).toBe("tailscale");
  });

  it("asks for the VPN's address when the answer is my own VPN", async () => {
    m.typed.push("my own VPN", "192.0.2.10");
    const plan = await planNetwork(m.ctx);
    expect(m.ctx.network).toBe("manual");
    expect(m.asked).toHaveLength(2);
    expect(plan.changes[0]?.summary).toContain("manual: 192.0.2.10");
  });

  it("a rerun with a record and no flag keeps it, asking nothing", async () => {
    recordNetwork(m.ctx, { kind: "manual", address: "192.0.2.10" });
    const plan = await planNetwork(m.ctx);
    expect(m.asked).toEqual([]);
    expect(m.ctx.network).toBe("manual");
    expect(plan.changes).toEqual([]);
    expect(plan.row).toBe("manual: 192.0.2.10");
    // Recorded beside the other keys, which stay.
    const raw = JSON.parse(readFileSync(setupInstallFile(m.ctx.volleydHome), "utf-8")) as object;
    expect(raw).toEqual({ network: { kind: "manual", address: "192.0.2.10" } });
  });

  it("--check plans without asking: none when nothing decides", async () => {
    m.ctx.check = true;
    const plan = await planNetwork(m.ctx);
    expect(m.asked).toEqual([]);
    expect(plan.changes.map((c) => c.summary)).toEqual([
      "Record that this machine is reached on its own network only (network: none)",
    ]);
  });

  it("the end's line names the private address beside the LAN one", () => {
    expect(privateDeskLine("192.0.2.10", 5199, { kind: "tailscale", address: "100.64.0.2" })).toBe(
      "Desk: http://192.0.2.10:5199 · on your private network: http://100.64.0.2:5199",
    );
    expect(privateDeskLine("192.0.2.10", 5199, { kind: "none" })).toBeNull();
    expect(privateDeskLine("192.0.2.10", 5199, null)).toBeNull();
    // Served on the tailnet: its HTTPS address.
    expect(
      privateDeskLine(
        "192.0.2.10",
        5199,
        { kind: "tailscale", name: "studio.example.ts.net", address: "100.64.0.2" },
        "https://studio.example.ts.net",
      ),
    ).toBe("Desk: http://192.0.2.10:5199 · https://studio.example.ts.net");
  });
});
