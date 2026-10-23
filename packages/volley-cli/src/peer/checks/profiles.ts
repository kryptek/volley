import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ProfileKeys, missingProfileKeys, seedProfile } from "volleyd/claude/sharing";
import type { Check, Facts } from "../doctor";

/**
 * The Claude account profiles under volleyd's profiles root (`~/.volley/claude/<acct>`): each
 * signed-in one is ready to run agents unattended, past Claude Code's first-run screens (#400).
 */

export interface AccountProfile {
  id: string;
  dir: string;
  missing: ProfileKeys;
  /** Agent sessions running in it (their launch.sh exports its CLAUDE_CONFIG_DIR). */
  sessions: number;
}

const readObject = (path: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** A launch script's profile line (volleyd's renderLaunchScript). */
const LAUNCH_PROFILE = /^export CLAUDE_CONFIG_DIR='((?:[^']|'\\'')*)'$/m;
const MCP_CONFIG = /(?:^|\s)--mcp-config=(?:'([^']*)'|"([^"]*)"|(\S+))/;

/**
 * The CLAUDE_CONFIG_DIR of each running agent session: `ps` lists them by their
 * `--mcp-config=<worktree>/.volley/mcp.json`, and that worktree's launch.sh names the profile.
 */
async function runningProfiles(
  sh: (argv: string[]) => Promise<{ code: number; stdout: string }>,
): Promise<string[]> {
  const r = await sh(["ps", "-axo", "pid=,command="]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").flatMap((line) => {
    const m = MCP_CONFIG.exec(line);
    const mcp = m === null ? undefined : (m[1] ?? m[2] ?? m[3]);
    if (mcp === undefined || mcp === "") return [];
    try {
      const p = LAUNCH_PROFILE.exec(readFileSync(join(dirname(mcp), "launch.sh"), "utf-8"));
      return p === null ? [] : [(p[1] as string).replace(/'\\''/g, "'")];
    } catch {
      return [];
    }
  });
}

/** A parsed `~/.claude.json`'s `lastOnboardingVersion` (null: none recorded). */
export function onboardingVersionOf(claudeJson: unknown): string | null {
  const v =
    typeof claudeJson === "object" && claudeJson !== null && !Array.isArray(claudeJson)
      ? (claudeJson as Record<string, unknown>).lastOnboardingVersion
      : undefined;
  return typeof v === "string" && v !== "" ? v : null;
}

/** The signed-in profiles under `root` (a `.claude.json` with an `oauthAccount`), sorted. */
export async function gatherAccountProfiles(
  sh: (argv: string[]) => Promise<{ code: number; stdout: string }>,
  root: string,
): Promise<AccountProfile[]> {
  let ids: string[] = [];
  try {
    ids = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {}
  const signedIn = ids.flatMap((id) => {
    const dir = join(root, id);
    const json = readObject(join(dir, ".claude.json"));
    if (json === null || typeof json.oauthAccount !== "object" || json.oauthAccount === null)
      return [];
    const missing = missingProfileKeys(json, readObject(join(dir, "settings.json")) ?? {});
    return [{ id, dir, missing }];
  });
  const unready = signedIn.some(
    (p) => p.missing[".claude.json"].length + p.missing["settings.json"].length > 0,
  );
  const running = unready ? await runningProfiles(sh) : [];
  return signedIn.map((p) => ({
    ...p,
    sessions: running.filter((d) => d === p.dir).length,
  }));
}

const describeMissing = (m: ProfileKeys) =>
  (Object.entries(m) as [string, string[]][])
    .filter(([, keys]) => keys.length > 0)
    .map(([file, keys]) => `${file}: ${keys.join(", ")}`)
    .join("; ");

/**
 * `claude.profiles` (warn): every signed-in account profile is ready to run agents unattended.
 * `--fix` writes the missing keys, except in a profile an agent session runs in (Claude Code
 * rewrites its `.claude.json` from memory): that one is reported skipped until they exit.
 */
export function accountProfilesCheck(f: Facts): Check {
  const all = f.claude.profiles;
  const unready = all.filter(
    (p) => p.missing[".claude.json"].length + p.missing["settings.json"].length > 0,
  );
  if (all.length === 0)
    return {
      id: "claude.profiles",
      ok: true,
      severity: "warn",
      detail: "no Claude account profiles on this machine",
    };
  if (unready.length === 0)
    return {
      id: "claude.profiles",
      ok: true,
      severity: "warn",
      detail: `${all.length} account profile${all.length === 1 ? "" : "s"} ready to run agents unattended`,
    };
  const fixable = unready.filter((p) => p.sessions === 0);
  const detail = unready
    .map((p) =>
      p.sessions > 0
        ? `${p.id}: skipped: ${p.sessions} session(s) running — rerun when they exit`
        : `${p.id}: not ready to run agents unattended (${describeMissing(p.missing)})`,
    )
    .join("; ");
  // as volleyd seeds: Claude Code's version here, else the one the default login recorded
  const version = f.tools.claude.version ?? f.claude.onboardingVersion;
  return {
    id: "claude.profiles",
    ok: false,
    severity: "warn",
    detail,
    fix:
      fixable.length === 0
        ? { command: "rerun volley peer doctor --fix once those sessions exit" }
        : {
            command: "volley peer doctor --fix",
            steps: [],
            apply: fixable.map((p) => ({
              what: `${p.dir}: the onboarding keys and the bypass-permissions consent written`,
              run: () => {
                seedProfile(p.dir, version === null ? {} : { claudeVersion: version });
              },
            })),
          },
  };
}
