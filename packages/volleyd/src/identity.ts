import { createHash } from "node:crypto";
import { join } from "node:path";
import { isValidAgentId } from "volley-mcp/topics";
import type { Host } from "./hosts/host";
import { SpawnError } from "./spawn-error";

/**
 * Agent identity: the literal agent id, broker credentials minted for it, and the
 * `.volley/agent.json` (SPEC §6.5, agent-identity.schema.json) both the MCP server and the hooks
 * resolve in the agent's cwd. Nothing about identity travels through flags or env.
 */

/** Broker credentials: the `broker` block of `.volley/agent.json`. */
export interface BrokerCredentials {
  username: string;
  password: string;
}

/** The contents of `.volley/agent.json`. */
export interface AgentIdentityFile {
  agent_id: string;
  namespace: string;
  parent_id: string | null;
  wave: string;
  task: string;
  role: string;
  broker_url: string;
  /** The Claude account profile the agent runs under (`primary`: the default profile). */
  claude_account?: string;
  broker?: BrokerCredentials;
}

const MAX_ID = 63;

const HASH = 6;
/** The shortest head a shortened id keeps: one wave character, `-` and the hash. */
const MIN_HEAD = 1 + 1 + HASH;

const shortHash = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, HASH);

/**
 * `<wave>-<task>-<role>-<attempt>`, lowercased (agent ids are `[a-z0-9][a-z0-9_-]{0,62}`). An
 * id that would be too long keeps its tail and replaces the overflow of the wave id with a short
 * hash, so it stays unique and recognisable. A task id so long that the tail alone leaves no room
 * (a flake fixer's `fix-<test>` under a reviewer's role) is cut too, its overflow replaced by a
 * hash of the whole task id.
 */
export function agentIdFor(wave: string, task: string, role: string, attempt: number): string {
  const rest = `-${role}-${attempt}`;
  let t = task.toLowerCase();
  // Only an id that could not be formed otherwise is cut here: every other one keeps its shape.
  const room = MAX_ID - MIN_HEAD - rest.length - 1;
  if (wave.length + 1 + t.length + rest.length > MAX_ID && t.length > room) {
    const head = t.slice(0, Math.max(0, room - HASH - 1)).replace(/-+$/, "");
    t = head ? `${head}-${shortHash(t)}` : shortHash(t);
  }
  return idWithTail(wave, `-${t}${rest}`, task);
}

/**
 * A release stage's agent (SPEC §4.6.19): `<wave>-release-<stage>-<attempt>` (stage names are
 * agent-id-shaped), shortened like `agentIdFor`.
 */
export function releaseAgentId(wave: string, stage: string, attempt: number): string {
  return idWithTail(wave, `-release-${stage}-${attempt}`, `release stage ${stage}`);
}

function idWithTail(wave: string, rawTail: string, what: string): string {
  const tail = rawTail.toLowerCase();
  let id = `${wave}${tail}`.toLowerCase();
  if (id.length > MAX_ID) {
    const hash = shortHash(id);
    const room = Math.max(1, MAX_ID - tail.length - hash.length - 1);
    id = `${wave.slice(0, room)}-${hash}${tail}`.toLowerCase();
  }
  if (!isValidAgentId(id)) {
    // The same parts never form one: retrying cannot help.
    throw new SpawnError(
      "CREDENTIALS_FAILED",
      `cannot form an agent id from ${wave}/${what}`,
      { agent_id: id },
      { permanent: true },
    );
  }
  return id;
}

/**
 * Where agent logins come from: volleyd's Dynamic Security control connection (dynsec.ts) in
 * production, an in-memory store in tests.
 */
export interface AgentCredentials {
  /** A fresh login for `agentId` (username = id, role volley-agent). Throws on failure. */
  mint: (agentId: string) => Promise<BrokerCredentials>;
  /** Delete `agentId`'s login (already gone counts); false on failure. Never throws. */
  revoke: (agentId: string) => Promise<boolean>;
}

/** Credentials the sweep can also enumerate. */
export interface CredentialStore extends AgentCredentials {
  /** Every agent login on the broker. */
  agentLogins: () => Promise<string[]>;
  /** When this daemon minted each login it still knows of. */
  readonly mintedAt: ReadonlyMap<string, number>;
}

/**
 * Mint `agentId`'s broker login. Its acks reach volleyd's and the Desk's mailboxes through the
 * shared role; nothing is granted per agent. Any failure refuses the spawn.
 */
export async function mintCredentials(
  creds: AgentCredentials | undefined,
  agentId: string,
): Promise<BrokerCredentials> {
  if (creds === undefined) {
    throw new SpawnError(
      "CREDENTIALS_FAILED",
      "no admin login for the broker's Dynamic Security plugin ($VOLLEYD_HOME/dynsec-admin.json, from `volley auth init --volleyd-file`); or run volleyd with --no-mint on an open broker",
      { agent_id: agentId },
    );
  }
  try {
    return await creds.mint(agentId);
  } catch (e) {
    throw new SpawnError(
      "CREDENTIALS_FAILED",
      `minting ${agentId}'s broker login: ${e instanceof Error ? e.message : String(e)}`,
      { agent_id: agentId },
    );
  }
}

/** Revoke an agent's login (safe to repeat). True on success, null with no credential store. */
export async function revokeCredentials(
  creds: AgentCredentials | undefined,
  agentId: string,
): Promise<boolean> {
  return creds === undefined ? false : creds.revoke(agentId);
}

export const agentJsonPath = (worktree: string) => join(worktree, ".volley", "agent.json");

/** Write `.volley/agent.json` with mode 0600 (it holds the agent's broker password). */
export async function writeAgentJson(
  host: Host,
  worktree: string,
  identity: AgentIdentityFile,
): Promise<string> {
  const path = agentJsonPath(worktree);
  await host.writeFile(path, `${JSON.stringify(identity, null, 2)}\n`, 0o600);
  return path;
}
