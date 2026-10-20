/**
 * The agent window's Terminal tab: the retained `screen` tail the supervisor
 * captures for the agent (SPEC §4.6.6, T13), with the prototype's blinking
 * caret and `tl-cmd` / `tl-ok` / `tl-bad` line classes; a capture the
 * supervisor has flagged `screen_stale` in the wave state carries a `stale`
 * marker. A new capture scrolls to the bottom only while the reader is there.
 * An agent with no signal says so in the empty state. Only agents volleyd
 * spawned have a screen: for one that registered on its own (no wave task)
 * the empty state says why, instead of a `no screen yet` that never comes.
 * The popout (`TerminalPopout`) renders the same lines with its own `className`
 * and `style` (no wrapping, its own text size).
 */
import type { CSSProperties } from "react";
import type { ScreenPayload } from "../../store/types";
import { useFollow } from "./Feed";

/** The prototype's line classes: `⏺` lines are commands, `✗`/`CONFLICT` bad, `✓` ok. */
export function lineClass(line: string): string {
  if (line.startsWith("⏺")) return "tl-cmd";
  if (line.includes("✗") || line.includes("CONFLICT")) return "tl-bad";
  if (line.includes("✓")) return "tl-ok";
  return "";
}

/** The empty Terminal of an agent volleyd did not launch: its screen is never published. */
export const NO_TERMINAL =
  "No terminal for this agent: it wasn't launched by volleyd, so its screen isn't published. Live output is in the Volley feed.";

export function Terminal({
  screen,
  stale,
  noSignal = false,
  selfRegistered = false,
  className,
  style,
}: {
  screen: ScreenPayload | null;
  stale: boolean;
  noSignal?: boolean;
  /** No wave task: volleyd did not launch it, so no screen will come. */
  selfRegistered?: boolean;
  /** Extra classes on the root (the popout's `term--popout`). */
  className?: string;
  style?: CSSProperties;
}) {
  const { ref, onScroll } = useFollow<HTMLDivElement>(screen);

  return (
    <div
      className={`term recessed${stale ? " term--stale" : ""}${className ? ` ${className}` : ""}`}
      style={style}
      ref={ref}
      onScroll={onScroll}
    >
      {stale && (
        <span className="term-stale" title="The supervisor could not refresh this screen">
          stale
        </span>
      )}
      {screen === null ? (
        <div className="term-empty dim">
          {selfRegistered ? NO_TERMINAL : "no screen yet"}
          {noSignal ? " · no signal from this agent on this broker" : ""}
        </div>
      ) : (
        <>
          {screen.lines.map((line, i) => {
            const cls = lineClass(line);
            return (
              // Lines are positional: a new capture replaces the whole tail.
              // biome-ignore lint/suspicious/noArrayIndexKey: positional screen lines
              <div key={i} className={cls ? `tl ${cls}` : "tl"}>
                {line}
              </div>
            );
          })}
          <div className="caret" aria-hidden>
            ▍
          </div>
        </>
      )}
    </div>
  );
}
