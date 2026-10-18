import type { JournalEvent, LeasePoolConfig, NewEvent } from "./types";

/**
 * Heavy-operation lease pools (SPEC §4.6.5), as pure logic. The daemon owns one `LeaseBook`,
 * feeds every input (a request from `volley/_system/leases/<pool>/requests`, a tick, a holder's
 * status change) through `step`, journals the returned events in the `_system` journal and
 * publishes `poolPayload` retained on `volley/_system/leases/<pool>`. `replayLeases` rebuilds
 * the book from that journal on restart, so leases survive a daemon restart.
 *
 * Rules: grants are FIFO and never exceed the pool's current capacity; nothing is ever
 * preempted (a capacity cut, or a pool removed from config, only stops new grants); a lease
 * ends on release, on TTL expiry, or when its holder's status turns terminal. A pool removed
 * from config drops its queued requests (they never started), so their clients stop waiting.
 */

export interface HeldLease {
  lease_id: string;
  holder: string;
  /** When the lease was granted. */
  since: string;
  ttl_s: number;
  /** Grant (or last renewal) time + ttl_s. Internal: not part of the published pool state. */
  expires_at: string;
}

export interface QueuedLease {
  lease_id: string;
  holder: string;
  /** When the request arrived. */
  since: string;
  /** The TTL the lease will get when granted. Internal. */
  ttl_s: number;
}

export interface PoolLeases {
  held: HeldLease[];
  /** FIFO: the first entry is granted next. */
  queue: QueuedLease[];
}

/** Every pool that has (or had, until it emptied) a holder or a queued request. */
export type LeaseBook = Record<string, PoolLeases>;

/** A lease-request payload (lease-request.schema.json). */
export interface LeaseRequest {
  op: "acquire" | "release" | "renew";
  lease_id: string;
  holder: string;
  ttl_s?: number;
}

export type LeaseInput =
  | { kind: "request"; pool: string; req: LeaseRequest }
  | { kind: "tick" }
  | { kind: "holder_status"; holder: string; status: string };

export interface LeaseStepContext {
  /** The pools as currently configured (hot-reloadable: read on every step). */
  pools: Record<string, LeasePoolConfig>;
  now: Date;
  /** TTL for a request that names none, in a pool that sets none. */
  defaultTtlS: number;
}

export interface LeaseStepResult {
  book: LeaseBook;
  /** To journal, in order (each carries its `at`). Empty when nothing changed. */
  events: NewEvent[];
  /** Set when a request was refused (not journaled): why. */
  rejected?: string;
}

/** The lease-pool.schema.json payload. */
export interface LeasePoolPayload {
  pool: string;
  capacity: number;
  held: { lease_id: string; holder: string; since: string; ttl_s: number }[];
  queue: { lease_id: string; holder: string; since: string }[];
  reasons: string[];
}

/** Statuses that end a holder's leases (SPEC §5.1 terminal states, minus `blocked`). */
export const HOLDER_GONE: ReadonlySet<string> = new Set(["reaped", "done", "failed"]);

const LEASE_EVENTS: ReadonlySet<string> = new Set([
  "lease_requested",
  "lease_granted",
  "lease_released",
  "lease_expired",
]);

export const emptyBook = (): LeaseBook => ({});

const plus = (iso: string, seconds: number) =>
  new Date(Date.parse(iso) + seconds * 1000).toISOString();

const has = (p: PoolLeases | undefined, leaseId: string) =>
  p !== undefined &&
  (p.held.some((h) => h.lease_id === leaseId) || p.queue.some((q) => q.lease_id === leaseId));

/**
 * Apply one journal event to the book (pure; non-lease events are ignored). A pool whose last
 * holder and request are gone is dropped from the book.
 */
export function applyLeaseEvent(book: LeaseBook, ev: JournalEvent | NewEvent): LeaseBook {
  if (!LEASE_EVENTS.has(ev.type)) return book;
  const d = ev.data as {
    pool: string;
    lease_id: string;
    holder: string;
    ttl_s?: number;
    renewed?: boolean;
  };
  const at = ev.at ?? new Date().toISOString();
  const prev = book[d.pool] ?? { held: [], queue: [] };
  const p: PoolLeases = { held: [...prev.held], queue: [...prev.queue] };
  const ttl = d.ttl_s ?? 0;
  switch (ev.type) {
    case "lease_requested":
      if (!has(p, d.lease_id))
        p.queue.push({ lease_id: d.lease_id, holder: d.holder, since: at, ttl_s: ttl });
      break;
    case "lease_granted":
      if (d.renewed === true) {
        p.held = p.held.map((h) =>
          h.lease_id === d.lease_id ? { ...h, ttl_s: ttl, expires_at: plus(at, ttl) } : h,
        );
      } else {
        p.queue = p.queue.filter((q) => q.lease_id !== d.lease_id);
        if (!p.held.some((h) => h.lease_id === d.lease_id)) {
          p.held.push({
            lease_id: d.lease_id,
            holder: d.holder,
            since: at,
            ttl_s: ttl,
            expires_at: plus(at, ttl),
          });
        }
      }
      break;
    case "lease_released":
      p.held = p.held.filter((h) => h.lease_id !== d.lease_id);
      p.queue = p.queue.filter((q) => q.lease_id !== d.lease_id);
      break;
    case "lease_expired":
      p.held = p.held.filter((h) => h.lease_id !== d.lease_id);
      break;
  }
  const next = { ...book };
  if (p.held.length === 0 && p.queue.length === 0) delete next[d.pool];
  else next[d.pool] = p;
  return next;
}

