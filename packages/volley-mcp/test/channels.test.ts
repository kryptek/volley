import { describe, expect, it } from "vitest";
import {
  channelConfigFor,
  isReservedChannel,
  isReservedChannelPath,
  isUserChannel,
} from "../src/channels";

describe("channels", () => {
  it("maps each reserved channel to its SPEC §4.1 QoS/retain", () => {
    expect(channelConfigFor("status")).toEqual({ qos: 1, retain: true });
    expect(channelConfigFor("progress")).toEqual({ qos: 0, retain: false });
    expect(channelConfigFor("mailbox")).toEqual({ qos: 1, retain: false });
    expect(channelConfigFor("control")).toEqual({ qos: 1, retain: false });
    expect(channelConfigFor("result")).toEqual({ qos: 1, retain: true });
    expect(channelConfigFor("capability")).toEqual({ qos: 1, retain: true });
  });
  it("treats a valid _user/* channel as fire-and-forget", () => {
    expect(channelConfigFor("_user/metrics")).toEqual({ qos: 0, retain: false });
  });
  it("returns null for an unknown or malformed channel", () => {
    expect(channelConfigFor("bogus")).toBeNull();
    expect(channelConfigFor("_user/")).toBeNull();
    expect(channelConfigFor("_user/Bad Name")).toBeNull();
    expect(channelConfigFor("_system/registry")).toBeNull();
  });
  it("discriminates reserved vs user channels", () => {
    expect(isReservedChannel("status")).toBe(true);
    expect(isReservedChannel("_user/x")).toBe(false);
    expect(isUserChannel("_user/x")).toBe(true);
    expect(isUserChannel("status")).toBe(false);
  });
  it("flags reserved-namespace channel paths (_system/* and _meta/*)", () => {
    expect(isReservedChannelPath("_system/registry")).toBe(true);
    expect(isReservedChannelPath("_meta/cli/will")).toBe(true);
    expect(isReservedChannelPath("_user/metrics")).toBe(false);
    expect(isReservedChannelPath("status")).toBe(false);
    expect(isReservedChannelPath("")).toBe(false);
  });
});
