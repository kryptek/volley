import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { CONFIG_DEFAULTS } from "../../src/config-defaults";
import { ControlClient } from "../../src/control";
import type { Daemon } from "../../src/daemon";
import { readJournalFile } from "../../src/journal";
import type { JournalEvent } from "../../src/types";
import { type DaemonEnv, NS, makeDaemonEnv } from "./daemon-env";
import { type Behaviour, type Fleet, type FleetAgent, fakeFleet } from "./fake-agents";
import { type FakeClock, fakeClock, flushMicrotasks } from "./fake-clock";
import { memoryCredentials } from "./fake-dynsec";
import { fakeExec } from "./fake-exec";
import { type FakeHost, fakeHost } from "./fake-host";
import { type Flake, type SoakWorld, soakWorld } from "./soak-world";

/**
 * The soak's environment (test/soak/): the real `Daemon` on Aedes with autopilot on and merging
 * automatically, the fake host on a fake clock, every exec answered by the soak world, the fake
 * fleet answering every launch, and the wave's owner — a coordinator name — registered. `step()`
 * is one turn of the night: the fleet acts, the daemon consumes it, time moves, the daemon ticks.
 */

export const WAVE = "soak";
export const RELEASE = `release/${WAVE}`;
export const OWNER = "coord-soak";
export const SOAK_PIPELINE = "[implement, [spec_review, quality_review], fixup, merge_ready]";

export interface SoakEnvOptions {
  /** Task ids (each gets issue 300 + its index). */
  tasks: string[];
  seed?: number;
  flake?: Flake;
  /** The flake per head over the seed (soak-world.ts `flaky`). */
  flaky?: (head: string) => boolean | undefined;
  behaviour?: (a: Omit<FleetAgent, "behaviour">) => Behaviour;
  /** The release playbook (`.volley/release.yaml`; none: no release train). */
  playbook?: string;
  /** Extra wave `config:` entries (YAML flow-map body). */
  config?: string;
  /** Extra top-level wave-file lines. */
  waveExtra?: string;
  pipeline?: string;
  /** The screen publisher's slow-read bound (ms of the fake clock). */
  screenSlowMs?: number;
}

export interface SoakEnv {
  env: DaemonEnv;
  daemon: Daemon;
  host: FakeHost;
  world: SoakWorld;
  fleet: Fleet;
  clock: FakeClock;
  repo: string;
  control: ControlClient;
  journal: () => JournalEvent[];
  logs: string[];
  /** One turn: the fleet acts, the daemon consumes it, `ms` of time pass, the daemon ticks. */
  step: (ms?: number) => Promise<void>;
  /**
   * Step until `pred` holds (checked before each step); after `maxSteps` steps, throws with the
   * journal tail and the open decisions (what a failing soak prints).
   */
  until: (pred: () => boolean, what: string, maxSteps?: number, ms?: number) => Promise<number>;
  /** Run `fn` at the start of every step (a scenario's world events). */
  onStep: (fn: () => void | Promise<void>) => void;
  /** Steps taken so far. */
  steps: () => number;
  /** The journal's last `n` events and the open decisions, one line each. */
  report: (n?: number) => string;
  /** Everything published so far consumed and the daemon idle (bounded: never deadlocks on a timer). */
  consumed: () => Promise<void>;
  /** The owner's coordinator session (its current agent id). */
  owner: {
    agentId: string;
    drop: () => Promise<void>;
    reconnect: (agentId: string) => Promise<void>;
  };
  /** Answer an open decision as the owner. */
  resolve: (decisionId: string, answer: string) => Promise<void>;
  cleanup: () => Promise<void>;
}

/** How long a settle may take before the step moves on (a timer only time releases). */
const SETTLE_MS = 2_000;

