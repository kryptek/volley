import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VolleyBroker } from "volley-mcp/broker";
import { Daemon, type DaemonOptions } from "../../src/daemon";
import { type TestBroker, startTestBroker } from "./aedes-broker";

export const NS = "volleyd-test";

/** An Aedes broker, a temp $VOLLEYD_HOME, and helpers to start daemons and read topics. */
export interface DaemonEnv {
  broker: TestBroker;
  home: string;
  env: Record<string, string>;
  /** Daemon options for this env (timer off: tests drive tick(); MQTT 3.1.1 for Aedes). */
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
    ...extra,
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
