/**
 * (Re)loading a launchd agent so that a rerun never leaves it down. `launchctl bootout` returns
 * before launchd has finished tearing the old job down, and a `bootstrap` in that window fails
 * with `Bootstrap failed: 5: Input/output error`. So: bootout only what is loaded, wait until
 * `launchctl print` no longer finds it, then bootstrap, retrying while launchd still answers EIO.
 * Used by `volley setup` (the Desk), `volleyd install` and `volley peer join`.
 */

export interface LaunchdDeps {
  exec: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  sleep: (ms: number) => Promise<void>;
}

export const LAUNCHD_RELOAD = {
  /** How long to wait for a booted-out job to be gone before bootstrapping anyway. */
  unload_wait_ms: 10_000,
  poll_ms: 250,
  /** Bootstraps tried while launchd answers EIO (the old job still going away). */
  bootstrap_attempts: 5,
  retry_ms: 1_000,
} as const;

/** `launchctl bootstrap`'s answer while the job it replaces is still being torn down. */
const isBusy = (r: { code: number; stderr: string; stdout: string }) =>
  r.code === 5 || /Input\/output error/i.test(`${r.stderr}\n${r.stdout}`);

export const isLoaded = async (d: LaunchdDeps, target: string) =>
  (await d.exec(["launchctl", "print", target])).code === 0;

/** Bootout `<domain>/<label>` when it is loaded, and wait until launchd no longer has it. */
export async function unloadLaunchd(d: LaunchdDeps, domain: string, label: string): Promise<void> {
  const target = `${domain}/${label}`;
  if (!(await isLoaded(d, target))) return;
  await d.exec(["launchctl", "bootout", target]);
  for (let waited = 0; waited < LAUNCHD_RELOAD.unload_wait_ms; waited += LAUNCHD_RELOAD.poll_ms) {
    if (!(await isLoaded(d, target))) return;
    await d.sleep(LAUNCHD_RELOAD.poll_ms);
  }
}

/**
 * Load `plist` as `<domain>/<label>`, replacing a loaded one: unload it first (waiting until it is
 * gone), then bootstrap, retrying EIO. Never throws: what went wrong, or ok.
 */
export async function reloadLaunchd(
  d: LaunchdDeps,
  domain: string,
  label: string,
  plist: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await unloadLaunchd(d, domain, label);
  let last = { code: 0, stdout: "", stderr: "" };
  for (let i = 0; i < LAUNCHD_RELOAD.bootstrap_attempts; i++) {
    last = await d.exec(["launchctl", "bootstrap", domain, plist]);
    if (last.code === 0) return { ok: true };
    if (!isBusy(last)) break;
    await d.sleep(LAUNCHD_RELOAD.retry_ms);
    // Still loaded (the bootout had not landed): unload again before the next try.
    await unloadLaunchd(d, domain, label);
  }
  return {
    ok: false,
    error: `\`launchctl bootstrap ${domain} ${plist}\` failed (exit ${last.code}): ${(last.stderr || last.stdout).trim()}`,
  };
}
