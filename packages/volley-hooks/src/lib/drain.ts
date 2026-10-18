import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseEnvelope } from "volley-mcp/envelope";
import type { HookContext } from "./hook-io";
import type { HookIdentity } from "./identity";
import { drainLockStaleMs, releaseLock, tryLock } from "./seq";
import {
  HookSession,
  connectDrain,
  ensureHarnessModel,
  openSession,
  readActivity,
  writeActivity,
} from "./session";
import {
  appendBlock,
  hasBlock,
  markDelivered,
  markSuperseded,
  undeliveredDirectives,
} from "./steering-file";

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
 * The caller MUST call `release` (it frees the lock, if held) once the drained directives
 * have been emitted; closing the session does not.
 */
export async function openDrainSession(
  identity: HookIdentity,
  ctx: Pick<HookContext, "env" | "event">,
  drain: boolean,
): Promise<{ session: HookSession; drained: MailMessage[] | null; release: () => void }> {
  const lock = join(identity.stateDir, "drain.lock");
  const token = drain ? tryLock(lock, drainLockStaleMs(ctx.env)) : null;
  if (token === null) {
    return {
      session: await openSession(identity, ctx.event, ctx.env),
      drained: null,
      release: () => {},
    };
  }
  const release = () => releaseLock(lock, token);
  let session: HookSession;
  try {
    session = new HookSession(identity, await connectDrain(identity, ctx.env), ctx.event);
  } catch (e) {
    release();
    throw e;
  }
  try {
    const raw = await session.broker.drainQueued(session.topic("mailbox"), {
      idleMs: 150,
      maxWaitMs: 2000,
    });
    const drained = raw.map((m) => parseMail(m.payload)).filter((m) => m !== null);
    return { session, drained, release };
  } catch (e) {
    await session.close();
    release();
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
  footer: string | null = ACT_ON_IT,
): string {
  const body = items.map((m, i) => `${i + 1}. ${describe(m)}:\n${m.text}`).join("\n\n");
  return footer === null ? `${heading}\n\n${body}` : `${heading}\n\n${body}\n\n${footer}`;
}

/**
 * Record, ack and format drained mail. Each directive is appended to STEERING.md before it is
 * acked; it is marked delivered only once the hook's stdout has been written (see
 * `drainHook`). Every live directive not yet delivered is injected — new mail, and any that
 * an earlier hook stored and acked but died before emitting — so an ack never strands a
 * directive. A message already in STEERING.md is re-acked, not stored twice. `supersedes`
 * marks the older block (same sender only). Acks addressed to this agent are reported, never
 * stored or acked (SPEC §4.4). Returns the context and the ids to mark delivered.
 */
export async function processMail(
  session: HookSession,
  messages: MailMessage[],
): Promise<{ text: string | null; ids: string[] }> {
  const path = steeringPath(session.identity);
  const ordered = messages
    .map((m, i) => ({ m, i }))
    .sort(
      (a, b) =>
        (a.m.seq ?? Number.POSITIVE_INFINITY) - (b.m.seq ?? Number.POSITIVE_INFINITY) || a.i - b.i,
    )
    .map(({ m }) => m);

  const notes: string[] = [];
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
  }

  const inject = undeliveredDirectives(path);
  const parts = [...notes];
  if (inject.length > 0) {
    parts.push(
      formatSteering(
        `[volley steering] ${inject.length} message(s) from your Volley mailbox:`,
        inject,
      ),
    );
  }
  return { text: parts.length > 0 ? parts.join("\n\n") : null, ids: inject.map((b) => b.id) };
}

/**
 * Once the context naming `ids` is on stdout, mark them delivered; then free the drain lock
 * (held until now so a concurrent drain cannot inject the same directives again).
 */
export function deliverAfterEmit(
  ctx: Pick<HookContext, "afterEmit">,
  stateDir: string,
  ids: string[],
  release: () => void,
): void {
  ctx.afterEmit((emitted) => {
    try {
      if (emitted && ids.length > 0) markDelivered(join(stateDir, "STEERING.md"), ids);
    } finally {
      release();
    }
  });
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
  const { session, drained, release } = await openDrainSession(ctx.identity, ctx, drainsFor(ctx));
  let handedOff = false;
  try {
    await markWorking(session);
    await ensureHarnessModel(session);
    const mail = drained === null ? null : await processMail(session, drained);
    await session.heartbeat();
    if (mail !== null) {
      deliverAfterEmit(ctx, ctx.identity.stateDir, mail.ids, release);
      handedOff = true;
    }
    return mail?.text ?? null;
  } finally {
    await session.close();
    if (!handedOff) release();
  }
}
