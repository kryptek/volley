/**
 * Conventional shell exit codes. 124 matches GNU coreutils `timeout` so callers can
 * branch on "did the wait actually time out" vs. "did anything else go wrong".
 */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  /** `volley deploy`: the services checkout has local changes (and no --force-clean). */
  DIRTY: 3,
  TIMEOUT: 124,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
