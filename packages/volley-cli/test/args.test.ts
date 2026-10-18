import { describe, expect, it } from "vitest";
import {
  parseCsv,
  parseGlobal,
  parseJsonPayload,
  parseLifecycleEventCsv,
  parsePositiveInt,
  parseSurfaceCsv,
  resolveAuth,
  resolveBrokerUrl,
  resolveNamespace,
  resolveWebhookUrl,
} from "../src/args";

describe("parseGlobal", () => {
  it("splits the first positional as the subcommand", () => {
    expect(parseGlobal(["pub", "--agent-id", "x"])).toEqual({
      subcommand: "pub",
      rest: ["--agent-id", "x"],
    });
  });
  it("returns a null subcommand on empty argv (caller prints help)", () => {
    expect(parseGlobal([])).toEqual({ subcommand: null, rest: [] });
  });
  it("treats --help as a subcommand of its own so cli.ts can intercept it", () => {
    expect(parseGlobal(["--help"])).toEqual({ subcommand: "--help", rest: [] });
    expect(parseGlobal(["--version"])).toEqual({ subcommand: "--version", rest: [] });
  });
});

describe("parseCsv", () => {
  it("splits on commas, trims, and drops empties", () => {
    expect(parseCsv("done, blocked,failed,, reaped")).toEqual([
      "done",
      "blocked",
      "failed",
      "reaped",
    ]);
  });
  it("returns the empty array on undefined or empty input", () => {
    expect(parseCsv(undefined)).toEqual([]);
    expect(parseCsv("")).toEqual([]);
  });
});

describe("parsePositiveInt", () => {
  it("parses positive integer strings", () => {
    expect(parsePositiveInt("30")).toBe(30);
    expect(parsePositiveInt("1")).toBe(1);
  });
  it("throws on zero, negative, NaN, or non-integer", () => {
    expect(() => parsePositiveInt("0")).toThrow(/positive integer/);
    expect(() => parsePositiveInt("-1")).toThrow(/positive integer/);
    expect(() => parsePositiveInt("abc")).toThrow(/positive integer/);
    expect(() => parsePositiveInt("3.5")).toThrow(/positive integer/);
  });
  it("prefixes the error message with the flag name when given", () => {
    expect(() => parsePositiveInt("abc", "--timeout")).toThrow(
      /^--timeout must be a positive integer/,
    );
  });
});

