/**
 * Whether a machine is a laptop (it sleeps and travels): a battery is present. Shared by the
 * machine records `volley peer run` and volleyd publish (`laptop`, machine.schema.json), so both
 * agree; the coordinator role refuses a laptop by default (SPEC §4.6.25).
 */

/** Linux lists its power supplies here; a battery's entry is `BAT<n>`. */
export const POWER_SUPPLY_DIR = "/sys/class/power_supply";

/** macOS: `pmset -g batt`, whose output names `InternalBattery` when the machine has one. */
export const PMSET_BATT_ARGV: readonly string[] = ["pmset", "-g", "batt"];

export interface LaptopFacts {
  platform: string;
  /** Linux: the entries of POWER_SUPPLY_DIR (absent: unreadable). */
  powerSupplies?: readonly string[];
  /** macOS: what `pmset -g batt` printed (absent: it did not run). */
  pmsetOutput?: string;
}

export function isLaptop(f: LaptopFacts): boolean {
  if (f.platform === "linux") return (f.powerSupplies ?? []).some((e) => /^BAT[0-9]*$/.test(e));
  if (f.platform === "darwin") return /InternalBattery/.test(f.pmsetOutput ?? "");
  return false;
}
