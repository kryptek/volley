import { readFileSync } from "node:fs";
import path from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DESK_SUBSCRIPTIONS } from "../src/store/mqtt-client";
import { initialState, reduceAll, resync, routeTopic } from "../src/store/reducer";
import type {
  DeskMessage,
  DigestPayload,
  Envelope,
  WaveStatePayload,
  WaveView,
} from "../src/store/types";
import { DigestCard, showDigest } from "../src/windows/wave/DigestCard";

const SPEC = path.resolve(__dirname, "../../../spec");
const json = (p: string) => JSON.parse(readFileSync(path.join(SPEC, p), "utf8"));
const schema = json("schemas/digest.schema.json");

const example = (file: string) => json(`examples/valid/${file}`) as Envelope;
const complete = example("digest-complete.json");
const escalation = example("digest-escalation.json");
const WAVE = (complete.payload as DigestPayload).wave;

const msg = (env: Envelope | null, over: Partial<Envelope> = {}): DeskMessage => ({
  topic: `volley/_waves/${WAVE}/digest`,
  receivedAt: 1_000,
  envelope: env === null ? null : { ...env, ...over },
});

const waveView = (status: WaveStatePayload["status"], open: string[]): WaveView => ({
  id: WAVE,
  receivedAt: 1_000,
  decisions: {},
  state: {
    wave: WAVE,
    version: 1,
    owner: "coord-a",
    repo: "example-org/example-repo",
    release_branch: `release/${WAVE}`,
    status,
    tasks: [],
    open_decisions: open,
    gates: [],
    updated_at: "2026-10-21T07:00:00.000Z",
  } as WaveStatePayload,
});

describe("the Desk's DigestPayload mirrors digest.schema.json", () => {
  it("names every payload property", () => {
    const keys: (keyof DigestPayload)[] = [
      "wave",
      "release_branch",
      "generated_at",
      "trigger",
      "shipped",
      "auto",
      "waiting",
      "release",
      "failures",
    ];
    expect([...keys].sort()).toEqual(Object.keys(schema.$defs.digest.properties).sort());
  });
});

describe("the store's digests", () => {
  it("subscribes to volley/_waves/+/digest and keeps volleyd's digest by wave; a clear forgets it", () => {
    expect(DESK_SUBSCRIPTIONS).toContain("volley/_waves/+/digest");
    expect(routeTopic(`volley/_waves/${WAVE}/digest`)).toEqual({ kind: "digest", wave: WAVE });
    let s = reduceAll(initialState(), [msg(complete)]);
    expect(s.digests?.[WAVE]?.trigger).toBe("release_go");
    s = reduceAll(s, [msg(null)]);
    expect(s.digests?.[WAVE]).toBeUndefined();
  });

  it("ignores a digest not from volleyd, or naming another wave", () => {
    const forged = msg(complete, { agent_id: "someone" });
    const other = { ...msg(complete), topic: "volley/_waves/other-wave/digest" };
    expect(reduceAll(initialState(), [forged, other]).digests ?? {}).toEqual({});
  });

  it("a resync drops them until the retained replay brings them back", () => {
    expect(resync(reduceAll(initialState(), [msg(complete)])).digests).toEqual({});
  });
});

describe("DigestCard", () => {
  it("renders the three sections, PR links and clickable decision ids", () => {
    const onOpenDecision = vi.fn();
    const d = complete.payload as DigestPayload;
    render(<DigestCard digest={d} onOpenDecision={onOpenDecision} />);
    const card = screen.getByRole("region", { name: "Morning digest" });
    expect(card).toHaveTextContent(
      `${WAVE} ready to release: 2 shipped, 1 flake fixed, 2 conflicts resolved, 1 retry, 4 decisions answered, 1 waiting for you (release_go)`,
    );
    for (const h of ["Shipped", "Autopilot handled", "Waiting for you"])
      expect(screen.getByRole("heading", { name: h })).toBeInTheDocument();
    const pr = screen.getByRole("link", { name: "PR #210" });
    expect(pr).toHaveAttribute("href", "https://github.com/example-org/example-repo/pull/210");
    expect(card).toHaveTextContent("checkout flake");
    const id = d.waiting[0]?.id as string;
    fireEvent.click(screen.getByRole("button", { name: id }));
    expect(onOpenDecision).toHaveBeenCalledWith(id);
  });

  it("lists failures, and says when nothing is waiting", () => {
    const d = escalation.payload as DigestPayload;
    render(<DigestCard digest={{ ...d, waiting: [] }} />);
    expect(screen.getByText("Nothing is waiting for you.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Morning digest" })).toHaveTextContent(
      "T3: superseded by #212",
    );
  });
});

describe("showDigest", () => {
  const d = escalation.payload as DigestPayload;
  const id = d.waiting[0]?.id as string;

  it("shows for an ended wave, or while one of its waiting decisions is still open", () => {
    expect(showDigest(waveView("complete", []), d)).toBe(true);
    expect(showDigest(waveView("stopped", []), d)).toBe(true);
    expect(showDigest(waveView("running", [id]), d)).toBe(true);
  });

  it("is absent for a running wave with no escalation, or without a digest", () => {
    expect(showDigest(waveView("running", []), d)).toBe(false);
    expect(showDigest(waveView("running", ["d-other"]), d)).toBe(false);
    expect(showDigest(waveView("complete", []), undefined)).toBe(false);
  });
});
