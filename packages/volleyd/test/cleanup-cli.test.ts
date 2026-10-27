import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { registryTopic } from "volley-mcp/topics";
import { ControlClient } from "../src/control";
import type { Daemon } from "../src/daemon";
import type { JournalEvent } from "../src/types";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { runCli } from "./helpers/run-cli";

/** `volleyd cleanup <wave>` identifies the owner as stop and steer do (#630 D1, D2, D4). */

const WAVE = "w-clean";
const OWNER = "coord-a";
const yaml = `wave: ${WAVE}
repo: /path/to/example-repo
release_branch: release/${WAVE}
model: claude-opus-5-5
pipeline: [implement]
config: { cleanup_on_end: false }
tasks:
  A: { issue: 1 }
  B: { issue: 2 }
`;

let t: DaemonEnv;
let daemon: Daemon;

beforeEach(async () => {
  t = await makeDaemonEnv();
  daemon = await t.start();
  const client = await ControlClient.connect(t.broker.url, NS);
  try {
    const res = await client.request("run", { wave_yaml: yaml, owner: OWNER });
    expect(res.error).toBeUndefined();
  } finally {
    await client.close();
  }
  // Every task done, its agent retired: nothing live, nothing runs on its own.
  for (const task of ["A", "B"]) {
    const agent_id = `${WAVE}-${task.toLowerCase()}-implementer-1`;
    await daemon.recordEvent(WAVE, {
      type: "agent_spawned",
      task,
      data: {
        agent_id,
        role: "implementer",
        host: "local",
        worktree: `/path/to/worktrees/${WAVE}/${task}-implementer`,
        branch: `${WAVE}/${task}-implementer-1`,
        credentials: "none",
      },
    });
    await daemon.recordEvent(WAVE, {
      type: "agent_retired",
      task,
      data: { agent_id, workspace_closed: true },
    });
    await daemon.recordEvent(WAVE, { type: "stage_entered", task, data: { stage: "done" } });
  }
});
afterEach(async () => {
  await t.cleanup();
});

const cleaned = (): JournalEvent[] =>
  daemon.journalEvents(WAVE).filter((e) => e.type === "wave_cleaned");

/** A retained registry entry, as a session's SessionStart hook publishes it. */
async function registered(agentId: string, payload: Record<string, unknown>) {
  const pub = new VolleyBroker();
  await pub.connect({ url: t.broker.url, agentId: `${agentId}-pub` });
  const env = buildEnvelope({
    agentId,
    parentId: null,
    channel: "_system/registry",
    type: "registered",
    payload: { capabilities: [], started_at: new Date().toISOString(), ...payload },
  });
  await pub.publish(registryTopic(agentId), JSON.stringify({ ...env, namespace: NS }), {
    qos: 1,
    retain: true,
  });
  await pub.disconnect();
}

describe("volleyd cleanup <wave>: the caller", () => {
  it("--by the owner: the dry run, journaled as the owner", async () => {
    const r = await runCli(["cleanup", WAVE, "--by", OWNER], t.env);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/dry run: pass --yes to remove\n$/);
    expect(cleaned().map((e) => e.data)).toEqual([
      expect.objectContaining({ by: OWNER, dry_run: true }),
    ]);
  });

  it("--by the owner --yes: the real run", async () => {
    const r = await runCli(["cleanup", WAVE, "--by", OWNER, "--yes"], t.env);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(cleaned().map((e) => e.data)).toEqual([
      expect.objectContaining({ by: OWNER, dry_run: false }),
    ]);
  });

  it("VOLLEY_COORDINATOR names the owner", async () => {
    const r = await runCli(["cleanup", WAVE], { ...t.env, VOLLEY_COORDINATOR: OWNER });
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(cleaned()[0]?.data.by).toBe(OWNER);
  });

  it("a registered session's coordinator name (VOLLEY_AGENT_ID) is the owner", async () => {
    await registered("coord-session-1", { coordinator: OWNER, cwd: "/path/to/elsewhere" });
    const r = await runCli(["cleanup", WAVE], { ...t.env, VOLLEY_AGENT_ID: "coord-session-1" });
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(cleaned()[0]?.data.by).toBe(OWNER);
  });

  it("the top-level session registered for the cwd is the owner", async () => {
    await registered("coord-session-2", { coordinator: OWNER, cwd: process.cwd() });
    const r = await runCli(["cleanup", WAVE], t.env);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(cleaned()[0]?.data.by).toBe(OWNER);
  });

  it("someone else is refused, and nothing is journaled", async () => {
    const r = await runCli(["cleanup", WAVE, "--by", "someone-else"], t.env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`owned by ${OWNER}`);
    expect(r.stderr).toContain("'cleanup' as someone-else is refused");
    expect(cleaned()).toEqual([]);
  });

  it("no identity at all: refused with the hint, which never names VOLLEY_AGENT_ID", async () => {
    const r = await runCli(["cleanup", WAVE], t.env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("owned by");
    expect(r.stderr).toContain(
      "(no caller identity: pass --by <name|agent-id> or set VOLLEY_COORDINATOR",
    );
    expect(r.stderr).not.toContain("VOLLEY_AGENT_ID");
    expect(cleaned()).toEqual([]);
  });

  it("--json prints the wave, the lines and the failure count", async () => {
    const r = await runCli(["cleanup", WAVE, "--by", OWNER, "--json"], t.env);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { wave: string; lines: string[]; failed: number };
    expect(out.wave).toBe(WAVE);
    expect(out.lines.at(-1)).toBe("dry run: pass --yes to remove");
    expect(out.failed).toBe(0);
  });

  it("--help lists the identity and target flags", async () => {
    const r = await runCli(["cleanup", "--help"]);
    expect(r.exitCode).toBe(0);
    for (const flag of ["--by", "--json", "--broker-url", "--namespace"])
      expect(r.stdout).toContain(flag);
  });
});
