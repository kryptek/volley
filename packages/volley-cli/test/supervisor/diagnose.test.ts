import { describe, expect, it } from "vitest";
import {
  type DiagnoseInput,
  MOSQUITTO_INSTALL_HINT,
  REASONS,
  diagnose,
  unreachableJson,
  unreachableText,
} from "../../src/supervisor/diagnose";

const PEER: DiagnoseInput["where"] = {
  kind: "peer",
  machine: "box",
  brokerUrl: "mqtt://127.0.0.1:21883",
  tunnelPort: 21883,
};
const SUPERVISOR: DiagnoseInput["where"] = {
  kind: "supervisor",
  brokerUrl: "mqtt://localhost:1883",
};
const COORDINATOR: DiagnoseInput["where"] = {
  kind: "coordinator",
  brokerUrl: "mqtt://192.0.2.10:1883",
  network: { kind: "tailscale", name: "box.example.ts.net" },
};

const ALL_UP: Omit<DiagnoseInput, "where"> = {
  internet: true,
  network: "up",
  tunnel: "up",
  broker: "up",
  daemon: "live",
};
const at = (where: DiagnoseInput["where"], over: Partial<DiagnoseInput> = {}): DiagnoseInput => ({
  ...ALL_UP,
  where,
  ...over,
});

describe("diagnose: the reasons and their texts", () => {
  it("offline", () => {
    const d = diagnose(at(PEER, { internet: false }));
    expect(d?.reason).toBe("offline");
    expect(d?.cause).toBe(
      "You are offline. Nothing can reach the supervisor until you are online.",
    );
    expect(d?.fix).toMatch(/online/);
  });

  it("network_down", () => {
    const d = diagnose(at(PEER, { network: "down" }));
    expect(d?.reason).toBe("network_down");
    expect(d?.cause).toBe(
      "The private network is not up on this machine (Tailscale is not running: `tailscale up`; or connect your VPN), then re-run.",
    );
    expect(d?.fix).toContain("tailscale up");
  });

  it("tunnel_down names the tunnel's port", () => {
    const d = diagnose(at(PEER, { tunnel: "down" }));
    expect(d?.reason).toBe("tunnel_down");
    expect(d?.cause).toBe(
      "This machine's tunnel to the broker is down (`127.0.0.1:21883` refuses). `volley peer doctor` shows why; the service restarts it on its own (`launchctl kickstart -k gui/$UID/systems.volley.peer` or `systemctl --user restart volley-peer`).",
    );
    expect(d?.fix).toContain("volley peer doctor");
  });

  it("broker_down names the broker's URL", () => {
    const d = diagnose(at(SUPERVISOR, { tunnel: "none", broker: "down" }));
    expect(d?.reason).toBe("broker_down");
    expect(d?.cause).toBe(
      "The broker at mqtt://localhost:1883 does not answer. On the supervisor's machine: `volley setup --check`; from elsewhere: check that machine is up.",
    );
    expect(d?.fix).toContain("volley setup --check");
  });

  it("daemon_silent", () => {
    const d = diagnose(at(SUPERVISOR, { tunnel: "none", daemon: "silent" }));
    expect(d?.reason).toBe("daemon_silent");
    expect(d?.cause).toBe(
      "The broker answers but volleyd is silent: on the supervisor's machine run `launchctl kickstart -k gui/$UID/systems.volley.volleyd` (or `systemctl --user restart volleyd`) or `volley deploy --latest`.",
    );
    expect(d?.fix).toContain("volley deploy --latest");
  });

  it("no_broker_here: a machine with no setup and no broker on its own loopback keeps the install hint", () => {
    const d = diagnose(
      at({ kind: "other", brokerUrl: "mqtt://localhost:1883" }, { tunnel: "none", broker: "down" }),
    );
    expect(d?.reason).toBe("no_broker_here");
    expect(d?.fix).toBe(MOSQUITTO_INSTALL_HINT);
    expect(d?.cause).toContain("mqtt://localhost:1883");
  });

  it("a machine with no setup pointed at a broker elsewhere gets broker_down, not the install hint", () => {
    const d = diagnose(
      at(
        { kind: "other", brokerUrl: "mqtt://192.0.2.10:1883" },
        { tunnel: "none", broker: "down" },
      ),
    );
    expect(d?.reason).toBe("broker_down");
  });

  it("everything up: nothing to diagnose", () => {
    expect(diagnose(at(PEER))).toBeNull();
  });

  it("REASONS lists exactly the six reasons", () => {
    expect([...REASONS].sort()).toEqual(
      [
        "broker_down",
        "daemon_silent",
        "network_down",
        "no_broker_here",
        "offline",
        "tunnel_down",
      ].sort(),
    );
  });
});

describe("diagnose: the order", () => {
  it("offline ignores every later rung", () => {
    const d = diagnose(
      at(PEER, {
        internet: false,
        network: "down",
        tunnel: "down",
        broker: "down",
        daemon: "silent",
      }),
    );
    expect(d?.reason).toBe("offline");
  });

  it("the private network comes before the tunnel", () => {
    expect(diagnose(at(PEER, { network: "down", tunnel: "down" }))?.reason).toBe("network_down");
  });

  it('network "unknown" falls through to the tunnel', () => {
    expect(diagnose(at(PEER, { network: "unknown", tunnel: "down" }))?.reason).toBe("tunnel_down");
  });

  it('tunnel "none" skips that rung', () => {
    expect(diagnose(at(SUPERVISOR, { tunnel: "none", broker: "down" }))?.reason).toBe(
      "broker_down",
    );
  });

  it("the broker comes before volleyd", () => {
    expect(diagnose(at(PEER, { broker: "down", daemon: "silent" }))?.reason).toBe("broker_down");
  });

  it('daemon "unknown" with the broker up is not a diagnosis', () => {
    expect(diagnose(at(PEER, { daemon: "unknown" }))).toBeNull();
  });
});

describe("diagnose: the coordinator", () => {
  it("gets the same texts, with the broker URL from where", () => {
    const d = diagnose(at(COORDINATOR, { tunnel: "none", broker: "down" }));
    expect(d?.reason).toBe("broker_down");
    expect(d?.cause).toBe(
      "The broker at mqtt://192.0.2.10:1883 does not answer. On the supervisor's machine: `volley setup --check`; from elsewhere: check that machine is up.",
    );
    expect(diagnose(at(COORDINATOR, { internet: false }))?.cause).toBe(
      diagnose(at(PEER, { internet: false }))?.cause,
    );
  });
});

describe("the report", () => {
  it("the stderr text: the reason, the cause and the fix line", () => {
    const input = at(PEER, { tunnel: "down" });
    const d = diagnose(input);
    if (d === null) throw new Error("expected a diagnosis");
    expect(unreachableText("volley list", d)).toBe(
      `volley list: supervisor unreachable (tunnel_down): ${d.cause}\n  fix: ${d.fix}\n`,
    );
  });

  it("the --json object", () => {
    const input = at(PEER, { tunnel: "down" });
    const d = diagnose(input);
    if (d === null) throw new Error("expected a diagnosis");
    expect(unreachableJson(d, input)).toEqual({
      error: "SUPERVISOR_UNREACHABLE",
      reason: "tunnel_down",
      cause: d.cause,
      fix: d.fix,
      where: PEER,
      probes: { internet: true, network: "up", tunnel: "down", broker: "up", daemon: "live" },
    });
  });
});
