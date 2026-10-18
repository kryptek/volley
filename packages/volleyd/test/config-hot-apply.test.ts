import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_TOPIC, ControlClient, waveStateTopic } from "../src/control";
import type { Daemon } from "../src/daemon";
import { readJournalFile } from "../src/journal";
import { SYSTEM_WAVE, type WaveState } from "../src/types";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { runCli } from "./helpers/run-cli";
import { schemaErrors } from "./helpers/schema";

const PARALLEL = fileURLToPath(new URL("./fixtures/parallel.yaml", import.meta.url));
const OVERRIDES = fileURLToPath(new URL("./fixtures/overrides.yaml", import.meta.url));
const WAVE = "w-parallel";

let t: DaemonEnv;
let daemon: Daemon;
beforeEach(async () => {
  t = await makeDaemonEnv();
  daemon = await t.start();
});
afterEach(async () => {
  await t.cleanup();
});

// readJournalFile, not Journal.open: opening would truncate a torn tail of the live daemon's file.
const systemEvents = () => readJournalFile(join(t.home, "waves", SYSTEM_WAVE, "journal.jsonl"));
const waveEvents = (wave: string) => readJournalFile(join(t.home, "waves", wave, "journal.jsonl"));
const admitted = (wave: string) =>
  waveEvents(wave)
    .filter((e) => e.type === "task_admitted")
    .map((e) => e.task);
const config = async () => (await t.retained(CONFIG_TOPIC)) as { payload: Record<string, unknown> };
const state = async (wave: string) =>
  ((await t.retained(waveStateTopic(wave))) as { payload: WaveState }).payload;

async function configSet(patch: Record<string, unknown>, by = "tester") {
  const client = await ControlClient.connect(t.broker.url, NS);
  try {
    return await client.request("config_set", { patch, by }, { text: "test config_set" });
  } finally {
    await client.close();
  }
}

describe("config_set hot-apply", () => {
  it("applies a ceiling change without restart: ack, journal, retained version+1, next tick", async () => {
    const v1 = await config();
    expect(v1.payload.version).toBe(1);

    const cli = await runCli(["config", "set", "hard_ceiling", "2", "--by", "tester"], t.env);
    expect(cli.stderr).toBe("");
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("config v2: hard_ceiling = 2 (by tester)");

    const [changed] = systemEvents();
    expect(changed).toMatchObject({
      type: "config_changed",
      data: { by: "tester", patch: { hard_ceiling: 2 }, previous: { hard_ceiling: 12 } },
    });
    expect(Number.isNaN(Date.parse(changed?.at ?? ""))).toBe(false);

    await daemon.tick();
    const v2 = await config();
    expect(v2.payload).toMatchObject({ version: 2, hard_ceiling: 2, updated_by: "tester" });
    expect(schemaErrors("config.schema.json", v2)).toEqual([]);

    // A 4-task wave submitted now admits only 2 — the ceiling was hot-applied.
    expect((await runCli(["run", PARALLEL], t.env)).exitCode).toBe(0);
    expect(admitted(WAVE)).toEqual(["A", "B"]);
    const s = await state(WAVE);
    expect(s.tasks.find((x) => x.id === "C")?.why_waiting).toBe(
      "hard ceiling reached: 2/2 live agents",
    );
    expect(s.effective_config?.hard_ceiling).toBe(2);

    // Raising it admits more on the next tick.
    expect((await configSet({ hard_ceiling: 3 })).applied).toBe(true);
    await daemon.tick();
    expect(admitted(WAVE)).toEqual(["A", "B", "C"]);

    // Lowering it below the live count preempts nothing and admits nothing.
    expect((await configSet({ hard_ceiling: 1 })).applied).toBe(true);
    await daemon.tick();
    expect(admitted(WAVE)).toEqual(["A", "B", "C"]);
    expect((await state(WAVE)).tasks.find((x) => x.id === "D")?.why_waiting).toBe(
      "hard ceiling reached: 3/1 live agents",
    );
    expect((await config()).payload.version).toBe(4);
  });

  it("returns { applied: true, rejected: [] } in the ack", async () => {
    const ack = await configSet({ claim_after_s: 900 });
    expect(ack).toMatchObject({ ok: true, applied: true, rejected: [], acked_type: "query" });
  });

  it("rejects unknown keys and out-of-bounds values as a whole; nothing changes", async () => {
    const unknown = await configSet({ hard_ceiling: 5, bogus: 1 });
    expect(unknown).toMatchObject({
      applied: false,
      rejected: [{ path: "bogus", reason: "unknown key" }],
    });
    const bounds = await configSet({ hard_ceiling: 500 });
    expect(bounds).toMatchObject({
      applied: false,
      rejected: [{ path: "hard_ceiling", reason: "must be <= 100" }],
    });
    const cli = await runCli(["config", "set", "admission.hysteresis_samples", "0"], t.env);
    expect(cli.exitCode).toBe(1);
    expect(cli.stderr).toContain("admission.hysteresis_samples: must be >= 1");

    await daemon.tick();
    expect(systemEvents()).toEqual([]);
    expect((await config()).payload).toMatchObject({ version: 1, hard_ceiling: 12 });
  });

  it("shrinking a lease pool is applied and journaled without touching admitted work", async () => {
    expect((await runCli(["run", PARALLEL], t.env)).exitCode).toBe(0);
    expect(admitted(WAVE)).toEqual(["A", "B", "C", "D"]);
    expect(
      (await configSet({ lease_pools: { build: { capacity: 2, match: ["vite build"] } } })).applied,
    ).toBe(true);
    const shrink = await runCli(["config", "set", "lease_pools.build.capacity", "1"], t.env);
    expect(shrink.exitCode).toBe(0);
    await daemon.tick();
    expect(systemEvents().at(-1)?.data).toMatchObject({
      patch: { lease_pools: { build: { capacity: 1 } } },
      previous: { lease_pools: { build: { capacity: 2 } } },
    });
    expect((await config()).payload.lease_pools).toEqual({
      build: { capacity: 1, match: ["vite build"] },
    });
    expect(admitted(WAVE)).toEqual(["A", "B", "C", "D"]);
  });

  it("config get layers per-wave overrides over the global config", async () => {
    expect((await runCli(["run", OVERRIDES], t.env)).exitCode).toBe(0);
    const global = await runCli(["config", "get", "hard_ceiling"], t.env);
    expect(global.stdout).toBe("12\n");
    const wave = await runCli(["config", "get", "hard_ceiling", "--wave", "w-overrides"], t.env);
    expect(wave.stdout).toBe("3\n");
    const nested = await runCli(["config", "get", "admission", "--wave", "w-overrides"], t.env);
    expect(JSON.parse(nested.stdout)).toMatchObject({ ci_queue_max: 4, hysteresis_samples: 3 });
    const all = await runCli(["config", "get", "--json"], t.env);
    expect(JSON.parse(all.stdout)).toMatchObject({ version: 1, hard_ceiling: 12 });
    const bad = await runCli(["config", "get", "nope"], t.env);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("unknown config path 'nope'");
    // Both tasks fit inside the wave's own ceiling (3) and spawn budget (5).
    expect(admitted("w-overrides")).toEqual(["A", "B"]);
  });
});
