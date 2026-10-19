import { describe, expect, it } from "vitest";
import { memoryOf, vmStatAvailablePct } from "../../src/peer/checks/machine";
import { MAC_16GB_BYTES, VM_STAT_MAC_16GB } from "../fixtures/vm-stat";

describe("available memory: one definition on every machine", () => {
  it("macOS: free + inactive + speculative + purgeable pages over total memory", () => {
    expect(vmStatAvailablePct(VM_STAT_MAC_16GB, MAC_16GB_BYTES)).toBe(45);
    // Free pages alone (what os.freemem() reports on macOS) would read 3%.
    expect(memoryOf(MAC_16GB_BYTES, 31457 * 16384).available_pct).toBe(3);
  });

  it("missing lines count as 0 pages; output without a page size or free pages is not vm_stat", () => {
    const four =
      "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 1048576.\n";
    expect(vmStatAvailablePct(four, MAC_16GB_BYTES)).toBe(25);
    expect(vmStatAvailablePct("Pages free: 10.\n", MAC_16GB_BYTES)).toBeNull();
    expect(vmStatAvailablePct("(page size of 4096 bytes)\n", MAC_16GB_BYTES)).toBeNull();
    expect(vmStatAvailablePct(four, 0)).toBeNull();
  });

  it("never reads over 100%", () => {
    const big = "(page size of 16384 bytes)\nPages free: 9999999.\n";
    expect(vmStatAvailablePct(big, MAC_16GB_BYTES)).toBe(100);
  });

  it("memoryOf takes the macOS figure when given, else free over total (Linux: MemAvailable)", () => {
    expect(memoryOf(MAC_16GB_BYTES, 0, 45)).toEqual({ total_mb: 16384, available_pct: 45 });
    expect(memoryOf(MAC_16GB_BYTES, MAC_16GB_BYTES / 4)).toEqual({
      total_mb: 16384,
      available_pct: 25,
    });
  });
});
