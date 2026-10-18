import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDecisions } from "../src/attention";
import { initialState, reduceAll } from "../src/store/reducer";
import { DECISION_KINDS, type DeskMessage, type Envelope } from "../src/store/types";

const SPEC = path.resolve(__dirname, "../../../spec");
const json = (p: string) => JSON.parse(readFileSync(path.join(SPEC, p), "utf8"));

/** `decision.schema.json`'s payload.kind enum. */
function schemaKinds(): string[] {
  const schema = json("schemas/decision.schema.json");
  for (const part of schema.allOf ?? []) {
    const kinds = part?.properties?.payload?.properties?.kind?.enum;
    if (Array.isArray(kinds)) return kinds;
  }
  throw new Error("decision.schema.json: no payload.kind enum");
}

function opened(kind: string, i: number): DeskMessage {
  const base = json("examples/valid/decision-merge-conflict.json") as Envelope;
  const id = `w1-d${i}`;
  return {
    topic: `volley/_waves/w1/decisions/${id}`,
    receivedAt: 1_000,
    envelope: {
      ...base,
      payload: { ...(base.payload as object), decision_id: id, wave: "w1", kind },
    } as Envelope,
  };
}

describe("decision kinds", () => {
  it("the Desk's DecisionPayload kinds are exactly the schema's", () => {
    expect([...DECISION_KINDS].sort()).toEqual([...schemaKinds()].sort());
  });

  it("accepts every schema kind, and a kind it does not know yet, as an open decision", () => {
    const kinds = [...schemaKinds(), "some_future_kind"];
    const s = reduceAll(
      initialState(),
      kinds.map((k, i) => opened(k, i)),
    );
    const open = openDecisions(s.waves.w1);
    expect(open.map((d) => d.kind).sort()).toEqual([...kinds].sort());
    for (const d of open) expect(d.question.length).toBeGreaterThan(0);
  });

  it("keeps the repo_untrusted example", () => {
    const env = json("examples/valid/decision-repo-untrusted.json") as Envelope;
    const p = env.payload as { wave: string; decision_id: string };
    const s = reduceAll(initialState(), [
      { topic: `volley/_waves/${p.wave}/decisions/${p.decision_id}`, envelope: env, receivedAt: 1 },
    ]);
    expect(s.waves[p.wave]?.decisions[p.decision_id]?.kind).toBe("repo_untrusted");
  });
});
