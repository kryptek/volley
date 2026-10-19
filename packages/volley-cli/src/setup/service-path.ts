import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/**
 * The PATH `volley setup` (and `volleyd install`) writes into the services' unit files. Never the
 * invoking shell's whole PATH: that holds per-terminal entries (a terminal's per-session shim
 * directory under the temp dir, a project's node_modules/.bin), so a rerun from another terminal
 * would plan to reinstall both services. Instead a short, fixed list, plus the directory of each
 * tool volleyd runs that the list does not reach yet, taken from the shell's PATH unless it is
 * temporary. The same machine gives the same PATH from any shell, and from its own output.
 */

/** Tools volleyd (or the Desk's server) runs by name. */
const TOOLS = ["claude", "gh", "git", "cmux", "tmux", "ssh", "mosquitto", "docker"];

/** Where the cmux app keeps its command-line tool (the one a service can run). */
export const CMUX_APP_BINS = (home: string) => [
  "/Applications/cmux.app/Contents/Resources/bin",
  join(home, "Applications", "cmux.app", "Contents", "Resources", "bin"),
];

const SYSTEM = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/**
 * Whether `dir` is a directory that may be gone tomorrow (or differs per terminal): relative, under
 * the temp dir (`/tmp`, macOS's per-user `/var/folders/…`, `$TMPDIR`), or a cmux shim directory.
 */
export function isEphemeralDir(dir: string, tmpdir?: string): boolean {
  if (!isAbsolute(dir)) return true;
  const under = (root: string) => {
    const r = root.replace(/\/+$/, "");
    return r !== "" && (dir === r || dir.startsWith(`${r}/`));
  };
  return (
    ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].some(under) ||
    (tmpdir !== undefined && tmpdir !== "" && under(tmpdir)) ||
    /(^|\/)cmux-cli-shims(\/|$)/.test(dir)
  );
}

export interface ServicePathInputs {
  /** The user's home (for ~/.volley/bin). */
  home: string;
  /** The bun the services run. */
  bun: string;
  /** The invoking shell's PATH. */
  path: string | undefined;
  /** `$TMPDIR`, whose subdirectories are never baked in. */
  tmpdir?: string | undefined;
  /** Injectable for tests. */
  exists?: (p: string) => boolean;
}

/**
 * `~/.volley/bin`, bun's directory, Homebrew's bin (when there is one), `/usr/local/bin`, the
 * cmux app's bin (when installed), then the directories of tools the list does not reach yet,
 * then `/usr/bin:/bin:/usr/sbin:/sbin`.
 */
export function stableServicePath({
  home,
  bun,
  path,
  tmpdir,
  exists = existsSync,
}: ServicePathInputs): string {
  const stable = (d: string) => !isEphemeralDir(d, tmpdir);
  const bunDir = dirname(bun);
  const head = [
    join(home, ".volley", "bin"),
    ...(isAbsolute(bun) && stable(bunDir) ? [bunDir] : []),
    ...(exists("/opt/homebrew/bin") ? ["/opt/homebrew/bin"] : []),
    "/usr/local/bin",
    ...CMUX_APP_BINS(home).filter((d) => exists(d)),
  ];
  const chosen = [...head, ...SYSTEM];
  const extra: string[] = [];
  const shell = (path ?? "").split(":").filter((d) => d !== "" && stable(d));
  for (const tool of TOOLS) {
    // One already reachable keeps the PATH short, and computing it again adds nothing.
    if ([...chosen, ...extra].some((d) => exists(join(d, tool)))) continue;
    const dir = shell.find((d) => exists(join(d, tool)));
    if (dir !== undefined) extra.push(dir);
  }
  return [...new Set([...head, ...extra, ...SYSTEM])].join(":");
}
