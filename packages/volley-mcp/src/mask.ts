/**
 * A Claude login's e-mail as a terminal shows it: masked until the owner asks to see it, and one
 * spelling per address so two machines' reports of the same login group together. The same rules
 * as the Desk's `packages/volley-desk/src/lib/email.ts`; change both together.
 */

const BULLETS = "•••";

/** `owner@example.com` → `o•••@example.com`; an address with no `@` masks whole. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return BULLETS;
  return `${email.slice(0, Math.min(at, 1))}${BULLETS}${email.slice(at)}`;
}

/** Trimmed and lower-cased: the key two reports of one login share. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
