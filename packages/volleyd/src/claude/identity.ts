import { readClaudeJson } from "../trust";

/**
 * A Claude login's identity: the e-mail address and organisation name Claude Code itself records
 * in a profile's `.claude.json` (`oauthAccount.emailAddress`, `oauthAccount.organizationName`).
 * Exactly those two fields are read, nothing else of the file; they are identity, never a
 * credential, and let a client tell when profiles on several machines are one account.
 */

export interface LoginIdentity {
  email?: string;
  org?: string;
}

// Kept byte-identical with volley-cli's copy (src/peer/checks/claude.ts), which cannot import it.
// The schemas' `format: email` (ajv-formats' full mode), so no address kept here fails them.
const EMAIL =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/** `{ email?, org? }` from a parsed `.claude.json`; a field that is not well-formed is left out. */
export function loginIdentity(json: Record<string, unknown> | null): LoginIdentity {
  const oauth = json?.oauthAccount;
  if (typeof oauth !== "object" || oauth === null || Array.isArray(oauth)) return {};
  const { emailAddress: e, organizationName: o } = oauth as Record<string, unknown>;
  const email = typeof e === "string" && e.length <= 254 && EMAIL.test(e) ? e.toLowerCase() : null;
  const org = typeof o === "string" && o !== "" && o.length <= 128 ? o : null;
  return { ...(email !== null ? { email } : {}), ...(org !== null ? { org } : {}) };
}
// End of the copy shared with volley-cli.

/** The identity in the `.claude.json` at `path`; `{}` when it is absent or unreadable. */
export const readLoginIdentity = (path: string): LoginIdentity =>
  loginIdentity(readClaudeJson(path));
