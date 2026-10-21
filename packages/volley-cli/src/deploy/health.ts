import type { BrokerAuth } from "volley-mcp/config";
import { buildTopic } from "volley-mcp/topics";
import { openClient } from "../connect";

/**
 * `volley deploy`'s health check after the restart, each bounded by a wait (`DEPLOY`): the Desk
 * answers and serves the release's bundle, and volleyd's retained status is `working` and was
 * published after the restart (the new process got through its start: the status carries no
 * version, and the self-check already proved the checkout's).
 */

export interface Wait {
  timeoutMs: number;
  pollMs: number;
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** Ask `probe` until it returns null (healthy) or the wait runs out; the last problem, or null. */
async function poll(wait: Wait, probe: (remainingMs: number) => Promise<string | null>) {
  const end = Date.now() + wait.timeoutMs;
  let problem: string | null = "not checked";
  for (;;) {
    problem = await probe(Math.max(1, end - Date.now()));
    if (problem === null || Date.now() + wait.pollMs > end) return problem;
    await sleep(wait.pollMs);
  }
}

/**
 * The Desk at `base` answers `GET /` with 200 and its `/version.json` carries `version`; null
 * when healthy, else why not. A null `version` (a rollback to a release whose build wrote no
 * version.json) takes any version.json, or none.
 */
export async function deskHealthy(
  base: string,
  version: string | null,
  wait: Wait,
): Promise<string | null> {
  return poll(wait, async (remaining) => {
    const get = (path: string) =>
      fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(Math.max(500, Math.min(remaining, wait.pollMs * 5))),
      });
    try {
      const index = await get("/");
      await index.arrayBuffer();
      if (index.status !== 200) return `the Desk at ${base}/ answers HTTP ${index.status}`;
      if (version === null) return null;
      const v = await get("/version.json");
      const text = await v.text();
      if (v.status !== 200) return `the Desk's ${base}/version.json answers HTTP ${v.status}`;
      let served: unknown;
      try {
        served = (JSON.parse(text) as { version?: unknown }).version;
      } catch {
        served = undefined;
      }
      return served === version
        ? null
        : `the Desk serves ${typeof served === "string" ? served : "no version.json"}, not ${version}`;
    } catch (e) {
      return `no answer from the Desk at ${base} (${e instanceof Error ? e.message : String(e)})`;
    }
  });
}

/**
 * volleyd's retained status in `namespace` is `working` and was published at or after `since`
 * (the restart); null when healthy, else why not. `spawning` and `registered` come before its
 * subscriptions and reconcile, so a daemon that dies in its start never passes.
 */
/** The least time one connection attempt gets, however little of the wait is left. */
const CONNECT_FLOOR_MS = 1_000;

export async function volleydHealthy(
  opts: { brokerUrl: string; auth: BrokerAuth | null; namespace: string; since: Date } & Wait,
): Promise<string | null> {
  const topic = buildTopic(opts.namespace, "volleyd", "status");
  return poll(opts, async (remaining) => {
    let broker: Awaited<ReturnType<typeof openClient>>;
    const connecting = openClient(opts.brokerUrl, opts.auth);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      broker = await Promise.race([
        connecting,
        new Promise<never>((_, fail) => {
          // A floor, not the sliver left of the deadline: a last poll that starts with 1 ms to go
          // would otherwise report a live broker as unreachable and hide the real reason.
          timer = setTimeout(
            () => fail(new Error("timed out connecting")),
            Math.max(remaining, CONNECT_FLOOR_MS),
          );
        }),
      ]);
    } catch (e) {
      // A client that connects after the timeout is closed, not leaked.
      void connecting.then((late) => late.disconnect()).catch(() => {});
      return `the broker at ${opts.brokerUrl} is unreachable (${e instanceof Error ? e.message : String(e)})`;
    } finally {
      clearTimeout(timer);
    }
    try {
      const raw = await broker.queryRetained(topic, Math.max(500, Math.min(remaining, 1_000)));
      if (raw === null) return `volleyd has no live status at ${topic}`;
      let env: { type?: unknown; wall_time?: unknown };
      try {
        env = JSON.parse(raw) as typeof env;
      } catch {
        return `volleyd's status at ${topic} is not JSON`;
      }
      const type = typeof env.type === "string" ? env.type : "unknown";
      const at = typeof env.wall_time === "string" ? Date.parse(env.wall_time) : Number.NaN;
      if (!(at >= opts.since.getTime())) {
        return `volleyd has not re-registered since the restart (its status is from ${
          Number.isNaN(at) ? "an unknown time" : new Date(at).toISOString()
        })`;
      }
      if (type !== "working") return `volleyd's status is ${type}, not working`;
      return null;
    } finally {
      await broker.disconnect().catch(() => {});
    }
  });
}
