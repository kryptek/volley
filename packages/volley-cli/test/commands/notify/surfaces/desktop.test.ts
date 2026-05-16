import { describe, expect, it, vi } from "vitest";
import { type Envelope, buildEnvelope } from "volley-mcp/envelope";
import {
  type DesktopSpawnFn,
  type DesktopWhichFn,
  createDesktopSurface,
} from "../../../../src/commands/notify/surfaces/desktop";
import { makeBufferIO } from "../../../../src/io";

function envelopeFor(agentId: string, type: string): Envelope {
  return buildEnvelope({
    agentId,
    parentId: null,
    channel: "status",
    type,
    now: () => new Date("2026-05-16T00:00:00Z"),
  });
}

describe("desktop surface", () => {
  it("when which() returns null, fire() is a no-op and disabled warning logged once", async () => {
    const io = makeBufferIO();
    const spawn = vi.fn<DesktopSpawnFn>();
    const which = vi.fn<DesktopWhichFn>().mockReturnValue(null);
    const s = createDesktopSurface({ io, spawn, which });
    await s.fire({
      topic: "volley/default/alpha/status",
      envelope: envelopeFor("alpha", "blocked"),
    });
    await s.fire({
      topic: "volley/default/alpha/status",
      envelope: envelopeFor("alpha", "failed"),
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(which).toHaveBeenCalledTimes(1);
    const stderr = io.readStderr();
    expect(stderr).toContain("terminal-notifier not found");
    expect(stderr).toContain("brew install terminal-notifier");
    // disabled warning logged exactly once across both fire() calls
    const matches = stderr.match(/terminal-notifier not found/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("when which() returns a path, fire() calls spawn with terminal-notifier argv", async () => {
    const io = makeBufferIO();
    const spawn = vi.fn<DesktopSpawnFn>();
    const which = vi.fn<DesktopWhichFn>().mockReturnValue("/usr/local/bin/terminal-notifier");
    const s = createDesktopSurface({ io, spawn, which });
    await s.fire({
      topic: "volley/default/alpha/status",
      envelope: envelopeFor("alpha", "blocked"),
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawn.mock.calls[0] ?? [];
    expect(cmd).toBe("terminal-notifier");
    expect(args).toEqual([
      "-title",
      "Volley",
      "-subtitle",
      "alpha",
      "-message",
      "blocked",
      "-sound",
      "Glass",
    ]);
  });

  it("custom sound overrides the default 'Glass'", async () => {
    const io = makeBufferIO();
    const spawn = vi.fn<DesktopSpawnFn>();
    const which = vi.fn<DesktopWhichFn>().mockReturnValue("/usr/local/bin/terminal-notifier");
    const s = createDesktopSurface({ io, spawn, which, sound: "Hero" });
    await s.fire({
      topic: "volley/default/alpha/status",
      envelope: envelopeFor("alpha", "failed"),
    });
    const [, args] = spawn.mock.calls[0] ?? [];
    expect(args).toContain("-sound");
    expect(args?.[args.indexOf("-sound") + 1]).toBe("Hero");
  });

  it("spawn throwing synchronously does NOT cause fire() to reject", async () => {
    const io = makeBufferIO();
    const spawn = vi.fn<DesktopSpawnFn>().mockImplementation(() => {
      throw new Error("EACCES");
    });
    const which = vi.fn<DesktopWhichFn>().mockReturnValue("/usr/local/bin/terminal-notifier");
    const s = createDesktopSurface({ io, spawn, which });
    await expect(
      s.fire({ topic: "volley/default/alpha/status", envelope: envelopeFor("alpha", "reaped") }),
    ).resolves.toBeUndefined();
    expect(io.readStderr()).toContain("EACCES");
  });

  it("surface name is 'desktop'", () => {
    const io = makeBufferIO();
    const s = createDesktopSurface({
      io,
      spawn: vi.fn<DesktopSpawnFn>(),
      which: vi.fn<DesktopWhichFn>().mockReturnValue(null),
    });
    expect(s.name).toBe("desktop");
  });
});
