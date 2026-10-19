import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeRoot } from "../../src/claude/profiles";
import { ControlClient } from "../../src/control";
import { NS } from "../helpers/daemon-env";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "../helpers/supervised-env";
import { withEnv } from "../helpers/with-env";

/** agent_move_account through a real daemon: cancel, stop, retire, respawn under the profile. */

let s: SupervisedEnv;
afterEach(async () => {
  await s?.cleanup();
});

/**
 * Move the supervised agent to profile `work` under `root`; `customRoot` undefined runs the daemon with
 * its default root (`claudeRoot()`, `~/.volley/claude` under a temporary HOME).
 */
async function moveToWork(customRoot: string | undefined, base: string): Promise<void> {
  const primary = join(base, ".claude");
  mkdirSync(primary, { recursive: true });
  s = await makeSupervisedEnv({
    daemon: {
      claude: { ...(customRoot !== undefined ? { root: customRoot } : {}), primaryDir: primary },
    },
  });
  const root = customRoot ?? claudeRoot();
  const dir = join(root, "work");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(root, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: "work",
          label: "work",
          machine: "local",
          created: "2026-10-18T12:00:00.000Z",
          signed_in_at: "2026-10-18T12:00:00.000Z",
        },
      ],
    }),
  );
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({ projects: { [s.repo]: { hasTrustDialogAccepted: true } } }),
  );
  // The respawn is checked by what it wrote; no simulated session for it.
  s.host.onLaunch = () => {};
  const client = await ControlClient.connect(s.env.broker.url, NS);
  try {
    const reply = client.request("agent_move_account", { agent: AGENT, acct: "work", by: "o" });
    await s.until(() => s.journal().some((e) => e.type === "agent_account_moved"));
    await s.status("blocked", { reason: "moving" });
    const r = await reply;
    expect(r).toMatchObject({
      ok: true,
      agent_id: "w1-t1-implementer-2",
      from: "primary",
      to: "work",
    });
    const j = s.journal();
    expect(j.find((e) => e.type === "agent_retired")?.data).toMatchObject({
      agent_id: AGENT,
      status: "moved",
    });
    const spawned = j.filter((e) => e.type === "agent_spawned");
    expect(spawned.map((e) => e.data.claude_account)).toEqual(["primary", "work"]);
    // the account is replayed from the journal, not passed in by the move
    const wt = join(s.env.home, "wt", "w1", "T1-implementer");
    expect(readFileSync(join(wt, ".volley", "launch.sh"), "utf-8")).toContain(
      `export CLAUDE_CONFIG_DIR='${dir}'`,
    );
    expect(readFileSync(join(wt, ".volley", "brief.md"), "utf-8")).toMatch(
      /## Resume after an account move/,
    );
    // the profile was prepared for its first agent: no onboarding screen
    expect(JSON.parse(readFileSync(join(dir, ".claude.json"), "utf-8"))).toMatchObject({
      hasCompletedOnboarding: true,
    });
    // the stop is the move's, not a blocked task: no decision for it
    expect(j.some((e) => e.type === "decision_opened")).toBe(false);
  } finally {
    await client.close();
  }
}

describe("agent_move_account (daemon)", () => {
  it("retires the agent as moved and respawns it with the target profile's CLAUDE_CONFIG_DIR", async () => {
    // A custom root (the daemon's `claude.root`) is the one $VOLLEY_CLAUDE_DIR names: the fence's.
    const base = mkdtempSync(join(tmpdir(), "volleyd-move-"));
    const root = join(base, "claude");
    await withEnv({ VOLLEY_CLAUDE_DIR: root }, () => moveToWork(root, base));
  }, 20_000);

  it("moves to a profile in the DEFAULT root (~/.volley/claude/<acct>) through the real fence", async () => {
    // The owner's smoke: the respawn under a profile there was FENCE_DENIED (launch.sh).
    const base = realpathSync(mkdtempSync(join(tmpdir(), "volleyd-move-")));
    await withEnv(
      { HOME: base, VOLLEY_CLAUDE_DIR: undefined, VOLLEYD_HOME: undefined },
      async () => {
        expect(claudeRoot()).toBe(join(base, ".volley", "claude"));
        await moveToWork(undefined, base);
      },
    );
  }, 20_000);
});
