import { afterEach, describe, expect, it } from "vitest";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { NS } from "./helpers/daemon-env";
import { memoryCredentials } from "./helpers/fake-dynsec";
import { runCli } from "./helpers/run-cli";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

/** `volleyd stop` must not leave the wave's broker logins behind. */
describe("volleyd stop retires the wave's agents; a sweep then leaves no agent login", () => {
  let s: SupervisedEnv;
  afterEach(async () => {
    await s.cleanup();
  });
  /** The agent logins that belong to wave w1. */
  const waveLogins = () => [...s.creds.logins].filter((id) => id.startsWith("w1-"));

  it("stop <wave>: the running agent's login is deleted at once (reaped, records cleared)", async () => {
    s = await makeSupervisedEnv({ daemon: { credentialSweepMs: 3_600_000 } });
    // A login of this wave that outlived an earlier run (never journaled live in this one).
    s.creds.logins.add("w1-t1-implementer-0");
    s.creds.mintedAt.set("w1-t1-implementer-0", 0);
    expect(waveLogins().sort()).toEqual([AGENT, "w1-t1-implementer-0"].sort());

    expect((await runCli(["stop", "w1", "--by", "tester"], s.env.env)).exitCode).toBe(0);
    await s.until(() => s.creds.revoked.includes(AGENT));
    const retired = s
      .journal()
      .find((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
    expect(retired?.data).toMatchObject({ status: "stopped", credentials_revoked: true });
    expect(s.journal().map((e) => e.type)).toContain("agent_reaped_by_supervisor");
    // No LWT comes for a deleted login: volleyd said it, then cleared the records.
    expect(await s.env.retained(buildTopic(NS, AGENT, "status"))).toBeNull();
    expect(await s.env.retained(registryTopic(AGENT))).toBeNull();
    // The daemon's own delete re-counted the logins: status shows only the leftover.
    const status = await runCli(["status"], s.env.env);
    expect(status.stdout.split("\n")[0]).toBe("agent logins: 1 live, 0 swept");

    await s.daemon.sweepCredentials();
    expect(waveLogins()).toEqual([]);
  });

  it("stop <wave> deletes all its agents' logins in ONE batched control message", async () => {
    // The store records which deletes arrive in the same tick: those share a batch window (and
    // so one control message) whatever the window's length.
    const creds = memoryCredentials();
    const revoke = creds.revoke;
    const batches: string[][] = [];
    let pending: string[] = [];
    creds.revoke = (id) => {
      pending.push(id);
      if (pending.length === 1) {
        queueMicrotask(() => {
          batches.push(pending.sort());
          pending = [];
        });
      }
      return revoke(id);
    };
    s = await makeSupervisedEnv({
      creds,
      tasks: ["T2: { issue: 42 }", "T3: { issue: 42 }"],
      daemon: { credentialSweepMs: 3_600_000 },
    });
    const agents = [AGENT, "w1-t2-implementer-1", "w1-t3-implementer-1"];
    expect(waveLogins().sort()).toEqual(agents);
    expect((await runCli(["stop", "w1", "--by", "tester"], s.env.env)).exitCode).toBe(0);
    await s.until(() => creds.revoked.length === 3);
    expect(batches).toEqual([agents]);
  });

  it("stop --all: the same for every wave", async () => {
    s = await makeSupervisedEnv({ daemon: { credentialSweepMs: 3_600_000 } });
    expect((await runCli(["stop", "--all", "--by", "tester"], s.env.env)).exitCode).toBe(0);
    await s.until(() => s.creds.revoked.includes(AGENT));
    await s.daemon.sweepCredentials();
    expect(waveLogins()).toEqual([]);
  });

  it("a running wave's live agent is never swept", async () => {
    s = await makeSupervisedEnv({ daemon: { credentialSweepMs: 3_600_000 } });
    s.creds.mintedAt.set(AGENT, 0); // old enough: only its liveness spares it
    expect(await s.daemon.sweepCredentials()).toEqual([]);
    expect(waveLogins()).toEqual([AGENT]);
  });
});
