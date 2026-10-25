import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { CONFIG_DEFAULTS } from "../../src/config-defaults";
import { Daemon, type DaemonOptions, type PressureSource } from "../../src/daemon";
import { type TestBroker, startTestBroker } from "./aedes-broker";
import { tempDir } from "./tmp";

export const NS = "volleyd-test";

/**
 * Every signal unknown. Never run the real samplers (sysctl, cmux, docker, gh) from tests: they
 * read the machine, so a loaded one holds admission.
 */
export const NO_PRESSURE: PressureSource = async () => ({ samples: {}, ci: {} });

/**
 * The defaults a test daemon starts from: the built-in ones with autopilot off, so a decision
 * waits for the answer the test gives it (the owner's path). Tests of autopilot itself start with
 * `AUTOPILOT_ON`.
 */
export const OWNER_DECIDES = {
  ...CONFIG_DEFAULTS,
  autopilot: { ...CONFIG_DEFAULTS.autopilot, enabled: false },
};
export const AUTOPILOT_ON: Partial<DaemonOptions> = { configDefaults: CONFIG_DEFAULTS };

/** A `DaemonOptions.fetch` that answers GitHub's status page with a fixture. */
export const statusPageFetch = (fixture: string): typeof fetch =>
  (async () =>
    new Response(
      readFileSync(new URL(`../fixtures/${fixture}`, import.meta.url), "utf-8"),
    )) as unknown as typeof fetch;

/** An Aedes broker, a temp $VOLLEYD_HOME, and helpers to start daemons and read topics. */
export interface DaemonEnv {
  broker: TestBroker;
  home: string;
  env: Record<string, string>;
  /**
   * Daemon options for this env (timer off: tests drive tick(); MQTT 3.1.1 for Aedes; no real
   * pressure samplers).
   */
  options: (extra?: Partial<DaemonOptions>) => DaemonOptions;
  /** Start a daemon with `options()`. Stopped automatically in cleanup(). */
  start: (extra?: Partial<DaemonOptions>) => Promise<Daemon>;
  /** Read one retained topic as JSON (null when absent). */
  retained: (topic: string) => Promise<unknown>;
  /**
   * The topics that still hold a retained record, read in parallel: each absent one waits out
   * the read timeout, so a loop of `retained` pays it once per topic.
   */
  stillRetained: (topics: string[]) => Promise<string[]>;
  cleanup: () => Promise<void>;
}

export async function makeDaemonEnv(
  o: {
    broker?: Parameters<typeof startTestBroker>[0];
    /**
     * Start from a broker volleyd has never used: no retained status, so the first start's
     * already-running probe waits out its whole `probe_ms`. By default the broker holds the
     * `done` status a cleanly stopped volleyd leaves (the restart case), which the probe reads
     * at once: that wait, paid by every daemon test, was most of the suite's time.
     */
    neverStarted?: boolean;
  } = {},
): Promise<DaemonEnv> {
  const broker = await startTestBroker(o.broker);
  const home = tempDir("volleyd-home-");
  const daemons: Daemon[] = [];
  const options = (extra: Partial<DaemonOptions> = {}): DaemonOptions => ({
    brokerUrl: broker.url,
    namespace: NS,
    home,
    tickMs: 0,
    protocolVersion: 4,
    pressure: NO_PRESSURE,
    configDefaults: OWNER_DECIDES,
    // GitHub's status page all operational: a red head's classification never reads the network.
    fetch: statusPageFetch("githubstatus-ok.json"),
    ...extra,
    // The own machine's record never reads the load or memory of the machine running the test.
    fleet: { os: CALM_OS, ...extra.fleet },
  });
  const reader = new VolleyBroker();
  await reader.connect({ url: broker.url, agentId: "test-reader" });
  if (o.neverStarted !== true) {
    const stopped = buildEnvelope({
      agentId: "volleyd",
      parentId: null,
      channel: "status",
      type: "done",
      payload: { reason: "shutdown" },
    });
    await reader.publish(`volley/${NS}/volleyd/status`, JSON.stringify(stopped), {
      qos: 1,
      retain: true,
    });
  }
  const retained = async (topic: string): Promise<unknown> => {
    const raw = await reader.queryRetained(topic, 500);
    return raw === null || raw === "" ? null : JSON.parse(raw);
  };
  return {
    broker,
    home,
    // HOME: never the real one (an unreachable broker's diagnosis reads ~/.volley/peer.json).
    env: {
      VOLLEY_BROKER_URL: broker.url,
      VOLLEY_NAMESPACE: NS,
      VOLLEYD_HOME: home,
      HOME: join(home, "user-home"),
    },
    options,
    start: async (extra) => {
      const d = await Daemon.start(options(extra));
      daemons.push(d);
      return d;
    },
    retained,
    stillRetained: async (topics) => {
      const values = await Promise.all(topics.map(retained));
      return topics.filter((_, i) => values[i] !== null);
    },
    cleanup: async () => {
      for (const d of daemons) await d.stop().catch(() => {});
      await reader.disconnect();
      await broker.close();
    },
  };
}

/**
 * The own machine's OS readings for a daemon test (DaemonOptions.fleet.os): a calm Linux box, so a
 * test's own-machine verdict never depends on the load or memory of the machine running it.
 */
export const CALM_OS = {
  platform: () => "linux" as NodeJS.Platform,
  loadavg: () => [0.5, 0.5, 0.5],
  freemem: () => 8 * 1024 ** 3,
  totalmem: () => 16 * 1024 ** 3,
};
