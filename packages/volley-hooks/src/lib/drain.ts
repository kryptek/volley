import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseEnvelope } from "volley-mcp/envelope";
import type { HookContext } from "./hook-io";
import type { HookIdentity } from "./identity";
import { releaseLock, tryLock } from "./seq";
import { HookSession, connectDrain, openSession, readActivity, writeActivity } from "./session";
import { appendBlock, hasBlock, liveDirectives, markSuperseded } from "./steering-file";

/** One mailbox message as the drain sees it. */
export interface MailMessage {
  /** The message id (envelope `correlation_id`); null when the sender set none. */
  id: string | null;
  from: string;
  type: string;
  seq: number | null;
  supersedes: string | null;
  text: string;
  at: string;
}

const TOKEN = /^\S+$/;

export function parseMail(raw: string): MailMessage | null {
  const env = parseEnvelope(raw);
  if (env === null || env.channel !== "mailbox" || !TOKEN.test(env.type)) return null;
  const p = (typeof env.payload === "object" && env.payload !== null ? env.payload : {}) as {
    text?: unknown;
    seq?: unknown;
    supersedes?: unknown;
  };
  const id =
    env.correlation_id !== null && TOKEN.test(env.correlation_id) ? env.correlation_id : null;
  return {
    id,
    from: env.agent_id,
    type: env.type,
    seq: typeof p.seq === "number" && Number.isSafeInteger(p.seq) && p.seq >= 0 ? p.seq : null,
    supersedes: typeof p.supersedes === "string" && TOKEN.test(p.supersedes) ? p.supersedes : null,
    text: typeof p.text === "string" ? p.text : "",
    at: env.wall_time,
  };
}

/**
 * Open this hook's session. With `drain`, take `.volley/drain.lock` and, if it is free,
 * connect the persistent drain session and drain the mailbox; if another hook holds the lock
 * (parallel PostToolUse), fall back to a clean session and drain nothing — the holder drains.
 * Closing the session releases the lock.
 */
export async function openDrainSession(
  identity: HookIdentity,
  ctx: Pick<HookContext, "env" | "event">,
  drain: boolean,
): Promise<{ session: HookSession; drained: MailMessage[] | null }> {
  const lock = join(identity.stateDir, "drain.lock");
  if (!drain || !tryLock(lock)) {
    return { session: await openSession(identity, ctx.event), drained: null };
  }
  let session: HookSession;
  try {
    session = new HookSession(identity, await connectDrain(identity, ctx.env), ctx.event, () =>
      releaseLock(lock),
    );
  } catch (e) {
    releaseLock(lock);
    throw e;
  }
  try {
    const raw = await session.broker.drainQueued(session.topic("mailbox"), {
      idleMs: 150,
      maxWaitMs: 2000,
    });
    const drained = raw.map((m) => parseMail(m.payload)).filter((m) => m !== null);
    return { session, drained };
  } catch (e) {
    await session.close();
    throw e;
  }
}

const steeringPath = (identity: HookIdentity) => join(identity.stateDir, "STEERING.md");

/** Publish the SPEC §4.4 `ack` to the sender's mailbox. */
function ack(session: HookSession, m: MailMessage & { id: string }): Promise<void> {
  return session.publish(
    session.topic("mailbox", m.from),
    "mailbox",
    "ack",
    { text: "ACKED", acked_type: m.type, ...(m.seq !== null ? { seq: m.seq } : {}) },
    { qos: 1, retain: false, correlationId: m.id },
  );
}

function describe(m: { type: string; from: string; id: string; seq: number | null }): string {
  const label = m.type === "cancel" ? "CANCEL (stop your current task)" : m.type;
  return `${label} from ${m.from} (id ${m.id}${m.seq !== null ? `, seq ${m.seq}` : ""})`;
}

const ACT_ON_IT =
  'Reply with an explicit "acknowledged: …" line AND publish ' +
  "vol_publish(channel='progress', type='steering_acked', correlation_id=<id>) " +
  "once you have acted on it.";

