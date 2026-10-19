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
 * registered: the MCP entry carries no broker login, the hooks get the URL without one, and an
 * entry that has settings of its own is never rewritten (its fix is printed for the person to
 * run, naming those settings but not their values).
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
/** The agent id prefix the doctor registers; another one is the person's own. */
const MCP_AGENT_ID = "coordinator";

/** The PATH the hooks installer runs with besides bun's folder (a service's PATH may lack bun). */
const BASE_PATH = "/usr/bin:/bin";

export interface SkillFact {
  name: string;
  /** `~/.claude/skills/<name>`. */
  at: string;
  pkg: string;
  installer: string;
  /**
   * linked: resolves to `pkg`; elsewhere: a link to another folder; broken: a link to nothing;
   * stray: a folder of its own.
   */
  state: "linked" | "elsewhere" | "broken" | "stray" | "absent";
}

export interface ProfileFacts {
  home: string;
  target: ProfileTarget;
  skillsDir: string;
  skills: SkillFact[];
  hooks: {
    installer: string;
    settings: string;
    /**
     * The URL the installer ran with (`--broker-url`): the target's, else the one the installed
     * hooks carry, never with a login (the hooks take credentials from their own login file).
     */
    brokerUrl: string | null;
    /** A login was dropped from that URL. */
    loginDropped: boolean;
    /** The namespace the installer ran with (`--namespace`); null for the default. */
    namespace: string | null;
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
    /**
     * The entry has settings of its own (a login, another agent id): the doctor never rewrites
     * it, and its printed fix keeps them.
     */
    own: boolean;
    /** For an `own` entry: the re-registration that keeps them (other keys as placeholders). */
    keep: string[] | null;
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
  if (!existsSync(at)) return "broken";
  return realOf(at) === realOf(pkg) ? "linked" : "elsewhere";
}

/** `url` without a login (`user:pw@`), and whether it had one. */
export function withoutLogin(url: string): { url: string; dropped: boolean } {
  const m = /^([a-z]+:\/\/)[^/@]*@(.*)$/i.exec(url);
  return m === null ? { url, dropped: false } : { url: `${m[1]}${m[2]}`, dropped: true };
}

/** The broker URL the Volley hooks in `settings` carry (`VOLLEY_BROKER_URL=<url>` in their prefix). */
export const installedBrokerUrl = (settings: string) =>
  installedPrefix(settings, "VOLLEY_BROKER_URL");

/** A variable the Volley hooks in `settings` carry in their prefix (`<name>=<value>`). */
function installedPrefix(settings: string, name: string): string | null {
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
    const m = new RegExp(`^(?:[A-Z_]+=\\S* )*?${name}=(\\S+) `).exec(c);
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
  given: ProfileTarget,
): Promise<ProfileFacts> {
  const { home, volleyDir, bun, claude } = where;
  // A login never reaches the profile: neither the hooks' prefix nor the MCP registration.
  const expected = given.brokerUrl !== null ? withoutLogin(given.brokerUrl) : null;
  const target = { ...given, brokerUrl: expected?.url ?? null };
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
  const login = withoutLogin(target.brokerUrl ?? installedBrokerUrl(current) ?? "");
  const brokerUrl = login.url !== "" ? login.url : null;
  // Passed only when it is not the default (the hooks' own default).
  const ns = target.namespace ?? installedPrefix(current, "VOLLEY_NAMESPACE");
  const namespace = ns !== null && ns !== "default" ? ns : null;
  const hooks: ProfileFacts["hooks"] = {
    installer,
    settings,
    brokerUrl,
    loginDropped: login.dropped || expected?.dropped === true,
    namespace,
    argv: null,
    state: "installed",
    why: null,
  };
  if (target.sharing["settings.json"] !== "own") {
    if (!existsSync(installer)) hooks.state = "no_installer";
    else if (bun === null) hooks.state = "no_bun";
    else {
      // The URL and namespace are flags: the installer never reads them from its environment.
      hooks.argv = [
        "env",
        `HOME=${home}`,
        `CLAUDE_SETTINGS=${settings}`,
        `PATH=${dirname(bun)}:${BASE_PATH}`,
        "bash",
        installer,
        ...(brokerUrl !== null ? ["--broker-url", brokerUrl] : []),
        ...(namespace !== null ? ["--namespace", namespace] : []),
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
  const registration = (env: Record<string, string>) =>
    claude === null
      ? null
      : [
          claude,
          "mcp",
          "add-json",
          "-s",
          "user",
          "volley",
          JSON.stringify({ type: "stdio", command: bun ?? "bun", args: ["run", entry], env }),
        ];
  const ours = {
    VOLLEY_AGENT_ID: MCP_AGENT_ID,
    ...(target.namespace !== null ? { VOLLEY_NAMESPACE: target.namespace } : {}),
    ...(target.brokerUrl !== null ? { VOLLEY_BROKER_URL: target.brokerUrl } : {}),
  };
  const mcp: ProfileFacts["mcp"] = {
    entry,
    add: registration(ours),
    remove: claude !== null ? [claude, "mcp", "remove", "-s", "user", "volley"] : null,
    state: "ok",
    why: null,
    own: false,
    keep: null,
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
      const theirs = Object.keys(envs).filter((k) => !MCP_ENV.includes(k));
      const agentId = envs.VOLLEY_AGENT_ID;
      const ownId = typeof agentId === "string" && agentId !== MCP_AGENT_ID ? agentId : null;
      mcp.own = theirs.length > 0 || ownId !== null;
      if (mcp.own) {
        // Their other settings by name only: the values (a login, say) are never read out.
        mcp.keep = registration({
          ...ours,
          ...(ownId !== null ? { VOLLEY_AGENT_ID: ownId } : {}),
          ...Object.fromEntries(theirs.map((k) => [k, "<yours>"])),
        });
      }
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
const skillWhy = (s: SkillFact) =>
  s.state === "absent"
    ? `${s.name} is not installed`
    : s.state === "broken"
      ? `${s.name} is a broken link`
      : s.state === "elsewhere"
        ? `${s.name} links to another folder`
        : `${s.name} is a folder of its own (the installer backs it up)`;

function skillsCheck(p: ProfileFacts): Check {
  const mode = p.target.sharing.skills;
  const names = p.skills.map((s) => s.name).join(" and ");
  if (mode === "own") return warn("skills", true, `~/.claude/skills: ${leftAsIs("skills")}`);
  if (mode === "copy") {
    // A broken link is missing too: the link goes first (cp will not write through it).
    const missing = p.skills.filter((s) => s.state === "absent" || s.state === "broken");
    if (missing.length === 0) {
      return warn("skills", true, `skills ${names} are in ~/.claude/skills (sharing: copy, kept)`);
    }
    return warn(
      "skills",
      false,
      `~/.claude/skills: ${missing.map(skillWhy).join("; ")} (sharing: copy)`,
      stepsFix([
        ["mkdir", "-p", p.skillsDir],
        ...missing.flatMap((s) => [
          ...(s.state === "broken" ? [["rm", s.at]] : []),
          ["cp", "-R", s.pkg, s.at],
        ]),
      ]),
    );
  }
  const bad = p.skills.filter((s) => s.state !== "linked");
  if (bad.length === 0) {
    return warn("skills", true, `skills ${names} link to this checkout`);
  }
  return warn(
    "skills",
    false,
    `~/.claude/skills: ${bad.map(skillWhy).join("; ")}`,
    stepsFix(bad.map((s) => ["env", `HOME=${p.home}`, "bash", s.installer])),
  );
}

function hooksCheck(p: ProfileFacts): Check {
  const h = p.hooks;
  if (p.target.sharing["settings.json"] === "own") {
    return warn("hooks", true, `~/.claude/settings.json: ${leftAsIs("settings.json")}`);
  }
  const at =
    (h.brokerUrl !== null ? ` for ${h.brokerUrl}` : "") +
    (h.namespace !== null ? ` in namespace ${h.namespace}` : "") +
    (h.loginDropped
      ? " (the login in that URL is left out: the hooks take theirs from their own login file)"
      : "");
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
  // Not atomic: should add-json fail after the remove, the next check reports the server
  // missing and its fix adds it back.
  const steps = [m.remove, m.add];
  if (m.own && m.keep !== null) {
    // Settings of the person's own (a broker login, say): never rewritten here. The printed
    // command keeps them, with each value left for them to fill in.
    return warn(
      "mcp",
      false,
      `the volley MCP server ${m.why}; it has settings of its own, so it is yours to update (replace each <yours> with your value)`,
      { command: [m.remove, m.keep].map(shellLine).join(" && ") },
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
  // Each item's own fix applies its mode: the sharing row names the items not applied yet and
  // carries no fix of its own (it would run nothing).
  const sharing = warn(
    "sharing",
    failing.length === 0,
    failing.length === 0
      ? detail
      : `${detail}; not applied yet: ${failing.map((c) => c.id).join(", ")}`,
  );
  return [...items, sharing];
}
