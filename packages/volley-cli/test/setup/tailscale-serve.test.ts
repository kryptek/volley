import { describe, expect, it } from "vitest";
import { TAILSCALE_APP_CLI } from "../../src/setup/network";
import {
  DESK_HTTPS_PORT,
  WS_HTTPS_PORT,
  deskServeTargets,
  isTailscaleServeCommand,
  parseServeStatus,
  planDeskServe,
  serveArgv,
  serveOffArgv,
} from "../../src/setup/tailscale-serve";

const NAME = "studio.example.ts.net";
const TS = { kind: "tailscale" as const, name: NAME, address: "100.64.0.2" };

/** `tailscale serve status --json` with both of the Desk's serves (as Tailscale 1.76 writes it). */
const BOTH = JSON.stringify({
  TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
  Web: {
    [`${NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:5199" } } },
    [`${NAME}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9001" } } },
  },
});

describe("serveArgv / serveOffArgv", () => {
  it("renders the two exact argvs for the Desk on 5199 and the WebSocket listener on 9001", () => {
    expect(deskServeTargets(5199)).toEqual([
      { https: DESK_HTTPS_PORT, port: 5199 },
      { https: WS_HTTPS_PORT, port: 9001 },
    ]);
    expect(deskServeTargets(5199).map((t) => serveArgv(t))).toEqual([
      ["tailscale", "serve", "--bg", "--https=443", "http://127.0.0.1:5199"],
      ["tailscale", "serve", "--bg", "--https=8443", "http://127.0.0.1:9001"],
    ]);
    expect(serveArgv({ https: 443, port: 5300 }, TAILSCALE_APP_CLI)).toEqual([
      TAILSCALE_APP_CLI,
      "serve",
      "--bg",
      "--https=443",
      "http://127.0.0.1:5300",
    ]);
  });

  it("removes one HTTPS port only (never `serve reset`)", () => {
    expect(serveOffArgv(443)).toEqual(["tailscale", "serve", "--https=443", "off"]);
    expect(serveOffArgv(8443)).toEqual(["tailscale", "serve", "--https=8443", "off"]);
  });
});

describe("parseServeStatus", () => {
  it("reads each HTTPS port's root proxy", () => {
    expect(parseServeStatus(BOTH)).toEqual(
      new Map([
        [443, "http://127.0.0.1:5199"],
        [8443, "http://127.0.0.1:9001"],
      ]),
    );
  });

  it("is empty with nothing served, and names a port served some other way", () => {
    expect(parseServeStatus("{}\n")).toEqual(new Map());
    expect(
      parseServeStatus(
        JSON.stringify({
          TCP: { "443": { TCPForward: "127.0.0.1:22" } },
          Web: { [`${NAME}:8443`]: { Handlers: { "/docs": { Path: "/srv/docs" } } } },
        }),
      ),
    ).toEqual(
      new Map([
        [443, "tcp://127.0.0.1:22"],
        [8443, "another handler"],
      ]),
    );
  });

  it("is null when it is not serve status JSON", () => {
    expect(parseServeStatus("serve config denied")).toBeNull();
    expect(parseServeStatus("[]")).toBeNull();
  });
});

describe("planDeskServe", () => {
  it("with neither configured plans both, at the machine's HTTPS name", () => {
    const p = planDeskServe(TS, new Map(), 5199);
    expect(p).toEqual({
      name: NAME,
      url: `https://${NAME}`,
      wsUrl: `wss://${NAME}:8443`,
      configured: [],
      missing: deskServeTargets(5199),
    });
  });

  it("with both configured plans nothing", () => {
    const p = planDeskServe(TS, parseServeStatus(BOTH) ?? new Map(), 5199);
    expect(p).toMatchObject({ configured: deskServeTargets(5199), missing: [] });
  });

  it("plans only the one missing", () => {
    const p = planDeskServe(TS, new Map([[443, "http://127.0.0.1:5199"]]), 5199);
    expect(p).toMatchObject({ missing: [{ https: 8443, port: 9001 }] });
  });

  it("without a Tailscale record it is blocked with the volley setup --network tailscale line", () => {
    for (const r of [null, { kind: "none" as const }, { kind: "manual" as const, address: "x" }]) {
      const p = planDeskServe(r, new Map(), 5199);
      expect("blocked" in p && p.blocked).toMatch(/run `volley setup --network tailscale` first/);
    }
  });

  it("is blocked without a MagicDNS name", () => {
    const p = planDeskServe({ kind: "tailscale", address: "100.64.0.2" }, new Map(), 5199);
    expect("blocked" in p && p.blocked).toMatch(/no MagicDNS name/);
  });

  it("never replaces the owner's own serve on one of the ports", () => {
    const p = planDeskServe(TS, new Map([[443, "http://127.0.0.1:3000"]]), 5199);
    expect("blocked" in p && p.blocked).toMatch(
      /HTTPS port 443 .* already serves http:\/\/127\.0\.0\.1:3000/,
    );
    expect("blocked" in p && p.blocked).toContain("tailscale serve --https=443 off");
  });
});

describe("isTailscaleServeCommand", () => {
  it.each([
    [["tailscale", "serve", "status", "--json"]],
    [["tailscale", "serve", "--bg", "--https=443", "http://127.0.0.1:5199"]],
    [["tailscale", "serve", "--bg", "--https=443", "http://127.0.0.1:5300"]],
    [["tailscale", "serve", "--bg", "--https=8443", "http://127.0.0.1:9001"]],
    [["tailscale", "serve", "--https=443", "off"]],
    [["tailscale", "serve", "--https=8443", "off"]],
    [[TAILSCALE_APP_CLI, "serve", "--bg", "--https=443", "http://127.0.0.1:5199"]],
    [["sudo", "tailscale", "serve", "--bg", "--https=8443", "http://127.0.0.1:9001"]],
  ])("allows %j", (argv) => {
    expect(isTailscaleServeCommand(argv, { sudo: true })).toBe(true);
  });

  it.each([
    [["tailscale", "funnel", "--bg", "--https=443", "http://127.0.0.1:5199"]],
    [["tailscale", "funnel", "443"]],
    [["tailscale", "serve", "reset"]],
    [["tailscale", "serve", "--bg", "--https=443", "http://0.0.0.0:5199"]],
    [["tailscale", "serve", "--bg", "--https=443", "http://192.0.2.10:5199"]],
    [["tailscale", "serve", "--bg", "--https=443", "http://localhost:5199"]],
    [["tailscale", "serve", "--bg", "--https=443", "https://127.0.0.1:5199"]],
    [["tailscale", "serve", "--bg", "--https=443", "http://127.0.0.1:5199/x"]],
    [["tailscale", "serve", "--bg", "--https=443", "http://127.0.0.1:99999"]],
    [["tailscale", "serve", "--bg", "--https=8443", "http://127.0.0.1:22"]],
    [["tailscale", "serve", "--bg", "--https=22", "http://127.0.0.1:5199"]],
    [["tailscale", "serve", "--https=443", "http://127.0.0.1:5199"]],
    [["tailscale", "serve", "--bg", "--funnel", "--https=443", "http://127.0.0.1:5199"]],
    [["tailscale", "serve", "--https=22", "off"]],
    [["tailscale", "serve", "status"]],
    [["tailscale-evil", "serve", "status", "--json"]],
  ])("refuses %j", (argv) => {
    expect(isTailscaleServeCommand(argv, { sudo: true })).toBe(false);
  });

  it("refuses sudo unless asked", () => {
    const argv = ["sudo", "tailscale", "serve", "--https=443", "off"];
    expect(isTailscaleServeCommand(argv, { sudo: false })).toBe(false);
  });
});
