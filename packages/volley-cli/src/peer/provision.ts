import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_SHARING, type Sharing } from "volleyd/claude/sharing";
import type { Check, Fix } from "./doctor";

export { DEFAULT_SHARING, type Sharing };

/**
 * The machine's own Claude profile (`~/.claude` of the user running the doctor, and the MCP
 * section of `~/.claude.json`), prepared the way `volley setup` and the installers prepare it
 * locally: the Volley skills linked to this checkout, the hooks installed for the broker as this
 * machine reaches it (the tunnel), the volley MCP server registered at that URL, each under the
 * supervisor's per-item sharing modes (SPEC §4.6.11, its readiness `requirements.sharing`).
 *
 * Every check is a `warn`: an agent volleyd spawns still runs without them (its spawn provides
 * `.volley/mcp.json` and the hooks itself); they are for the sessions people start here. The
 * fixes write only inside `~/.claude`, `~/.claude.json`'s `mcpServers` and the hooks' state dir,
 * through the packages' own installers and `claude mcp`. No credential is read, printed or
 * registered: the MCP entry carries no broker login, and an entry that has env of its own is
 * never rewritten (its fix is printed for the person to run).
 */

export const PROFILE_CHECKS = ["skills", "hooks", "mcp", "sharing"] as const;

/** What the profile is checked against. */
export interface ProfileTarget {
  /** The broker as this machine reaches it (the tunnel); null when not paired (kept as found). */
  brokerUrl: string | null;
  /** The volley namespace the MCP server registers in; null when not known (not compared). */
  namespace: string | null;
  sharing: Sharing;
  /** Where `sharing` came from: the supervisor's readiness, `--sharing`, or the defaults. */
  from: "supervisor" | "flag" | "defaults";
}

export const defaultTarget = (): ProfileTarget => ({
  brokerUrl: null,
  namespace: null,
  sharing: { ...DEFAULT_SHARING },
  from: "defaults",
});

/** The skills this checkout installs: `~/.claude/skills/<name>` → `packages/<pkg>`. */
const SKILLS = [
  { name: "volley", pkg: "volley-skill" },
  { name: "volley-issues", pkg: "volley-issues" },
] as const;

/** The env keys the doctor's MCP registration sets: any other is the person's own. */
const MCP_ENV = ["VOLLEY_AGENT_ID", "VOLLEY_NAMESPACE", "VOLLEY_BROKER_URL"];

/** The PATH the hooks installer runs with besides bun's folder (a service's PATH may lack bun). */
const BASE_PATH = "/usr/bin:/bin";

export interface SkillFact {
  name: string;
  /** `~/.claude/skills/<name>`. */
  at: string;
  pkg: string;
  installer: string;
  /** linked: resolves to `pkg`; elsewhere: a link to another folder; stray: a folder of its own. */
  state: "linked" | "elsewhere" | "stray" | "absent";
}

export interface ProfileFacts {
  home: string;
  target: ProfileTarget;
  skillsDir: string;
  skills: SkillFact[];
  hooks: {
    installer: string;
    settings: string;
    /** The URL the installer ran with: the target's, else the one the installed hooks carry. */
    brokerUrl: string | null;
    argv: string[] | null;
    state: "installed" | "differs" | "failed" | "no_bun" | "no_installer";
    why: string | null;
  };
  mcp: {
    entry: string;
    /** `claude mcp` argv that register this checkout's server (null without claude). */
    add: string[] | null;
    remove: string[] | null;
    state: "ok" | "missing" | "differs" | "unreadable";
    /** What differs (never a value from the entry: its env can hold secrets). */
    why: string | null;
    /** The entry has env of its own (a login, say): the doctor never rewrites it. */
    own: boolean;
  };
}

type Sh = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const realOf = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

function skillState(at: string, pkg: string): SkillFact["state"] {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(at);
  } catch {
    return "absent";
  }
  if (!st.isSymbolicLink()) return "stray";
  return existsSync(at) && realOf(at) === realOf(pkg) ? "linked" : "elsewhere";
}

