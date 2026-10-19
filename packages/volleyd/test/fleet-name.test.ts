import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import { LOCAL_HOST, deriveMachineName, isMachineName, localMachineName } from "../src/fleet-name";
import { schemaErrors } from "./helpers/schema";

describe("fleet-name: the supervisor's own machine name (SPEC §4.6.15)", () => {
  it("derives the name from the first DNS label, lowercased", () => {
    expect(deriveMachineName("MacBook-Pro.local")).toBe("macbook-pro");
    expect(deriveMachineName("build01.example.org")).toBe("build01");
    expect(deriveMachineName("box_a")).toBe("box_a");
  });

  it("replaces characters outside [a-z0-9_-] and drops leading non-alphanumerics", () => {
    expect(deriveMachineName("Owner's iMac")).toBe("owner-s-imac");
    expect(deriveMachineName("--_box")).toBe("box");
  });

  it("cuts the name to 63 characters", () => {
    expect(deriveMachineName("a".repeat(80))).toBe("a".repeat(63));
  });

  it("an empty, reserved or fixed-identity result becomes `supervisor`", () => {
    for (const h of [
      "",
      ".",
      "---",
      "local",
      "LOCAL.lan",
      "auto",
      "volleyd",
      "desk",
      "coordinator",
    ])
      expect(deriveMachineName(h)).toBe("supervisor");
  });

  it("every derived name is a valid machine name (config.schema.json fleet.local_name)", () => {
    for (const h of ["MacBook-Pro.local", "", "--x", "ÜBER.box", "a".repeat(80), "local"]) {
      const name = deriveMachineName(h);
      expect(isMachineName(name)).toBe(true);
      expect(
        schemaErrors("config.schema.json#/$defs/tunables", { fleet: { local_name: name } }),
      ).toEqual([]);
    }
  });

  it("isMachineName follows the schema: [a-z0-9][a-z0-9_-]{0,62}, never local or auto", () => {
    expect(isMachineName("box-a")).toBe(true);
    expect(isMachineName("a".repeat(63))).toBe(true);
    expect(isMachineName("a".repeat(64))).toBe(false);
    expect(isMachineName("Box")).toBe(false);
    expect(isMachineName("-box")).toBe(false);
    expect(isMachineName("box.a")).toBe(false);
    expect(isMachineName(LOCAL_HOST)).toBe(false);
    expect(isMachineName("auto")).toBe(false);
  });

  it("localMachineName: a configured fleet.local_name wins; null or absent derives from the host name", () => {
    expect(localMachineName("studio", "MacBook-Pro.local")).toBe("studio");
    expect(localMachineName(null, "MacBook-Pro.local")).toBe("macbook-pro");
    expect(localMachineName(undefined, "MacBook-Pro.local")).toBe("macbook-pro");
    expect(localMachineName()).toBe(deriveMachineName(hostname()));
  });

  it("localMachineName: an invalid configured name falls back to the derived one", () => {
    expect(localMachineName("local", "MacBook-Pro.local")).toBe("macbook-pro");
    expect(localMachineName("Not Valid", "MacBook-Pro.local")).toBe("macbook-pro");
  });
});
