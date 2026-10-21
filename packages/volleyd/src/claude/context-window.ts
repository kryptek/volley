/**
 * A model's context window, known before its first response, and the auto-compact window a launch
 * exports from it (`agent_auto_compact_pct`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`). Pure, no I/O.
 *
 * The table follows Claude Code's model configuration docs: a `[1m]` suffix is 1M; the native-1M
 * families (fable, sonnet 5 and later, haiku 5.5 and later, opus 4.7 and later, and the bare
 * aliases, which resolve to native-1M models) are 1M; everything else, including an id this cannot
 * read (ARNs, gateway names), is 200K. A wrong row only moves the compaction point: Claude Code
 * caps the window at the model's own.
 */

const ONE_MILLION = 1_000_000;
const TWO_HUNDRED_K = 200_000;
/** The auto-compact window Claude Code accepts, in tokens; outside it, it clamps with a warning. */
export const COMPACT_MIN = 100_000;
export const COMPACT_MAX = 1_000_000;

const ALIASES = new Set(["fable", "opus", "sonnet", "haiku"]);
/** `claude-<family>-<major>[-<minor>]` anywhere in a provider-qualified id. */
const FAMILY = /claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/;

/** [major, minor] at or above which a family runs with a 1M window natively. */
const NATIVE_1M: Record<string, [number, number]> = {
  fable: [0, 0],
  sonnet: [5, 0],
  haiku: [5, 5],
  opus: [4, 7],
};

/** The context window `model` runs with, in tokens. */
export function contextWindowTokens(model: string): number {
  const id = model.trim().toLowerCase();
  if (id.endsWith("[1m]")) return ONE_MILLION;
  if (ALIASES.has(id)) return ONE_MILLION;
  const m = FAMILY.exec(id);
  if (m === null) return TWO_HUNDRED_K;
  const major = Number(m[2]);
  // A date suffix (`claude-opus-4-20250514`) is not a minor version.
  const minor = m[3] !== undefined && m[3].length <= 2 ? Number(m[3]) : 0;
  const [fromMajor, fromMinor] = NATIVE_1M[m[1] as string] as [number, number];
  const native = major > fromMajor || (major === fromMajor && minor >= fromMinor);
  return native ? ONE_MILLION : TWO_HUNDRED_K;
}

/**
 * `pct` of `model`'s window in tokens, an integer clamped to Claude Code's accepted range;
 * undefined at 0 (nothing is exported and Claude Code's own default applies).
 */
export function autoCompactWindowTokens(model: string, pct: number): number | undefined {
  if (pct === 0) return undefined;
  const tokens = Math.round((contextWindowTokens(model) * pct) / 100);
  return Math.min(COMPACT_MAX, Math.max(COMPACT_MIN, tokens));
}