/** Rebuild the book from journal events (the `_system` journal holds other events too). */
export function replayLeases(events: readonly JournalEvent[]): LeaseBook {
  return events.reduce(applyLeaseEvent, emptyBook());
}

/**
 * One input → the events it causes, applied. After the input itself, every step expires leases
 * past their TTL, drops the queued requests of pools no longer configured, and then grants
 * queued requests FIFO while a pool is under its current capacity — so a capacity increase is
 * granted on the next tick and a decrease only waits for releases.
 */
export function step(book: LeaseBook, input: LeaseInput, ctx: LeaseStepContext): LeaseStepResult {
  const at = ctx.now.toISOString();
  const events: NewEvent[] = [];
  let cur = book;
  const emit = (type: NewEvent["type"], data: Record<string, unknown>) => {
    const ev: NewEvent = { type, at, data };
    events.push(ev);
    cur = applyLeaseEvent(cur, ev);
  };
  let rejected: string | undefined;

  if (input.kind === "request") {
    const { pool, req } = input;
    const p = cur[pool];
    const cfg = Object.hasOwn(ctx.pools, pool) ? ctx.pools[pool] : undefined;
    const ref = { pool, lease_id: req.lease_id, holder: req.holder };
    const heldBy = p?.held.find((h) => h.lease_id === req.lease_id);
    const queuedBy = p?.queue.find((q) => q.lease_id === req.lease_id);
    if (req.op === "release") {
      // Releases work even for a removed pool: that is how it drains.
      if (heldBy?.holder === req.holder) emit("lease_released", { ...ref, reason: "released" });
      else if (queuedBy?.holder === req.holder)
        emit("lease_released", { ...ref, reason: "cancelled" });
    } else if (cfg === undefined) {
      rejected = `pool ${pool} is not configured`;
    } else if (req.op === "acquire") {
      if (heldBy === undefined && queuedBy === undefined) {
        emit("lease_requested", { ...ref, ttl_s: req.ttl_s ?? cfg.ttl_s ?? ctx.defaultTtlS });
      }
    } else if (heldBy?.holder === req.holder) {
      emit("lease_granted", {
        ...ref,
        ttl_s: req.ttl_s ?? heldBy.ttl_s,
        renewed: true,
      });
    }
  } else if (input.kind === "holder_status" && HOLDER_GONE.has(input.status)) {
    for (const [pool, p] of Object.entries(cur)) {
      for (const l of [...p.held, ...p.queue]) {
        if (l.holder !== input.holder) continue;
        emit("lease_released", {
          pool,
          lease_id: l.lease_id,
          holder: l.holder,
          reason: `holder ${input.status}`,
        });
      }
    }
  }

  for (const [pool, p] of Object.entries(cur)) {
    for (const h of p.held) {
      if (Date.parse(h.expires_at) <= ctx.now.getTime()) {
        emit("lease_expired", { pool, lease_id: h.lease_id, holder: h.holder });
      }
    }
  }
  for (const [pool, p] of Object.entries(cur)) {
    if (Object.hasOwn(ctx.pools, pool)) continue;
    for (const q of p.queue) {
      emit("lease_released", {
        pool,
        lease_id: q.lease_id,
        holder: q.holder,
        reason: "pool removed",
      });
    }
  }
  for (const pool of Object.keys(cur)) {
    const cfg = Object.hasOwn(ctx.pools, pool) ? ctx.pools[pool] : undefined;
    if (cfg === undefined) continue;
    for (;;) {
      const p = cur[pool];
      const next = p?.queue[0];
      if (p === undefined || next === undefined || p.held.length >= cfg.capacity) break;
      emit("lease_granted", {
        pool,
        lease_id: next.lease_id,
        holder: next.holder,
        ttl_s: next.ttl_s,
      });
    }
  }

  return { book: cur, events, ...(rejected !== undefined ? { rejected } : {}) };
}

/**
 * The retained pool state. `reasons` explains the queue; a pool removed from config reports
 * capacity 0 and says new requests are rejected, until its last holder releases.
 */
export function poolPayload(
  pool: string,
  book: LeaseBook,
  pools: Record<string, LeasePoolConfig>,
  extraReasons: readonly string[] = [],
): LeasePoolPayload {
  const p = book[pool] ?? { held: [], queue: [] };
  const cfg = Object.hasOwn(pools, pool) ? pools[pool] : undefined;
  const capacity = cfg?.capacity ?? 0;
  const reasons: string[] = [];
  if (cfg === undefined) reasons.push(`pool ${pool} removed from config: new requests rejected`);
  else if (p.queue.length > 0)
    reasons.push(`queued: ${p.held.length}/${capacity} ${pool} leases held`);
  reasons.push(...extraReasons);
  return {
    pool,
    capacity,
    held: p.held.map(({ lease_id, holder, since, ttl_s }) => ({ lease_id, holder, since, ttl_s })),
    queue: p.queue.map(({ lease_id, holder, since }) => ({ lease_id, holder, since })),
    reasons,
  };
}
