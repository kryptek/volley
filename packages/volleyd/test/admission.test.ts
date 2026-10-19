import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import {
  type AdmissionState,
  type HostAdmissionState,
  type Samples,
  decide,
  decideHost,
  emptyAdmissionState,
  foldHost,
  forHost,
  hostSamples,
  summaryPayload,
} from "../src/admission";
import { CONFIG_DEFAULTS } from "../src/config-defaults";
import { ADMISSION_TOPIC, waveStateTopic } from "../src/control";
import type { PressureReading } from "../src/daemon";
import { admit } from "../src/scheduler";
import type { AdmissionConfig, WaveState } from "../src/types";
import { eventually } from "./helpers/broker-wait";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { runCli } from "./helpers/run-cli";
import { envelope, schemaErrors } from "./helpers/schema";

const CFG: AdmissionConfig = { ...CONFIG_DEFAULTS.admission, hysteresis_samples: 3 };

const s = (value: number) => ({ ok: true, value, raw: String(value) });
const unknown = { ok: false, raw: "", error: "spawn cmux ENOENT" };

/** Every signal comfortably clear. */
const CALM: Samples = {
  memory_pressure: s(1),
  cmux_ping: s(40),
  containers: s(2),
  api_overload: s(0),
  ci_queue: s(1),
};

describe("decide: one signal over its threshold throttles starts", () => {
  const cases: [string, Samples, RegExp][] = [
    [
      "memory pressure 4",
      { memory_pressure: s(4) },
      /^memory pressure critical \(level 4 > max 2\)$/,
    ],
    ["memory pressure 2 is at the max: allowed", { memory_pressure: s(2) }, /^$/],
    ["cmux ping > 2 s", { cmux_ping: s(2500) }, /^cmux ping 2500 ms > 2000 ms$/],
    ["containers over max", { containers: s(21) }, /^21 containers running > max 20$/],
    ["API overload", { api_overload: s(4) }, /^4 API overload signals in 300 s > max 3$/],
    ["CI queue", { ci_queue: s(11) }, /^11 queued CI runs > max 10$/],
  ];
  for (const [name, over, reason] of cases) {
    it(name, () => {
      const v = decide({ ...CALM, ...over }, emptyAdmissionState(), CFG);
      if (reason.source === "^$") {
        expect(v.allow).toBe(Number.POSITIVE_INFINITY);
        expect(v.reasons).toEqual([]);
      } else {
        expect(v.allow).toBe(0);
        expect(v.reasons).toHaveLength(1);
        expect(v.reasons[0]).toMatch(reason);
      }
    });
  }

  it("all clear → no pressure limit, no reasons", () => {
    const v = decide(CALM, emptyAdmissionState(), CFG);
    expect(v).toMatchObject({ allow: Number.POSITIVE_INFINITY, reasons: [] });
    expect(v.signals.memory_pressure).toMatchObject({ state: "clear", value: 1, max: 2 });
  });

  it("an unmeasurable signal is unknown and never throttles", () => {
    const v = decide(
      { ...CALM, cmux_ping: unknown, ci_queue: undefined },
      emptyAdmissionState(),
      CFG,
    );
    expect(v.allow).toBe(Number.POSITIVE_INFINITY);
    expect(v.signals.cmux_ping).toEqual({ state: "unknown", error: "spawn cmux ENOENT" });
    expect(v.signals.ci_queue).toEqual({ state: "unknown" });
  });

  it("every breached signal is a reason", () => {
    const v = decide(
      { ...CALM, memory_pressure: s(4), cmux_ping: s(9000) },
      emptyAdmissionState(),
      CFG,
    );
    expect(v.reasons).toEqual([
      "memory pressure critical (level 4 > max 2)",
      "cmux ping 9000 ms > 2000 ms",
    ]);
  });
});

