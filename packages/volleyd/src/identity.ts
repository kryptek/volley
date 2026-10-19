import { createHash } from "node:crypto";
import { join } from "node:path";
import { isValidAgentId } from "volley-mcp/topics";
import type { ExecFn } from "./exec";
import type { Host } from "./hosts/host";
import { SpawnError } from "./spawn-error";

/**
 * Agent identity: the literal agent id, broker credentials minted for it, and the
 * `.volley/agent.json` (SPEC §6.5, agent-identity.schema.json) both the MCP server and the hooks
 * resolve in the agent's cwd. Nothing about identity travels through flags or env.
 */

/** Broker credentials as `volley auth add-agent --json` prints them. */
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

/**
 * `<wave>-<task>-<role>-<attempt>`, lowercased (agent ids are `[a-z0-9][a-z0-9_-]{0,62}`). An
 * id that would be too long keeps its tail and replaces the overflow of the wave id with a short
 * hash, so it stays unique and recognisable.
 */
export function agentIdFor(wave: string, task: string, role: string, attempt: number): string {
  const tail = `-${task}-${role}-${attempt}`.toLowerCase();
  let id = `${wave}${tail}`.toLowerCase();
  if (id.length > MAX_ID) {
    const hash = createHash("sha256").update(id).digest("hex").slice(0, 6);
    const room = Math.max(1, MAX_ID - tail.length - hash.length - 1);
    id = `${wave.slice(0, room)}-${hash}${tail}`.toLowerCase();
  }
  if (!isValidAgentId(id)) {
    throw new SpawnError("CREDENTIALS_FAILED", `cannot form an agent id from ${wave}/${task}`, {
      agent_id: id,
    });
  }
  return id;
}

/**
 * Mint broker credentials for `agentId` (username = id) with the fenced
 * `volley auth add-agent <id> --ack-to <sender>… --json`. `ackTo` are the senders whose
 * mailboxes the agent must be able to ack (its parent, volleyd). Any failure refuses the spawn.
 */
export async function mintCredentials(
  exec: ExecFn,
  agentId: string,
  ackTo: readonly string[],
): Promise<BrokerCredentials> {
  const argv = ["volley", "auth", "add-agent", agentId];
  for (const s of new Set(ackTo)) argv.push("--ack-to", s);
  argv.push("--json");
  let r: Awaited<ReturnType<ExecFn>>;
  try {
    r = await exec(argv);
  } catch (e) {
    throw new SpawnError(
      "CREDENTIALS_FAILED",
      `volley auth add-agent: ${e instanceof Error ? e.message : String(e)}`,
      { agent_id: agentId },
    );
  }
  if (r.code !== 0) {
    throw new SpawnError("CREDENTIALS_FAILED", `volley auth add-agent exited ${r.code}`, {
      agent_id: agentId,
      stderr: r.stderr.trim(),
    });
  }
  try {
    const c = JSON.parse(r.stdout) as Partial<BrokerCredentials>;
    if (typeof c.username === "string" && c.username !== "" && typeof c.password === "string") {
      return { username: c.username, password: c.password };
    }
  } catch {}
  throw new SpawnError("CREDENTIALS_FAILED", "volley auth add-agent printed no credentials", {
    agent_id: agentId,
  });
}

/**
 * Let minted agent `agentId` also ack `ackTo` (SPEC §4.4 acks go to the sender's mailbox):
 * `volley auth grant <id> --ack-to <sender>…`, which rewrites only its ACL block, so the live
 * agent keeps its password. Throws on failure.
 */
export async function grantAckTo(
  exec: ExecFn,
  agentId: string,
  ackTo: readonly string[],
): Promise<void> {
  const argv = ["volley", "auth", "grant", agentId];
  for (const s of new Set(ackTo)) argv.push("--ack-to", s);
  const r = await exec(argv);
  if (r.code !== 0) {
    throw new Error(`volley auth grant exited ${r.code}: ${r.stderr.trim()}`);
  }
}

/** Revoke an agent's credentials (`volley auth rm-agent`, safe to repeat). True on success. */
export async function revokeCredentials(exec: ExecFn, agentId: string): Promise<boolean> {
  try {
    return (await exec(["volley", "auth", "rm-agent", agentId])).code === 0;
  } catch {
    return false;
  }
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
