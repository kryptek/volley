import { createHash } from "node:crypto";

/**
 * The tail of an agent's terminal as the Desk's Terminal tab shows it: the transcript, not the
 * harness chrome. Claude Code draws its input box at the bottom — a rule, the `❯` prompt (`│ >`
 * in the older boxed style) with any draft the operator typed, another rule, then the status bar
 * — so everything from the input box's top rule down is dropped. `(ctrl+…)` hints are cut out of
 * the remaining lines and blank lines are skipped. A screen with no input box (a bare shell, a
 * dialog) keeps its last lines as they are. Pure; no harness-specific state.
 */
export function screenTail(text: string, max: number): string[] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "").trimEnd());
  const box = inputBoxTop(lines);
  return (box === -1 ? lines : lines.slice(0, box))
    .map((l) => l.replace(HINT, "").trimEnd())
    .filter((l) => l.trim() !== "")
    .slice(-max);
}

/**
 * The harness chrome `screenTail` drops: the lines from the input box's top rule down (the
 * status bar is below the box). Empty when the screen has no input box.
 */
export function screenFooter(text: string): string[] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "").trimEnd());
  const box = inputBoxTop(lines);
  return box === -1 ? [] : lines.slice(box);
}

/** A horizontal rule: Claude Code's `────` input-box border, or a box's top edge `╭───╮`. */
const RULE = /^\s*[╭┌]?[─━]{3,}[╮┐]?\s*$/;
/** The input prompt line: `❯ …`, or `│ > …` / `│ ❯ …` inside a box. */
const PROMPT = /^\s*(?:[│┃]\s*)?(?:❯|>)(?:\s|$)/;
/** A keyboard hint in parentheses, e.g. `(ctrl+o to expand)`. */
const HINT = /\s*\((?:ctrl|shift|alt|cmd|meta)\+[^)]*\)/gi;

/** Index of the last input box's top rule (a rule directly above a prompt line), or -1. */
function inputBoxTop(lines: string[]): number {
  for (let i = lines.length - 1; i > 0; i--) {
    if (PROMPT.test(lines[i] as string) && RULE.test(lines[i - 1] as string)) return i - 1;
  }
  return -1;
}

/** Content hash of a tail; publishers skip captures whose hash is unchanged. */
export function screenHash(lines: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(lines)).digest("hex").slice(0, 32);
}
