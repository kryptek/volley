import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DESK_SUBSCRIPTIONS } from "../src/store/mqtt-client";
import { initialState, reduceAll, resync, routeTopic } from "../src/store/reducer";
import {
  type DeskMessage,
  type Envelope,
  INBOX_KINDS,
  INBOX_WHERE_KINDS,
  type InboxItem,
} from "../src/store/types";

const SPEC = path.resolve(__dirname, "../../../spec");
const json = (p: string) => JSON.parse(readFileSync(path.join(SPEC, p), "utf8"));
const schema = json("schemas/inbox-item.schema.json");
const payloadSchema = () => {
  for (const part of schema.allOf ?? [])
    if (part?.properties?.payload) return part.properties.payload;
  throw new Error("inbox-item.schema.json: no payload");
};

const msg = (file: string, over: Partial<Envelope> = {}): DeskMessage => {
  const env = { ...(json(`examples/valid/${file}`) as Envelope), ...over };
  return {
    topic: `volley/_inbox/${(env.payload as InboxItem).id}`,
    receivedAt: 1_000,
    envelope: env,
  };
};

describe("the Desk's inbox types mirror inbox-item.schema.json", () => {
  it("kinds and where kinds are exactly the schema's", () => {
    expect([...INBOX_KINDS].sort()).toEqual([...payloadSchema().properties.kind.enum].sort());
    expect([...INBOX_WHERE_KINDS].sort()).toEqual(
      [...schema.$defs.where.properties.kind.enum].sort(),
    );
  });

  it("InboxItem's fields are the schema's payload properties", () => {
    // Every key of the examples is a property the Desk type names (compile-time: InboxItem).
    const keys: (keyof InboxItem)[] = [
      "id",
      "kind",
      "version",
      "owner_only",
      "wave",
      "task",
      "agent_id",
      "title",
      "question",
      "options",
      "allow_other",
      "multi",
      "pointers",
      "opened_at",
      "source",
      "answered",
      "held",
    ];
    expect([...keys].sort()).toEqual(Object.keys(payloadSchema().properties).sort());
  });
});

describe("the store's inbox", () => {
  it("subscribes to volley/_inbox/+ and routes it", () => {
    expect(DESK_SUBSCRIPTIONS).toContain("volley/_inbox/+");
    expect(routeTopic("volley/_inbox/d-w1-d-abc")).toEqual({ kind: "inbox", id: "d-w1-d-abc" });
    expect(routeTopic("volley/_inbox/a/b")).toBeNull();
  });

  it("keeps volleyd's items by id; an answered one replaces it; a clear forgets it", () => {
    const open = msg("inbox-decision.json");
    const id = (open.envelope?.payload as InboxItem).id;
    let s = reduceAll(initialState(), [open, msg("inbox-picker.json")]);
    expect(Object.keys(s.inbox ?? {}).sort()).toEqual([id, "p-coord-a1b2c3-toolu_01AbCdEf"].sort());
    s = reduceAll(s, [msg("inbox-answered.json")]);
    expect(s.inbox?.[id]?.answered?.where).toEqual({ kind: "desk", device: "phone" });
    s = reduceAll(s, [{ topic: `volley/_inbox/${id}`, receivedAt: 2_000, envelope: null }]);
    expect(s.inbox?.[id]).toBeUndefined();
  });

  it("ignores an item not from volleyd, or not naming its topic's id", () => {
    const forged = msg("inbox-decision.json", { agent_id: "someone" });
    const wrong = { ...msg("inbox-decision.json"), topic: "volley/_inbox/d-w1-other" };
    const s = reduceAll(initialState(), [forged, wrong]);
    expect(s.inbox ?? {}).toEqual({});
  });

  it("a resync drops the items until the retained replay brings them back", () => {
    const s = reduceAll(initialState(), [msg("inbox-decision.json")]);
    expect(resync(s).inbox).toEqual({});
  });
});
