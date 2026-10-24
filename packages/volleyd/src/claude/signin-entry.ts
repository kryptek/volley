/**
 * What the owner pastes to finish a sign-in from another device (SPEC §4.6.11): the code
 * Anthropic's code page shows, or the `http://localhost:<port>/callback?code=…&state=…` address a
 * browser ended up on when the localhost redirect could not reach Claude Code's listener. Pure.
 *
 * Both are credential-grade: the caller never journals, logs or echoes them, and every message
 * that could carry one goes through `redact` first.
 */

export type SigninEntry =
  | { kind: "code"; code: string }
  /** The callback's port and its raw query, byte for byte (requested as is on that machine). */
  | { kind: "redirect"; port: number; query: string }
  | { kind: "invalid" };

/** The longest entry taken: a code is ~100 characters, an address a few hundred. */
const MAX_ENTRY = 2048;
/** A code: one printable token, never an option (`-…`) and never an address. */
const CODE = /^[A-Za-z0-9_~#.%+=/:-]+$/;
/** The callback address Claude Code's listener answers; nothing that would need quoting. */
const REDIRECT =
  /^http:\/\/(?:localhost|127\.0\.0\.1):([0-9]{4,5})\/callback\?([A-Za-z0-9._~%+=&-]+)$/;

export function parseSigninEntry(text: string): SigninEntry {
  const t = text.trim();
  if (t === "" || t.length > MAX_ENTRY) return { kind: "invalid" };
  const m = REDIRECT.exec(t);
  if (m !== null) {
    const port = Number(m[1]);
    const query = m[2] as string;
    const keys = new Set(query.split("&").map((kv) => kv.split("=")[0]));
    return port >= 1024 && port <= 65535 && keys.has("code") && keys.has("state")
      ? { kind: "redirect", port, query }
      : { kind: "invalid" };
  }
  if (t.includes("://") || t.startsWith("-") || !CODE.test(t)) return { kind: "invalid" };
  return { kind: "code", code: t };
}

/** The `state` of a query (or an authorize URL's), null when it has none. */
export function queryState(query: string): string | null {
  return new URLSearchParams(query).get("state");
}

const MASK = "•••";

/** `text` with every `code=` / `state=` value, and each of `secrets` (a bare code), masked. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(/\b(code|state)=[^&\s"'<>]*/g, `$1=${MASK}`);
  for (const s of secrets) if (s !== "") out = out.split(s).join(MASK);
  return out;
}
