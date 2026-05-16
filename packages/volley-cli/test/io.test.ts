import { describe, expect, it } from "vitest";
import { makeBufferIO } from "../src/io";

describe("makeBufferIO", () => {
  it("appends to in-memory stdout/stderr buffers and returns concatenated strings", () => {
    const io = makeBufferIO();
    io.stdout("hello");
    io.stdout(" world\n");
    io.stderr("boom\n");
    expect(io.readStdout()).toBe("hello world\n");
    expect(io.readStderr()).toBe("boom\n");
  });

  it("returns a fixed wall_time when given a frozen clock", () => {
    const io = makeBufferIO({ now: () => new Date("2026-05-14T02:11:23.000Z") });
    expect(io.now().toISOString()).toBe("2026-05-14T02:11:23.000Z");
  });
});
