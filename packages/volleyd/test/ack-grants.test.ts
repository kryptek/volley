import { afterEach, describe, expect, it } from "vitest";
import { ControlClient } from "../src/control";
import { NS } from "./helpers/daemon-env";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

/**
 * SPEC §4.4: an agent acks to the SENDER's mailbox, and the shipped ACL lets a minted agent write
 * only the mailboxes it was granted. A wave that changes owner must let its live agents ack the
 * new owner (its steers' "Delivered by hook" / `vol_send_mailbox(wait_ack_ms)`).
 */
describe("ack grants follow the wave's owner", () => {
  let s: SupervisedEnv;
  afterEach(async () => {
    await s.cleanup();
  });

  it("claim extends every live minted agent's grant to the new owner (password kept)", async () => {
    s = await makeSupervisedEnv();
    const client = await ControlClient.connect(s.env.broker.url, NS);
    try {
      const res = await client.request("claim", { wave: "w1", by: "coord-new" });
      expect(res.error).toBeUndefined();
      expect(res.ok).toBe(true);
    } finally {
      await client.close();
    }
    await s.until(() => s.host.fake.argvs(["volley", "auth", "grant"]).length > 0);
    expect(s.host.fake.argvs(["volley", "auth", "grant"])).toEqual([
      ["volley", "auth", "grant", AGENT, "--ack-to", "coord-new"],
    ]);
    // Never a re-mint: that would change the live agent's password.
    expect(s.host.fake.argvs(["volley", "auth", "add-agent"])).toHaveLength(1);
  });

  it("an agent minted for the old owner while a claim landed is granted the new owner", async () => {
    // The claim is journaled after the spawn captured the old owner and before supervision
    // started, so the claim's own grant pass cannot see the agent yet.
    s = await makeSupervisedEnv({
      onLaunch: (daemon) =>
        void daemon.recordEvent("w1", {
          type: "owner_claimed",
          data: { owner: "coord-new", previous: null, why: "test" },
        }),
    });
    await s.until(() => s.host.fake.argvs(["volley", "auth", "grant"]).length > 0);
    expect(s.host.fake.argvs(["volley", "auth", "grant"])).toEqual([
      ["volley", "auth", "grant", AGENT, "--ack-to", "coord-new"],
    ]);
  });

  it("a failed grant is journaled as an alarm, and the claim still stands", async () => {
    s = await makeSupervisedEnv({
      exec: [[["volley", "auth", "grant"], { code: 1, stderr: "no passwd file" }]],
    });
    const client = await ControlClient.connect(s.env.broker.url, NS);
    try {
      expect((await client.request("claim", { wave: "w1", by: "coord-new" })).ok).toBe(true);
    } finally {
      await client.close();
    }
    await s.until(() =>
      s.journal().some((e) => e.type === "alarm_raised" && e.data.code === "ACK_GRANT_FAILED"),
    );
    const alarm = s
      .journal()
      .find((e) => e.type === "alarm_raised" && e.data.code === "ACK_GRANT_FAILED");
    expect(alarm?.data).toMatchObject({ agent_id: AGENT, owner: "coord-new" });
    expect(s.daemon.snapshot("w1")?.owner).toBe("coord-new");
  });
});
