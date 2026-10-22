import { sleep, systemClock } from "./clock";
import { DAEMON_DEFAULTS } from "./config-defaults";
import type { ExecFn, ExecResult } from "./exec";

/**
 * One clone, one `git fetch` at a time. Two spawns admitted on the same tick into one machine's
 * clone would otherwise both update `refs/remotes/origin/<branch>`, and git refuses the loser
 * (`incorrect old value provided`). Every fetch volleyd runs into a clone goes through
 * `withRepoLock`, keyed by the host's name (`local` for the supervisor) and the clone's path, so
 * two inline host specs for one machine share the lock.
 */

const chains = new Map<string, Promise<void>>();

/** `fn`, once every earlier call for the same host and clone has settled. */
export function withRepoLock<T>(host: string, repo: string, fn: () => Promise<T>): Promise<T> {
  const key = `${host}:${repo}`;
  const run = (chains.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/** Git losing a ref update to another git process: transient, worth one retry. */
const REF_LOCK_RACE =
  /incorrect old value provided|cannot lock ref|Unable to create '[^']*\.lock'/i;

/** A fetch that never reached origin (DNS, the network): the base is not known to be stale. */
const UNREACHABLE =
  /Could not resolve host|Connection timed out|Operation timed out|Connection refused|Network is unreachable/i;

/** What a failed fetch's error says: origin was not reached, or it was and the fetch failed. */
export const fetchFailure = (error: string): "unreachable" | "stale" =>
  UNREACHABLE.test(error) ? "unreachable" : "stale";

export interface LockedFetch {
  /** The fetch's result (the retry's, when there was one). */
  result: ExecResult;
  /** The first attempt's error, when it lost a ref-lock race and was retried. */
  retried?: string;
}

/**
 * `fetch` under `withRepoLock(host, repo)`; a ref-lock race (another git process — an agent in a
 * worktree of the same clone — updating the same ref) is retried once in place after
 * `git_fetch_race_retry_ms`, before the caller decides anything from the result.
 */
export function lockedFetch(
  host: string,
  repo: string,
  fetch: () => Promise<ExecResult>,
): Promise<LockedFetch> {
  return withRepoLock(host, repo, async () => {
    const first = await fetch();
    if (first.code === 0 || !REF_LOCK_RACE.test(first.stderr)) return { result: first };
    // real clock: a host adapter has no daemon clock, and the wait is inside one fetch.
    await sleep(systemClock, DAEMON_DEFAULTS.git_fetch_race_retry_ms);
    return { result: await fetch(), retried: firstLine(first.stderr) };
  });
}

/**
 * `exec` with every `git -C <dir> fetch …` it runs going through `lockedFetch(host, repo)`: for
 * callers that fetch into a worktree of the clone `repo` (spawn's `pushedBranch`, the pipeline's
 * artifact probes), whose remote-tracking refs are the clone's. A fetch the caller left unbounded
 * gets `git_fetch_timeout_ms` and no credential prompt: a hung fetch would otherwise hold the lock,
 * and with it every later fetch into the clone, forever.
 */
export function lockFetches(exec: ExecFn, host: string, repo: string): ExecFn {
  const locked: ExecFn = async (argv, opts) => {
    // Only the `git -C <dir> fetch …` shape is recognized (every caller's); any other form, such
    // as `git -c k=v -C …` or a fetch without `-C`, would bypass the lock.
    if (argv[0] !== "git" || argv[1] !== "-C" || argv[3] !== "fetch") return exec(argv, opts);
    const bounded = {
      ...opts,
      timeoutMs: opts?.timeoutMs ?? DAEMON_DEFAULTS.git_fetch_timeout_ms,
      env: opts?.env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    };
    return (await lockedFetch(host, repo, () => exec(argv, bounded))).result;
  };
  return Object.assign(locked, { [INNER]: exec });
}

const INNER = Symbol("lockFetches.inner");

/** The exec a `lockFetches` wrapper routes to (itself when `exec` is not one): which machine it runs on. */
export function routedExec(exec: unknown): unknown {
  return (exec as { [INNER]?: ExecFn } | null)?.[INNER] ?? exec;
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";
