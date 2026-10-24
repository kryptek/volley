import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POLICY_TABLE, renderPolicyTable } from "../src/autopilot/policy";
import { formatPolicy } from "../src/commands/policy";
import { formatWave } from "../src/commands/status";
import { CONFIG_DEFAULTS } from "../src/config-defaults";
import type { Daemon } from "../src/daemon";
import type { WaveState } from "../src/types";
import { AUTOPILOT_ON, type DaemonEnv, makeDaemonEnv } from "./helpers/daemon-env";
import { runCli } from "./helpers/run-cli";

let t: DaemonEnv;
let daemon: Daemon;
beforeEach(async () => {
  t = await makeDaemonEnv();
  daemon = await t.start(AUTOPILOT_ON);
});
afterEach(async () => {
  await t.cleanup();
});

describe("volleyd policy", () => {
  it("prints one row per rule (after the owner_only row) with the effective budgets", async () => {
    await runCli(["config", "set", "autopilot.relaunch_max", "3", "--by", "tester"], t.env);
    const r = await runCli(["policy"], t.env);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("autopilot: on");
    const rows = lines.slice(1).filter((l) => l.startsWith("  ") && !l.startsWith("    "));
    expect(rows).toHaveLength(POLICY_TABLE.length + 1);
    expect(r.stdout).toContain(
      'hooks_auth_failed, mcp_not_registered, unknown_screen · pipeline.on === "relaunch" · relaunch · relaunch_max per <task>/<role> · max 3',
    );
    expect(r.stdout).toContain("plan_change, repo_untrusted, model_switch, release_go, stage_go");
    expect(r.stdout).toContain(
      'agent_account_limit · class === "credit_exhausted" && suggested !== null · move <agent> to <suggested> · account_move_max per <task>/<role> · max 2',
    );
    void daemon;
  });

  it("--json prints { rules, config: autopilot }", async () => {
    const r = await runCli(["policy", "--json"], t.env);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { rules: { policy: string }[]; config: unknown };
    expect(out.config).toEqual(CONFIG_DEFAULTS.autopilot);
    expect(out.rules.map((x) => x.policy)).toEqual([
      "owner_only",
      ...POLICY_TABLE.map((x) => x.policy),
    ]);
    const names = out.rules.map((x) => x.policy);
    expect(names.indexOf("agent_account_limit/move-exhausted")).toBeGreaterThan(0);
    expect(names.indexOf("agent_account_limit/move-exhausted")).toBeLessThan(
      names.indexOf("agent_account_limit/move"),
    );
  });

  it("the README's Autopilot section shows the default table verbatim", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
    const ap = CONFIG_DEFAULTS.autopilot;
    expect(readme).toContain(formatPolicy(renderPolicyTable(POLICY_TABLE, ap), ap));
  });

  it("refuses an unknown wave", async () => {
    const r = await runCli(["policy", "nope"], t.env);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("unknown wave 'nope'");
  });
});

describe("volleyd status: the autopilot line", () => {
  const state: WaveState = {
    wave: "w1",
    version: 1,
    owner: null,
    repo: "example-org/example-repo",
    release_branch: "release/w1",
    status: "running",
    tasks: [],
    open_decisions: [],
    gates: [],
    updated_at: "2026-10-20T00:00:00.000Z",
  };

  it("prints autopilot: on · N auto-resolved · M escalated under the wave header", () => {
    const out = formatWave({
      ...state,
      autopilot: { enabled: true, auto_resolved: 2, escalated: 1, budgets: {} },
    });
    expect(out.split("\n")[1]).toBe("  autopilot: on · 2 auto-resolved · 1 escalated");
  });

  it("off, and absent for a state from before autopilot", () => {
    const off = formatWave({
      ...state,
      autopilot: { enabled: false, auto_resolved: 0, escalated: 0, budgets: {} },
    });
    expect(off.split("\n")[1]).toBe("  autopilot: off · 0 auto-resolved · 0 escalated");
    expect(formatWave(state)).not.toContain("autopilot");
  });
});
