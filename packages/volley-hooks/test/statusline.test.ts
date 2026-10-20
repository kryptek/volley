import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VolleyBroker } from "volley-mcp/broker";
import {
  STATUSLINE_TIMEOUT_MS,
  type UsagePayload,
  shouldPublish,
  statusText,
  usageSample,
} from "../src/statusline/publish";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import {
  PACKAGE_ROOT,
  collect,
  connectClient,
  makeWorkdir,
  retainedEnvelope,
  runScript,
} from "./helpers/hooks";
import { tempDir } from "./helpers/tmp";

const AGENT = "w1-t1-implementer-1";
const USAGE_TOPIC = `volley/default/${AGENT}/usage`;
const SCRIPT = join("src", "statusline", "publish.ts");

const sample = (name = "statusline.json") =>
  JSON.parse(readFileSync(join(PACKAGE_ROOT, "test", "fixtures", name), "utf-8")) as Record<
    string,
    unknown
  >;

/** The O0 sample with the 5-hour window at `pct`. */
function withFiveHour(pct: number): Record<string, unknown> {
  const s = sample();
  const limits = s.rate_limits as { five_hour: { used_percentage: number } };
  limits.five_hour.used_percentage = pct;
  return s;
}

describe("usageSample", () => {
  it("maps Claude Code's statusLine JSON to the usage payload", () => {
    const at = new Date("2026-10-18T14:06:00.000Z");
    expect(usageSample(sample(), { account: "work" }, at)).toEqual({
      account: "work",
      model: "claude-haiku-5-5",
      context_window: { used_percentage: 4, used: 38427, size: 1000000 },
      rate_limits: {
        five_hour: { pct: 11, resets_at: new Date(1792375800 * 1000).toISOString() },
        weekly: { pct: 43, resets_at: new Date(1792371600 * 1000).toISOString() },
      },
      captured_at: "2026-10-18T14:06:00.000Z",
    } satisfies UsagePayload);
  });

  it("keeps what a session-start sample does not have yet as null, and drops absent windows", () => {
    const p = usageSample(
      sample("statusline-session-start.json"),
      { account: null, configDir: "/path/to/profile" },
      new Date(0),
    );
    expect(p).toMatchObject({
      account: null,
      config_dir: "/path/to/profile",
      model: "claude-opus-5-5",
      context_window: { used_percentage: null, used: null, size: 1000000 },
      rate_limits: {},
    });
  });
});

describe("shouldPublish", () => {
  const base = usageSample(sample(), { account: "work" }, new Date(0));
  const moved = (pct: number): UsagePayload => ({
    ...base,
    rate_limits: { ...base.rate_limits, five_hour: { pct, resets_at: null } },
  });
  const t0 = 1_000_000;

  it("publishes the first sample", () => {
    expect(shouldPublish(null, base, t0)).toBe(true);
  });

  it("holds a sample within 15 s unless a percentage moved by more than one point", () => {
    const prev = { at: t0, payload: moved(11) };
    expect(shouldPublish(prev, moved(11), t0 + 5_000)).toBe(false);
    expect(shouldPublish(prev, moved(12), t0 + 5_000)).toBe(false);
    expect(shouldPublish(prev, moved(12.5), t0 + 5_000)).toBe(true);
    expect(shouldPublish(prev, { ...moved(11), account: "personal" }, t0 + 5_000)).toBe(true);
  });

  it("publishes again once 15 s have passed", () => {
    expect(shouldPublish({ at: t0, payload: base }, base, t0 + 15_000)).toBe(true);
  });
});

describe("statusText", () => {
  it("is one short line: model, context fill and the windows it knows", () => {
    expect(statusText(sample())).toBe("Haiku 5.5 · ctx 4% · 5h 11% · 7d 43%");
    expect(statusText(sample("statusline-session-start.json"))).toBe("Opus 5.5");
  });
});

