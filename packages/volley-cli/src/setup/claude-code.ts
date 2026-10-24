import { existsSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import {
  type SkillFact,
  VOLLEY_SKILLS,
  realOf,
  skillState,
  volleyEntryIn,
  withoutLogin,
} from "../peer/profile-checks";
import { COORDINATOR_NAME, readSetupInstall, writeSetupInstall } from "./journal";
import { planHooks } from "./services";
import type { SetupContext, StepPlan } from "./step";

/**
 * The Claude Code step: everything a coordinator session on this machine needs, with no secret
 * in `~/.claude.json`. One coordinator name, chosen once (asked, with this machine's name as the
 * default) and kept in setup.json; the volley MCP server registered at user scope with
 * non-secret env only (its login comes from `coordinator.json` in the auth dir it names); the
 * three Volley skills linked through their installers; the Volley hooks installed. An MCP entry
 * that carries settings of the person's own (a password, another agent id) is left alone and the
 * command that replaces it is printed. `--broker-url` re-points the registration and the hooks.
 */

/** The namespace a coordinator set up here works in. */
export const SETUP_NAMESPACE = "default";

/** The MCP env keys setup's registration sets: any other is the person's own. */
export const MCP_ENV_KEYS = [
  "VOLLEY_AGENT_ID",
  "VOLLEY_COORDINATOR",
  "VOLLEY_NAMESPACE",
  "VOLLEY_BROKER_URL",
  "VOLLEY_AUTH_DIR",
] as const;

export const MCP_GET = ["claude", "mcp", "get", "volley"] as const;
export const MCP_REMOVE = ["claude", "mcp", "remove", "-s", "user", "volley"] as const;
export const mcpAddArgv = (json: string) => [
  "claude",
  "mcp",
  "add-json",
  "-s",
  "user",
  "volley",
  json,
];

/** `coord-<this machine's name, slugged>`, within the agent-id grammar. */
export function defaultCoordinator(host: string): string {
  const slug = host
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/, "");
  return slug === "" ? "coord-main" : `coord-${slug}`;
}

export const COORDINATOR_QUESTION = (dflt: string) => `Coordinator name [${dflt}]: `;

/** The registration's JSON: `bun run <checkout>/packages/volley-mcp/src/index.ts`, env without a secret. */
export function mcpRegistration(
  ctx: SetupContext,
  repo: string,
  coordinator: string,
): { type: string; command: string; args: string[]; env: Record<string, string> } {
  return {
    type: "stdio",
    command: ctx.deps.bun,
    args: ["run", join(repo, "packages", "volley-mcp", "src", "index.ts")],
    env: {
      VOLLEY_AGENT_ID: "coordinator",
      VOLLEY_COORDINATOR: coordinator,
      VOLLEY_NAMESPACE: SETUP_NAMESPACE,
      VOLLEY_BROKER_URL: withoutLogin(ctx.tcpUrl).url,
      VOLLEY_AUTH_DIR: ctx.auth.dir,
    },
  };
}

const sq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

async function must(
  ctx: SetupContext,
  argv: readonly string[],
  env?: Record<string, string | undefined>,
) {
  const r = await ctx.deps.exec(argv, env !== undefined ? { env } : undefined);
  if (r.code !== 0) {
    // Never the argv itself: an add-json carries the registration (no secret, but long).
    throw new Error(
      `\`${argv.slice(0, 4).join(" ")}\` failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`,
    );
  }
  return r;
}

/** Ask for the name until it is in the grammar (Enter takes the default; nobody there: the default). */
async function askName(ctx: SetupContext, dflt: string): Promise<string> {
  const ask = ctx.deps.ask;
  if (ask === undefined || ctx.yes || ctx.check === true || !ctx.deps.interactive) return dflt;
  for (let tries = 0; tries < 3; tries++) {
    const a = await ask(COORDINATOR_QUESTION(dflt));
    if (a === null || a === "") return dflt;
    if (COORDINATOR_NAME.test(a)) return a;
    ctx.auth.io.stdout(
      `  A coordinator name is lowercase letters, digits, - and _ (at most 63, starting with a letter or digit): ${JSON.stringify(a)} is not one.\n`,
    );
  }
  return dflt;
}

