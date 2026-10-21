import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderDigestMd } from "../src/autopilot/digest";
import { ControlClient } from "../src/control";
import type { Daemon } from "../src/daemon";
import { AUTOPILOT_ON, type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { runCli } from "./helpers/run-cli";

const WAVE = "w1";
const YAML = `wave: ${WAVE}
repo: example-org/example-repo
release_branch: release/${WAVE}
model: claude-opus-5-5
pipeline: [implement, merge_ready]
tasks:
  A: { issue: 1 }
`;

let t: DaemonEnv;
let daemon: Daemon;
beforeEach(async () => {
  t = await makeDaemonEnv();
  daemon = await t.start(AUTOPILOT_ON);
  const client = await ControlClient.connect(t.broker.url, NS);
  expect(
    (await client.request("run", { wave_yaml: YAML, owner: "coord-a" })).error,
  ).toBeUndefined();
  await client.close();
  await daemon.openDecision(WAVE, {
    kind: "plan_change",
    task: null,
    question: "Add a task T2?",
    options: ["apply"],
  });
});
afterEach(async () => {
  await t.cleanup();
});

describe("volleyd digest", () => {
  it("prints the digest as markdown", async () => {
    const r = await runCli(["digest", WAVE], t.env);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^# w1 needs you: 0 shipped, 1 waiting for you \(plan_change\)\n/);
    for (const h of ["## Shipped", "## Autopilot handled", "## Waiting for you"])
      expect(r.stdout).toContain(h);
    expect(r.stdout).toContain("(owner only): Add a task T2?");
  });

  it("--json prints the payload", async () => {
    const r = await runCli(["digest", WAVE, "--json"], t.env);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ wave: WAVE, trigger: "escalation" });
    expect(renderDigestMd(out)).toContain("Add a task T2?");
  });

  it("needs exactly one wave", async () => {
    const r = await runCli(["digest"], t.env);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("expected one wave");
  });
});
