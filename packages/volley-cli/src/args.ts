import { type BrokerAuth, resolveBrokerAuth } from "volley-mcp/config";
import { isValidNamespace } from "volley-mcp/topics";
import { type SavedLoginDeps, savedCoordinatorLogin } from "./auth/coordinator-login";

export interface ParsedGlobal {
  subcommand: string | null;
  rest: string[];
}

/** Split argv into (subcommand, rest). Subcommand is the first positional, or `--help`/`--version` if those appear before any other arg. */
export function parseGlobal(argv: string[]): ParsedGlobal {
  if (argv.length === 0) return { subcommand: null, rest: [] };
  const first = argv[0] ?? "";
  return { subcommand: first, rest: argv.slice(1) };
}

/** Comma-separated string → trimmed, non-empty values. */
export function parseCsv(input: string | undefined): string[] {
  if (input === undefined || input === "") return [];
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Positive integer (1, 2, ...). Used for `--timeout`, `--max-messages`, and any other numeric flag.
 * Pass `flagName` so the error message tells the user which flag was bad.
 */
export function parsePositiveInt(input: string, flagName?: string): number {
  if (!/^[1-9][0-9]*$/.test(input)) {
    const prefix = flagName !== undefined ? `${flagName} ` : "";
    throw new Error(`${prefix}must be a positive integer, got "${input}"`);
  }
  return Number.parseInt(input, 10);
}

/** Parse a `--payload` argument: either undefined (→ `{}`) or a JSON object literal. */
export function parseJsonPayload(input: string | undefined): Record<string, unknown> {
  if (input === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error(`--payload is invalid JSON: ${input}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`--payload must be a JSON object, got ${typeof parsed}`);
  }
  return parsed as Record<string, unknown>;
}

const VALID_LIFECYCLE_TYPES = [
  "spawning",
  "working",
  "done",
  "blocked",
  "failed",
  "reaped",
  "registered",
  // volleyd's morning digest push (SPEC §4.6.16): a `progress` envelope, one per digest.
  "digest",
] as const;
const VALID_LIFECYCLE_SET = new Set<string>(VALID_LIFECYCLE_TYPES);

const VALID_SURFACES = ["bell", "desktop", "webhook"] as const;
const VALID_SURFACE_SET = new Set<string>(VALID_SURFACES);

/** Parse and validate the `--on` CSV. Throws on empty input or any unknown lifecycle type. */
export function parseLifecycleEventCsv(input: string): string[] {
  const parsed = parseCsv(input);
  if (parsed.length === 0) {
    throw new Error("--on must list at least one lifecycle type");
  }
  for (const v of parsed) {
    if (!VALID_LIFECYCLE_SET.has(v)) {
      throw new Error(
        `--on: unknown lifecycle type "${v}" (valid: ${VALID_LIFECYCLE_TYPES.join(",")})`,
      );
    }
  }
  return parsed;
}

/** Parse and validate the `--surface` CSV. Throws on empty input or any unknown surface. */
export function parseSurfaceCsv(input: string): string[] {
  const parsed = parseCsv(input);
  if (parsed.length === 0) {
    throw new Error("--surface must list at least one surface");
  }
  for (const v of parsed) {
    if (!VALID_SURFACE_SET.has(v)) {
      throw new Error(`--surface: unknown surface "${v}" (valid: ${VALID_SURFACES.join(",")})`);
    }
  }
  return parsed;
}

/** Flag > env > null for the webhook URL. Throws on a non-http(s) scheme. */
export function resolveWebhookUrl(
  flag: string | undefined,
  env: Record<string, string | undefined>,
): string | null {
  const v = flag ?? env.VOLLEY_NOTIFY_WEBHOOK_URL ?? null;
  if (v === null) return null;
  if (!/^https?:\/\//.test(v)) {
    throw new Error(`--webhook-url must start with http:// or https://, got "${v}"`);
  }
  return v;
}

const DEFAULT_BROKER_URL = "mqtt://localhost:1883";

/** Flag > env > default. Pure — env is passed in. */
export function resolveBrokerUrl(
  flag: string | undefined,
  env: Record<string, string | undefined>,
): string {
  return flag ?? env.VOLLEY_BROKER_URL ?? DEFAULT_BROKER_URL;
}

/** Flag > env > "default". Validates the grammar (SPEC §2.1). */
export function resolveNamespace(
  flag: string | undefined,
  env: Record<string, string | undefined>,
): string {
  const ns = flag ?? env.VOLLEY_NAMESPACE ?? "default";
  if (!isValidNamespace(ns)) {
    throw new Error(`namespace "${ns}" does not match [a-z0-9][a-z0-9_-]{0,62}`);
  }
  return ns;
}

/**
 * Broker credentials: `--username`/`--password` flags win, then the `broker` block of
 * `<cwd>/.volley/agent.json`, then `VOLLEY_AUTH_USERNAME`/`VOLLEY_AUTH_PASSWORD`, then (given
 * `brokerUrl`, a broker on this machine, an operator not an agent, and the fallback turned on by
 * the entry point) the coordinator login `volley setup` saved; null means anonymous. Flags pass straight through so the caller can override an identity file; a
 * `--username` without `--password` takes the password from `VOLLEY_AUTH_PASSWORD`.
 */
export function resolveAuth(
  flags: { username?: string | undefined; password?: string | undefined },
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
  brokerUrl?: string,
  saved?: SavedLoginDeps,
): BrokerAuth | null {
  if (flags.username !== undefined) {
    // `--username` + VOLLEY_AUTH_PASSWORD is the documented way to keep the password off argv.
    const password = flags.password ?? env.VOLLEY_AUTH_PASSWORD;
    return password !== undefined
      ? { username: flags.username, password }
      : { username: flags.username };
  }
  if (flags.password !== undefined) throw new Error("--password requires --username");
  return (
    resolveBrokerAuth(env, cwd) ??
    (brokerUrl !== undefined ? savedCoordinatorLogin(env, brokerUrl, cwd, saved) : null)
  );
}