describe("decide: hysteresis", () => {
  it("needs hysteresis_samples consecutive clean samples before the allowance recovers", () => {
    let st: AdmissionState = emptyAdmissionState();
    const run = (samples: Samples) => {
      const v = decide(samples, st, CFG);
      st = v.state;
      return v;
    };
    expect(run({ ...CALM, cmux_ping: s(5000) }).allow).toBe(0);
    let v = run(CALM);
    expect(v.allow).toBe(0);
    expect(v.reasons).toEqual(["recovering: cmux ping clear for 1/3 samples"]);
    expect(v.signals.cmux_ping).toMatchObject({ state: "recovering", clean_samples: 1 });
    expect(run(CALM).reasons).toEqual(["recovering: cmux ping clear for 2/3 samples"]);
    v = run(CALM);
    expect(v.allow).toBe(Number.POSITIVE_INFINITY);
    expect(v.signals.cmux_ping?.state).toBe("clear");
  });

  it("a relapse during recovery restarts the count", () => {
    let st: AdmissionState = emptyAdmissionState();
    const run = (samples: Samples) => {
      const v = decide(samples, st, CFG);
      st = v.state;
      return v;
    };
    run({ ...CALM, memory_pressure: s(4) });
    run(CALM);
    run(CALM);
    expect(run({ ...CALM, memory_pressure: s(4) }).reasons).toEqual([
      "memory pressure critical (level 4 > max 2)",
    ]);
    expect(run(CALM).reasons).toEqual(["recovering: memory pressure clear for 1/3 samples"]);
  });

  it("an unknown sample on a tripped signal counts toward recovery and is reported as recovering", () => {
    const tripped = decide({ ...CALM, containers: s(50) }, emptyAdmissionState(), CFG).state;
    const v = decide({ ...CALM, containers: { ...unknown, error: "docker down" } }, tripped, CFG);
    expect(v.allow).toBe(0);
    expect(v.reasons).toEqual([
      "recovering: containers clear for 1/3 samples (last sample unknown)",
    ]);
    expect(v.signals.containers).toEqual({
      state: "recovering",
      max: 20,
      clean_samples: 1,
      error: "docker down",
    });
  });

  it("hysteresis_samples: 1 recovers on the first clean sample", () => {
    const one = { ...CFG, hysteresis_samples: 1 };
    const tripped = decide({ ...CALM, containers: s(50) }, emptyAdmissionState(), one).state;
    expect(decide(CALM, tripped, one).allow).toBe(Number.POSITIVE_INFINITY);
  });

  it("is pure: the input state is not mutated", () => {
    const st = emptyAdmissionState();
    const frozen = JSON.stringify(st);
    decide({ ...CALM, cmux_ping: s(5000) }, st, CFG);
    expect(JSON.stringify(st)).toBe(frozen);
  });
});

describe("decide + the T3 runaway fuse", () => {
  it("pressure reasons and ceiling/budget reasons are all preserved by admit()", () => {
    const v = decide({ ...CALM, memory_pressure: s(4) }, emptyAdmissionState(), CFG);
    const r = admit(["T1", "T2"], v, { live: 3, hardCeiling: 3, spawnsUsed: 6, spawnBudget: 6 });
    expect(r.admit).toEqual([]);
    expect(r.reasons).toEqual([
      "memory pressure critical (level 4 > max 2)",
      "hard ceiling reached: 3/3 live agents",
      "spawn budget exhausted: 6/6 spawns",
    ]);
  });

  it("an open verdict leaves the ceiling as the only limit", () => {
    const v = decide(CALM, emptyAdmissionState(), CFG);
    const r = admit(["T1", "T2", "T3"], v, {
      live: 0,
      hardCeiling: 2,
      spawnsUsed: 0,
      spawnBudget: 9,
    });
    expect(r).toEqual({ admit: ["T1", "T2"], reasons: ["hard ceiling reached: 2/2 live agents"] });
  });
});

describe("decide reads thresholds from the config it is given", () => {
  it("raising a threshold changes the next verdict (no restart, same samples)", () => {
    const hot = { ...CALM, cmux_ping: s(2500) };
    const before = decide(hot, emptyAdmissionState(), CFG);
    expect(before.allow).toBe(0);
    const after = decide(hot, emptyAdmissionState(), { ...CFG, cmux_ping_max_ms: 3000 });
    expect(after.allow).toBe(Number.POSITIVE_INFINITY);
  });

  it("lowering a threshold throttles on the next verdict", () => {
    const v = decide(CALM, emptyAdmissionState(), { ...CFG, container_max: 1 });
    expect(v.reasons).toEqual(["2 containers running > max 1"]);
  });
});