/** The broker URL the Volley hooks in `settings` carry (`VOLLEY_BROKER_URL=<url>` in their prefix). */
export function installedBrokerUrl(settings: string): string | null {
  let j: { hooks?: unknown; statusLine?: { command?: unknown } };
  try {
    j = JSON.parse(settings);
  } catch {
    return null;
  }
  const commands: unknown[] = [j?.statusLine?.command];
  if (typeof j?.hooks === "object" && j.hooks !== null) {
    for (const groups of Object.values(j.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        const hs = (g as { hooks?: unknown } | null)?.hooks;
        for (const h of Array.isArray(hs) ? hs : []) {
          commands.push((h as { command?: unknown } | null)?.command);
        }
      }
    }
  }
  for (const c of commands) {
    if (typeof c !== "string" || !c.includes("/volley-hooks/src/")) continue;
    const m = /^(?:[A-Z_]+=\S* )*?VOLLEY_BROKER_URL=(\S+) /.exec(c);
    if (m !== null) return m[1] as string;
  }
  return null;
}

const lastLine = (s: string) => s.trim().split("\n").pop()?.trim() ?? "";

/** A single-quoted shell word. */
const sq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const shellLine = (argv: string[]) => argv.map(sq).join(" ");

export async function gatherProfile(
  sh: Sh,
  where: { home: string; volleyDir: string; bun: string | null; claude: string | null },
  target: ProfileTarget,
): Promise<ProfileFacts> {
  const { home, volleyDir, bun, claude } = where;
  const pkgs = join(volleyDir, "packages");
  const skillsDir = join(home, ".claude", "skills");
  const skills = SKILLS.map(({ name, pkg }): SkillFact => {
    const at = join(skillsDir, name);
    const dir = join(pkgs, pkg);
    return {
      name,
      at,
      pkg: dir,
      installer: join(dir, "scripts", "install.sh"),
      state: skillState(at, dir),
    };
  });

  // The hooks: the installer's dry run for this profile and URL, compared with settings.json
  // (`volley setup`'s services step does the same locally).
  const settings = join(home, ".claude", "settings.json");
  let current = "";
  try {
    current = readFileSync(settings, "utf-8");
  } catch {}
  const installer = join(pkgs, "volley-hooks", "scripts", "install.sh");
  const brokerUrl = target.brokerUrl ?? installedBrokerUrl(current);
  const hooks: ProfileFacts["hooks"] = {
    installer,
    settings,
    brokerUrl,
    argv: null,
    state: "installed",
    why: null,
  };
  if (target.sharing["settings.json"] !== "own") {
    if (!existsSync(installer)) hooks.state = "no_installer";
    else if (bun === null) hooks.state = "no_bun";
    else {
      hooks.argv = [
        "env",
        // Never the doctor's own environment's URL: only the one expected or already installed.
        ...(brokerUrl === null ? ["-u", "VOLLEY_BROKER_URL"] : []),
        `HOME=${home}`,
        `CLAUDE_SETTINGS=${settings}`,
        ...(brokerUrl !== null ? [`VOLLEY_BROKER_URL=${brokerUrl}`] : []),
        `PATH=${dirname(bun)}:${BASE_PATH}`,
        "bash",
        installer,
      ];
      const r = await sh([...hooks.argv, "--dry-run"]);
      if (r.code !== 0) {
        hooks.state = "failed";
        hooks.why = lastLine(r.stderr) || `exit ${r.code}`;
      } else hooks.state = r.stdout === current ? "installed" : "differs";
    }
  }

  // The MCP server: `mcpServers.volley` in ~/.claude.json (where `claude mcp add-json -s user`
  // puts it).
  const entry = join(pkgs, "volley-mcp", "src", "index.ts");
  const json = JSON.stringify({
    type: "stdio",
    command: bun ?? "bun",
    args: ["run", entry],
    env: {
      VOLLEY_AGENT_ID: "coordinator",
      ...(target.namespace !== null ? { VOLLEY_NAMESPACE: target.namespace } : {}),
      ...(target.brokerUrl !== null ? { VOLLEY_BROKER_URL: target.brokerUrl } : {}),
    },
  });
  const mcp: ProfileFacts["mcp"] = {
    entry,
    add: claude !== null ? [claude, "mcp", "add-json", "-s", "user", "volley", json] : null,
    remove: claude !== null ? [claude, "mcp", "remove", "-s", "user", "volley"] : null,
    state: "ok",
    why: null,
    own: false,
  };
  const file = join(home, ".claude.json");
  let j: unknown = {};
  if (existsSync(file)) {
    try {
      j = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      j = undefined;
    }
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) mcp.state = "unreadable";
  else {
    const servers = (j as { mcpServers?: unknown }).mcpServers;
    const e = (typeof servers === "object" && servers !== null ? servers : {}) as Record<
      string,
      unknown
    >;
    const v = Object.hasOwn(e, "volley") ? e.volley : undefined;
    if (typeof v !== "object" || v === null) mcp.state = "missing";
    else {
      const { command, args, env } = v as { command?: unknown; args?: unknown; env?: unknown };
      const envs = (typeof env === "object" && env !== null ? env : {}) as Record<string, unknown>;
      mcp.own = Object.keys(envs).some((k) => !MCP_ENV.includes(k));
      const runsEntry =
        typeof command === "string" &&
        /(^|\/)bun$/.test(command) &&
        Array.isArray(args) &&
        args.some((a) => typeof a === "string" && realOf(a) === realOf(entry));
      if (!runsEntry) mcp.why = "does not run this checkout's volley-mcp";
      else if (target.brokerUrl !== null && envs.VOLLEY_BROKER_URL !== target.brokerUrl) {
        mcp.why = `is not at ${target.brokerUrl}`;
      } else if (
        target.namespace !== null &&
        (envs.VOLLEY_NAMESPACE ?? "default") !== target.namespace
      ) {
        mcp.why = `is not in namespace ${target.namespace}`;
      }
      if (mcp.why !== null) mcp.state = "differs";
    }
  }
  return { home, target, skillsDir, skills, hooks, mcp };
}

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

