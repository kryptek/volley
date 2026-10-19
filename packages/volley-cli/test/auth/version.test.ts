import { describe, expect, it } from "vitest";
import {
  BrokerVersionError,
  INSTALL_INSTRUCTIONS,
  checkBrokerVersion,
  detectBrokerVersion,
  parseBrokerVersion,
  requireBrokerVersion,
} from "../../src/auth/version";

describe("parseBrokerVersion", () => {
  it("reads $SYS/broker/version and `mosquitto -h` text", () => {
    expect(parseBrokerVersion("mosquitto version 2.1.2")).toEqual([2, 1, 2]);
    expect(parseBrokerVersion("mosquitto version 2.0.22\n\nmosquitto is an MQTT broker")).toEqual([
      2, 0, 22,
    ]);
    expect(parseBrokerVersion("2.1")).toEqual([2, 1, 0]);
    expect(parseBrokerVersion("no version here")).toBeNull();
  });
});

describe("checkBrokerVersion", () => {
  it("2.0.22 → BROKER_TOO_OLD with the brew / snap / container instructions", () => {
    const r = checkBrokerVersion("mosquitto version 2.0.22");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("BROKER_TOO_OLD");
    expect(r.message).toContain("2.0.22");
    expect(r.message).toContain("brew install mosquitto");
    expect(r.message).toContain("sudo snap install mosquitto");
    expect(r.message).toContain("/var/snap/mosquitto/common/");
    expect(r.message).toContain("eclipse-mosquitto:2.1");
  });

  it("2.1.2 and 3.0.0 proceed", () => {
    expect(checkBrokerVersion("mosquitto version 2.1.2")).toEqual({ ok: true, version: "2.1.2" });
    expect(checkBrokerVersion("3.0.0").ok).toBe(true);
  });

  it("an unparseable version is refused as unknown, with the same instructions", () => {
    const r = checkBrokerVersion("garbage");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("BROKER_VERSION_UNKNOWN");
      expect(r.message).toContain(INSTALL_INSTRUCTIONS);
    }
  });
});

describe("detectBrokerVersion", () => {
  it("prefers the retained $SYS/broker/version; `mosquitto -h` is not run", async () => {
    let ran = false;
    const v = await detectBrokerVersion({
      sys: async () => "mosquitto version 2.1.2",
      binary: async () => {
        ran = true;
        return "mosquitto version 2.0.22";
      },
    });
    expect(v).toEqual({ version: "mosquitto version 2.1.2", source: "$SYS/broker/version" });
    expect(ran).toBe(false);
  });

  it("no retained version → falls back to `mosquitto -h`", async () => {
    const v = await detectBrokerVersion({
      sys: async () => null,
      binary: async () => "mosquitto version 2.1.2\n\nmosquitto is an MQTT v5.0/v3.1.1 broker.",
    });
    expect(v?.source).toBe("mosquitto -h");
    expect(v?.version).toContain("2.1.2");
  });

  it("a probe that throws counts as no answer", async () => {
    const v = await detectBrokerVersion({
      sys: async () => {
        throw new Error("not authorised");
      },
      binary: async () => null,
    });
    expect(v).toBeNull();
  });
});

describe("requireBrokerVersion", () => {
  it("throws BrokerVersionError(BROKER_TOO_OLD) for 2.0.22", async () => {
    const err = await requireBrokerVersion({ sys: async () => "mosquitto version 2.0.22" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BrokerVersionError);
    expect((err as BrokerVersionError).code).toBe("BROKER_TOO_OLD");
  });

  it("resolves with the version for 2.1.2", async () => {
    await expect(
      requireBrokerVersion({ sys: async () => "mosquitto version 2.1.2" }),
    ).resolves.toBe("2.1.2");
  });
});
