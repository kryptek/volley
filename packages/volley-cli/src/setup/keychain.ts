import type { SetupExec } from "./step";

/**
 * A secret in the macOS keychain, stored the one way setup stores one: `security -i`, the
 * command fed on stdin so the secret never reaches argv (`ps`), then read back, because -i
 * reports a failed command on stderr, not always in its exit code.
 */

export interface KeychainItem {
  service: string;
  account: string;
  /** What Keychain Access shows. */
  label: string;
}

/** A double-quoted word for `security -i`'s command line (`\` and `"` escaped). */
export const securityQuote = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** The `security -i` command that stores `secret` as `item` (fed on stdin). */
export function keychainAddLine(item: KeychainItem, secret: string): string {
  return [
    "add-generic-password",
    "-U",
    "-s",
    item.service,
    "-a",
    item.account,
    "-l",
    securityQuote(item.label),
    "-w",
    securityQuote(secret),
  ].join(" ");
}

/** Reads `item`'s secret (on stdout). */
export const keychainReadItemArgv = (item: Pick<KeychainItem, "service" | "account">) => [
  "security",
  "find-generic-password",
  "-s",
  item.service,
  "-a",
  item.account,
  "-w",
];

/** Store `secret` as `item`, reading it back; throws when it did not take. */
export async function storeInKeychain(
  exec: SetupExec,
  item: KeychainItem,
  secret: string,
): Promise<void> {
  const r = await exec(["security", "-i"], { input: `${keychainAddLine(item, secret)}\n` });
  const back = await exec(keychainReadItemArgv(item));
  if (r.code !== 0 || back.code !== 0 || back.stdout.replace(/\n$/, "") !== secret) {
    throw new Error(
      `security add-generic-password failed (exit ${r.code}): ${(r.stderr || back.stderr).trim()}`,
    );
  }
}
