/**
 * The agent window's Volley feed (prototype `AgentWindow` feed tab): every envelope the store kept for the agent
 * (registry, status, progress, result, mailbox), oldest first and newest last,
 * auto-scrolled to the bottom while the reader is there. Clicking a row toggles the pretty JSON of the
 * real envelope as it arrived, not a reconstruction. volleyd's control traffic (a mailbox `query`
 * with `payload.op` and its reply) is not shown: it is the daemon's, not a conversation with the agent.
 * Heartbeats are liveness (the footer's dot and age), not rows: the store only counts them, and
 * the "show heartbeats" toggle (off by default) adds one collapsed `heartbeat ×N · last 3s` row at
 * the end. Autopilot's events on the agent's task (SPEC §4.6.16) read as their line
 * (`Autopilot · relaunch (<policy>): <rationale>`), the evidence in their JSON; its account events
 * (SPEC §4.6.11) as `Account · <why>` and `Account · moved off <from> to <to> by <by>: <why>`.
 */
import { type UIEvent, useLayoutEffect, useRef, useState } from "react";
import { autopilotLine } from "../../store/autopilot";
import { accountLine } from "../../store/claude";
import { isControlTraffic } from "../../store/reducer";
import type { FeedEntry } from "../../store/types";

/** Some text inside `el` is selected (the reader is copying it). */
function selectedIn(el: Element): boolean {
  const sel = typeof window === "undefined" ? null : window.getSelection();
  if (!sel || sel.isCollapsed || sel.toString() === "") return false;
  return el.contains(sel.anchorNode) || el.contains(sel.focusNode);
}

/** Within this many px of the bottom a scroller keeps following new content. */
const FOLLOW_PX = 24;

/**
 * Keep a scroller pinned to the bottom when `content` changes, but only while
 * the reader is already at the bottom: scrolling up stops following, scrolling
 * back down resumes it. Re-renders with unchanged content never scroll.
 */
export function useFollow<T extends HTMLElement>(content: unknown) {
  const ref = useRef<T>(null);
  const follow = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll only when the content changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [content]);
  const onScroll = (ev: UIEvent<T>) => {
    const el = ev.currentTarget;
    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX;
  };
  return { ref, onScroll };
}

/**
 * Row identity for React keys. Envelopes carry no id on the wire and the
 * store never recreates a `FeedEntry`, so each entry gets a number the first
 * time it is rendered; keys survive the ring dropping its oldest entries.
 */
const rowIds = new WeakMap<FeedEntry, number>();
let nextRowId = 0;
function rowId(e: FeedEntry): number {
  let id = rowIds.get(e);
  if (id === undefined) {
    id = nextRowId++;
    rowIds.set(e, id);
  }
  return id;
}

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
  const auto = autopilotLine(e.envelope) ?? accountLine(e.envelope);
  if (auto !== null) return auto;
  const p = e.envelope.payload;
  if (p === null || typeof p !== "object") return typeof p === "string" ? p : "";
  const r = p as Record<string, unknown>;
  for (const k of ["msg", "text", "question", "summary", "reason"]) {
    if (typeof r[k] === "string" && r[k] !== "") return r[k] as string;
  }
  if (typeof r.model === "string") return r.model;
  return "";
}

/** `3s`, `4m`, `1.2h` (the agent footer's `age`). */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

export function Feed({
  feed,
  noSignal = false,
  heartbeats,
  now,
}: {
  feed: readonly FeedEntry[];
  noSignal?: boolean;
  /** How many heartbeats arrived and the last one's time (ms), for the collapsed row. */
  heartbeats?: { count: number; last: number | null };
  /** Clock for the collapsed row's age; defaults to the render time. */
  now?: number;
}) {
  const [open, setOpen] = useState<FeedEntry | null>(null);
  const [showBeats, setShowBeats] = useState(false);
  const beats = showBeats && heartbeats && heartbeats.count > 0 ? heartbeats : null;
  const { ref, onScroll } = useFollow<HTMLDivElement>(beats ? [feed, beats.count] : feed);
  // Stable sort: equal timestamps keep arrival order.
  const rows = feed
    .filter(
      (e) =>
        !(
          feedChannel(e) === "mailbox" && isControlTraffic(e.envelope, e.topic.split("/")[2] ?? "")
        ) && !(feedChannel(e) === "progress" && e.envelope.type === "heartbeat"),
    )
    .map((e, i) => ({ e, i, t: entryTime(e) }))
    .sort((a, b) => a.t - b.t || a.i - b.i);

  const toggle = heartbeats && heartbeats.count > 0 && (
    <label className="feed-beats dim">
      <input type="checkbox" checked={showBeats} onChange={() => setShowBeats((v) => !v)} /> show
      heartbeats
    </label>
  );
  if (rows.length === 0 && !beats) {
    return (
      <>
        {toggle}
        <div className="feed feed--empty recessed dim">
          no envelopes yet{noSignal ? " · no signal from this agent on this broker" : ""}
        </div>
      </>
    );
  }
  return (
    <>
      {toggle}
      <div className="feed recessed" ref={ref} onScroll={onScroll}>
        {rows.map(({ e, t }) => {
          const ch = feedChannel(e);
          const isOpen = open === e;
          return (
            <div key={rowId(e)} className={`env ch-${ch}`}>
              <div
                // biome-ignore lint/a11y/useSemanticElements: a browser will not select a <button>'s text, and a row is copyable
                role="button"
                tabIndex={0}
                className="env-row"
                aria-expanded={isOpen}
                onClick={(ev) => {
                  // The click that ends selecting the row's text is a copy, not a toggle.
                  if (selectedIn(ev.currentTarget)) return;
                  setOpen(isOpen ? null : e);
                }}
                onKeyDown={(ev) => {
                  if (ev.key !== "Enter" && ev.key !== " ") return;
                  ev.preventDefault();
                  setOpen(isOpen ? null : e);
                }}
              >
                <span className="mono dim">{clock(t)}</span>
                <span className="env-ch">{ch}</span>
                <span className="env-type">{e.envelope.type}</span>
                <span className="env-msg">{summary(e)}</span>
              </div>
              {isOpen && (
                <pre className="env-json recessed">{JSON.stringify(e.envelope, null, 2)}</pre>
              )}
            </div>
          );
        })}
        {beats && (
          <div className="env ch-progress env--heartbeats">
            <div className="env-row">
              <span className="mono dim">
                {beats.last === null ? "--:--:--" : clock(beats.last)}
              </span>
              <span className="env-ch">progress</span>
              <span className="env-type">
                heartbeat ×{beats.count}
                {beats.last !== null && ` · last ${ago((now ?? Date.now()) - beats.last)}`}
              </span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