const warn = (id: string, ok: boolean, detail: string, fix?: Fix): Check => ({
  id,
  ok,
  severity: "warn",
  detail,
  ...(fix !== undefined ? { fix } : {}),
});
const stepsFix = (steps: string[][]): Fix => ({
  command: steps.map(shellLine).join(" && "),
  steps,
});
const leftAsIs = (item: string) => `left as is (sharing: ${item} own)`;

function skillsCheck(p: ProfileFacts): Check {
  const mode = p.target.sharing.skills;
  const names = p.skills.map((s) => s.name).join(" and ");
  if (mode === "own") return warn("skills", true, `~/.claude/skills: ${leftAsIs("skills")}`);
  if (mode === "copy") {
    const absent = p.skills.filter((s) => s.state === "absent");
    if (absent.length === 0) {
      return warn("skills", true, `skills ${names} are in ~/.claude/skills (sharing: copy, kept)`);
    }
    return warn(
      "skills",
      false,
      `not in ~/.claude/skills: ${absent.map((s) => s.name).join(", ")} (sharing: copy)`,
      stepsFix([["mkdir", "-p", p.skillsDir], ...absent.map((s) => ["cp", "-R", s.pkg, s.at])]),
    );
  }
  const bad = p.skills.filter((s) => s.state !== "linked");
  if (bad.length === 0) {
    return warn("skills", true, `skills ${names} link to this checkout`);
  }
  const why = (s: SkillFact) =>
    s.state === "absent"
      ? `${s.name} is not installed`
      : s.state === "elsewhere"
        ? `${s.name} links to another folder`
        : `${s.name} is a folder of its own (the installer backs it up)`;
  return warn(
    "skills",
    false,
    `~/.claude/skills: ${bad.map(why).join("; ")}`,
    stepsFix(bad.map((s) => ["env", `HOME=${p.home}`, "bash", s.installer])),
  );
}

