import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import type { IO } from "../../../io";
import type { Surface } from "./types";

/** Loose function type — lets tests pass `vi.fn()` without `unknown` casts. */
export type DesktopSpawnFn = (cmd: string, args: string[]) => void;

/** Synchronous PATH probe — `spawnSync` keeps the factory itself synchronous. */
export type DesktopWhichFn = (cmd: string) => string | null;

export interface CreateDesktopSurfaceOpts {
  io: IO;
  /** Override `VOLLEY_NOTIFY_SOUND` (defaults to `"Glass"`). */
  sound?: string;
  spawn?: DesktopSpawnFn;
  which?: DesktopWhichFn;
}

function makeDefaultSpawn(io: IO): DesktopSpawnFn {
  return (cmd, args) => {
    // Fire-and-forget: don't wait on the child, swallow its I/O so it can't
    // pollute the notify loop's own stdio. The `'error'` handler is required —
    // without it, an async spawn failure (binary vanished between the
    // construction-time `which` probe and now) would surface as an unhandled
    // EventEmitter error and crash the parent. Route it through io.stderr for
    // parity with the synchronous-throw branch in `fire()`.
    nodeSpawn(cmd, args, { stdio: "ignore" })
      .on("error", (e) => {
        io.stderr(`[notify] desktop spawn failed: ${e.message}\n`);
      })
      .unref();
  };
}

const defaultWhich: DesktopWhichFn = (cmd) => {
  try {
    const result = spawnSync("which", [cmd], { encoding: "utf8" });
    if (result.status === 0 && typeof result.stdout === "string") {
      const trimmed = result.stdout.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    return null;
  } catch {
    return null;
  }
};

export function createDesktopSurface(opts: CreateDesktopSurfaceOpts): Surface {
  const { io } = opts;
  const which = opts.which ?? defaultWhich;
  const spawn = opts.spawn ?? makeDefaultSpawn(io);
  const sound = opts.sound ?? "Glass";
  const resolvedPath = which("terminal-notifier");

  if (resolvedPath === null) {
    io.stderr(
      "[notify] desktop surface disabled: terminal-notifier not found on PATH (brew install terminal-notifier)\n",
    );
    return {
      name: "desktop",
      async fire() {
        // no-op when terminal-notifier is unavailable
      },
    };
  }

  return {
    name: "desktop",
    async fire({ envelope }) {
      try {
        // Spawn by absolute path (from the construction-time `which` probe) so a
        // PATH mutation between factory-construction and fire-time can't break us.
        spawn(resolvedPath, [
          "-title",
          "Volley",
          "-subtitle",
          envelope.agent_id,
          "-message",
          envelope.type,
          "-sound",
          sound,
        ]);
      } catch (e) {
        io.stderr(`[notify] desktop spawn failed: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    },
  };
}
