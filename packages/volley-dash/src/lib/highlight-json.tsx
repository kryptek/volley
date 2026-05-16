/**
 * Tiny JSON syntax highlighter — used by the drawer's "retained status
 * envelope" and "result" code blocks. Returns React nodes with span tokens
 * for keys / strings / numbers / booleans / null, coloured via Tailwind
 * status-token classes (per handoff "retained status envelope" colour map).
 *
 * Intentionally minimal: ~30 lines, no dependency on prismjs / shiki / etc.
 */
import type { ReactNode } from "react";

export function highlightJson(value: unknown): ReactNode[] {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) return ["undefined"];
  const tokens: ReactNode[] = [];
  // Single pass: match keys ("...":), strings, numbers, booleans, null.
  const re =
    /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b/g;
  let last = 0;
  let key = 0;
  for (let m = re.exec(json); m !== null; m = re.exec(json)) {
    if (m.index > last) tokens.push(json.slice(last, m.index));
    const strLit = m[1];
    const colon = m[2];
    const num = m[3];
    const bool = m[4];
    const nul = m[5];
    if (strLit !== undefined && colon !== undefined) {
      tokens.push(
        <span key={`k${key++}`} className="text-fg-3">
          {strLit}
        </span>,
      );
      tokens.push(colon);
    } else if (strLit !== undefined) {
      tokens.push(
        <span key={`s${key++}`} className="text-st-working">
          {strLit}
        </span>,
      );
    } else if (num !== undefined) {
      tokens.push(
        <span key={`n${key++}`} className="text-st-blocked">
          {num}
        </span>,
      );
    } else if (bool !== undefined) {
      tokens.push(
        <span key={`b${key++}`} className="text-st-failed">
          {bool}
        </span>,
      );
    } else if (nul !== undefined) {
      tokens.push(
        <span key={`u${key++}`} className="text-fg-4">
          {nul}
        </span>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < json.length) tokens.push(json.slice(last));
  return tokens;
}
