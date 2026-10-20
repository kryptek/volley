import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  classifyCmux,
  cmuxAdvice,
  cmuxEnv,
  cmuxSaid,
  readCmuxPassword,
} from "volley-cli/setup/cmux";
import { DAEMON_DEFAULTS } from "../config-defaults";
import { volleydHome } from "../config-store";
import type { ExecFn, ExecOptions, ExecResult } from "../exec";
import type { ConsentToken } from "../fence";
import { SpawnError } from "../spawn-error";
import { addWorktree } from "../worktree";
import type { Host, LaunchSpec, TypedTextTokens, WorktreeResult, WorktreeSpec } from "./host";

/**
 * The local host: worktrees on this machine, agents in cmux workspaces. Every command goes
 * through the fenced `exec`; closing a workspace needs a consent token (`cleanup --yes`, or a
 * retire for its agent's own workspace). volleyd runs as a service, outside cmux, so cmux lets it
 * in only with its socket password: every cmux call gets the one `volley setup` stored
 * (`$VOLLEYD_HOME/cmux.json`, read each time) as `CMUX_SOCKET_PASSWORD` in its environment.
 */
export class LocalCmuxHost implements Host {
  readonly name = "local";
  readonly screenSource = "cmux";
  constructor(
    readonly exec: ExecFn,
    private readonly home: string = volleydHome(process.env),
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  /** `exec` for a cmux argv, with the socket password in its environment when one is stored. */
  private cmux(argv: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const env = cmuxEnv(this.home, this.env);
    return this.exec(argv, env === undefined ? opts : { ...opts, env });
  }

  prepareWorktree(spec: WorktreeSpec): Promise<WorktreeResult> {
    return addWorktree(this.exec, spec);
  }

  async writeFile(path: string, content: string, mode?: number): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (mode === undefined) return writeFile(path, content);
    // A fresh temp file created with `mode`, renamed over the target: the content is never
    // readable under an existing file's older, more open mode (agent.json holds a password).
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, content, { mode, flag: "wx" });
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  async launch(spec: LaunchSpec): Promise<{ workspace: string }> {
    const r = await this.cmux(
      ["cmux", "new-workspace", "--cwd", spec.cwd, "--name", spec.name, "--command", spec.command],
      spec.launch !== undefined ? { launch: spec.launch } : {},
    ).catch((e: unknown) => {
      throw new SpawnError(
        "LAUNCH_FAILED",
        `cmux new-workspace: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    const workspace = r.code === 0 ? parseWorkspaceRef(r.stdout) : null;
    if (workspace === null) {
      // cmux refusing volleyd (or not running) is something the owner can fix: say how.
      const access = r.code === 0 ? "unknown" : classifyCmux(r);
      const hasPassword =
        (this.env.CMUX_SOCKET_PASSWORD ?? "") !== "" || readCmuxPassword(this.home) !== null;
      throw new SpawnError(
        "LAUNCH_FAILED",
        access === "refused" || access === "not_running" || access === "missing"
          ? `volleyd cannot open a cmux workspace. ${cmuxAdvice(access, hasPassword)}${cmuxSaid(r.stderr || r.stdout)}`
          : `cmux new-workspace failed: ${r.stderr.trim()}`,
        { exit: r.code, stdout: r.stdout.trim(), cmux: r.stderr.trim() },
      );
    }
    return { workspace };
  }

  async readScreen(workspace: string, lines: number): Promise<string | null> {
    // Bounded: a hung cmux must not hold a caller (the screen publisher, verification) forever.
    const r = await this.cmux(
      ["cmux", "read-screen", "--workspace", workspace, "--lines", String(lines)],
      { timeoutMs: DAEMON_DEFAULTS.screen_read_timeout_ms },
    ).catch(() => null);
    return r !== null && r.code === 0 && !r.timedOut ? r.stdout : null;
  }

  async sendKeys(workspace: string, key: string): Promise<void> {
    await this.cmux(["cmux", "send-key", "--workspace", workspace, key]);
  }

  async sendText(workspace: string, text: string, tokens: TypedTextTokens = {}): Promise<void> {
    await this.cmux(["cmux", "send", "--workspace", workspace, text], tokens);
  }

  async close(workspace: string, consent: ConsentToken): Promise<void> {
    await this.cmux(["cmux", "close-workspace", "--workspace", workspace], { consent });
  }
}

/**
 * The workspace ref in `cmux new-workspace` output: `workspace:<n>` (as printed by `OK
 * workspace:3`), a JSON `{ workspace_ref | ref | id }`, or a bare UUID.
 */
export function parseWorkspaceRef(stdout: string): string | null {
  const text = stdout.trim();
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    for (const k of ["workspace_ref", "ref", "workspace", "id"]) {
      if (typeof j[k] === "string" && j[k] !== "") return j[k] as string;
    }
  } catch {}
  const ref = /\bworkspace:[A-Za-z0-9-]+/.exec(text);
  if (ref !== null) return ref[0];
  const uuid =
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/.exec(text);
  return uuid !== null ? uuid[0] : null;
}