describe("per-host admission (SPEC §4.6.15)", () => {
  const T = {
    mem_available_min_pct: CONFIG_DEFAULTS.placement.mem_available_min_pct,
    load_per_core_max: CONFIG_DEFAULTS.placement.load_per_core_max,
    hysteresis_samples: 3,
  };
  const rec = (available_pct: number, load1 = 2) => ({
    cores: 16,
    load: [load1, 1, 1] as [number, number, number],
    memory: { total_mb: 8192, available_pct },
  });

  it("a task placed on box-a is held by box-a's memory sample, not the local cmux ping", () => {
    // The supervisor's own machine: cmux ping over (a local-only signal).
    const local = decide({ ...CALM, cmux_ping: s(9000) }, emptyAdmissionState(), CFG);
    expect(local.allow).toBe(0);
    const clean = decideHost("box-a", hostSamples(rec(60)), {}, T);
    // box-a is fine: the local cmux ping does not hold a task placed there.
    expect(forHost(local, clean)).toEqual({ allow: Number.POSITIVE_INFINITY, reasons: [] });
    const low = decideHost("box-a", hostSamples(rec(9)), clean.state, T);
    expect(forHost(local, low)).toEqual({
      allow: 0,
      reasons: ["box-a: memory available 9% (min 10%)"],
    });
  });

  it("the global signals (API overload, CI queue) still apply on every host", () => {
    const local = decide({ ...CALM, ci_queue: s(99), cmux_ping: s(9000) }, {}, CFG);
    const host = decideHost("box-a", hostSamples(rec(60)), {}, T);
    expect(forHost(local, host)).toEqual({ allow: 0, reasons: ["99 queued CI runs > max 10"] });
    // A verdict without per-signal reasons (injected, or before the first sample) applies whole.
    expect(forHost({ allow: 0, reasons: ["waiting for the first pressure sample"] }, host)).toEqual(
      {
        allow: 0,
        reasons: ["waiting for the first pressure sample"],
      },
    );
  });

  it("load per core over the max holds too, naming the host", () => {
    const v = decideHost("box-a", hostSamples(rec(60, 32)), {}, T);
    expect(v.reasons).toEqual(["box-a: load 2.00 per core (max 1.5)"]);
  });

  it("three clean heartbeats clear it; an unknown memory sample never trips", () => {
    let state: HostAdmissionState = decideHost("box-a", hostSamples(rec(9)), {}, T).state;
    const reasons: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const v = decideHost("box-a", hostSamples(rec(60)), state, T);
      state = v.state;
      reasons.push(v.reasons);
    }
    expect(reasons).toEqual([
      ["box-a: recovering: memory available clear for 1/3 samples"],
      ["box-a: recovering: memory available clear for 2/3 samples"],
      [],
    ]);
    const noMem = decideHost("box-a", hostSamples({ cores: 16, load: [1, 1, 1] }), {}, T);
    expect(noMem.allow).toBe(Number.POSITIVE_INFINITY);
  });

  it("recovering lists the hysteresis reasons alone, without the host's name", () => {
    const tripped = decideHost("box-a", hostSamples(rec(9)), {}, T);
    expect(tripped.recovering).toEqual([]);
    const v = decideHost("box-a", hostSamples(rec(60)), tripped.state, T);
    expect(v.recovering).toEqual(["recovering: memory available clear for 1/3 samples"]);
  });

  it("foldHost: the verdict from the last heartbeats, under the thresholds asked with", () => {
    const history = [rec(9), rec(60), rec(60)].map(hostSamples);
    expect(foldHost("box-a", history, T).reasons).toEqual([
      "box-a: recovering: memory available clear for 2/3 samples",
    ]);
    // A wave whose own minimum is 5% was never breached by 9%.
    expect(foldHost("box-a", history, { ...T, mem_available_min_pct: 5 })).toMatchObject({
      allow: Number.POSITIVE_INFINITY,
      reasons: [],
    });
    // A lowered load maximum (config_set) applies to the latest heartbeat at once.
    expect(
      foldHost("box-a", [hostSamples(rec(60, 20))], { ...T, load_per_core_max: 1 }).reasons,
    ).toEqual(["box-a: load 1.25 per core (max 1)"]);
    // Only the last hysteresis_samples heartbeats count: an older breach has cleared.
    expect(
      foldHost("box-a", [rec(9), rec(60), rec(60), rec(60)].map(hostSamples), T).reasons,
    ).toEqual([]);
    expect(foldHost("box-a", [], T)).toMatchObject({
      allow: Number.POSITIVE_INFINITY,
      reasons: [],
    });
  });
});

