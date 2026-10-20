/** `steerSounds`: steering_sent at the PUBACK, steering_delivered at the first of delivered or acked. */
import { describe, expect, it } from "vitest";
import type { SentSteer } from "../src/steer/ackState";
import { steerSounds } from "../src/steer/useSteering";
import { initialState } from "../src/store/reducer";
import type { DeskState } from "../src/store/types";

const msg = (over: Partial<SentSteer> = {}): SentSteer => ({
  id: "m1",
  target: "a1",
  namespace: "default",
  coordinator: false,
  type: "steering",
  text: "hi",
  seq: 1,
  sentAt: 0,
  puback: false,
  ...over,
});

const withReceipts = (acks: string[], applied: string[] = []): DeskState => ({
  ...initialState(),
  steering: {
    acks: Object.fromEntries(acks.map((id) => [id, { a1: 1 }])),
    applied: Object.fromEntries(applied.map((id) => [id, { a1: 2 }])),
    replies: {},
    signals: {},
  },
});

describe("steerSounds", () => {
  it("sounds each step once, in order", () => {
    const heard = new Map<string, number>();
    expect(steerSounds([msg()], initialState(), heard)).toEqual([]);
    expect(steerSounds([msg({ puback: true })], initialState(), heard)).toEqual(["steering_sent"]);
    expect(steerSounds([msg({ puback: true })], initialState(), heard)).toEqual([]);
    expect(steerSounds([msg({ puback: true })], withReceipts(["m1"]), heard)).toEqual([
      "steering_delivered",
    ]);
    // Acked after delivered: nothing new.
    expect(steerSounds([msg({ puback: true })], withReceipts(["m1"], ["m1"]), heard)).toEqual([]);
  });

  it("a message delivered at once sounds only delivered", () => {
    expect(steerSounds([msg({ puback: true })], withReceipts(["m1"]), new Map())).toEqual([
      "steering_delivered",
    ]);
  });
});
