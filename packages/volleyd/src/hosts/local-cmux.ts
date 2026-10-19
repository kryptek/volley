import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DAEMON_DEFAULTS } from "../config-defaults";
import type { ExecFn } from "../exec";
import type { ConsentToken } from "../fence";
import { SpawnError } from "../spawn-error";
import { addWorktree } from "../worktree";
import type { Host, LaunchSpec, TypedTextTokens, WorktreeResult, WorktreeSpec } from "./host";

/**
 * The local host: worktrees on this machine, agents in cmux workspaces. Every command goes
 * through the fenced `exec`; closing a workspace needs a consent token (`cleanup --yes`, or a
 * retire for its agent's own workspace).
 */
export class LocalCmuxHost implements Host {
  readonly name = "local";
  readonly screenSource = "cmux";
  constructor(readonly exec: ExecFn) {}

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
    const r = await this.exec(
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
      throw new SpawnError("LAUNCH_FAILED", `cmux new-workspace failed: ${r.stderr.trim()}`, {
        exit: r.code,
        stdout: r.stdout.trim(),
      });
    }
    return { workspace };
  }

  async readScreen(workspace: string, lines: number): Promise<string | null> {
    // Bounded: a hung cmux must not hold a caller (the screen publisher, verification) forever.
    const r = await this.exec(
      ["cmux", "read-screen", "--workspace", workspace, "--lines", String(lines)],
      { timeoutMs: DAEMON_DEFAULTS.screen_read_timeout_ms },
    ).catch(() => null);
    return r !== null && r.code === 0 && !r.timedOut ? r.stdout : null;
  }

  async sendKeys(workspace: string, key: string): Promise<void> {
    await this.exec(["cmux", "send-key", "--workspace", workspace, key]);
  }

  async sendText(workspace: string, text: string, tokens: TypedTextTokens = {}): Promise<void> {
    await this.exec(["cmux", "send", "--workspace", workspace, text], tokens);
  }

  async close(workspace: string, consent: ConsentToken): Promise<void> {
    await this.exec(["cmux", "close-workspace", "--workspace", workspace], { consent });
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
