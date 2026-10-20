import { describe, expect, it } from "vitest";
import { STALE_AFTER_MS } from "../src/settings/BrokerAccounts";
import type { AuthOps } from "../src/store/control";
import { ADMIN_SEEN_EVERY_MS, type PeerOps, keepAdminSeen } from "../src/store/peerOps";

/** An admin channel that records each op, answered at once; and manual timers. */
function rig(known: ReturnType<PeerOps["known"]>) {
  const sent: string[] = [];
  const auth = {
    identity: "admin-0000aaaa",
    request: async (op: string) => {
      sent.push(op);
      return { ok: true };
    },
  } as unknown as AuthOps;
  const peer = { known: () => known, admin: async () => known ?? "no-answer" } as PeerOps;
  let tick: (() => void) | null = null;
  let cleared = false;
  const timers = {
    setInterval: (fn: () => void) => {
      tick = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {
      cleared = true;
    },
  };
  return { sent, auth, peer, timers, tick: () => tick?.(), cleared: () => cleared };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("keepAdminSeen", () => {
  it("an admin Desk tells volleyd it is in use at once and then on every interval", async () => {
    const r = rig("admin");
    const stop = keepAdminSeen(r.peer, r.auth, r.timers);
    await flush();
    expect(r.sent).toEqual(["account_list"]);
    r.tick();
    await flush();
    expect(r.sent).toEqual(["account_list", "account_list"]);
    stop();
    expect(r.cleared()).toBe(true);
  });

  it("a Desk that is not an admin sends nothing", async () => {
    const r = rig("not-admin");
    keepAdminSeen(r.peer, r.auth, r.timers);
    r.tick();
    await flush();
    expect(r.sent).toEqual([]);
  });

  it("checks in well inside the Broker accounts section's stale limit", () => {
    expect(ADMIN_SEEN_EVERY_MS * 4).toBeLessThanOrEqual(STALE_AFTER_MS);
  });
});
