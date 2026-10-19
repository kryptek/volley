/**
 * The broker version Volley's broker auth needs, shared by `volley auth` and volleyd.
 *
 * Volley's broker auth runs on mosquitto's Dynamic Security plugin with static shared roles whose
 * ACLs use `%u` (the client's username). mosquitto substitutes `%u` / `%c` in Dynamic Security
 * ACLs only from 2.1.0 on; on 2.0.x the pattern matches the literal string `%u`, so every
 * per-agent grant would silently deny. A broker older than 2.1 is therefore refused, before
 * anything is changed.
 */

export const MIN_BROKER_VERSION = [2, 1, 0] as const;

export type BrokerVersionCode = "BROKER_TOO_OLD" | "BROKER_VERSION_UNKNOWN";

/** How to get a 2.1 broker on each supported platform (README: examples/mosquitto-auth/). */
export const INSTALL_INSTRUCTIONS = [
  "Install mosquitto 2.1 or newer:",
  "  macOS:     brew install mosquitto   (or: brew upgrade mosquitto)",
  "  Linux:     sudo snap install mosquitto",
  "             config under /var/snap/mosquitto/common/, plugin at",
  "             /snap/mosquitto/current/usr/lib/<arch>/mosquitto_dynamic_security.so; the",
  "             dynamic-security.json state file must live under /var/snap/mosquitto/common/",
  "             (snap confinement). Distribution packages may still ship 2.0.x.",
  "  Container: docker run eclipse-mosquitto:2.1",
].join("\n");

/** `[major, minor, patch]` from `mosquitto version 2.1.2`, `2.0.22`, `mosquitto -h` output… */
export function parseBrokerVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

export type VersionCheck =
  | { ok: true; version: string }
  | { ok: false; code: BrokerVersionCode; message: string };

/** Whether the broker that reported `text` is new enough. */
export function checkBrokerVersion(text: string): VersionCheck {
  const v = parseBrokerVersion(text);
  if (v === null) {
    return {
      ok: false,
      code: "BROKER_VERSION_UNKNOWN",
      message: `could not tell the broker's version (got ${JSON.stringify(text.trim().slice(0, 80))}); Volley needs mosquitto >= 2.1.\n${INSTALL_INSTRUCTIONS}`,
    };
  }
  const version = v.join(".");
  for (let i = 0; i < 3; i++) {
    const have = v[i] as number;
    const need = MIN_BROKER_VERSION[i] as number;
    if (have > need) break;
    if (have < need) {
      return {
        ok: false,
        code: "BROKER_TOO_OLD",
        message: `the broker is mosquitto ${version}; Volley's broker auth needs mosquitto >= 2.1 (Dynamic Security substitutes %u in role ACLs only from 2.1 on).\n${INSTALL_INSTRUCTIONS}`,
      };
    }
  }
  return { ok: true, version };
}

/** Where a version can come from, most authoritative first. Each resolves null when it has none. */
export interface VersionProbes {
  /** The running broker's retained `$SYS/broker/version`. */
  sys?: () => Promise<string | null>;
  /** `mosquitto -h` on this machine (the binary, which may not be the running broker). */
  binary?: () => Promise<string | null>;
}

export interface DetectedVersion {
  version: string;
  source: "$SYS/broker/version" | "mosquitto -h";
}

/** The broker's version text: retained `$SYS/broker/version` first, else `mosquitto -h`. */
export async function detectBrokerVersion(probes: VersionProbes): Promise<DetectedVersion | null> {
  const attempt = async (p: (() => Promise<string | null>) | undefined) => {
    if (p === undefined) return null;
    try {
      const v = await p();
      return v !== null && v.trim() !== "" ? v.trim() : null;
    } catch {
      return null;
    }
  };
  const sys = await attempt(probes.sys);
  if (sys !== null) return { version: sys, source: "$SYS/broker/version" };
  const bin = await attempt(probes.binary);
  if (bin !== null) return { version: bin, source: "mosquitto -h" };
  return null;
}

export class BrokerVersionError extends Error {
  constructor(
    readonly code: BrokerVersionCode,
    message: string,
  ) {
    super(message);
    this.name = "BrokerVersionError";
  }
}

/** Detect and check the broker version; throws BrokerVersionError, else the `x.y.z` version. */
export async function requireBrokerVersion(probes: VersionProbes): Promise<string> {
  const found = await detectBrokerVersion(probes);
  if (found === null) {
    throw new BrokerVersionError(
      "BROKER_VERSION_UNKNOWN",
      `could not read the broker's version (no retained $SYS/broker/version, no \`mosquitto -h\`); Volley needs mosquitto >= 2.1.\n${INSTALL_INSTRUCTIONS}`,
    );
  }
  const r = checkBrokerVersion(found.version);
  if (!r.ok) throw new BrokerVersionError(r.code, r.message);
  return r.version;
}
