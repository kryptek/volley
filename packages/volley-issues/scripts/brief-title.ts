/**
 * Turn a raw GitHub issue title into the one-line agent title a spawn brief carries
 * (`vol_register`'s `title`, the cmux workspace name): `#<N> <title>[ — <role>]`.
 *
 * The coordinator pipes the raw title in on stdin, so it never sits on a command line:
 *
 *   gh issue view <N> --json title -q .title | bun <skill-dir>/scripts/brief-title.ts <N> [<role>]
 *
 * The output goes inside a single-quoted prompt within a double-quoted `--command "…"`, and
 * inside `--name "…"`, so every character special in either kind of shell quote is removed:
 * `'` `"` `` ` `` `$` `\`. Control characters (newlines and tabs included) become spaces,
 * whitespace runs collapse to one space, and the line is trimmed and cut to
 * {@link BRIEF_TITLE_MAX} characters (the role suffix is kept; the title is what gets cut).
 */
import { readFileSync } from "node:fs";

/** `vol_register`'s `title` limit (1–120 characters). */
export const BRIEF_TITLE_MAX = 120;

/** The role suffix's own limit, so a long role cannot crowd out the title. */
const ROLE_MAX = 40;

/** Characters special inside single or double shell quotes. */
const SHELL_QUOTE_SPECIALS = /['"`$\\]/g;
/** C0 and C1 control characters, DEL, and the Unicode line/paragraph separators. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Strip shell-quote specials and controls, collapse whitespace, trim. */
export function sanitise(text: string): string {
  return text.replace(SHELL_QUOTE_SPECIALS, "").replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
}

/** Cut to at most `max` UTF-16 units without splitting a character, then trim. */
function cut(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out.trimEnd();
}

/** The safe agent title for issue `n`; throws unless `n` is digits only. */
export function briefTitle(n: string, rawTitle: string, role?: string): string {
  if (!/^[0-9]{1,10}$/.test(n)) {
    throw new Error(`issue number must be digits only, got ${JSON.stringify(n)}`);
  }
  const head = `#${n}`;
  const safeRole = role === undefined ? "" : cut(sanitise(role), ROLE_MAX);
  const suffix = safeRole === "" ? "" : ` — ${safeRole}`;
  const room = BRIEF_TITLE_MAX - head.length - suffix.length - 1;
  const title = cut(sanitise(rawTitle), room);
  return `${head}${title === "" ? "" : ` ${title}`}${suffix}`;
}

if (import.meta.main) {
  const [n, role] = process.argv.slice(2);
  if (n === undefined) {
    process.stderr.write(
      "usage: gh issue view <N> --json title -q .title | bun brief-title.ts <N> [<role>]\n",
    );
    process.exit(2);
  }
  try {
    process.stdout.write(`${briefTitle(n, readFileSync(0, "utf8"), role)}\n`);
  } catch (e) {
    process.stderr.write(`brief-title: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
}