export async function makeSoakEnv(o: SoakEnvOptions): Promise<SoakEnv> {
  const env = await makeDaemonEnv({ broker: { overlapSafe: true } });
  const repo = join(realpathSync(env.home), "repo");
  mkdirSync(join(repo, ".volley"), { recursive: true });
  if (o.playbook !== undefined) writeFileSync(join(repo, ".volley", "release.yaml"), o.playbook);
  const claudeJson = join(env.home, "claude.json");
  writeFileSync(
    claudeJson,
    JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
  );
  const clock = fakeClock(Date.parse("2026-10-20T22:00:00.000Z"));
  const world = soakWorld({
    repo,
    release_branch: RELEASE,
    seed: o.seed ?? 1,
    ...(o.flake !== undefined ? { flake: o.flake } : {}),
    ...(o.flaky !== undefined ? { flaky: o.flaky } : {}),
  });
  /** The daemon's log lines. */
  const logs: string[] = [];
  const fx = fakeExec().on([], (argv, opts) => world.exec(argv, opts));
  const host = fakeHost(fx);
  // Every pane shows a Claude session mid-task (a screen read finds it, never a crash).
  host.screens = ["⏺ Reading the diff.\n\n  ? for shortcuts  ·  Opus 5.5"];
  host.sleep = async (ms) => {
    await new Promise<void>((r) => clock.setTimeout(r, ms));
  };
  // A worktree starts at its base, as `git worktree add` cuts it.
  const prepare = host.prepareWorktree.bind(host);
  host.prepareWorktree = async (spec) => {
    const r = await prepare(spec);
    const base = world.resolve(spec.base);
    if (base === null) throw new Error(`soak: worktree base ${spec.base} is not a commit`);
    world.local[spec.path] = base;
    return spec.releaseBase === true ? { ...r, base: { sha: base, fresh: true } } : r;
  };

  const broker = new VolleyBroker();
  await broker.connect({ url: env.broker.url, agentId: "soak-fleet" });
  const fleet = fakeFleet({
    broker,
    namespace: NS,
    host,
    world,
    release_branch: RELEASE,
    ...(o.behaviour !== undefined ? { behaviour: o.behaviour } : {}),
    ...(o.flake !== undefined ? { flakeFile: o.flake.file } : {}),
    now: () => clock.now(),
  });

  const d = await env.start({
    spawner: {
      host,
      claudeJsonPath: claudeJson,
      hooksDir: "/opt/volley-hooks",
      reapGraceMs: 300,
      credentials: memoryCredentials(),
    },
    configDefaults: CONFIG_DEFAULTS,
    clock,
    log: (line) => logs.push(line),
    ...(o.screenSlowMs !== undefined ? { screenTimeouts: { slowMs: o.screenSlowMs } } : {}),
  });
  const offJournal = d.onJournal((_wave, e) => fleet.observe(e));
  const control = await ControlClient.connect(env.broker.url, NS);

  // The owner: a coordinator session registered under its name (SPEC §6.2).
  const owner = {
    agentId: "coord-soak-a1",
    async register(agentId: string) {
      await broker.publish(
        registryTopic(agentId),
        JSON.stringify({
          ...buildEnvelope({
            now: () => new Date(clock.now()),
            agentId,
            parentId: null,
            channel: "_system/registry",
            type: "registered",
            payload: {
              capabilities: [],
              cwd: repo,
              coordinator: OWNER,
              started_at: new Date(clock.now()).toISOString(),
            },
          }),
          namespace: NS,
        }),
        { qos: 1, retain: true },
      );
      await this.status(agentId, "working");
    },
    async status(agentId: string, type: string) {
      await broker.publish(
        buildTopic(NS, agentId, "status"),
        JSON.stringify(
          buildEnvelope({
            now: () => new Date(clock.now()),
            agentId,
            parentId: null,
            channel: "status",
            type,
            payload: {},
          }),
        ),
        { qos: 1, retain: true },
      );
    },
    /** Its MCP server goes away: the registry entry's LWT, `reaped`. */
    async drop() {
      await this.status(this.agentId, "reaped");
    },
    /** It comes back under a new agent id, the same coordinator name. */
    async reconnect(agentId: string) {
      this.agentId = agentId;
      await this.register(agentId);
    },
  };
  await owner.register(owner.agentId);

  const consumed = async () => {
    await fleet.idle();
    const r = await control.request("status", {});
    if (!r.ok) throw new Error(`status: ${r.error}`);
    await Promise.race([
      d.settled(),
      // broker round-trip: a settle a fake-clock timer holds is released by the next step.
      new Promise((r) => setTimeout(r, SETTLE_MS)),
    ]);
    await flushMicrotasks();
  };

  const tasks = o.tasks.map((t, i) => `  ${t}: { issue: ${300 + i} }`).join("\n");
  const yaml = [
    `wave: ${WAVE}`,
    `repo: ${repo}`,
    `release_branch: ${RELEASE}`,
    "model: claude-opus-5-5",
    `pipeline: ${o.pipeline ?? SOAK_PIPELINE}`,
    "merge: auto",
    ...(o.waveExtra !== undefined ? [o.waveExtra] : []),
    "tasks:",
    tasks,
    `config: { worktree_root: ${join(env.home, "wt")}${o.config !== undefined ? `, ${o.config}` : ""} }`,
    "",
  ].join("\n");
  const run = await control.request("run", { wave_yaml: yaml, owner: OWNER });
  if (!run.ok) throw new Error(`run: ${run.error}`);
  await consumed();

  const hooks: (() => void | Promise<void>)[] = [];
  let steps = 0;
  const step = async (ms = 5_000) => {
    steps++;
    for (const h of hooks) await h();
    await fleet.step();
    await consumed();
    await fleet.heartbeats();
    await clock.advance(ms);
    await d.tick();
    void d.tickScreens();
    await consumed();
  };
  const report = (n = 40) => {
    const j = readJournalFile(join(env.home, "waves", WAVE, "journal.jsonl"));
    const rec = d.record(WAVE);
    const open = (rec?.state?.open_decisions ?? []).map((id) => {
      const x = rec?.decisions[id];
      return `  ${id} ${x?.kind} [${x?.task ?? "-"}] ${x?.question?.slice(0, 200)}`;
    });
    return [
      `journal tail (${j.length} events):`,
      ...j
        .slice(-n)
        .map((e) => `  ${e.seq} ${e.type} ${e.task ?? ""} ${JSON.stringify(e.data).slice(0, 240)}`),
      `open decisions (${open.length}):`,
      ...open,
      `tasks: ${(rec?.state?.tasks ?? []).map((t) => `${t.id}:${t.stage}`).join(" ")}`,
      `unknown argvs: ${world.unknown
        .slice(0, 10)
        .map((a) => a.join(" "))
        .join(" | ")}`,
    ].join("\n");
  };

  return {
    env,
    daemon: d,
    host,
    world,
    fleet,
    clock,
    repo,
    control,
    journal: () => readJournalFile(join(env.home, "waves", WAVE, "journal.jsonl")),
    logs,
    consumed,
    step,
    report,
    onStep: (fn) => {
      hooks.push(fn);
    },
    steps: () => steps,
    async until(pred, what, maxSteps = 200, ms = 5_000) {
      for (let i = 0; i < maxSteps; i++) {
        if (pred()) return i;
        await step(ms);
      }
      if (pred()) return maxSteps;
      throw new Error(`soak: ${what} not reached in ${maxSteps} steps\n${report()}`);
    },
    owner,
    async resolve(decisionId, answer) {
      const r = await control.request("resolve", {
        wave: WAVE,
        decision_id: decisionId,
        answer,
        by: owner.agentId,
      });
      if (!r.ok) throw new Error(`resolve ${decisionId}: ${r.error}`);
      await consumed();
    },
    async cleanup() {
      offJournal();
      await fleet.idle();
      await control.close();
      await broker.disconnect();
      await env.cleanup();
    },
  };
}
