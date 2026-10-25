import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SIM_BIN, WORLD_ENTRIES } from "../src/env";
import {
  SIM_ADDRESS,
  SIM_LOGIN_URL,
  TAILSCALE_VERSION,
  UP_MARKER,
  runTailscale,
} from "../src/tailscale";
import { tempDir } from "./helpers/tmp";

let home: string;
const ts = (argv: string[]) =>
  runTailscale(argv, { cwd: home, env: { VOLLEY_SIM_HOME: home, VOLLEY_SIMULATED: "1" } });

beforeEach(() => {
  home = tempDir("volley-sim-tailscale-");
});

describe("the fake tailscale", () => {
  it("`version`, `status --json` (Running, MagicDNS name, 100.64.0.2) and `ip -4`", () => {
    expect(ts(["version"]).stdout.split("\n")[0]).toBe(TAILSCALE_VERSION);
    const s = JSON.parse(ts(["status", "--json"]).stdout) as {
      BackendState: string;
      Self: { DNSName: string; TailscaleIPs: string[] };
    };
    expect(s.BackendState).toBe("Running");
    expect(s.Self.DNSName).toBe("sim-machine.example.ts.net.");
    expect(s.Self.TailscaleIPs[0]).toBe(SIM_ADDRESS);
    expect(ts(["ip", "-4"]).stdout).toBe(`${SIM_ADDRESS}\n`);
  });

  it("`up` prints its sign-in link once, then exits 0; volley sim reset forgets it", () => {
    const first = ts(["up"]);
    expect(first.code).toBe(1);
    expect(first.stderr).toBe(`\nTo authenticate, visit:\n\n\t${SIM_LOGIN_URL}\n\n`);
    expect(ts(["up"])).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(existsSync(join(home, UP_MARKER))).toBe(true);
    expect(WORLD_ENTRIES).toContain(UP_MARKER);
  });

  it("refuses funnel, serve and anything else, recording it in unknown.jsonl", () => {
    for (const argv of [
      ["funnel", "443"],
      ["serve", "5199"],
      ["up", "--ssh"],
    ]) {
      expect(ts(argv).code).toBe(1);
    }
    const lines = readFileSync(join(home, "unknown.jsonl"), "utf-8").trim().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as { argv: string[] }).argv)).toEqual([
      ["tailscale", "funnel", "443"],
      ["tailscale", "serve", "5199"],
      ["tailscale", "up", "--ssh"],
    ]);
  });

  it("bin/tailscale answers under VOLLEY_SIMULATED=1 only", () => {
    const bin = join(SIM_BIN, "tailscale");
    const sim = spawnSync(bin, ["ip", "-4"], {
      env: { PATH: process.env.PATH, VOLLEY_SIM_HOME: home, VOLLEY_SIMULATED: "1" },
      encoding: "utf8",
    });
    expect(sim.stdout).toBe(`${SIM_ADDRESS}\n`);
    // Not simulated: the call goes to the real tailscale further down PATH (none here: 127).
    const bun = dirname(spawnSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).stdout);
    const real = spawnSync(bin, ["ip", "-4"], {
      env: { PATH: `${SIM_BIN}:${bun}`, VOLLEY_SIM_HOME: home },
      encoding: "utf8",
    });
    expect(real.status).toBe(127);
    expect(real.stderr).toContain("tailscale: command not found (volley-sim");
  });
});
