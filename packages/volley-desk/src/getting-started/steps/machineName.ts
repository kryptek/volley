/**
 * Getting started › This computer › Name this computer: whether a name can be the supervisor's
 * own machine name (`fleet.local_name`). The machine-name grammar (`[a-z0-9][a-z0-9_-]{0,62}`),
 * never a name volleyd keeps for itself, never a configured host's.
 */

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** Names volleyd and its fixed identities hold (`local`, `auto` and the accounts). */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "local",
  "auto",
  "volleyd",
  "desk",
  "coordinator",
]);

/** Why `name` cannot name this computer, or `null` when it can; `hosts` are the other machines. */
export function machineNameProblem(name: string, hosts: readonly string[]): string | null {
  if (!NAME_RE.test(name)) {
    return "A name is lower-case letters, digits, - or _, starting with a letter or digit (at most 63).";
  }
  if (RESERVED_NAMES.has(name)) return `"${name}" is reserved: pick another name.`;
  if (hosts.includes(name)) return "that is another machine's name";
  return null;
}
