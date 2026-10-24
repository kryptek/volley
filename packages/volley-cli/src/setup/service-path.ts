import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { SetupContext } from "./step";

/**
 * The PATH `volley setup` (and `volleyd install`) writes into the services' unit files. Never
 * derived from the invoking shell's PATH: that holds per-terminal entries (a terminal's per-session
 * shim directory under the temp dir, a project's node_modules/.bin) and differs between shells, so
 * a rerun from another terminal would plan to reinstall both services, or drop a directory volleyd
 * needs. Instead a fixed list of candidates, each kept when it exists on this machine: the same
 * machine gives the same PATH from any shell, and from its own output.
 */

/** Where the cmux app keeps its command-line tool (the one a service can run). */
export const CMUX_APP_BINS = (home: string) => [
  "/Applications/cmux.app/Contents/Resources/bin",
  join(home, "Applications", "cmux.app", "Contents", "Resources", "bin"),
];

/** Package managers' and installers' directories (Homebrew, Linuxbrew), before /usr/local/bin. */
const PACKAGE_DIRS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/home/linuxbrew/.linuxbrew/bin",
  "/home/linuxbrew/.linuxbrew/sbin",
];

/**
 * Where installers put the tools volleyd runs (claude's native installer: ~/.local/bin; bun's:
 * ~/.bun/bin; npm's user prefix; volta; nix; snap's mosquitto), after the cmux app's bin.
 */
const USER_DIRS = (home: string) => [
  join(home, ".local", "bin"),
  join(home, ".bun", "bin"),
  join(home, ".claude", "local"),
  join(home, ".npm-global", "bin"),
  join(home, ".volta", "bin"),
  join(home, ".nix-profile", "bin"),
  "/nix/var/nix/profiles/default/bin",
  "/snap/bin",
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
  /** The user's home (for ~/.volley/bin and the per-user install dirs). */
  home: string;
  /** The bun the services run. */
  bun: string;
  /** `$TMPDIR`: bun's directory is never baked in from under it. */
  tmpdir?: string | undefined;
  /** Whether a directory exists (injectable: tests fake the machine). */
  exists?: (p: string) => boolean;
}

/**
 * `~/.volley/bin`, bun's directory, Homebrew's (when there is one), `/usr/local/bin`, the cmux
 * app's bin, the per-user install dirs (each when it exists), then `/usr/bin:/bin:/usr/sbin:/sbin`.
 */
export function stableServicePath({
  home,
  bun,
  tmpdir,
  exists = existsSync,
}: ServicePathInputs): string {
  const bunDir = dirname(bun);
  return [
    ...new Set([
      join(home, ".volley", "bin"),
      ...(isAbsolute(bun) && !isEphemeralDir(bunDir, tmpdir) ? [bunDir] : []),
      ...PACKAGE_DIRS.filter((d) => exists(d)),
      "/usr/local/bin",
      ...CMUX_APP_BINS(home).filter((d) => exists(d)),
      ...USER_DIRS(home).filter((d) => exists(d)),
      ...SYSTEM,
    ]),
  ].join(":");
}

/**
 * The services' PATH: the linked commands first, then a fixed list (`stableServicePath`), never
 * the invoking shell's whole PATH, so a rerun from another terminal changes nothing.
 */
export function servicePath(ctx: SetupContext): string {
  return stableServicePath({
    home: ctx.home,
    bun: ctx.deps.bun,
    tmpdir: ctx.auth.env.TMPDIR,
    ...(ctx.deps.exists !== undefined ? { exists: ctx.deps.exists } : {}),
  });
}

/**
 * The environment the services run with: where volleyd lives, which broker, the auth dir its
 * `volley auth` calls use (the one setup used, even when `--dir` / `--layout` chose it), a usable
 * PATH.
 */
export function serviceEnv(ctx: SetupContext): Record<string, string> {
  return {
    VOLLEYD_HOME: ctx.volleydHome,
    VOLLEY_BROKER_URL: ctx.auth.url,
    VOLLEY_AUTH_DIR: ctx.auth.dir,
    VOLLEY_NAMESPACE: ctx.auth.env.VOLLEY_NAMESPACE ?? "default",
    PATH: servicePath(ctx),
  };
}
