/**
 * The agent window's Terminal tab: the retained `screen` tail the supervisor
 * captures for the agent (SPEC §4.6.6, T13), with a blinking caret. Commands
 * (`⏺ Tool(…)` or `⏺ <shell command>`), passes and failures get the
 * prototype's `tl-cmd` / `tl-ok` / `tl-bad` classes; a capture the supervisor
 * has flagged `screen_stale` in the wave state carries a `stale` marker.
 */
import { useLayoutEffect, useRef } from "react";
import type { ScreenPayload } from "../../store/types";

/** `⏺ Bash(…)`, `⏺ Update(…)`, or `⏺ gh pr checks` — not `⏺ The alias…` prose. */
const CMD = /^⏺\s+(?:[A-Z][\w-]*\(|[a-z][\w.-]*(?:\s|$))/;
const BAD = /[✗✘]|\b(?:CONFLICT|ERROR|Error|error|FAIL|FAILED|failed|fatal)\b/;
const OK = /[✓✔]/;

/** The line class for one screen line: `tl-cmd`, `tl-bad`, `tl-ok`, or `""`. */
export function lineClass(line: string): string {
  const t = line.trim();
  if (CMD.test(t)) return "tl-cmd";
  if (BAD.test(t)) return "tl-bad";
  if (OK.test(t)) return "tl-ok";
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
          <span className="term-caret" aria-hidden />
        </>
      )}
    </div>
  );
}
