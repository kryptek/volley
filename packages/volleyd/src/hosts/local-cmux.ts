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
import { type ConsentToken, FenceError } from "../fence";
import { SpawnError } from "../spawn-error";
import { addWorktree } from "../worktree";
import type { Host, LaunchSpec, TypedTextTokens, WorktreeResult, WorktreeSpec } from "./host";

/**
 * The local host: worktrees on this machine, agents in cmux workspaces. Every command goes
 * through the fenced `exec`; closing a workspace needs a consent token (`cleanup --yes`, or a
 * retire for its agent's own workspace). volleyd runs as a service, outside cmux, so cmux lets it
 * in only in Automation mode (what `volley setup` recommends), Password mode or full open access.
 * For Password mode every cmux call gets the password `volley setup` stored
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

  /** The launch chain: each launch starts after the one before it settles. */
  private launches: Promise<unknown> = Promise.resolve();

  /**
   * Open a workspace. Launches are serialized: one `new-workspace` in flight at a time, so a slow
   * cmux does not stack them.
   */
  launch(spec: LaunchSpec): Promise<{ workspace: string }> {
    const run = this.launches.then(() => this.launchNow(spec));
    this.launches = run.catch(() => undefined);
    return run;
  }

  /**
   * A failed launch's `detail.outcome`: `refused` when cmux answered and created nothing (it
   * refused volleyd, is not running or is not installed), `unknown` when it may have created the
   * workspace (a timeout, an unexplained failure, an exit with no ref): spawn.ts reconciles.
   */
  private async launchNow(spec: LaunchSpec): Promise<{ workspace: string }> {
    const r = await this.cmux(
      ["cmux", "new-workspace", "--cwd", spec.cwd, "--name", spec.name, "--command", spec.command],
      {
        timeoutMs: DAEMON_DEFAULTS.launch_timeout_ms,
        ...(spec.launch !== undefined ? { launch: spec.launch } : {}),
      },
    ).catch((e: unknown) => {
      throw new SpawnError(
        "LAUNCH_FAILED",
        `cmux new-workspace: ${e instanceof Error ? e.message : String(e)}`,
        // The fence refusing it means nothing ran; anything else may have started cmux.
        { outcome: e instanceof FenceError ? "refused" : "unknown" },
      );
    });
    const workspace = r.code === 0 && !r.timedOut ? parseWorkspaceRef(r.stdout) : null;
    if (workspace === null) {
      // cmux refusing volleyd (or not running) is something the owner can fix: say how.
      const timedOut = r.timedOut || /command timed out/i.test(`${r.stderr}\n${r.stdout}`);
      const access = r.code === 0 || timedOut ? "unknown" : classifyCmux(r);
      const refused = access === "refused" || access === "not_running" || access === "missing";
      const hasPassword =
        (this.env.CMUX_SOCKET_PASSWORD ?? "") !== "" || readCmuxPassword(this.home) !== null;
      throw new SpawnError(
        "LAUNCH_FAILED",
        refused
          ? `volleyd cannot open a cmux workspace. ${cmuxAdvice(access, hasPassword)}${cmuxSaid(r.stderr || r.stdout)}`
          : `cmux new-workspace failed: ${r.timedOut ? "timed out" : r.stderr.trim()}`,
        {
          exit: r.code,
          stdout: r.stdout.trim(),
          cmux: r.stderr.trim(),
          outcome: refused ? "refused" : "unknown",
        },
      );
    }
    return { workspace };
  }

  async findWorkspace(name: string): Promise<string | null> {
    const r = await this.cmux(["cmux", "list-workspaces"], {
      timeoutMs: DAEMON_DEFAULTS.workspace_lookup_timeout_ms,
    });
    if (r.timedOut || r.code !== 0) {
      throw new Error(
        `cmux list-workspaces failed: ${r.timedOut ? "timed out" : r.stderr.trim() || `exit ${r.code}`}`,
      );
    }
    return parseWorkspaceList(r.stdout, name);
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

/**
 * The ref of the workspace titled exactly `name` in `cmux list-workspaces` output: its lines
 * (`[*] workspace:<n>  <title>  [[selected]]`), or JSON (an array, or `{ workspaces }`, of
 * `{ ref | workspace_ref | id, name | title | custom_title }`). Null when none has that title;
 * throws when more than one has it (which one a launch opened cannot be told, spawn.ts burns it).
 * A `--name` title is a custom title: checked against live cmux, it stays the listed title (and
 * `custom_title`) while the agent in the workspace sets its terminal title. Only workspaces with
 * no custom title list the process's title (`✳ …`).
 */
export function parseWorkspaceList(stdout: string, name: string): string | null {
  const want = name.trim();
  try {
    const j = JSON.parse(stdout) as unknown;
    const list = Array.isArray(j) ? j : (j as { workspaces?: unknown }).workspaces;
    if (Array.isArray(list)) {
      const pick = (o: Record<string, unknown>, keys: string[]) =>
        keys.map((k) => o[k]).find((v): v is string => typeof v === "string" && v !== "");
      const refs = (list as Record<string, unknown>[])
        .filter((w) => pick(w, ["name", "title", "custom_title"])?.trim() === want)
        .map((w) => pick(w, ["ref", "workspace_ref", "id"]))
        .filter((ref): ref is string => ref !== undefined);
      return onlyOne(refs, want);
    }
  } catch (e) {
    if (e instanceof AmbiguousWorkspace) throw e;
  }
  const refs: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*\*?\s*(workspace:[A-Za-z0-9-]+)\s+(.*?)\s*(?:\[selected\])?\s*$/.exec(line);
    if (m !== null && m[2] === want) refs.push(m[1] as string);
  }
  return onlyOne(refs, want);
}

class AmbiguousWorkspace extends Error {}

/** The one ref carrying the name; more than one cannot be told apart, so the lookup fails. */
function onlyOne(refs: string[], name: string): string | null {
  if (refs.length > 1) {
    throw new AmbiguousWorkspace(
      `${refs.length} workspaces are named "${name}": ${refs.join(", ")}`,
    );
  }
  return refs[0] ?? null;
}