export function formatSteering(
  heading: string,
  items: { type: string; from: string; id: string; seq: number | null; text: string }[],
): string {
  const body = items.map((m, i) => `${i + 1}. ${describe(m)}:\n${m.text}`).join("\n\n");
  return `${heading}\n\n${body}\n\n${ACT_ON_IT}`;
}

/**
 * Record, ack and format drained mail. Each directive is appended to STEERING.md before it is
 * acked (a crash in between re-delivers nothing, but the directive is on disk). A message
 * already in STEERING.md is re-acked, not re-injected. `supersedes` marks the older block
 * (same sender only); only directives still live are injected. Acks addressed to this agent
 * are reported, never stored or acked (SPEC §4.4).
 */
export async function processMail(
  session: HookSession,
  messages: MailMessage[],
): Promise<string | null> {
  const path = steeringPath(session.identity);
  const ordered = messages
    .map((m, i) => ({ m, i }))
    .sort(
      (a, b) =>
        (a.m.seq ?? Number.POSITIVE_INFINITY) - (b.m.seq ?? Number.POSITIVE_INFINITY) || a.i - b.i,
    )
    .map(({ m }) => m);

  const notes: string[] = [];
  const fresh: (MailMessage & { id: string })[] = [];
  for (const m of ordered) {
    if (m.type === "ack") {
      if (m.id !== null) notes.push(`[volley] ${m.from} acknowledged your message ${m.id}.`);
      continue;
    }
    const withId = { ...m, id: m.id ?? `local-${randomUUID()}` };
    if (m.id !== null && hasBlock(path, m.id)) {
      await ack(session, withId);
      continue;
    }
    appendBlock(path, {
      seq: m.seq,
      type: m.type,
      id: withId.id,
      from: m.from,
      at: m.at,
      text: m.text,
    });
    if (m.supersedes !== null) markSuperseded(path, m.supersedes, withId.id, m.from);
    if (m.id !== null) await ack(session, withId);
    fresh.push(withId);
  }

  const live = new Set(liveDirectives(path).map((b) => b.id));
  const inject = fresh.filter((m) => live.has(m.id));
  const parts = [...notes];
  if (inject.length > 0) {
    parts.push(
      formatSteering(
        `[volley steering] ${inject.length} message(s) from your Volley mailbox, oldest first:`,
        inject,
      ),
    );
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Publish `resumed` when the last recorded activity was idle / awaiting input, and record
 * that the agent is working again.
 */
export async function markWorking(session: HookSession): Promise<void> {
  const { stateDir } = session.identity;
  const prev = readActivity(stateDir);
  if (prev?.state === "working") return;
  if (prev !== null) await session.progress("resumed", { previous: prev.state });
  writeActivity(stateDir, {
    state: "working",
    at: new Date().toISOString(),
    hook_event: session.hookEvent,
  });
}

/** `VOLLEY_HOOKS_DRAIN_MATCHER` (a regex on `tool_name`) narrows which PostToolUse calls drain. */
export function drainsFor(ctx: Pick<HookContext, "event" | "input" | "env">): boolean {
  const pattern = ctx.env.VOLLEY_HOOKS_DRAIN_MATCHER;
  if (ctx.event !== "PostToolUse" || pattern === undefined || pattern === "") return true;
  try {
    return new RegExp(pattern).test(String(ctx.input.tool_name ?? ""));
  } catch {
    return true;
  }
}

/** UserPromptSubmit / PostToolUse: resumed if needed, drain + inject + ack, heartbeat. */
export async function drainHook(ctx: HookContext): Promise<string | null> {
  const { session, drained } = await openDrainSession(ctx.identity, ctx, drainsFor(ctx));
  try {
    await markWorking(session);
    const context = drained === null ? null : await processMail(session, drained);
    await session.heartbeat();
    return context;
  } finally {
    await session.close();
  }
}
