#!/usr/bin/env bun
/**
 * PreToolUse (matcher "Bash"): when `tool_input.command` matches a lease pool's `match` regex
 * (volleyd's `lease_pools`, read from the retained `volley/_waves/_config` and cached for 60 s
 * in the state directory), return `updatedInput` with the command wrapped in
 * `volley lease run --pool <pool> -- <shell> -c '<original>'`, plus `additionalContext` saying
 * so. The wrapper waits for the lease inside the Bash tool call — visible to the agent, no hook
 * timeout involved — and fails open (runs unleased) when no volleyd is live. An already-wrapped
 * command, a non-matching one, or no configured pools: empty output, the command runs as is.
 * The permission decision is never touched.
 *
 * Known gap: an agent can run a heavy command the regexes do not see (from a script file, an
 * alias, `$(…)`); pressure-based spawn admission in volleyd is the backstop.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvelope } from "volley-mcp/envelope";
import { isValidAgentId } from "volley-mcp/topics";
import { type HookContext, type HookResult, runHook } from "../lib/hook-io";
import { writeFileAtomic } from "../lib/seq";

const CONFIG_TOPIC = "volley/_waves/_config";
/** Pool definitions are cached this long, so a pool change reaches the hook within a minute. */
const POOLS_TTL_MS = 60_000;
const READ_MS = 300;

/** A command already running under the lease wrapper (ours, or one the agent typed). */
const WRAPPED = /(^|[\s'"/])(volley|cli\.ts['"]?)\s+lease\s+run\s/;

type Pools = Record<string, { match?: unknown }>;

/**
 * The first pool (config order) with a `match` regex that hits `command`; null when none. Pool
 * names come from a retained broker topic, so one that is not a valid pool id (§2.1 grammar,
 * which volleyd enforces) is skipped: it never reaches the shell command we build.
 */
export function leaseFor(command: string, pools: Pools): string | null {
  for (const [pool, def] of Object.entries(pools)) {
    if (!isValidAgentId(pool)) continue;
    const patterns = Array.isArray(def?.match) ? def.match : [];
    for (const p of patterns) {
      if (typeof p !== "string") continue;
      try {
        if (new RegExp(p).test(command)) return pool;
      } catch {
        // an invalid regex never matches (volleyd validates them; the cache could be stale)
      }
    }
  }
  return null;
}

/** POSIX single-quoting: the result is one shell word whose value is exactly `s`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * How to invoke the CLI: `$VOLLEY_LEASE_CLI` (a shell fragment), else `bun <this repo's
 * volley-cli/src/cli.ts>` when it exists next to this package, else `volley` on PATH.
 */
export function leaseCli(env: Record<string, string | undefined>): string {
  if (env.VOLLEY_LEASE_CLI !== undefined && env.VOLLEY_LEASE_CLI !== "")
    return env.VOLLEY_LEASE_CLI;
  const sibling = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "volley-cli",
    "src",
    "cli.ts",
  );
  return existsSync(sibling) ? `bun ${shellQuote(sibling)}` : "volley";
}

export function wrapCommand(
  command: string,
  o: { pool: string; holder: string; brokerUrl: string; projectDir?: string; cli: string },
): string {
  const dir = o.projectDir !== undefined ? ` --project-dir ${shellQuote(o.projectDir)}` : "";
  return (
    `${o.cli} lease run --pool ${shellQuote(o.pool)} --holder ${shellQuote(o.holder)}` +
    ` --broker-url ${shellQuote(o.brokerUrl)}${dir}` +
    ` -- "\${SHELL:-/bin/sh}" -c ${shellQuote(command)}`
  );
}

/** `lease_pools` from the retained supervisor config, cached in `<stateDir>/lease-pools.json`. */
async function lookupPools(ctx: HookContext): Promise<Pools> {
  const cachePath = join(ctx.identity.stateDir, "lease-pools.json");
  try {
    const c = JSON.parse(readFileSync(cachePath, "utf-8")) as { pools: Pools; fetched_at: number };
    if (Date.now() - c.fetched_at < POOLS_TTL_MS) return c.pools ?? {};
  } catch {
    // no usable cache
  }
  const { connectBroker } = await import("../lib/session");
  let pools: Pools = {};
  const broker = await connectBroker(ctx.identity, ctx.env);
  try {
    const raw = await broker.queryRetained(CONFIG_TOPIC, READ_MS);
    const payload = raw === null ? null : parseEnvelope(raw)?.payload;
    const lp = (payload as { lease_pools?: unknown } | null)?.lease_pools;
    if (typeof lp === "object" && lp !== null && !Array.isArray(lp)) pools = lp as Pools;
  } finally {
    await broker.disconnect();
  }
  writeFileAtomic(cachePath, `${JSON.stringify({ pools, fetched_at: Date.now() })}\n`);
  return pools;
}

export async function handle(ctx: HookContext): Promise<HookResult | null> {
  if (ctx.input.tool_name !== "Bash") return null;
  const toolInput = ctx.input.tool_input as Record<string, unknown> | undefined;
  const command = toolInput?.command;
  if (typeof command !== "string" || command.trim() === "" || WRAPPED.test(command)) return null;
  const pool = leaseFor(command, await lookupPools(ctx));
  if (pool === null) return null;
  const { identity } = ctx;
  return {
    updatedInput: {
      ...toolInput,
      command: wrapCommand(command, {
        pool,
        holder: identity.agentId,
        brokerUrl: identity.brokerUrl,
        // Agent mode: the CLI reads broker credentials from the same .volley/agent.json.
        ...(identity.mode === "agent" ? { projectDir: identity.projectDir } : {}),
        cli: leaseCli(ctx.env),
      }),
    },
    additionalContext: `volley: command queued for a ${pool} lease (the wrapper waits for a free ${pool} slot, then runs it; a \`cd\` inside it does not persist)`,
  };
}

if (import.meta.main) await runHook("PreToolUse", handle);
