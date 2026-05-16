/**
 * LiveFeed — 340px right rail with the rolling event stream. Header has
 * a (static-in-Phase-2) accent pulse dot + "LIVE FEED" label, channel
 * filter chips (all / status / progress / mailbox / result), and a
 * pause/play toggle. Body is a 3-col grid (60px timestamp · 14px channel
 * tag · 1fr body) sourced from `state.events`.
 *
 * Auto-scroll stick-to-bottom only when the user is within 24px of the
 * bottom (handoff §"Auto-scroll behavior"). Pause toggle blocks both the
 * auto-scroll AND the visual append of new rows — events keep accumulating
 * in the reducer's ring buffer; on resume the rail jumps to latest.
 *
 * Fresh-event flash animation is deferred to Phase 3; Phase 2 renders the
 * 12% steady-state tint via the `--c-ch` custom property on each row.
 */
import { Pause, Play } from "lucide-react";
import { type UIEvent, useEffect, useMemo, useRef, useState } from "react";
import { fmtTimeOfDay } from "../lib/format-time";
import { CHANNEL_META } from "../lib/lifecycle-meta";
import type { ChannelKind, FeedEvent } from "../types";

const CHANNEL_FILTER_OPTIONS: Array<ChannelKind | "all"> = [
  "all",
  "status",
  "progress",
  "mailbox",
  "result",
];

const STICKY_THRESHOLD_PX = 24;

export interface LiveFeedProps {
  events?: FeedEvent[] | undefined;
  paused?: boolean | undefined;
  setPaused?: ((next: boolean) => void) | undefined;
  channelFilter?: ChannelKind | "all" | undefined;
  setChannelFilter?: ((next: ChannelKind | "all") => void) | undefined;
}

export function LiveFeed({
  events = [],
  paused = false,
  setPaused = () => {},
  channelFilter = "all",
  setChannelFilter = () => {},
}: LiveFeedProps = {}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef<boolean>(true);
  // `frozen` keeps the rendered slice fixed while paused so visual appends
  // are blocked — but the reducer's ring buffer keeps accumulating, so on
  // resume the rail jumps to the latest.
  const [frozen, setFrozen] = useState<FeedEvent[] | null>(null);

  useEffect(() => {
    if (paused) {
      setFrozen((prev) => prev ?? events);
    } else {
      setFrozen(null);
    }
  }, [paused, events]);

  const visible = useMemo(() => {
    const source = paused && frozen !== null ? frozen : events;
    if (channelFilter === "all") return source;
    return source.filter((e) => e.ch === channelFilter);
  }, [paused, frozen, events, channelFilter]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on `visible` change so auto-scroll fires when new events render
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || paused || !stickyRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [visible, paused]);

  useEffect(() => {
    if (!paused) {
      const el = scrollRef.current;
      if (el !== null) {
        el.scrollTop = el.scrollHeight;
        stickyRef.current = true;
      }
    }
  }, [paused]);

  const onScroll = (e: UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget;
    stickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD_PX;
  };

  return (
    <div data-testid="live-feed" className="vd-rail">
      <div className="vd-rail-hd">
        <span className="vd-pulse" />
        <h3>LIVE FEED</h3>
        <div className="vd-rail-actions">
          <div
            data-testid="channel-filter-chips"
            className="vd-rail-actions"
            aria-label="Channel filter"
          >
            {CHANNEL_FILTER_OPTIONS.map((c) => (
              <button
                type="button"
                key={c}
                className="vd-rail-icbtn"
                title={`filter: ${c}`}
                data-on={channelFilter === c ? "1" : "0"}
                data-channel={c}
                onClick={() => setChannelFilter(c)}
              >
                {c}
              </button>
            ))}
          </div>
          <button
            type="button"
            data-testid="pause-toggle"
            className="vd-rail-icbtn vd-iconbtn"
            title={paused ? "resume" : "pause"}
            aria-pressed={paused}
            data-on={paused ? "1" : "0"}
            onClick={() => setPaused(!paused)}
          >
            {paused ? <Play className="vd-icon" /> : <Pause className="vd-icon" />}
          </button>
        </div>
      </div>
      <div className="vd-feed" ref={scrollRef} onScroll={onScroll}>
        {visible.map((e) => {
          const meta = CHANNEL_META[e.ch] ?? CHANNEL_META.system;
          return (
            <div
              key={e.id}
              className="vd-evt"
              data-channel={e.ch}
              data-fresh={e.fresh ? "1" : "0"}
              style={{ "--c-ch": meta.color } as React.CSSProperties}
            >
              <span className="vd-t">{fmtTimeOfDay(e.ts)}</span>
              <span className="vd-ch">{meta.short}</span>
              <span className="vd-body">
                <span className="vd-aid">{e.agent}</span>
                <span className="vd-type">{e.type}</span>
                <span className="vd-msg">{e.msg}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
