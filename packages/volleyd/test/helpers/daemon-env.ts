import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VolleyBroker } from "volley-mcp/broker";
import { Daemon, type DaemonOptions, type PressureSource } from "../../src/daemon";
import { type TestBroker, startTestBroker } from "./aedes-broker";

export const NS = "volleyd-test";

/**
 * Every signal unknown. Never run the real samplers (sysctl, cmux, docker, gh) from tests: they
 * read the machine, so a loaded one holds admission.
 */
export const NO_PRESSURE: PressureSource = async () => ({ samples: {}, ci: {} });

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
  cleanup: () => Promise<void>;
}

export async function makeDaemonEnv(): Promise<DaemonEnv> {
  const broker = await startTestBroker();
  const home = mkdtempSync(join(tmpdir(), "volleyd-home-"));
  const daemons: Daemon[] = [];
  const options = (extra: Partial<DaemonOptions> = {}): DaemonOptions => ({
    brokerUrl: broker.url,
    namespace: NS,
    home,
    tickMs: 0,
    protocolVersion: 4,
    pressure: NO_PRESSURE,
    ...extra,
    // The own machine's record never reads the load or memory of the machine running the test.
    fleet: { os: CALM_OS, ...extra.fleet },
  });
  const reader = new VolleyBroker();
  await reader.connect({ url: broker.url, agentId: "test-reader" });
  return {
    broker,
    home,
    env: { VOLLEY_BROKER_URL: broker.url, VOLLEY_NAMESPACE: NS, VOLLEYD_HOME: home },
    options,
    start: async (extra) => {
      const d = await Daemon.start(options(extra));
      daemons.push(d);
      return d;
    },
    retained: async (topic) => {
      const raw = await reader.queryRetained(topic, 500);
      return raw === null || raw === "" ? null : JSON.parse(raw);
    },
    cleanup: async () => {
      for (const d of daemons) await d.stop().catch(() => {});
      await reader.disconnect();
      await broker.close();
      rmSync(home, { recursive: true, force: true });
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