const skillWhy = (s: SkillFact) =>
  s.state === "absent"
    ? `${s.name}: not installed`
    : s.state === "broken"
      ? `${s.name}: a broken link`
      : s.state === "elsewhere"
        ? `${s.name}: links to another folder`
        : `${s.name}: a folder of its own (backed up, not replaced)`;

export async function planClaudeCode(ctx: SetupContext): Promise<StepPlan> {
  const plan: StepPlan = { step: "claude-code", title: "Claude Code", found: [], changes: [] };
  if (ctx.auth.deps.invokingUser(ctx.auth.env) !== null) {
    plan.skipped =
      "running as root, and Claude Code's settings are your user's: run `volley setup --step claude-code` as that user (without sudo)";
    return plan;
  }
  const repo = ctx.deps.repoRoot;
  if (repo === null) {
    plan.blocked =
      "no Volley checkout found (bun.lock's directory): run `volley setup` from the checkout `install.sh` made";
    return plan;
  }
  const rows: string[] = [];

  // The coordinator name: chosen once, then kept.
  const saved = readSetupInstall(ctx.volleydHome)?.coordinator ?? ctx.coordinator;
  let name: string;
  if (saved !== undefined) {
    name = saved;
    ctx.coordinator = saved;
    plan.found.push(`Coordinator name: ${name} (from setup.json)`);
    rows.push(`✓ coordinator: ${name}`);
  } else {
    const dflt = defaultCoordinator((ctx.deps.hostname ?? osHostname)());
    name = await askName(ctx, dflt);
    rows.push("coordinator: not chosen yet");
    plan.changes.push({
      summary: `Save the coordinator name ${name} (setup.json: VOLLEY_COORDINATOR for this machine's sessions and commands)`,
      apply: async () => {
        ctx.coordinator = name;
        writeSetupInstall(ctx);
        return [
          `Coordinator name: ${name}. Waves submitted here are owned by it (\`volleyd run\` without --owner).`,
        ];
      },
    });
  }

  // The volley MCP server: non-secret env only.
  const want = mcpRegistration(ctx, repo, name);
  const add = mcpAddArgv(JSON.stringify(want));
  const claudeJson = join(ctx.home, ".claude.json");
  // undefined: the file is there but not a JSON object; null: no volley entry.
  const entry = existsSync(claudeJson) ? volleyEntryIn(claudeJson) : null;
  const register = (why: string, replace: boolean) =>
    plan.changes.push({
      summary: `${replace ? "Re-register" : "Register"} the volley MCP server with Claude Code (${why}; no password in it)`,
      detail: `Runs ${replace ? `\`${MCP_REMOVE.join(" ")}\`, then ` : ""}\`claude mcp add-json -s user volley …\` with env ${Object.entries(
        want.env,
      )
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}. The login comes from ${join(ctx.auth.dir, "coordinator.json")}.`,
      apply: async () => {
        if (replace) await must(ctx, MCP_REMOVE);
        await must(ctx, add);
        return [
          `The volley MCP server runs ${want.args[1]} at ${want.env.VOLLEY_BROKER_URL} (restart Claude Code sessions to pick it up).`,
        ];
      },
    });
  if (entry === undefined) {
    plan.found.push(`${claudeJson} cannot be read: the MCP registration is left as is`);
    rows.push("MCP: ~/.claude.json cannot be read");
  } else if (entry === null) {
    rows.push("MCP: volley is not registered");
    register("new", false);
  } else {
    const env = (typeof entry.env === "object" && entry.env !== null ? entry.env : {}) as Record<
      string,
      unknown
    >;
    const theirs = Object.keys(env).filter((k) => !(MCP_ENV_KEYS as readonly string[]).includes(k));
    const ownId = typeof env.VOLLEY_AGENT_ID === "string" && env.VOLLEY_AGENT_ID !== "coordinator";
    if (theirs.length > 0 || ownId) {
      // The person's own settings (a password, say): never rewritten here; their names only.
      const own = [...theirs, ...(ownId ? ["VOLLEY_AGENT_ID"] : [])].sort();
      plan.found.push(
        `The volley MCP server has settings of its own (${own.join(", ")}): left as is. To register it the way setup does (its login from the auth dir, no password in ~/.claude.json): ${[...MCP_REMOVE].map(sq).join(" ")} && ${add.map(sq).join(" ")}`,
      );
      rows.push(`MCP: volley has settings of its own (${own.join(", ")}): left as is`);
    } else {
      const args = Array.isArray(entry.args) ? entry.args : [];
      const runs =
        typeof entry.command === "string" &&
        /(^|\/)bun$/.test(entry.command) &&
        args.some((a) => typeof a === "string" && realOf(a) === realOf(want.args[1] as string));
      const differs = runs
        ? MCP_ENV_KEYS.filter((k) => env[k] !== want.env[k])
        : ["the checkout it runs"];
      if (differs.length === 0) {
        plan.found.push(`The volley MCP server is registered at ${want.env.VOLLEY_BROKER_URL}`);
        rows.push(`✓ MCP: volley registered (${want.env.VOLLEY_BROKER_URL}, no secret)`);
      } else {
        rows.push(`MCP: volley differs (${differs.join(", ")})`);
        register(`${differs.join(", ")} ${differs.length === 1 ? "differs" : "differ"}`, true);
      }
    }
  }

  // The skills, through their own installers (each backs a folder of its own up).
  const skills = VOLLEY_SKILLS.map(({ name: skill, pkg }): SkillFact => {
    const at = join(ctx.home, ".claude", "skills", skill);
    const dir = join(repo, "packages", pkg);
    return {
      name: skill,
      at,
      pkg: dir,
      installer: join(dir, "scripts", "install.sh"),
      state: skillState(at, dir),
    };
  });
  const bad = skills.filter((s) => s.state !== "linked");
  if (bad.length === 0) {
    plan.found.push(`Skills ${skills.map((s) => s.name).join(", ")} link to this checkout`);
    rows.push(`✓ skills: ${skills.map((s) => s.name).join(", ")}`);
  } else {
    rows.push(`skills: ${bad.map(skillWhy).join("; ")}`);
    plan.changes.push({
      summary: `Link the Volley skills into ~/.claude/skills (${bad.map(skillWhy).join("; ")})`,
      detail: bad.map((s) => `Runs \`bash ${s.installer}\``).join("\n"),
      apply: async () => {
        const lines: string[] = [];
        for (const s of bad) {
          await must(ctx, ["bash", s.installer], { ...ctx.auth.env, HOME: ctx.home });
          lines.push(`${s.at} → ${s.pkg}`);
        }
        return lines;
      },
    });
  }

  // The hooks (the Services step plans the same install: whichever runs first makes it).
  const hooks = await planHooks(ctx, repo);
  if ("blocked" in hooks) {
    plan.blocked = hooks.blocked;
    return plan;
  }
  if ("change" in hooks) {
    rows.push("hooks: not installed");
    plan.changes.push(hooks.change);
  } else {
    plan.found.push(hooks.found);
    rows.push("✓ hooks: installed");
  }

  plan.row = rows.join("\n");
  plan.verify = async () => {
    const again = await planClaudeCode({ ...ctx, check: true });
    return [
      ...(again.blocked !== undefined ? [again.blocked] : []),
      ...again.changes.map((c) => `still not in place: ${c.summary}`),
    ];
  };
  return plan;
}
