import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Check, Facts } from "../doctor";

/**
 * The Claude account profiles under volleyd's profiles root (`~/.volley/claude/<acct>`): each
 * signed-in one is ready to run agents unattended, past Claude Code's first-run screens (#400).
 */

// Kept in step with volleyd's copy (src/claude/sharing.ts): volley-cli cannot import it.
const ONBOARDING_KEYS = {
  ".claude.json": ["hasCompletedOnboarding", "lastOnboardingVersion", "theme"],
  "settings.json": ["skipDangerousModePermissionPrompt"],
} as const;
const ONBOARDING_THEME = "dark";

export type ProfileKeys = { ".claude.json": string[]; "settings.json": string[] };

/** The keys `claudeJson` and `settings` still lack, per file. */
export function missingProfileKeys(
  claudeJson: Record<string, unknown>,
  settings: Record<string, unknown>,
): ProfileKeys {
  const present = (o: Record<string, unknown>, k: string) =>
    k === "hasCompletedOnboarding" || k === "skipDangerousModePermissionPrompt"
      ? o[k] === true
      : typeof o[k] === "string" && o[k] !== "";
  return {
    ".claude.json": ONBOARDING_KEYS[".claude.json"].filter((k) => !present(claudeJson, k)),
    "settings.json": ONBOARDING_KEYS["settings.json"].filter((k) => !present(settings, k)),
  };
}
// End of the copy kept with volleyd.

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

/** Write JSON through a temp file and a rename (0600: a profile's files hold its login). */
function writeJson(path: string, value: Record<string, unknown>) {
  const tmp = `${path}.volley-doctor.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Write a profile's missing keys (the doctor's `--fix`): `.claude.json` under Claude Code's own
 * lock (`<file>.lock/`), `settings.json` unless it is linked to the primary's. A symlinked
 * `.claude.json` is refused: a profile's own is never linked.
 */
export function seedAccountProfile(dir: string, claudeVersion: string | null): void {
  const json = join(dir, ".claude.json");
  if (lstatSync(json).isSymbolicLink()) throw new Error(`${json} is a symlink`);
  const lock = `${json}.lock`;
  try {
    mkdirSync(lock);
  } catch {
    throw new Error(`${lock} is held; rerun when no Claude Code session of this profile runs`);
  }
  try {
    const cur = readObject(json) ?? {};
    const value: Record<string, unknown> = {
      hasCompletedOnboarding: true,
      lastOnboardingVersion: claudeVersion ?? undefined,
      theme: ONBOARDING_THEME,
    };
    const add = missingProfileKeys(cur, {})[".claude.json"].filter((k) => value[k] !== undefined);
    if (add.length > 0)
      writeJson(json, { ...cur, ...Object.fromEntries(add.map((k) => [k, value[k]])) });
  } finally {
    rmdirSync(lock);
  }
  const settings = join(dir, "settings.json");
  let linked = false;
  try {
    linked = lstatSync(settings).isSymbolicLink();
  } catch {}
  if (linked) return;
  const cur = readObject(settings) ?? {};
  if (missingProfileKeys({}, cur)["settings.json"].length > 0)
    writeJson(settings, { ...cur, skipDangerousModePermissionPrompt: true });
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
  const version = f.tools.claude.version;
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
              run: () => seedAccountProfile(p.dir, version),
            })),
          },
  };
}