describe("parseJsonPayload", () => {
  it("returns the empty object on undefined", () => {
    expect(parseJsonPayload(undefined)).toEqual({});
  });
  it("parses a JSON object literal", () => {
    expect(parseJsonPayload('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });
  it("throws on non-object JSON or invalid JSON", () => {
    expect(() => parseJsonPayload("[1,2]")).toThrow(/JSON object/);
    expect(() => parseJsonPayload('"string"')).toThrow(/JSON object/);
    expect(() => parseJsonPayload("{ not json")).toThrow(/invalid JSON/);
  });
});

describe("resolveBrokerUrl / resolveNamespace", () => {
  it("prefers the flag value over the env var, falls back to the default", () => {
    expect(resolveBrokerUrl("mqtt://flag:1883", { VOLLEY_BROKER_URL: "mqtt://env:1883" })).toBe(
      "mqtt://flag:1883",
    );
    expect(resolveBrokerUrl(undefined, { VOLLEY_BROKER_URL: "mqtt://env:1883" })).toBe(
      "mqtt://env:1883",
    );
    expect(resolveBrokerUrl(undefined, {})).toBe("mqtt://localhost:1883");
  });
  it("resolves the namespace the same way and validates the grammar", () => {
    expect(resolveNamespace("ns-flag", { VOLLEY_NAMESPACE: "ns-env" })).toBe("ns-flag");
    expect(resolveNamespace(undefined, { VOLLEY_NAMESPACE: "ns-env" })).toBe("ns-env");
    expect(resolveNamespace(undefined, {})).toBe("default");
    expect(() => resolveNamespace("Bad Name", {})).toThrow(/namespace/);
  });
});

describe("parseLifecycleEventCsv", () => {
  it("parses a valid CSV of lifecycle types", () => {
    expect(parseLifecycleEventCsv("blocked,failed,reaped")).toEqual([
      "blocked",
      "failed",
      "reaped",
    ]);
    expect(parseLifecycleEventCsv("done")).toEqual(["done"]);
  });
  it("throws on empty input", () => {
    expect(() => parseLifecycleEventCsv("")).toThrow(/at least one lifecycle type/);
  });
  it("throws on unknown type, listing the valid types in the message", () => {
    expect(() => parseLifecycleEventCsv("garbage")).toThrow(/unknown lifecycle type "garbage"/);
    expect(() => parseLifecycleEventCsv("blocked,bogus")).toThrow(
      /spawning,working,done,blocked,failed,reaped,registered/,
    );
  });
});

describe("parseSurfaceCsv", () => {
  it("parses a valid CSV of surfaces", () => {
    expect(parseSurfaceCsv("bell,desktop,webhook")).toEqual(["bell", "desktop", "webhook"]);
    expect(parseSurfaceCsv("bell")).toEqual(["bell"]);
  });
  it("throws on empty input", () => {
    expect(() => parseSurfaceCsv("")).toThrow(/at least one surface/);
  });
  it("throws on unknown surface, listing the valid surfaces in the message", () => {
    expect(() => parseSurfaceCsv("zzz")).toThrow(/unknown surface "zzz"/);
    expect(() => parseSurfaceCsv("bell,zzz")).toThrow(/bell,desktop,webhook/);
  });
});

describe("resolveWebhookUrl", () => {
  it("prefers the flag value over the env var", () => {
    expect(
      resolveWebhookUrl("https://flag.example/x", {
        VOLLEY_NOTIFY_WEBHOOK_URL: "https://env.example/x",
      }),
    ).toBe("https://flag.example/x");
  });
  it("falls back to the env var when the flag is absent", () => {
    expect(
      resolveWebhookUrl(undefined, { VOLLEY_NOTIFY_WEBHOOK_URL: "https://env.example/x" }),
    ).toBe("https://env.example/x");
  });
  it("returns null when neither flag nor env is set", () => {
    expect(resolveWebhookUrl(undefined, {})).toBeNull();
  });
  it("throws on non-http(s) scheme", () => {
    expect(() => resolveWebhookUrl("file:///tmp/x", {})).toThrow(/http:\/\/ or https:\/\//);
    expect(() => resolveWebhookUrl("ftp://example.com", {})).toThrow(/http:\/\/ or https:\/\//);
  });
});

describe("resolveAuth", () => {
  const cwd = "/nonexistent-volley-cwd"; // no .volley/agent.json here
  it("flags win over VOLLEY_AUTH_*", () => {
    const env = { VOLLEY_AUTH_USERNAME: "coordinator", VOLLEY_AUTH_PASSWORD: "env-pw" };
    expect(resolveAuth({ username: "desk", password: "flag-pw" }, env, cwd)).toEqual({
      username: "desk",
      password: "flag-pw",
    });
  });
  it("--username alone takes the password from VOLLEY_AUTH_PASSWORD (the documented safe path)", () => {
    const env = { VOLLEY_AUTH_USERNAME: "coordinator", VOLLEY_AUTH_PASSWORD: "env-pw" };
    expect(resolveAuth({ username: "desk" }, env, cwd)).toEqual({
      username: "desk",
      password: "env-pw",
    });
    expect(resolveAuth({ username: "desk" }, {}, cwd)).toEqual({ username: "desk" });
  });
  it("falls back to VOLLEY_AUTH_*, then anonymous", () => {
    expect(
      resolveAuth({}, { VOLLEY_AUTH_USERNAME: "coordinator", VOLLEY_AUTH_PASSWORD: "p" }, cwd),
    ).toEqual({ username: "coordinator", password: "p" });
    expect(resolveAuth({}, {}, cwd)).toBeNull();
  });
  it("refuses --password without --username", () => {
    expect(() => resolveAuth({ password: "p" }, {}, cwd)).toThrow(/--password requires --username/);
  });
});