describe("statusLine publisher (Aedes)", () => {
  let broker: TestBroker;
  let observer: VolleyBroker;
  let stateRoot: string;

  beforeEach(async () => {
    broker = await startTestBroker();
    observer = await connectClient(broker.url);
    stateRoot = tempDir("volley-hooks-state-");
  });

  afterEach(async () => {
    await observer.disconnect();
    await broker.close();
  });

  const run = (dir: string, input: Record<string, unknown>) =>
    runScript(SCRIPT, JSON.stringify({ ...input, cwd: dir }), {
      cwd: dir,
      env: { VOLLEY_HOOKS_STATE_DIR: stateRoot },
    });

  it("publishes a retained usage envelope, then throttles an unchanged sample", async () => {
    const dir = makeWorkdir({ agent_id: AGENT, broker_url: broker.url, claude_account: "work" });
    const seen = await collect(observer, USAGE_TOPIC);
    try {
      const first = await run(dir, sample());
      expect(first.exitCode).toBe(0);
      expect(first.stdout.trim()).toBe("Haiku 5.5 · ctx 4% · 5h 11% · 7d 43%");
      // the same sample again within 15 s: nothing new on the topic
      await run(dir, sample());
      // a > 1 pt move of the 5-hour window: published at once
      await run(dir, withFiveHour(13));
      await new Promise((r) => setTimeout(r, 200));
      expect(
        seen.envelopes.map((e) => (e.payload as UsagePayload).rate_limits.five_hour?.pct),
      ).toEqual([11, 13]);
      // the retained value, as a client attaching late sees it
      const late = await connectClient(broker.url, "late-observer");
      try {
        expect(await retainedEnvelope(late, USAGE_TOPIC)).toMatchObject({
          agent_id: AGENT,
          channel: "usage",
          type: "usage",
          payload: {
            account: "work",
            model: "claude-haiku-5-5",
            context_window: { used_percentage: 4, used: 38427, size: 1000000 },
            rate_limits: { five_hour: { pct: 13 }, weekly: { pct: 43 } },
          },
        });
      } finally {
        await late.disconnect();
      }
    } finally {
      await seen.stop();
    }
  }, 20_000);

  it("prints the chained statusLine command's output when the install saved one", async () => {
    const dir = makeWorkdir({ agent_id: AGENT, broker_url: broker.url });
    writeFileSync(
      join(stateRoot, "statusline-chain.json"),
      JSON.stringify({ type: "command", command: "cat >/dev/null; echo my own line" }),
    );
    const r = await run(dir, sample());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("my own line\n");
    // the account is unknown here (no claude_account, no CLAUDE_CONFIG_DIR: the primary)
    const env = await retainedEnvelope(observer, USAGE_TOPIC);
    expect((env.payload as UsagePayload).account).toBe("primary");
  }, 20_000);

  it("bounds a publish to an unreachable broker and still throttles the next attempt", async () => {
    const dead = await startTestBroker();
    await dead.close();
    const dir = makeWorkdir({ agent_id: AGENT, broker_url: dead.url });
    const r = await run(dir, sample());
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("Haiku 5.5 · ctx 4% · 5h 11% · 7d 43%");
    // well under the 10 s hook deadline: the status line is not held for a down broker
    expect(r.ms).toBeLessThan(STATUSLINE_TIMEOUT_MS + 2_000);
    // the attempt is recorded, so the next update within 15 s does not try again
    const last = JSON.parse(readFileSync(join(dir, ".volley", "usage.json"), "utf-8"));
    expect(last.payload.rate_limits.five_hour.pct).toBe(11);
  }, 20_000);

  it("prints the minimal line and publishes nothing without an identity", async () => {
    const dir = makeWorkdir();
    const r = await run(dir, sample());
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("Haiku 5.5 · ctx 4% · 5h 11% · 7d 43%");
    expect(await observer.queryRetained(USAGE_TOPIC, 300)).toBeNull();
  }, 20_000);
});
