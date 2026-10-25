import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoSteerClient } from "../src/steer/demoClient";
import type { DeskMessage } from "../src/store/types";

const envelope = (payload: unknown) =>
  JSON.stringify({
    schema_version: "0.1",
    agent_id: "desk",
    parent_id: null,
    namespace: "default",
    channel: "mailbox",
    type: "steering",
    wall_time: "2026-10-25T00:00:00.000Z",
    correlation_id: "c1",
    payload,
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("the demo steering client's close", () => {
  it("cancels every answer still pending, so nothing reaches the store after the Desk unmounts", async () => {
    vi.useFakeTimers();
    const applied: DeskMessage[][] = [];
    const client = createDemoSteerClient(
      (msgs) => applied.push(msgs),
      () => false,
    );
    await client.publish("volley/default/w1-t1-implementer-1/mailbox", envelope({ text: "hi" }));
    await client.publish(
      "volley/default/volleyd/mailbox",
      envelope({ op: "claude_signin_entry", acct: "work", code: "x" }),
    );
    const before = applied.length;
    client.close();
    await vi.runAllTimersAsync();
    expect(applied.length).toBe(before);
  });

  it("still answers a publish made after close (React's strict-mode remount)", async () => {
    vi.useFakeTimers();
    const applied: DeskMessage[][] = [];
    const client = createDemoSteerClient(
      (msgs) => applied.push(msgs),
      () => false,
    );
    client.close();
    await client.publish("volley/default/w1-t1-implementer-1/mailbox", envelope({ text: "hi" }));
    await vi.runAllTimersAsync();
    expect(applied.length).toBeGreaterThan(1);
  });
});
