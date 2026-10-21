import { describe, expect, it } from "vitest";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import type { ExecFn, ExecResult } from "../src/exec";
import { fetchFailure, lockFetches, lockedFetch, withRepoLock } from "../src/git-lock";

/** A promise and the function that settles it. */
function gate() {
  let open = () => {};
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
}

const ok: ExecResult = { code: 0, stdout: "", stderr: "", timedOut: false };
const failed = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr, timedOut: false });

describe("withRepoLock", () => {
  it("runs calls for one host + repo one at a time, in order; other keys run alongside", async () => {
    const log: string[] = [];
    const gates = [gate(), gate(), gate()];
    const runs = gates.map((g, i) =>
      withRepoLock("box-a", "/r", async () => {
        log.push(`start ${i}`);
        await g.p;
        log.push(`end ${i}`);
        return i;
      }),
    );
    // Another clone on the same machine, and the same path on another machine, are not held up.
    const other = withRepoLock("box-a", "/other", async () => "other");
    const elsewhere = withRepoLock("box-b", "/r", async () => "elsewhere");
    expect(await other).toBe("other");
    expect(await elsewhere).toBe("elsewhere");
    await Promise.resolve();
    expect(log).toEqual(["start 0"]);
    gates[0]?.open();
    gates[1]?.open();
    gates[2]?.open();
    expect(await Promise.all(runs)).toEqual([0, 1, 2]);
    expect(log).toEqual(["start 0", "end 0", "start 1", "end 1", "start 2", "end 2"]);
  });

  it("a call that throws releases the lock for the next one", async () => {
    const first = withRepoLock("box-a", "/r", async () => {
      throw new Error("boom");
    });
    const second = withRepoLock("box-a", "/r", async () => "next");
    await expect(first).rejects.toThrow("boom");
    expect(await second).toBe("next");
  });
});

describe("lockedFetch", () => {
  it("a ref-lock race is retried once in place; the retry's result stands", async () => {
    for (const race of [
      "error: fetching ref refs/remotes/origin/release/w1 failed: incorrect old value provided",
      "error: cannot lock ref 'refs/remotes/origin/release/w1': is at abc but expected def",
      "fatal: Unable to create '/path/to/repo/.git/shallow.lock': File exists.",
    ]) {
      const results = [failed(race), ok];
      const r = await lockedFetch("local", "/r", async () => results.shift() as ExecResult);
      expect(r.result.code).toBe(0);
      expect(r.retried).toBe(race);
      expect(results).toEqual([]);
    }
  });

  it("any other failure is not retried", async () => {
    let n = 0;
    const r = await lockedFetch("local", "/r", async () => {
      n++;
      return failed("fatal: couldn't find remote ref release/w1");
    });
    expect(n).toBe(1);
    expect(r.result.code).toBe(1);
    expect(r.retried).toBeUndefined();
  });
});

describe("fetchFailure", () => {
  it("a network or DNS failure is unreachable; anything else is stale", () => {
    expect(fetchFailure("fatal: unable to access 'x': Could not resolve host: github.com")).toBe(
      "unreachable",
    );
    expect(fetchFailure("ssh: connect to host example.com port 22: Connection timed out")).toBe(
      "unreachable",
    );
    expect(fetchFailure("git fetch timed out")).toBe("stale");
    expect(fetchFailure("fatal: couldn't find remote ref release/w1")).toBe("stale");
    expect(fetchFailure("incorrect old value provided")).toBe("stale");
  });
});

describe("lockFetches", () => {
  it("serializes the fetches an exec runs per host + clone; other commands pass straight through", async () => {
    const log: string[] = [];
    const exec: ExecFn = async (argv) => {
      log.push(`start ${argv.slice(2).join(" ")}`);
      for (let k = 0; k < 20; k++) await Promise.resolve();
      log.push(`end ${argv.slice(2).join(" ")}`);
      return ok;
    };
    const a = lockFetches(exec, "box-a", "/r");
    const b = lockFetches(exec, "box-a", "/r");
    await Promise.all([
      a(["git", "-C", "/wt/1", "fetch", "origin", "x"]),
      b(["git", "-C", "/wt/2", "fetch", "origin", "y"]),
    ]);
    expect(log).toEqual([
      "start /wt/1 fetch origin x",
      "end /wt/1 fetch origin x",
      "start /wt/2 fetch origin y",
      "end /wt/2 fetch origin y",
    ]);
    log.length = 0;
    await Promise.all([
      a(["git", "-C", "/wt/1", "rev-parse", "HEAD"]),
      b(["git", "-C", "/wt/2", "rev-parse", "HEAD"]),
    ]);
    expect(log.slice(0, 2)).toEqual(["start /wt/1 rev-parse HEAD", "start /wt/2 rev-parse HEAD"]);
  });
});

describe("lockFetches bounds a fetch the caller left unbounded", () => {
  it("defaults the fetch's timeout and turns off git's credential prompt; a caller's own options win", async () => {
    const seen: Parameters<ExecFn>[1][] = [];
    const exec: ExecFn = async (_argv, opts) => {
      seen.push(opts);
      return ok;
    };
    const locked = lockFetches(exec, "box-a", "/bounded");
    await locked(["git", "-C", "/wt/1", "fetch", "origin", "x"]);
    await locked(["git", "-C", "/wt/1", "fetch", "origin", "x"], {
      timeoutMs: 5,
      env: { ONLY: "mine" },
    });
    await locked(["git", "-C", "/wt/1", "rev-parse", "HEAD"]);
    expect(seen[0]?.timeoutMs).toBe(DAEMON_DEFAULTS.git_fetch_timeout_ms);
    expect(seen[0]?.env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(seen[1]?.timeoutMs).toBe(5);
    expect(seen[1]?.env).toEqual({ ONLY: "mine" });
    expect(seen[2]).toBeUndefined();
  });

  it("a fetch that hangs until its timeout does not hold the clone's lock forever", async () => {
    let calls = 0;
    const exec: ExecFn = (_argv, opts) => {
      calls++;
      if (calls > 1) return Promise.resolve(ok);
      // Stands in for exec's timeout firing: without one, the fetch would never settle.
      return opts?.timeoutMs !== undefined
        ? Promise.resolve({ ...failed(""), timedOut: true })
        : new Promise<ExecResult>(() => {});
    };
    const locked = lockFetches(exec, "box-a", "/hung");
    const hung = locked(["git", "-C", "/wt/1", "fetch", "origin", "x"]);
    const next = locked(["git", "-C", "/wt/2", "fetch", "origin", "y"]);
    expect((await hung).timedOut).toBe(true);
    expect(await next).toEqual(ok);
  });
});
