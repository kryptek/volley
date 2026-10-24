import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type DashChildProcess,
  type DashSpawnFn,
  type DashSpawnOptions,
  brewStableRoot,
  dash,
} from "../../src/commands/dash";
import { makeBufferIO } from "../../src/io";
import { tempDir } from "../helpers/tmp";

/**
 * Returns a fake child that fires `close` with `closeCode` on the next microtask —
 * after the dash command has had a chance to attach its `on("close", cb)` handler.
 */
function fakeChild(closeCode = 0): DashChildProcess {
  let closeCb: ((code: number | null) => void) | null = null;
  const child: DashChildProcess = {
    on(event, cb) {
      if (event === "close") closeCb = cb as (code: number | null) => void;
      return child;
    },
  };
  queueMicrotask(() => {
    closeCb?.(closeCode);
  });
  return child;
}

interface SpawnCall {
  cmd: string;
  args: string[];
  opts: DashSpawnOptions;
}

function recordingSpawn(closeCode = 0): {
  spawn: DashSpawnFn;
  calls: SpawnCall[];
  fn: ReturnType<typeof vi.fn>;
} {
  const calls: SpawnCall[] = [];
  const fn = vi.fn((cmd: string, args: string[], opts: DashSpawnOptions) => {
    calls.push({ cmd, args, opts });
    return fakeChild(closeCode);
  });
  return { spawn: fn as unknown as DashSpawnFn, calls, fn };
}

