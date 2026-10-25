import { describe, expect, it } from "vitest";
import { POWER_SUPPLY_DIR, isLaptop } from "../../src/machine/laptop";

describe("isLaptop: a battery is present", () => {
  it("Linux: a /sys/class/power_supply/BAT* entry", () => {
    expect(POWER_SUPPLY_DIR).toBe("/sys/class/power_supply");
    expect(isLaptop({ platform: "linux", powerSupplies: ["AC", "BAT0"] })).toBe(true);
    expect(
      isLaptop({ platform: "linux", powerSupplies: ["AC", "ucsi-source-psy-USBC000:001"] }),
    ).toBe(false);
    expect(isLaptop({ platform: "linux", powerSupplies: [] })).toBe(false);
    expect(isLaptop({ platform: "linux" })).toBe(false);
  });

  it("macOS: pmset -g batt mentions InternalBattery", () => {
    const mac =
      "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234)\t100%; charged; 0:00 remaining present: true\n";
    const mini = "Now drawing from 'AC Power'\n";
    expect(isLaptop({ platform: "darwin", pmsetOutput: mac })).toBe(true);
    expect(isLaptop({ platform: "darwin", pmsetOutput: mini })).toBe(false);
    expect(isLaptop({ platform: "darwin" })).toBe(false);
  });

  it("other platforms: never", () => {
    expect(isLaptop({ platform: "win32", powerSupplies: ["BAT0"] })).toBe(false);
  });
});
