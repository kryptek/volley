import { describe, expect, it } from "vitest";
import { LAUNCHD_RELOAD, type LaunchdDeps, reloadLaunchd } from "../../src/setup/launchd";

/**
 * A launchd whose bootout is asynchronous, like the real one: the job stays loaded for
 * `teardown` more `print`s after a bootout, and a bootstrap meanwhile fails with EIO.
 */
function fakeLaunchd(opts: { loaded?: boolean; teardown?: number; refuse?: string } = {}) {
  let loaded = opts.loaded ?? false;
  let goingAway = 0;
  const calls: string[] = [];
  let slept = 0;
  const d: LaunchdDeps = {
    exec: async (argv) => {
      calls.push(argv.slice(1, 2).join(" "));
      const [, sub] = argv;
      if (sub === "print") {
        if (goingAway > 0 && --goingAway === 0) loaded = false;
        return { code: loaded ? 0 : 113, stdout: "", stderr: "" };
      }
      if (sub === "bootout") {
        if (!loaded) return { code: 3, stdout: "", stderr: "No such process" };
        // A second bootout while the job is going away does not restart its teardown.
        if (goingAway === 0) goingAway = opts.teardown ?? 0;
        if (goingAway === 0) loaded = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (opts.refuse !== undefined) return { code: 1, stdout: "", stderr: opts.refuse };
      if (loaded) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      loaded = true;
      return { code: 0, stdout: "", stderr: "" };
    },
    sleep: async (ms) => {
      slept += ms;
    },
  };
  return { d, calls, isLoaded: () => loaded, slept: () => slept };
}

describe("launchd reload", () => {
  it("loads a service that is not loaded, without a bootout", async () => {
    const f = fakeLaunchd();
    expect(await reloadLaunchd(f.d, "gui/501", "x", "/p/x.plist")).toEqual({ ok: true });
    expect(f.calls).toEqual(["print", "bootstrap"]);
    expect(f.isLoaded()).toBe(true);
  });

  it("waits for a booted-out service to be gone before bootstrapping it again", async () => {
    const f = fakeLaunchd({ loaded: true, teardown: 4 });
    expect(await reloadLaunchd(f.d, "gui/501", "x", "/p/x.plist")).toEqual({ ok: true });
    expect(f.calls.filter((c) => c === "bootstrap")).toHaveLength(1);
    expect(f.calls.indexOf("bootstrap")).toBeGreaterThan(f.calls.lastIndexOf("print"));
    expect(f.isLoaded()).toBe(true);
  });

  it("retries a bootstrap that launchd answers with EIO (the old job still going away)", async () => {
    // Torn down slower than setup waits: the first bootstraps meet the old job.
    const polls = LAUNCHD_RELOAD.unload_wait_ms / LAUNCHD_RELOAD.poll_ms;
    const f = fakeLaunchd({ loaded: true, teardown: polls + 3 });
    expect(await reloadLaunchd(f.d, "gui/501", "x", "/p/x.plist")).toEqual({ ok: true });
    expect(f.isLoaded()).toBe(true);
  });

  it("gives up with launchctl's own words, never throwing", async () => {
    const f = fakeLaunchd({ refuse: "Bootstrap failed: 125: Domain does not support action" });
    const r = await reloadLaunchd(f.d, "gui/501", "x", "/p/x.plist");
    expect(r).toEqual({
      ok: false,
      error:
        "`launchctl bootstrap gui/501 /p/x.plist` failed (exit 1): Bootstrap failed: 125: Domain does not support action",
    });
    // Not EIO: no point retrying.
    expect(f.calls.filter((c) => c === "bootstrap")).toHaveLength(1);
  });
});