function hooksCheck(p: ProfileFacts): Check {
  const h = p.hooks;
  if (p.target.sharing["settings.json"] === "own") {
    return warn("hooks", true, `~/.claude/settings.json: ${leftAsIs("settings.json")}`);
  }
  const at = h.brokerUrl !== null ? ` for ${h.brokerUrl}` : "";
  switch (h.state) {
    case "installed":
      return warn("hooks", true, `the Volley hooks are installed in ~/.claude/settings.json${at}`);
    case "no_installer":
      return warn("hooks", false, "this volley checkout has no volley-hooks installer");
    case "no_bun":
      return warn("hooks", false, "bun is needed to install the Volley hooks (see tool.bun)");
    case "failed":
      return warn("hooks", false, `the hooks installer's dry run failed: ${h.why}`);
    case "differs":
      return warn(
        "hooks",
        false,
        `~/.claude/settings.json does not have this checkout's Volley hooks${at}`,
        stepsFix([h.argv as string[]]),
      );
  }
}

function mcpCheck(p: ProfileFacts): Check {
  const m = p.mcp;
  if (p.target.sharing.mcp === "own")
    return warn("mcp", true, `the MCP servers: ${leftAsIs("mcp")}`);
  const at = p.target.brokerUrl !== null ? ` at ${p.target.brokerUrl}` : "";
  if (m.state === "ok") return warn("mcp", true, `the volley MCP server is registered${at}`);
  if (m.state === "unreadable") {
    return warn("mcp", false, "~/.claude.json cannot be read: the MCP servers are left as is");
  }
  if (m.add === null || m.remove === null) {
    return warn(
      "mcp",
      false,
      "the volley MCP server is not registered, and claude is not installed",
    );
  }
  if (m.state === "missing") {
    return warn("mcp", false, "the volley MCP server is not registered", stepsFix([m.add]));
  }
  const steps = [m.remove, m.add];
  if (m.own) {
    // Its env holds settings of the person's own (a broker login, say): never rewritten here.
    return warn(
      "mcp",
      false,
      `the volley MCP server ${m.why}; it has settings of its own, so it is yours to update`,
      { command: steps.map(shellLine).join(" && ") },
    );
  }
  return warn("mcp", false, `the volley MCP server ${m.why}`, stepsFix(steps));
}

/** The four checks, in this order: skills, hooks, mcp, then the sharing modes they applied. */
export function profileChecks(p: ProfileFacts): Check[] {
  const items = [skillsCheck(p), hooksCheck(p), mcpCheck(p)];
  const s = p.target.sharing;
  const from =
    p.target.from === "supervisor"
      ? "modes from the supervisor"
      : p.target.from === "flag"
        ? "modes from --sharing"
        : "the default modes";
  const own = (["skills", "settings.json", "mcp"] as const).filter((i) => s[i] === "own");
  const modes = `skills ${s.skills}, settings.json ${s["settings.json"]}, mcp ${s.mcp}`;
  const failing = items.filter((c) => !c.ok);
  const detail = `${from}: ${modes}${own.length > 0 ? `; left as is: ${own.join(", ")}` : ""}`;
  // Each item's own fix applies its mode: the sharing row points at them and runs nothing
  // itself (a step two rows shared would run once, attributed to the last).
  const sharing = warn(
    "sharing",
    failing.length === 0,
    failing.length === 0
      ? detail
      : `${detail}; not applied yet: ${failing.map((c) => c.id).join(", ")}`,
    failing.length === 0
      ? undefined
      : failing.every((c) => c.fix?.steps !== undefined)
        ? { command: `the ${failing.map((c) => c.id).join(", ")} fix(es) above`, steps: [] }
        : { command: `fix ${failing.map((c) => c.id).join(", ")} (above)` },
  );
  return [...items, sharing];
}