describe("volley dash", () => {
  it("--help prints usage and exits 0 without spawning", async () => {
    const io = makeBufferIO();
    const { spawn, fn } = recordingSpawn();
    const exitCode = await dash({ argv: ["--help"], env: {}, io, spawn });
    expect(exitCode).toBe(0);
    expect(io.readStdout()).toContain("Usage: volley dash");
    expect(io.readStderr()).toBe("");
    expect(fn).not.toHaveBeenCalled();
  });

  it("--port forwards through to vite as --port <N>", async () => {
    const io = makeBufferIO();
    const { spawn, calls } = recordingSpawn(0);
    const exitCode = await dash({ argv: ["--port", "6000"], env: {}, io, spawn });
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    const args = calls[0]?.args ?? [];
    expect(args).toContain("--port");
    expect(args).toContain("6000");
    // --port comes immediately before its value in the forwarded args.
    const portIdx = args.indexOf("--port");
    expect(args[portIdx + 1]).toBe("6000");
  });

  it("--broker-url injects VITE_VOLLEY_BROKER_URL into the spawned env", async () => {
    const io = makeBufferIO();
    const { spawn, calls } = recordingSpawn(0);
    const exitCode = await dash({
      argv: ["--broker-url", "ws://example:9001"],
      env: {},
      io,
      spawn,
    });
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts.env.VITE_VOLLEY_BROKER_URL).toBe("ws://example:9001");
  });

  it("--build switches to the build path and then runs preview", async () => {
    const io = makeBufferIO();
    const { spawn, calls } = recordingSpawn(0);
    const exitCode = await dash({ argv: ["--build"], env: {}, io, spawn });
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toContain("build");
    expect(calls[0]?.args).not.toContain("dev");
    expect(calls[1]?.args).toContain("preview");
  });

  it("--port abc exits 2 with stderr and does not spawn", async () => {
    const io = makeBufferIO();
    const { spawn, fn } = recordingSpawn();
    const exitCode = await dash({ argv: ["--port", "abc"], env: {}, io, spawn });
    expect(exitCode).toBe(2);
    expect(io.readStderr()).toContain("--port");
    expect(fn).not.toHaveBeenCalled();
  });

  it("default (no flags) spawns Vite (`bun run dev`) in packages/volley-desk with --open", async () => {
    const io = makeBufferIO();
    const { spawn, calls } = recordingSpawn(0);
    const exitCode = await dash({ argv: [], env: {}, io, spawn });
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("bun");
    expect(calls[0]?.opts.cwd).toMatch(/[\\/]packages[\\/]volley-desk$/);
    expect(calls[0]?.args).toEqual(["run", "dev", "--", "--open"]);
  });

  it("--legacy spawns the old dashboard in packages/volley-dash", async () => {
    const io = makeBufferIO();
    const { spawn, calls } = recordingSpawn(0);
    const exitCode = await dash({ argv: ["--legacy", "--port", "6000"], env: {}, io, spawn });
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts.cwd).toMatch(/[\\/]packages[\\/]volley-dash$/);
    expect(calls[0]?.args).toEqual(["run", "dev", "--", "--port", "6000", "--open"]);
  });

  it("--build builds and previews the Desk (or the old dashboard with --legacy)", async () => {
    for (const [argv, pkg] of [
      [["--build"], "volley-desk"],
      [["--build", "--legacy"], "volley-dash"],
    ] as const) {
      const io = makeBufferIO();
      const { spawn, calls } = recordingSpawn(0);
      expect(await dash({ argv: [...argv], env: {}, io, spawn })).toBe(0);
      expect(calls.map((c) => c.args)).toEqual([
        ["run", "build"],
        ["run", "preview"],
      ]);
      for (const c of calls) expect(c.opts.cwd.endsWith(pkg)).toBe(true);
    }
  });

  it("--help names the Desk and the --legacy dashboard", async () => {
    const io = makeBufferIO();
    const { spawn } = recordingSpawn();
    await dash({ argv: ["--help"], env: {}, io, spawn });
    expect(io.readStdout()).toContain("Volley Desk");
    expect(io.readStdout()).toContain("--legacy");
  });

  it("--build never inlines dev-only Desk credentials into the bundle (P3-14)", async () => {
    const io = makeBufferIO();
    const { spawn, calls } = recordingSpawn(0);
    const env = { VITE_VOLLEY_BROKER_USERNAME: "desk", VITE_VOLLEY_BROKER_PASSWORD: "s3cret" };
    expect(await dash({ argv: ["--build"], env, io, spawn })).toBe(0);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.opts.env).not.toHaveProperty("VITE_VOLLEY_BROKER_PASSWORD");
      expect(c.opts.env).not.toHaveProperty("VITE_VOLLEY_BROKER_USERNAME");
    }
    expect(io.readStderr()).toMatch(/VITE_VOLLEY_BROKER_PASSWORD/);
  });

  it("the dev server keeps dev-only Desk credentials (never bundled)", async () => {
    const io = makeBufferIO();
    const { spawn, calls } = recordingSpawn(0);
    const env = { VITE_VOLLEY_BROKER_USERNAME: "desk", VITE_VOLLEY_BROKER_PASSWORD: "s3cret" };
    expect(await dash({ argv: [], env, io, spawn })).toBe(0);
    expect(calls[0]?.opts.env.VITE_VOLLEY_BROKER_PASSWORD).toBe("s3cret");
  });

  it("--host serves the Desk on the LAN; the broker follows the page's host (P3-14)", async () => {
    const io = makeBufferIO();
    const { spawn, calls } = recordingSpawn(0);
    expect(await dash({ argv: ["--host", "0.0.0.0", "--no-open"], env: {}, io, spawn })).toBe(0);
    expect(calls[0]?.args).toEqual(["run", "dev", "--", "--host", "0.0.0.0"]);
    // No localhost broker URL: a phone opening http://<laptop>:5174 connects to ws://<laptop>:9001.
    expect(calls[0]?.opts.env).not.toHaveProperty("VITE_VOLLEY_BROKER_URL");

    // A broker URL inherited from the shell (e.g. a stale localhost export) does not defeat that.
    const polluted = recordingSpawn(0);
    const env = { VITE_VOLLEY_BROKER_URL: "ws://localhost:9001" };
    const hostArgv = ["--host", "0.0.0.0", "--no-open"];
    expect(await dash({ argv: hostArgv, env, io: makeBufferIO(), spawn: polluted.spawn })).toBe(0);
    expect(polluted.calls[0]?.opts.env).not.toHaveProperty("VITE_VOLLEY_BROKER_URL");

    const io2 = makeBufferIO();
    const rec = recordingSpawn(0);
    const argv = ["--host", "0.0.0.0", "--broker-url", "ws://broker.lan:9001", "--no-open"];
    expect(await dash({ argv, env: {}, io: io2, spawn: rec.spawn })).toBe(0);
    expect(rec.calls[0]?.opts.env.VITE_VOLLEY_BROKER_URL).toBe("ws://broker.lan:9001");
  });

  it("--help keeps every option under Options: and documents the LAN broker listener", async () => {
    const io = makeBufferIO();
    const { spawn } = recordingSpawn();
    await dash({ argv: ["--help"], env: {}, io, spawn });
    const out = io.readStdout();
    const options = out.slice(
      out.indexOf("Options:"),
      out.indexOf("\n\n", out.indexOf("Options:")),
    );
    for (const flag of [
      "--legacy",
      "--build",
      "--port",
      "--host",
      "--broker-url",
      "--open",
      "--no-open",
      "--help",
    ])
      expect(options).toContain(flag);
    // --host over a LAN needs mosquitto's WebSocket listener on the LAN, with broker accounts.
    expect(out).toMatch(/listener 9001/);
    expect(out).toMatch(/allow_anonymous false/);
  });

  it("--open --no-open exits 2 with a mutual-exclusion stderr and does not spawn", async () => {
    const io = makeBufferIO();
    const { spawn, fn } = recordingSpawn();
    const exitCode = await dash({ argv: ["--open", "--no-open"], env: {}, io, spawn });
    expect(exitCode).toBe(2);
    expect(io.readStderr()).toMatch(/mutually exclusive|--open.*--no-open/i);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("brewStableRoot", () => {
  /** A Homebrew prefix with Volley's formula installed at `version`, `opt/volley` linked to it. */
  function brewPrefix(version: string, linked = true): string {
    const prefix = tempDir("volley-brew-");
    const libexec = join(prefix, "Cellar", "volley", version, "libexec");
    mkdirSync(libexec, { recursive: true });
    writeFileSync(join(libexec, "bun.lock"), "");
    if (linked) {
      mkdirSync(join(prefix, "opt"));
      symlinkSync(join("..", "Cellar", "volley", version), join(prefix, "opt", "volley"));
    }
    return prefix;
  }

  it("maps a Cellar checkout to the opt path, which survives brew upgrade", () => {
    const prefix = brewPrefix("0.11.0");
    const cellar = join(prefix, "Cellar", "volley", "0.11.0", "libexec");
    expect(brewStableRoot(cellar)).toBe(join(prefix, "opt", "volley", "libexec"));
  });

  it("after an upgrade the opt path still resolves (to the new version)", () => {
    const prefix = brewPrefix("0.12.0");
    const cellar = join(prefix, "Cellar", "volley", "0.11.0", "libexec");
    expect(brewStableRoot(cellar)).toBe(join(prefix, "opt", "volley", "libexec"));
  });

  it("leaves a Cellar path alone when there is no opt link", () => {
    const prefix = brewPrefix("0.11.0", false);
    const cellar = join(prefix, "Cellar", "volley", "0.11.0", "libexec");
    expect(brewStableRoot(cellar)).toBe(cellar);
  });

  it("leaves any other checkout alone", () => {
    expect(brewStableRoot("/path/to/repo")).toBe("/path/to/repo");
    expect(brewStableRoot("/path/to/Cellar/volley/0.11.0")).toBe("/path/to/Cellar/volley/0.11.0");
  });
});
