import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VolleyBroker } from "volley-mcp/broker";
import { type Envelope, buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { registryTopic } from "volley-mcp/topics";
import { tempDir } from "./tmp";

export const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const FIXTURES = join(PACKAGE_ROOT, "test", "fixtures");

export type HookName =
  | "session-start"
  | "post-model-switch"
  | "user-prompt-submit"
  | "post-tool-use"
  | "stop"
  | "notification"
  | "pre-compact"
  | "pre-tool-use-lease";

export const HOOK_NAMES: HookName[] = [
  "session-start",
  "post-model-switch",
  "user-prompt-submit",
  "post-tool-use",
  "stop",
  "notification",
  "pre-compact",
  "pre-tool-use-lease",
];

/** A hook stdin sample from test/fixtures with `cwd` pointed at `cwd`. */
export function fixture(
  name: string,
  cwd: string,
  overrides: Record<string, unknown> = {},
): string {
  const raw = JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as Record<string, unknown>;
  return JSON.stringify({ ...raw, cwd, ...overrides });
}

/**
 * A working directory, by default a temp one removed after the test (pass `dir` from a
 * `tempDirForAll` to share one across a describe); with `agent`, it holds `.volley/agent.json`.
 */
export function makeWorkdir(
  agent?: Record<string, unknown>,
  dir: string = tempDir("volley-hooks-"),
): string {
  if (agent !== undefined) {
    mkdirSync(join(dir, ".volley"), { recursive: true });
    writeFileSync(join(dir, ".volley", "agent.json"), JSON.stringify(agent));
  }
  return dir;
}

/**
 * The parent environment minus anything that would leak the developer's own session into a
 * hook under test (Claude Code / cmux / Volley variables), plus `extra`. VOLLEY_AUTH_DIR
 * defaults to an empty temp dir (removed after the test), so a coordinator-mode hook never reads
 * (or sends to a test broker) the host's real `<mosquitto etc>/volley/coordinator.json`. That dir
 * is a `tempDir`: call this (and `runHook` / `runScript`) inside a test or a `beforeEach`.
 */
export function hookEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(VOLLEY_|CLAUDE|CMUX_)/.test(k)) continue;
    env[k] = v;
  }
  // Aedes speaks MQTT 3.1.1 only.
  return {
    VOLLEY_HOOKS_MQTT_VERSION: "4",
    VOLLEY_AUTH_DIR: tempDir("volley-hooks-noauth-"),
    ...env,
    ...extra,
  };
}

export interface HookRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Run `src/hooks/<name>.ts` as Claude Code would: a `bun` process with JSON on stdin. */
export function runHook(
  name: HookName,
  stdin: string,
  opts: { cwd: string; env?: Record<string, string> },
): Promise<HookRun> {
  return runScript(join("src", "hooks", `${name}.ts`), stdin, opts);
}

/** Run a package script (path relative to the package root) with JSON on stdin. */
export function runScript(
  path: string,
  stdin: string,
  opts: { cwd: string; env?: Record<string, string> },
): Promise<HookRun> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [join(PACKAGE_ROOT, path)], {
      cwd: opts.cwd,
      env: hookEnv(opts.env),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    proc.stderr.on("data", (c: Buffer) => err.push(c));
    proc.on("error", reject);
    proc.on("close", (code) =>
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
        ms: Date.now() - started,
      }),
    );
    proc.stdin.end(stdin);
  });
}

/** `hookSpecificOutput.additionalContext` from a hook's stdout, or null. */
export function contextOf(stdout: string): string | null {
  if (stdout.trim() === "") return null;
  const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } };
  return parsed.hookSpecificOutput?.additionalContext ?? null;
}

export async function connectClient(url: string, agentId = "test-observer"): Promise<VolleyBroker> {
  const b = new VolleyBroker();
  await b.connect({ url, agentId });
  return b;
}

/** Collect every envelope on `pattern` until `stop()` is called. */
export async function collect(
  broker: VolleyBroker,
  pattern: string,
): Promise<{ envelopes: Envelope[]; stop: () => Promise<void> }> {
  const envelopes: Envelope[] = [];
  const stop = await broker.subscribeStream(pattern, (m) => {
    const env = parseEnvelope(m.payload);
    if (env !== null) envelopes.push(env);
  });
  return { envelopes, stop };
}

export async function publishEnvelope(
  broker: VolleyBroker,
  topic: string,
  input: Parameters<typeof buildEnvelope>[0] & { namespace?: string },
  opts: { qos: 0 | 1; retain: boolean } = { qos: 1, retain: false },
): Promise<void> {
  const env = {
    ...buildEnvelope(input),
    ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
  };
  await broker.publish(topic, JSON.stringify(env), opts);
}

export async function retainedEnvelope(broker: VolleyBroker, topic: string): Promise<Envelope> {
  const raw = await broker.queryRetained(topic, 1000);
  if (raw === null) throw new Error(`nothing retained at ${topic}`);
  const env = parseEnvelope(raw);
  if (env === null) throw new Error(`retained value at ${topic} is not an envelope`);
  return env;
}

export async function publishRegistry(
  broker: VolleyBroker,
  agentId: string,
  namespace: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await publishEnvelope(
    broker,
    registryTopic(agentId),
    {
      agentId,
      parentId: null,
      channel: "_system/registry",
      type: "registered",
      payload,
      namespace,
    },
    { qos: 1, retain: true },
  );
}

export const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns true or `ms` passes. */
export async function eventually(fn: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await tick(20);
  }
}
