/**
 * The agent window's Terminal tab: the retained `screen` tail the supervisor
 * captures for the agent (SPEC §4.6.6, T13), with the prototype's blinking
 * caret and `tl-cmd` / `tl-ok` / `tl-bad` line classes; a capture the
 * supervisor has flagged `screen_stale` in the wave state carries a `stale`
 * marker.
 */
import { useLayoutEffect, useRef } from "react";
import type { ScreenPayload } from "../../store/types";

/** The prototype's line classes: `⏺` lines are commands, `✗`/`CONFLICT` bad, `✓` ok. */
export function lineClass(line: string): string {
  if (line.startsWith("⏺")) return "tl-cmd";
  if (line.includes("✗") || line.includes("CONFLICT")) return "tl-bad";
  if (line.includes("✓")) return "tl-ok";
  return "";
}

export function Terminal({ screen, stale }: { screen: ScreenPayload | null; stale: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  return (
    <div className={`term${stale ? " term--stale" : ""}`} ref={box}>
      {stale && (
        <span className="term-stale" title="The supervisor could not refresh this screen">
          stale
        </span>
      )}
      {screen === null ? (
        <div className="term-empty dim">no screen yet</div>
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
