import { constants, accessSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecFn } from "./exec";
import { mintScriptToken } from "./fence";
import { SpawnError } from "./spawn-error";

/** The roles volleyd spawns; each has `briefs/<role>.md.tmpl`. */
export const ROLES = ["implementer", "spec_reviewer", "quality_reviewer", "fixup"] as const;
export type Role = (typeof ROLES)[number];

export const isRole = (r: string): r is Role => (ROLES as readonly string[]).includes(r);

export const BRIEFS_DIR = fileURLToPath(new URL("../briefs/", import.meta.url));

/** Every placeholder a template may use. */
export interface BriefVars {
  agent_id: string;
  namespace: string;
  wave: string;
  task: string;
  role: Role;
  issue: number;
  issue_title: string;
  issue_url: string;
  model: string;
  repo: string;
  release_branch: string;
  branch: string;
  worktree: string;
  /** Repo-specific notes (`<repo>/.volley/brief-extra.md`), rendered as their own section. */
  extra: string;
}

export function loadTemplate(role: Role, dir: string = BRIEFS_DIR): string {
  return readFileSync(join(dir, `${role}.md.tmpl`), "utf-8");
}

/**
 * Fill `{{name}}` placeholders in one pass, so text substituted in (an issue title that itself
 * contains `{{…}}`) is never expanded again. An unknown placeholder is an error: a template and
 * this module never silently drift apart.
 */
export function renderBrief(template: string, vars: BriefVars): string {
  const table = vars as unknown as Record<string, string | number>;
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, name: string) => {
    if (!Object.hasOwn(table, name)) throw new Error(`brief template: unknown {{${name}}}`);
    return String(table[name]);
  });
}

/** The `extra` section from `<repoRoot>/.volley/brief-extra.md` (kept out of git), or "". */
export function briefExtra(repoRoot: string): string {
  const file = join(repoRoot, ".volley", "brief-extra.md");
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf-8").trim();
  return text === "" ? "" : `\n## Repository notes\n\n${text}\n`;
}

/**
 * The brief gate: `$VOLLEYD_HOME/brief-gate`, if present and executable. It is a local file on
 * purpose: a gate is a program, so it must not be settable over the broker (`config_set`).
 */
export function briefGatePath(home: string): string | null {
  const file = join(home, "brief-gate");
  try {
    accessSync(file, constants.X_OK);
    return file;
  } catch {
    return null;
  }
}

/**
 * Run the gate on the rendered brief: `<gate> <brief.md>` in the worktree. A non-zero exit (or
 * a gate that cannot run) refuses the spawn with SPAWN_BRIEF_REJECTED, before any launch.
 */
export async function runBriefGate(
  exec: ExecFn,
  gate: string,
  briefPath: string,
  cwd: string,
): Promise<void> {
  let r: Awaited<ReturnType<ExecFn>>;
  try {
    r = await exec([gate, briefPath], { cwd, script: mintScriptToken(gate) });
  } catch (e) {
    throw new SpawnError(
      "SPAWN_BRIEF_REJECTED",
      `brief gate did not run: ${e instanceof Error ? e.message : String(e)}`,
      { gate },
    );
  }
  if (r.code !== 0) {
    throw new SpawnError("SPAWN_BRIEF_REJECTED", `brief gate exited ${r.code}`, {
      gate,
      exit: r.code,
      stderr: r.stderr.trim(),
      stdout: r.stdout.trim(),
    });
  }
}
