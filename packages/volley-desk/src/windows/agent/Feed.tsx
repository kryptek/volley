/**
 * The agent window's Volley feed (prototype `AgentWindow` feed tab): every envelope the store kept for the agent
 * (registry, status, progress, result, mailbox), oldest first and newest last,
 * auto-scrolled to the bottom. Clicking a row toggles the pretty JSON of the
 * real envelope as it arrived, not a reconstruction.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { FeedEntry } from "../../store/types";

/** Within this many px of the bottom the feed keeps following new rows. */
const FOLLOW_PX = 24;

export function entryTime(e: FeedEntry): number {
  const t = Date.parse(e.envelope.wall_time ?? "");
  return Number.isNaN(t) ? e.receivedAt : t;
}

/** Channel slug for the row class: the topic's channel segment, or `registry`. */
export function feedChannel(e: FeedEntry): string {
  if (e.topic.startsWith("volley/_system/registry/")) return "registry";
  return e.topic.split("/").at(-1) ?? e.envelope.channel;
}

function summary(e: FeedEntry): string {
  const p = e.envelope.payload;
  if (p === null || typeof p !== "object") return typeof p === "string" ? p : "";
  const r = p as Record<string, unknown>;
  for (const k of ["msg", "text", "question", "summary", "reason"]) {
    if (typeof r[k] === "string" && r[k] !== "") return r[k] as string;
  }
  if (typeof r.model === "string") return r.model;
  return "";
}

function clock(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

export function Feed({ feed }: { feed: readonly FeedEntry[] }) {
  const [open, setOpen] = useState<FeedEntry | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  // Stable sort: equal timestamps keep arrival order.
  const rows = feed
    .map((e, i) => ({ e, i, t: entryTime(e) }))
    .sort((a, b) => a.t - b.t || a.i - b.i);

  useLayoutEffect(() => {
    const el = list.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  });

  if (rows.length === 0) return <div className="feed feed--empty dim">no envelopes yet</div>;
  return (
    <div
      className="feed"
      ref={list}
      onScroll={(ev) => {
        const el = ev.currentTarget;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX;
      }}
    >
      {rows.map(({ e, i, t }) => {
        const ch = feedChannel(e);
        const isOpen = open === e;
        return (
          <div
            key={String(e.envelope.message_id ?? `${e.receivedAt}-${i}`)}
            className={`env ch-${ch}`}
          >
            <button
              type="button"
              className="env-row"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : e)}
            >
              <span className="mono dim">{clock(t)}</span>
              <span className="env-ch">{ch}</span>
              <span className="env-type">{e.envelope.type}</span>
              <span className="env-msg">{summary(e)}</span>
            </button>
            {isOpen && <pre className="env-json">{JSON.stringify(e.envelope, null, 2)}</pre>}
          </div>
        );
      })}
    </div>
  );
}