describe("summaryPayload", () => {
  it("is a schema-valid retained admission summary", () => {
    const v = decide(
      { ...CALM, memory_pressure: s(4), ci_queue: unknown },
      emptyAdmissionState(),
      CFG,
    );
    const p = summaryPayload(v, new Date("2026-10-18T15:00:10.000Z"), {
      "w-1": { allow: 0, reasons: v.reasons },
    });
    expect(p).toMatchObject({ allow: 0, throttled: true, sampled_at: "2026-10-18T15:00:10.000Z" });
    expect(
      schemaErrors("admission.schema.json", envelope("_system/admission", "admission", p)),
    ).toEqual([]);
    const open = summaryPayload(decide(CALM, emptyAdmissionState(), CFG), new Date());
    expect(open).toMatchObject({ allow: null, throttled: false, reasons: [] });
  });
});

// ---------------------------------------------------------------------------------------------
// The daemon: sample → decide → publish summary → admit (in-process Aedes broker)
// ---------------------------------------------------------------------------------------------

const PARALLEL = fileURLToPath(new URL("./fixtures/parallel.yaml", import.meta.url));
const WAVE = "w-parallel";

describe("volleyd daemon: pressure-based admission", () => {
  let t: DaemonEnv;
  let reading: PressureReading;
  const state = async () =>
    ((await t.retained(waveStateTopic(WAVE))) as { payload: WaveState }).payload;
  const summary = async () =>
    ((await t.retained(ADMISSION_TOPIC)) as { payload: Record<string, unknown> } | null)?.payload;

  beforeEach(async () => {
    t = await makeDaemonEnv();
    reading = { samples: { memory_pressure: s(1), cmux_ping: s(30), containers: s(0) }, ci: {} };
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it("critical memory pressure holds every start, with the reason in why_waiting and the summary", async () => {
    reading.samples.memory_pressure = s(4);
    const daemon = await t.start({ pressure: async () => reading });
    await daemon.tick();
    expect((await runCli(["run", PARALLEL], t.env)).exitCode).toBe(0);

    const st = await state();
    expect(st.tasks.map((x) => x.stage)).toEqual(["queued", "queued", "queued", "queued"]);
    expect(st.tasks[0]?.why_waiting).toBe("memory pressure critical (level 4 > max 2)");

    await daemon.tick(); // a sample with the wave running: the summary carries its verdict
    const sum = await summary();
    expect(sum).toMatchObject({
      throttled: true,
      allow: 0,
      reasons: ["memory pressure critical (level 4 > max 2)"],
      waves: { [WAVE]: { allow: 0 } },
    });
    expect(schemaErrors("admission.schema.json", await t.retained(ADMISSION_TOPIC))).toEqual([]);

    const cli = await runCli(["admission"], t.env);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("admission: THROTTLED (allow 0)");
    expect(cli.stdout).toContain("- memory pressure critical (level 4 > max 2)");
    expect(cli.stdout).toMatch(/memory_pressure\s+over\s+4 \(max 2\)/);
    const json = JSON.parse((await runCli(["admission", "--json"], t.env)).stdout);
    expect(json.reasons).toEqual(["memory pressure critical (level 4 > max 2)"]);
  });

  it("recovers only after hysteresis_samples clean samples", async () => {
    reading.samples.cmux_ping = s(9000);
    const daemon = await t.start({ pressure: async () => reading });
    await daemon.tick();
    expect((await runCli(["run", PARALLEL], t.env)).exitCode).toBe(0);
    reading.samples.cmux_ping = s(30);
    await daemon.tick();
    await daemon.tick();
    expect((await state()).tasks[0]?.why_waiting).toBe(
      "recovering: cmux ping clear for 2/3 samples",
    );
    await daemon.tick();
    expect((await state()).tasks.every((x) => x.why_waiting === "admitted: awaiting spawn")).toBe(
      true,
    );
  });

  it("a threshold changed through config_set re-decides without a restart", async () => {
    reading.samples.containers = s(25);
    // start() takes the first sample: the only one before the threshold change.
    const daemon = await t.start({ pressure: async () => reading });
    expect((await runCli(["run", PARALLEL], t.env)).exitCode).toBe(0);
    expect((await state()).tasks[0]?.why_waiting).toBe("25 containers running > max 20");

    const set = await runCli(["config", "set", "admission.container_max", "30"], t.env);
    expect(set.exitCode).toBe(0);
    await daemon.tick();
    expect((await state()).tasks[0]?.why_waiting).toBe("admitted: awaiting spawn");
  });

  it("a new wave version's admission override applies at once (no wait for the next tick)", async () => {
    reading.samples.containers = s(25);
    await t.start({ pressure: async () => reading });
    expect((await runCli(["run", PARALLEL], t.env)).exitCode).toBe(0);
    expect((await state()).tasks[0]?.why_waiting).toBe("25 containers running > max 20");

    const v2 = join(t.home, "parallel-v2.yaml");
    writeFileSync(
      v2,
      `${readFileSync(PARALLEL, "utf-8")}config: { admission: { container_max: 30 } }\n`,
    );
    const r = await runCli(["run", v2], t.env);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    // No daemon.tick(): resubmit itself re-decides the last sample with the wave's overrides.
    expect((await state()).tasks[0]?.why_waiting).toBe("admitted: awaiting spawn");
  });

  it("after a restart under critical pressure it admits nothing, before or after the first tick", async () => {
    reading.samples.memory_pressure = s(4);
    let daemon = await t.start({ pressure: async () => reading });
    await daemon.tick();
    expect((await runCli(["run", PARALLEL], t.env)).exitCode).toBe(0);
    expect((await state()).tasks.map((x) => x.why_waiting)).toEqual(
      Array(4).fill("memory pressure critical (level 4 > max 2)"),
    );
    await daemon.stop();

    daemon = await t.start({ pressure: async () => reading });
    expect((await state()).tasks.map((x) => x.why_waiting)).toEqual(
      Array(4).fill("memory pressure critical (level 4 > max 2)"),
    );
    await daemon.tick();
    expect((await state()).tasks.every((x) => x.why_waiting !== "admitted: awaiting spawn")).toBe(
      true,
    );
  });

  it("counts API overload signals from agents' progress events", async () => {
    const daemon = await t.start({ pressure: async () => reading });
    const agent = new VolleyBroker();
    await agent.connect({ url: t.broker.url, agentId: "agent-a" });
    try {
      for (let i = 0; i < 4; i++) {
        const env = buildEnvelope({
          agentId: "agent-a",
          parentId: null,
          channel: "progress",
          type: "idle",
          // Each hook event carries its own seq (SPEC §4.3): four distinct messages.
          payload: { source: "harness-hook", seq: i + 1, text: "API Error: 529 Overloaded" },
        });
        await agent.publish(`volley/${NS}/agent-a/progress`, JSON.stringify(env), {
          qos: 1,
          retain: false,
        });
      }
      // The signals reach the daemon over MQTT; each tick re-decides on what it has seen so far.
      let sum: Awaited<ReturnType<typeof summary>>;
      await eventually(async () => {
        await daemon.tick();
        sum = await summary();
        return (sum?.reasons as string[] | undefined)?.length === 1;
      });
      expect(sum?.reasons).toEqual(["4 API overload signals in 300 s > max 3"]);
    } finally {
      await agent.disconnect();
    }
  });
});
