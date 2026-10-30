import { describe, expect, it } from "vitest";
import { itemForNotice } from "../src/autopilot/inbox";
import {
  type SilentMachineInput,
  machineNoticeId,
  peerRestartHint,
  silentMachineNotice,
} from "../src/machine-notice";

/** A paired machine silent past the bound (#638). */
const BOUND = 300_000;
const T0 = Date.parse("2026-10-30T09:00:00.000Z");
const base = (over: Partial<SilentMachineInput> = {}): SilentMachineInput => ({
  name: "box",
  os: "linux",
  lastSeen: "2026-10-30T08:59:30.000Z",
  why: "disconnect",
  downSince: T0,
  now: T0 + BOUND,
  boundMs: BOUND,
  paired: true,
  waves: [{ wave: "w1", slug: "a/a" }],
  holds: (slug) => slug === "a/a",
  prior: undefined,
  ...over,
});

describe("silentMachineNotice (#638)", () => {
  it("opens for a paired machine down at least the bound that holds a running wave's repository", () => {
    const n = silentMachineNotice(base());
    expect(n).toMatchObject({
      notice: "machine-down-box",
      machine: "box",
      since: "2026-10-30T08:59:30.000Z",
    });
    expect(n?.title).toContain("box");
    expect(n?.question).toContain("w1");
    expect(n?.question).toContain("a/a");
    expect(n?.question).toContain("systemctl --user restart volley-peer.service");
    const item = itemForNotice(n as NonNullable<typeof n>, "2026-10-30T09:05:00.000Z");
    expect(item).toMatchObject({ id: machineNoticeId("box"), kind: "notice", owner_only: true });
    expect(item.source.since).toBe("2026-10-30T08:59:30.000Z");
  });

  it("not before the bound, not for the own machine or one outside config, not with no running wave on it", () => {
    expect(silentMachineNotice(base({ now: T0 + BOUND - 1 }))).toBeNull();
    expect(silentMachineNotice(base({ paired: false }))).toBeNull();
    // A laptop asleep between waves: nothing it holds is running.
    expect(silentMachineNotice(base({ waves: [] }))).toBeNull();
    expect(silentMachineNotice(base({ holds: () => false }))).toBeNull();
  });

  it("once per outage: not while open, not again once answered for the same outage; a new outage opens", () => {
    const first = silentMachineNotice(base());
    const item = itemForNotice(first as NonNullable<typeof first>, "2026-10-30T09:05:00.000Z");
    expect(silentMachineNotice(base({ prior: item }))).toBeNull();
    const dismissed = {
      ...item,
      answered: { answer: "dismiss", by: "owner", where: { kind: "desk" }, at: "x" },
    } as typeof item;
    expect(silentMachineNotice(base({ prior: dismissed }))).toBeNull();
    expect(
      silentMachineNotice(base({ prior: dismissed, lastSeen: "2026-10-30T10:00:00.000Z" })),
    ).not.toBeNull();
  });

  it("the restart hint follows the machine's OS", () => {
    expect(peerRestartHint("linux")).toBe("systemctl --user restart volley-peer.service");
    expect(peerRestartHint("darwin")).toBe(
      "launchctl kickstart -k gui/$(id -u)/systems.volley.peer",
    );
    expect(silentMachineNotice(base({ os: "darwin" }))?.question).toContain("launchctl kickstart");
  });
});
