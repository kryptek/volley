import { describe, expect, it } from "vitest";
import { buildEnvelope } from "volley-mcp/envelope";
import { createBellSurface } from "../../../../src/commands/notify/surfaces/bell";
import { makeBufferIO } from "../../../../src/io";

describe("bell surface", () => {
  it("writes BEL to stdout and a formatted line to stderr", async () => {
    const io = makeBufferIO();
    const s = createBellSurface(io);
    const envelope = buildEnvelope({
      agentId: "alpha",
      parentId: null,
      channel: "status",
      type: "blocked",
      now: () => new Date("2026-05-16T00:00:00Z"),
    });
    await s.fire({ topic: "volley/default/alpha/status", envelope });
    expect(io.readStdout()).toBe("\x07");
    expect(io.readStderr()).toContain("[notify] alpha → blocked");
    expect(io.readStderr()).toContain("volley/default/alpha/status");
  });

  it("surface name is 'bell'", () => {
    expect(createBellSurface(makeBufferIO()).name).toBe("bell");
  });
});
